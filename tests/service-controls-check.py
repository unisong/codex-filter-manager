"""Browser check of shared service controls with offline release responses."""
from pathlib import Path
import json
import os
import subprocess
import tempfile
from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parent.parent
source = r'''
const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {DatabaseSync}=require('node:sqlite');
const {makeProxy}=require('./src/proxy.cjs');
const {createManagement}=require('./src/management.cjs');
(async()=>{
 const directory=process.argv[1];
 const databasePath=path.join(directory,'mock.db'),db=new DatabaseSync(databasePath);
 db.exec("CREATE TABLE providers(id TEXT,name TEXT,app_type TEXT,is_current INTEGER,settings_config TEXT,sort_index INTEGER); CREATE TABLE proxy_config(app_type TEXT,auto_failover_enabled INTEGER); INSERT INTO proxy_config VALUES('codex',0)"); db.close();
 let server;
 const dashboard=createManagement({databasePath,runtime:directory,onStop:()=>setTimeout(()=>{server.close();server.closeAllConnections()},60)});
 server=makeProxy({token:'offline-token',dashboard,getUpstream:()=> 'http://127.0.0.1:1',getState:()=>({state:'passthrough'})});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const gateway=http.createServer((req,res)=>res.end(JSON.stringify({data:[]})));
 await new Promise(r=>gateway.listen(0,'127.0.0.1',r));
 const {createService}=await import('./magpie-workbench/server/http.mjs');
 const service=await createService({directory:path.join(directory,'magpie'),gateFile:path.join(directory,'gate.js'),options:{gatewayUrl:'http://127.0.0.1:'+gateway.address().port}});
 console.log(JSON.stringify({ccswitch:'http://127.0.0.1:'+server.address().port+'/__codex_filter__/ui',magpie:service.openURL(),host:'http://127.0.0.1:'+gateway.address().port}));
})();
'''

with tempfile.TemporaryDirectory(prefix='filter-controls-ui-') as scratch:
    proc = subprocess.Popen(['node', '-e', source, scratch], cwd=root, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, text=True,
                            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
    try:
        urls = json.loads(proc.stdout.readline())
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True, **({'executable_path': os.environ['CHROME_PATH']} if os.environ.get('CHROME_PATH') else {}))
            for mode in ['ccswitch', 'magpie']:
                page = browser.new_page(viewport={'width': 1440, 'height': 1000})
                errors = []
                page.on('pageerror', lambda e: errors.append(str(e)))
                state = dict(currentVersion='1.0.9', releases=[], phase='idle', checkedAt=None,
                             mode=mode, canInstall=True, installReason='', error=None)
                checks = []
                def update(route):
                    url = route.request.url
                    if url.endswith('/check'):
                        checks.append('check')
                        state.update(phase='checking')
                    elif url.endswith('/install'):
                        state.update(phase='idle', result={'phase': 'ready', 'tag': 'v1.2.0', 'target': r'C:\Demo\new-version\magpie-workbench'}
                                     if mode == 'magpie' else {'phase': 'failed', 'tag': 'v1.2.0', 'message': 'SHA-256 mismatch'})
                    elif state['phase'] == 'checking':
                        state.update(phase='idle', checkedAt='2026-10-18T00:00:00Z', releases=[{
                            'tag': 'v1.2.0', 'notes': '演示更新说明 <script>neverExecute()</script>', 'size': 12000,
                            'page': 'https://github.com/unisong/codex-filter-manager/releases/tag/v1.2.0'}])
                    route.fulfill(json=state)
                page.route('**/api/updates**', update)
                page.goto(urls[mode])
                expect(page.locator('#stopService')).to_be_visible()
                page.locator('#viewSettings' if mode == 'ccswitch' else '[data-view=settings]').click()
                expect(page.locator('#updateStatus')).to_contain_text('尚未检查')
                assert not checks, 'Opening settings must not contact GitHub'
                page.locator('#checkUpdates').click()
                expect(page.locator('#checkUpdates')).to_have_text('正在检查…')
                expect(page.locator('#updateVersion')).to_have_value('v1.2.0', timeout=7000)
                if os.environ.get('UI_ARTIFACT_DIR'):
                    output = Path(os.environ['UI_ARTIFACT_DIR'])
                    output.mkdir(parents=True, exist_ok=True)
                    page.screenshot(path=str(output / (mode + '-service-controls.png')), full_page=True)
                page.locator('.service-release-notes summary').click()
                expect(page.locator('.service-release-notes pre')).to_contain_text('<script>neverExecute()')
                page.locator('#installUpdate').click()
                expect(page.locator('#serviceConfirm')).to_be_visible()
                page.locator('#serviceConfirm button[value=cancel]').click()
                assert 'result' not in state
                page.locator('#installUpdate').click()
                page.locator('#serviceConfirm button[value=ok]').click()
                expect(page.locator('#updateResult')).to_contain_text('已下载' if mode == 'magpie' else '更新未完成')
                for dark in [False, True]:
                    if dark:
                        page.locator('#themeToggle').click()
                    for width in [1440, 390]:
                        page.set_viewport_size({'width': width, 'height': 1000})
                        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), (mode, width)
                        expect(page.locator('#stopService')).to_be_visible()
                page.set_viewport_size({'width': 1440, 'height': 1000})
                page.locator('#stopService').click()
                page.locator('#serviceConfirm button[value=cancel]').click()
                expect(page.locator('#serviceStopped')).to_have_count(0)
                page.locator('#stopService').click()
                page.locator('#serviceConfirm button[value=ok]').click()
                expect(page.locator('#serviceStopped')).to_contain_text('已关闭', timeout=8000)
                assert not errors, errors
                assert page.request.get(urls['host']).ok, 'Stopping the console must not kill the host/gateway'
                print(mode + ': update states, safe notes, confirmation, theme, mobile and shutdown passed')
                page.close()
            browser.close()
    finally:
        proc.terminate()
        proc.wait(timeout=15)

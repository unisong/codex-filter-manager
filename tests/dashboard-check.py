"""Exercise the management UI against a disposable, offline CC Switch database."""
from pathlib import Path
import hashlib
import json
import os
import subprocess
import tempfile
from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parent.parent
node_source = r'''
const fs=require('node:fs'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {makeProxy}=require('./src/proxy.cjs');
const {createManagement}=require('./src/management.cjs');
const runtime=process.argv[1],databasePath=path.join(runtime,'mock.db');
const db=new DatabaseSync(databasePath);
db.exec("PRAGMA user_version=19; CREATE TABLE providers(id TEXT,name TEXT,app_type TEXT,is_current INTEGER,settings_config TEXT,sort_index INTEGER); CREATE TABLE proxy_config(app_type TEXT,auto_failover_enabled INTEGER); INSERT INTO proxy_config VALUES('codex',0)");
const providers=[['gugu','演示供应商-Codex','https://gugu.example',1],['ugq','备用供应商-Codex','https://backup.example',0],['agent','团队供应商','https://team.example',0],['hub','测试供应商','https://test.example',0],['unsafe','<img src=x onerror=alert(1)>','https://example.com',0]];
for(const [id,name,url,current] of providers) db.prepare('INSERT INTO providers VALUES(?,?,?,?,?,0)').run(id,name,'codex',current,JSON.stringify({config:'model_provider="custom"\n[model_providers.custom]\nbase_url='+JSON.stringify(url)}));
db.close();
fs.writeFileSync(path.join(runtime,'legacy-model-aliases.json'),JSON.stringify({enabled:true,databaseVersion:19,aliases:[['ccs-old/gpt-6-astra','gpt-6-astra']]}));
const management=createManagement({runtime,databasePath});
const server=makeProxy({token:'ui-test-only',getUpstream:()=> 'http://127.0.0.1:1',dashboard:management,getFilterPolicy:management.policy,getState:()=>({state:'filtering',currentPolicy:management.policy()})});
server.listen(0,'127.0.0.1',()=>console.log('http://127.0.0.1:'+server.address().port+'/__codex_filter__/ui'));
'''

with tempfile.TemporaryDirectory(prefix='codex-filter-ui-') as scratch:
    proc = subprocess.Popen(['node', '-e', node_source, scratch], cwd=root,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
    try:
        url = proc.stdout.readline().strip()
        assert url.startswith('http://127.0.0.1:'), 'Preview failed to start'
        db = Path(scratch) / 'mock.db'
        before_hash = hashlib.sha256(db.read_bytes()).hexdigest()
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True, **({'executable_path': os.environ['CHROME_PATH']} if os.environ.get('CHROME_PATH') else {}))
            page = browser.new_page(viewport={'width': 1440, 'height': 1000}, device_scale_factor=1)
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.goto(url)
            expect(page.locator('#providers tr')).to_have_count(5)
            page.locator('#viewSettings').click()
            page.locator('#diagnose').click()
            expect(page.locator('#diagnosticDialog')).to_be_visible()
            expect(page.locator('#diagnosticChecks')).to_contain_text('管理服务可响应')
            expect(page.locator('#diagnosticPreview')).not_to_contain_text('ui-test-only')
            with page.expect_download() as downloaded:
                page.locator('#exportDiagnostics').click()
            report_path = Path(scratch) / 'downloaded-report.json'
            downloaded.value.save_as(report_path)
            diagnostic = json.loads(report_path.read_text(encoding='utf-8'))
            assert diagnostic['schemaVersion'] == 1
            assert '演示供应商' not in report_path.read_text(encoding='utf-8')
            page.locator('#closeDiagnostics').click()
            expect(page.locator('#diagnosticDialog')).to_be_hidden()
            page.locator('#viewProviders').click()
            expect(page.locator('#providersView')).to_be_visible()
            expect(page.locator('#viewProtection')).to_be_hidden()
            expect(page.locator('#viewHistory')).to_be_hidden()
            expect(page.locator('#guardEnabled')).to_be_hidden()
            expect(page.locator('#currentHistoryEnabled')).to_have_attribute('aria-checked', 'false')
            expect(page.locator('#providers .rule-label')).to_have_text(['原样转发'] * 5)
            expect(page.locator('#providers .rule-source')).to_have_text(['默认直通'] * 5)
            assert not (Path(scratch) / 'provider-rules.json').exists()
            assert page.locator('#error').is_hidden()
            assert page.locator('#current').inner_text() == '演示供应商-Codex'
            assert page.locator('#providers img').count() == 0
            # Hold state reads to exercise a click joining an automatic refresh.
            page.evaluate('''() => {
                window.refreshTest = {original: window.fetch, pending: [], calls: 0, snapshot: JSON.stringify(state)};
                window.fetch = (url, options) => {
                    if (String(url).endsWith('/api/state')) {
                        refreshTest.calls++;
                        return new Promise(resolve => refreshTest.pending.push(resolve));
                    }
                    return refreshTest.original(url, options);
                };
                void refresh();
            }''')
            page.locator('#refresh').click()
            expect(page.locator('#refresh')).to_have_text('刷新中…')
            expect(page.locator('#refresh')).to_have_attribute('aria-busy', 'true')
            expect(page.locator('#refresh')).to_be_disabled()
            expect(page.locator('#toast')).to_have_text('正在刷新供应商列表…')
            assert page.evaluate('refreshTest.calls') == 1, 'Manual click duplicated the ongoing state read'
            page.evaluate('''() => {
                document.getElementById('refresh').dispatchEvent(new MouseEvent('click'));
                refreshTest.pending.shift()(new Response(refreshTest.snapshot, {headers: {'content-type': 'application/json'}}));
            }''')
            expect(page.locator('#refresh')).to_be_enabled()
            expect(page.locator('#refresh')).to_have_attribute('aria-busy', 'false')
            expect(page.locator('#toast')).to_have_text('列表已刷新，共 5 个供应商')
            assert page.evaluate('refreshTest.calls') == 1
            page.locator('#refresh').click()
            expect(page.locator('#refresh')).to_be_disabled()
            page.evaluate('''() => refreshTest.pending.shift()(new Response(JSON.stringify({error: {message: '模拟连接失败'}}), {
                status: 503, headers: {'content-type': 'application/json'}
            }))''')
            expect(page.locator('#refresh')).to_be_enabled()
            expect(page.locator('#toast')).to_have_text('刷新失败，请检查本地服务连接。')
            expect(page.locator('#toast')).to_have_class('toast error')
            expect(page.locator('#error')).to_be_visible()
            # Automatic polling must stay quiet after a manual result.
            page.evaluate('''() => { window.fetch = refreshTest.original; void refresh(); }''')
            expect(page.locator('#error')).to_be_hidden()
            expect(page.locator('#toast')).to_have_text('刷新失败，请检查本地服务连接。')
            page.locator('#refresh').click()
            expect(page.locator('#toast')).to_have_text('列表已刷新，共 5 个供应商')
            page.get_by_role('switch', name='演示供应商-Codex 历史过滤', exact=True).click()
            expect(page.get_by_role('switch', name='演示供应商-Codex 历史过滤', exact=True)).to_have_attribute('aria-checked', 'true')
            expect(page.locator('#refresh')).to_be_enabled()
            rules_path = Path(scratch) / 'provider-rules.json'
            assert json.loads(rules_path.read_text())['providers']['gugu']['historyFilter']
            page.get_by_role('searchbox', name='搜索供应商').fill('演示')
            assert page.locator('#providers tr').count() == 1
            page.get_by_role('button', name='配置', exact=True).click()
            page.locator('#preserveEncryptedInclude').uncheck()
            page.get_by_role('button', name='保存设置', exact=True).click()
            expect(page.locator('#drawer')).to_be_hidden()
            expect(page.locator('#refresh')).to_be_enabled()
            page.get_by_role('button', name='配置', exact=True).click()
            assert not page.locator('#preserveEncryptedInclude').is_checked()
            page.get_by_role('button', name='关闭全部兼容', exact=True).click()
            expect(page.get_by_role('switch', name='演示供应商-Codex 历史过滤', exact=True)).to_have_attribute('aria-checked', 'false')
            expect(page.locator('#refresh')).to_be_enabled()
            page.get_by_role('button', name='配置', exact=True).click()
            page.get_by_role('button', name='恢复默认', exact=True).click()
            expect(page.locator('#drawer')).to_be_hidden()
            expect(page.locator('#providers .rule-source')).to_have_text('默认直通')
            expect(page.locator('#currentHistoryEnabled')).to_have_attribute('aria-checked', 'false')
            assert 'gugu' not in json.loads(rules_path.read_text())['providers']
            page.locator('#currentHistoryEnabled').click()
            expect(page.locator('#currentHistoryEnabled')).to_have_attribute('aria-checked', 'true')
            expect(page.get_by_role('switch', name='演示供应商-Codex 历史过滤', exact=True)).to_have_attribute('aria-checked', 'true')
            expect(page.locator('#refresh')).to_be_enabled()
            page.locator('#currentHistoryEnabled').click()
            expect(page.locator('#currentHistoryEnabled')).to_have_attribute('aria-checked', 'false')
            expect(page.locator('#refresh')).to_be_enabled()
            page.get_by_role('switch', name='旧模型名称兼容', exact=True).click()
            expect(page.get_by_role('switch', name='旧模型名称兼容', exact=True)).to_have_attribute('aria-checked','false')
            page.get_by_role('searchbox', name='搜索供应商').fill('')
            page.get_by_role('button', name='已启用', exact=True).click()
            expect(page.locator('#providers tr')).to_have_count(0)
            expect(page.locator('#empty')).to_be_visible()
            page.get_by_role('button', name='全部', exact=True).click()
            output = root / '.runtime'
            output.mkdir(exist_ok=True)
            page.screenshot(path=str(output / 'dashboard-desktop.png'), full_page=True)
            page.get_by_role('button', name='配置', exact=True).first.click()
            page.screenshot(path=str(output / 'dashboard-settings.png'), full_page=True)
            page.keyboard.press('Escape')
            page.set_viewport_size({'width': 390, 'height': 844})
            assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), 'Mobile horizontal overflow'
            page.locator('#viewSettings').click()
            page.locator('#diagnose').click()
            expect(page.locator('#diagnosticDialog')).to_be_visible()
            expect(page.locator('#exportDiagnostics')).to_be_enabled()
            assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), 'Diagnostic dialog overflows mobile viewport'
            page.screenshot(path=str(output / 'diagnostics-mobile.png'), full_page=True)
            page.locator('#closeDiagnostics').click()
            page.screenshot(path=str(output / 'dashboard-mobile.png'), full_page=True)
            assert not errors, errors
            browser.close()
        assert hashlib.sha256(db.read_bytes()).hexdigest() == before_hash, 'CC Switch DB changed'
        print(json.dumps({'passed': True, 'checks': ['diagnostic-dialog', 'diagnostic-download-schema-and-privacy', 'diagnostic-mobile-layout', 'refresh-progress', 'refresh-joins-poll', 'refresh-no-duplicate-click', 'refresh-success', 'refresh-failure-recovery', 'quiet-auto-poll', 'toggle', 'search', 'configure', 'persist', 'disable', 'reset', 'alias-switch', 'tabs', 'mobile-layout', 'no-page-errors', 'CCS-database-unchanged']}, ensure_ascii=False))
    finally:
        proc.terminate()
        proc.wait(timeout=10)

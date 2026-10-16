"""Offline browser checks for Magpie routing labels and independent controls."""
from pathlib import Path
import hashlib
import json
import os
import subprocess
import tempfile
from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parent
source = r'''
const fs=require('node:fs'),path=require('node:path');
const {createMagpieAdapter}=require('./magpie.cjs');
const {createManagement}=require('./management.cjs');
const {createGuardService}=require('./guard-service.cjs');
const {makeProxy}=require('./proxy.cjs');
const runtime=process.argv[1],configPath=path.join(runtime,'config.toml');
fs.writeFileSync(configPath,'model="demo/gpt-6-astra"\nmodel_provider="magpie"\n[model_providers.magpie]\nbase_url="http://127.0.0.1:3425/v1"\n');
fs.writeFileSync(path.join(runtime,'providers.json'),JSON.stringify({providers:[
 {id:'demo',name:'演示供应商',key:'OFFLINE_PRIVATE_KEY',responses:'https://demo.invalid/v1',models:['gpt-6-astra']},
 {id:'backup',name:'备用供应商',responses:'https://backup.invalid/v1',models:['gpt-6-astra'],fallback:['demo/gpt-6-astra']}
]}));
const getUpstream=()=> 'http://127.0.0.1:1';
const adapter=createMagpieAdapter({directory:runtime,configPath,getUpstream});
const guard=createGuardService({runtime,configPath,getUpstream,adapter});
const {createMagpiePluginStore}=require('./magpie-plugin-store.cjs');
const pluginStore=createMagpiePluginStore({directory:runtime});pluginStore.install();
const dashboard=createManagement({runtime,adapter,guard,pluginStore});
const server=makeProxy({token:'offline-ui',dashboard,getUpstream,getState:()=>({state:'magpie-plugin',backend:'magpie'})});
server.listen(0,'127.0.0.1',()=>console.log('http://127.0.0.1:'+server.address().port+'/__codex_filter__/ui'));
'''
with tempfile.TemporaryDirectory(prefix='magpie-ui-') as scratch:
    proc = subprocess.Popen(['node', '-e', source, scratch], cwd=root, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            text=True, creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
    try:
        url = proc.stdout.readline().strip()
        assert url.startswith('http://127.0.0.1:')
        provider_path = Path(scratch) / 'providers.json'
        before = hashlib.sha256(provider_path.read_bytes()).hexdigest()
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True, **({'executable_path': os.environ['CHROME_PATH']} if os.environ.get('CHROME_PATH') else {}))
            page = browser.new_page(viewport={'width': 1440, 'height': 1000})
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.goto(url)
            expect(page.locator('#providers tr')).to_have_count(2)
            expect(page.locator('.backend-name')).to_have_text(['Magpie', 'Magpie'])
            expect(page.locator('#legacyAliasesCard')).to_be_hidden()
            expect(page.locator('#current')).to_have_text('演示供应商')
            expect(page.locator('#current').locator('..').locator('.label')).to_contain_text('配置默认供应商')
            expect(page.locator('#versionBadge')).to_have_text('v31')
            expect(page.locator('#currentHistoryEnabled')).to_have_attribute('aria-checked', 'false')
            page.locator('#currentHistoryEnabled').click()
            expect(page.locator('#currentHistoryEnabled')).to_have_attribute('aria-checked', 'true')
            rules = json.loads((Path(scratch) / 'plugins.json').read_text())
            assert list(rules['plugins'][0]['options']['providers']) == ['magpie:demo']
            assert 'fallback' in page.locator('#providers').inner_text()
            page.locator('#viewProtection').click()
            expect(page.locator('#guardModel')).to_contain_text('demo/gpt-6-astra')
            expect(page.locator('#guardManualModel')).to_have_value('gpt-6-astra')
            expect(page.locator('#guardTest')).to_be_enabled()
            expect(page.locator('#guardEnabled')).to_have_attribute('aria-checked', 'false')
            expect(page.locator('#guardEnabled')).to_be_disabled()
            expect(page.locator('#guardBadge')).to_have_text('手动检测模式')
            expect(page.locator('#warning')).to_contain_text('不改写 base_url')
            output = root / '.runtime'
            output.mkdir(exist_ok=True)
            page.screenshot(path=str(output / 'magpie-dashboard-desktop.png'), full_page=True)
            page.set_viewport_size({'width': 390, 'height': 844})
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
            page.screenshot(path=str(output / 'magpie-dashboard-mobile.png'), full_page=True)
            assert not errors, errors
            browser.close()
        assert hashlib.sha256(provider_path.read_bytes()).hexdigest() == before
        print('PASS Magpie UI: route labels, model selection, default-off controls, isolated rules, responsive layout; provider file unchanged')
    finally:
        proc.terminate()
        proc.wait(timeout=10)

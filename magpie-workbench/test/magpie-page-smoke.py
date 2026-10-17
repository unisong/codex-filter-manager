"""Optional native GUI integration test. Uses a disposable portable Magpie and loopback mock only.

python test/magpie-page-smoke.py --binary /path/to/magpie.exe [--screenshot docs/settings.png]
Requires Playwright + Chromium. Never uses the installed Magpie profile.
"""
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import argparse
import hashlib
import json
import os
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import urllib.request
from playwright.sync_api import sync_playwright, expect

parser = argparse.ArgumentParser()
parser.add_argument('--binary', required=True)
parser.add_argument('--screenshot')
args = parser.parse_args()
root = Path(__file__).resolve().parent.parent
seen = []


class Mock(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        seen.append(body)
        reply = json.dumps({'id': 'resp_mock', 'object': 'response', 'status': 'completed',
                            'model': body['model'], 'output': []}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(reply)))
        self.end_headers()
        self.wfile.write(reply)


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


mock = ThreadingHTTPServer(('127.0.0.1', 0), Mock)
threading.Thread(target=mock.serve_forever, daemon=True).start()
scratch = Path(tempfile.mkdtemp(prefix='magpie-history-page-')).resolve()
app = scratch / 'app'
app.mkdir()
binary = app / 'magpie.exe'
shutil.copy2(Path(args.binary).resolve(), binary)
(app / '.portable').write_text('')
data = app / 'data'
data.mkdir()
plugin = scratch / 'plugin'
plugin.mkdir()
for name in ['package.json', 'workbench.middleware.js', 'history', 'plugin', 'server', 'vendor', 'web']:
    source = root / name
    if source.is_dir():
        shutil.copytree(source, plugin / name)
    else:
        shutil.copy2(source, plugin / name)
home = scratch / 'profile'
(home / '.codex').mkdir(parents=True)
config = home / '.codex/config.toml'
config.write_text('model="demo/mock"\n[model_providers.magpie]\nbase_url="http://127.0.0.1:3425/v1"\n')
config_before = hashlib.sha256(config.read_bytes()).hexdigest()
port, web_port = free_port(), free_port()
origin, web = f'http://127.0.0.1:{port}', f'http://127.0.0.1:{web_port}'
(data / 'settings.json').write_text(json.dumps({'port': port, 'lang': 'zh', 'theme': 'light',
    'updateEvery': 1440, 'autoRestart': False, 'noUsageStats': True}))
(data / 'plugins.yml').write_text('preset: all\n')
provider_file = data / 'providers.json'
provider_file.write_text(json.dumps({'providers': [
    {'id': pid, 'name': name, 'key': 'LOCAL_MOCK_ONLY', 'responses': f'http://127.0.0.1:{mock.server_port}/v1',
     'models': ['mock']} for pid, name in [('demo', '演示供应商'), ('backup', '备用供应商'),
                                         ('unsafe', '<img src=x onerror=alert(1)>')]]}), encoding='utf-8')
provider_before = hashlib.sha256(provider_file.read_bytes()).hexdigest()
plugin_file = data / 'plugins.json'
plugin_file.write_text(json.dumps({'plugins': [{'spec': str(plugin), 'options': {
    'magpieDirectory': str(data), 'providers': {}, 'aliases': {'old-demo': 'demo'}, 'keepExtra': 'unchanged'}}]}))
env = {k: v for k, v in os.environ.items() if k.upper() in
       ('SYSTEMROOT', 'WINDIR', 'PATH', 'TEMP', 'TMP', 'PATHEXT', 'COMSPEC')}
env.update({'USERPROFILE': str(home), 'CODEX_HOME': str(home / '.codex'),
            'XDG_CONFIG_HOME': str(scratch / 'config'), 'XDG_CACHE_HOME': str(scratch / 'cache'),
            'MAGPIE_ADDR': f'127.0.0.1:{port}', 'MAGPIE_WEB_KEY': 'local-native-page-test-only',
            'MAGPIE_PLUGIN_MARKET': 'off'})
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
log = (scratch / 'magpie.log').open('wb')
proc = None


def upstream():
    body = {'model': 'demo/mock', 'input': [
        {'type': 'reasoning', 'encrypted_content': 'foreign'},
        {'type': 'message', 'id': 'msg_foreign', 'role': 'user', 'content': 'local only'}],
        'include': ['reasoning.encrypted_content'], 'stream': False}
    req = urllib.request.Request(origin + '/v1/responses', data=json.dumps(body).encode(),
                                 headers={'Content-Type': 'application/json'})
    with opener.open(req, timeout=12) as response:
        assert response.status == 200


try:
    proc = subprocess.Popen([str(binary), 'serve', f'--web=127.0.0.1:{web_port}'], cwd=app, env=env,
                            stdout=log, stderr=log,
                            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
    for _ in range(150):
        try:
            with socket.create_connection(('127.0.0.1', web_port), timeout=.2):
                break
        except OSError:
            if proc.poll() is not None:
                raise RuntimeError(f'Magpie exited; inspect {scratch}')
            time.sleep(.1)
    else:
        raise RuntimeError(f'Web did not start; inspect {scratch}')
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, **({'executable_path': os.environ['CHROME_PATH']} if os.environ.get('CHROME_PATH') else {}))
        page = browser.new_page(viewport={'width': 1200, 'height': 900}, locale='zh-CN')
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        # Suppress the host's unrelated asynchronous release-notes dialog.
        page.route('**/api/whatsnew*', lambda r: r.fulfill(content_type='application/json', body='{"show":false,"releases":[]}'))
        page.goto(web + '/?k=local-native-page-test-only')
        page.locator('button[data-plugin-page]').filter(has_text='Codex Workbench').click()
        frame = page.frame_locator('iframe.plugin-frame')
        demo = frame.locator('input[data-id="demo"][data-field="historyFilter"]')
        include = frame.locator('input[data-id="demo"][data-field="preserveEncryptedInclude"]')
        expect(demo).not_to_be_checked()
        expect(include).to_be_disabled()
        expect(frame.locator('#notice')).to_have_attribute('data-kind', 'success')
        upstream()
        assert len(seen[-1]['input']) == 2
        print('PASS default rules remain off in the native page and gateway')
        demo.check()
        expect(include).to_be_enabled()
        expect(include).to_be_checked()
        expect(frame.locator('#save')).to_be_enabled()
        frame.locator('#save').click()
        expect(frame.locator('#notice')).to_have_attribute('data-kind', 'success')
        options = json.loads(plugin_file.read_text(encoding='utf-8'))['plugins'][0]['options']
        assert options['providers']['magpie:demo'] == {'historyFilter': True, 'preserveEncryptedInclude': True}
        assert options['aliases'] == {'old-demo': 'demo'} and options['keepExtra'] == 'unchanged'
        time.sleep(1.2)
        upstream()
        assert len(seen[-1]['input']) == 1 and 'id' not in seen[-1]['input'][0]
        assert seen[-1]['include'] == ['reasoning.encrypted_content']
        print('PASS page bridge saves options and the real gateway filters the next request')
        # Search, refresh feedback and HTML-like names use actual provider data.
        frame.locator('#search').fill('unsafe')
        expect(frame.locator('#providers img')).to_have_count(0)
        expect(frame.locator('.name')).to_have_text('<img src=x onerror=alert(1)>')
        frame.locator('#search').fill('demo')
        frame.locator('#refresh').click()
        expect(frame.locator('#notice')).to_have_attribute('data-kind', 'success')
        expect(demo).to_be_checked()
        # A write error retains edits and tells the user it was not completed.
        include.uncheck()
        def fail_save(route):
            if '"options":' in (route.request.post_data or ''):
                route.fulfill(status=500, content_type='application/json', body='{"error":"mock save failed"}')
            else:
                route.continue_()
        page.route('**/api/plugin-pages/options', fail_save)
        expect(frame.locator('#save')).to_be_enabled()
        frame.locator('#save').click()
        expect(frame.locator('#notice')).to_have_attribute('data-kind', 'error')
        expect(include).not_to_be_checked()
        assert json.loads(plugin_file.read_text())['plugins'][0]['options']['providers']['magpie:demo']['preserveEncryptedInclude']
        page.unroute('**/api/plugin-pages/options', fail_save)
        frame.locator('#discard').click()
        expect(include).to_be_checked()
        # Refreshing the provider list must not discard local edits.
        include.uncheck()
        frame.locator('#refresh').click()
        expect(frame.locator('#notice')).to_have_attribute('data-kind', 'success')
        expect(include).not_to_be_checked()
        frame.locator('#discard').click()
        print('PASS search, refresh, failed save, discard and unsaved edit retention')
        frame.locator('#refresh').click()
        expect(frame.locator('#notice')).to_have_attribute('data-kind', 'success')
        frame.locator('#search').fill('供应商')
        frame.locator('#search').blur()
        if args.screenshot:
            for button in page.get_by_role('button', name='关闭', exact=True).all():
                if button.is_visible():
                    button.click()
            dest = Path(args.screenshot).resolve()
            dest.parent.mkdir(parents=True, exist_ok=True)
            frame.locator('main').screenshot(path=str(dest))
        page.set_viewport_size({'width': 430, 'height': 900})
        # Magpie has its own responsive sidebar. Verify the frame after opening
        # the plugin view, regardless of how the host lays out that sidebar.
        expect(frame.locator('#save')).to_be_visible()
        assert frame.locator('body').evaluate('(e) => e.scrollWidth <= innerWidth'), 'mobile overflow'
        page.evaluate("document.documentElement.dataset.theme = 'dark'")
        expect(frame.locator('html')).to_have_attribute('data-theme', 'dark')
        assert not errors, errors
        browser.close()
    assert hashlib.sha256(config.read_bytes()).hexdigest() == config_before
    assert hashlib.sha256(provider_file.read_bytes()).hexdigest() == provider_before
    print('PASS narrow layout, host theme, unchanged Codex endpoint and provider configuration')
    print(json.dumps({'passed': True, 'realSupplierCalls': 0, 'mockCalls': len(seen), 'scratch': str(scratch)}))
finally:
    if proc is not None:
        proc.terminate()
        proc.wait(timeout=10)
    log.close()
    mock.shutdown()
    mock.server_close()

"""Real Magpie + browser integration, disposable profile and loopback upstream.
No installed configuration is used or changed; never calls a real supplier.
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
import urllib.error
from playwright.sync_api import sync_playwright, expect

parser = argparse.ArgumentParser()
parser.add_argument('--binary', required=True)
parser.add_argument('--bun', help='Reuse an existing Magpie Bun, avoiding a download in the disposable profile')
parser.add_argument('--screenshot-dir')
parser.add_argument('--package-dir', help='Test an unpacked public archive instead of the source checkout')
args = parser.parse_args()
root = Path(args.package_dir).resolve() if args.package_dir else Path(__file__).resolve().parent.parent
scratch = Path(tempfile.mkdtemp(prefix='magpie-workbench-smoke-')).resolve()
app = scratch / 'app'
app.mkdir()
binary = app / 'magpie.exe'
shutil.copy2(Path(args.binary).resolve(), binary)
(app / '.portable').write_text('')
data = app / 'data'
data.mkdir()
profile = scratch / 'profile'
profile.mkdir()
config = profile / '.codex/config.toml'
config.parent.mkdir()
config.write_text('model="demo/gpt-6-astra"\n[model_providers.magpie]\nbase_url="http://127.0.0.1:3425/v1"\n')
config_hash = hashlib.sha256(config.read_bytes()).hexdigest()
workbench = scratch / 'workbench'
workbench.mkdir()
for name in ['package.json', 'workbench.middleware.js', 'history', 'plugin', 'server', 'vendor', 'web']:
    source = root / name
    if source.is_dir():
        shutil.copytree(source, workbench / name)
    else:
        shutil.copy2(source, workbench / name)
history_root = root / 'history'
history_hash = hashlib.sha256((history_root / 'codex-history.middleware.js').read_bytes()).hexdigest()
bank = json.loads((root / 'vendor/modeltrace/unified_bank.json').read_text(encoding='utf-8'))
luna = next(m for m in bank['models'] if m['id'] == 'gpt-6-luna')
seen = []
probe_index = 0
summary_instructions = 'Summarize the recorded conversation; local compaction fixture only.'


def numbers(index):
    total = sum(luna['counts'])
    values = []
    for position in range(300):
        q = (position + (index % 3 + 1) / 7) / 300 * total
        for bin_index, count in enumerate(luna['counts']):
            q -= count
            if q < 0:
                values.append(bin_index + 1)
                break
    offset = (index // 3) % len(values)
    return ','.join(map(str, values[offset:] + values[:offset]))


class Mock(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        global probe_index
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        seen.append(body)
        if body.get('instructions') == summary_instructions:
            items = body.get('input', [])
            native = any(item.get('type') == 'web_search_call' for item in items)
            foreign = any(item.get('id') or item.get('encrypted_content') for item in items)
            if native or foreign:
                reply = json.dumps({'error': 'web_search_call is missing required reasoning' if native
                    else 'The requested item was created under a different Azure OpenAI resource.'}).encode()
                self.send_response(400)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(reply)))
                self.end_headers()
                self.wfile.write(reply)
                return
        content = json.dumps(body.get('input', []), ensure_ascii=False)
        is_probe = '整数' in content
        answer = numbers(probe_index) if is_probe else 'local mock only'
        if is_probe:
            probe_index += 1
        reply = json.dumps({'id': 'resp_mock', 'object': 'response', 'status': 'completed',
            'model': 'gpt-6-astra', 'output': [{'type': 'message', 'role': 'assistant',
            'content': [{'type': 'output_text', 'text': answer}]}],
            'usage': {'input_tokens': 100, 'output_tokens': 600, 'total_tokens': 700}}).encode()
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
port, web_port = free_port(), free_port()
origin, web = f'http://127.0.0.1:{port}', f'http://127.0.0.1:{web_port}'
(data / 'settings.json').write_text(json.dumps({'port': port, 'lang': 'zh', 'updateEvery': 1440,
                                               'noUsageStats': True, 'autoRestart': False}))
(data / 'plugins.yml').write_text('preset: all\n')
providers = {'providers': [{'id': pid, 'name': name, 'key': 'LOCAL_ONLY',
    'responses': f'http://127.0.0.1:{mock.server_port}/v1', 'models': ['gpt-6-astra']}
    for pid, name in [('demo', '演示供应商'), ('backup', '备用供应商')]]}
(data / 'providers.json').write_text(json.dumps(providers))
history_options = {'providers': {'magpie:demo': {'historyFilter': True, 'preserveEncryptedInclude': True}}, 'aliases': {}}
plugins = {'plugins': [{'spec': str(workbench), 'options': {**history_options, 'magpieDirectory': str(data), 'keepExtra': 'unchanged'}}]}
(data / 'plugins.json').write_text(json.dumps(plugins))
env = {k: v for k, v in os.environ.items() if k.upper() in
       ('SYSTEMROOT', 'WINDIR', 'PATH', 'TEMP', 'TMP', 'PATHEXT', 'COMSPEC')}
env.update({'USERPROFILE': str(profile), 'XDG_CONFIG_HOME': str(scratch / 'config'),
            'XDG_CACHE_HOME': str(scratch / 'cache'), 'MAGPIE_ADDR': f'127.0.0.1:{port}',
            'MAGPIE_WEB_KEY': 'workbench-real-smoke-only', 'MAGPIE_PLUGIN_MARKET': 'off'})
if args.bun:
    env['MAGPIE_BUN'] = str(Path(args.bun).resolve())
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
log = (scratch / 'magpie.log').open('wb')
proc = None


def get(url):
    with opener.open(url, timeout=5) as response:
        return json.load(response)


def send(url, body):
    req = urllib.request.Request(url, data=json.dumps(body).encode(),
                                 headers={'Content-Type': 'application/json', 'User-Agent': 'codex_cli_rs/0.100.0'})
    try:
        response = opener.open(req, timeout=15)
    except urllib.error.HTTPError as e:
        response = e
    with response:
        return response.status, response.read().decode()


def business(pid='demo'):
    body = {'model': pid + '/gpt-6-astra', 'stream': False, 'include': ['reasoning.encrypted_content'],
            'input': [{'type': 'reasoning', 'encrypted_content': 'old-cipher'},
                      {'type': 'message', 'id': 'msg_old', 'role': 'user', 'content': 'Mock only'}]}
    return send(origin + '/v1/responses', body)


def text_compaction():
    return {'model': 'demo/gpt-6-astra', 'stream': False, 'instructions': summary_instructions,
        'reasoning': {'effort': 'xhigh'}, 'include': ['reasoning.encrypted_content'], 'input': [
            {'type': 'reasoning', 'id': 'rs_foreign', 'encrypted_content': 'old-cipher'},
            {'type': 'web_search_call', 'id': 'ws_foreign', 'status': 'completed',
             'action': {'type': 'search', 'query': 'saved query', 'queries': ['saved query', 'second query']},
             'internal_chat_message_metadata_passthrough': {'turn_id': 'private-turn'}},
            {'type': 'message', 'role': 'assistant', 'content': 'Saved finding: https://example.invalid/rules'},
            {'type': 'function_call', 'id': 'fc_foreign', 'call_id': 'paired', 'name': 'read_file', 'arguments': '{}'},
            {'type': 'function_call_output', 'id': 'out_foreign', 'call_id': 'paired', 'output': 'saved file'},
            {'role': 'user', 'content': 'Produce a text summary, without new searches.'}]}


def expect_portable_summary():
    request = text_compaction()
    status, body = send(origin + '/v1/responses', request)
    assert status == 200, (status, body)
    forwarded = seen[-1]
    assert forwarded['instructions'] == summary_instructions
    assert forwarded['reasoning'] == request['reasoning']
    assert forwarded['include'] == request['include']
    record = forwarded['input'][0]
    assert record['type'] == 'message' and record['role'] == 'assistant'
    assert json.loads(record['content'].split('\n', 1)[1]) == {
        'status': 'completed', 'action': request['input'][1]['action']}
    assert forwarded['input'][1] == request['input'][2]
    assert forwarded['input'][2]['call_id'] == forwarded['input'][3]['call_id'] == 'paired'
    assert forwarded['input'][3]['output'] == 'saved file'
    assert all(item.get('type') not in ('reasoning', 'web_search_call') for item in forwarded['input'])
    assert 'private-turn' not in json.dumps(forwarded)


def expect_reloaded_filter(items):
    # The Bun console can be ready before the gateway publishes its new hook.
    # Poll only mock business requests; a permanently stale hook still fails.
    last = None
    for _ in range(40):
        before = len(seen)
        status, response = business()
        count = len(seen[-1]['input']) if len(seen) > before else None
        if status == 200 and count == items:
            return
        last = (status, count, response)
        time.sleep(.2)
    raise AssertionError(('reloaded filter did not apply', items, last))


try:
    proc = subprocess.Popen([str(binary), 'serve', f'--web=127.0.0.1:{web_port}'], cwd=app, env=env,
        stdout=log, stderr=log, creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
    runtime_path = profile / '.config/magpie-model-workbench/runtime.json'
    for _ in range(300):
        if runtime_path.exists():
            break
        try:
            get(origin + '/v1/models')
        except Exception:
            pass
        if proc.poll() is not None:
            raise RuntimeError('Magpie exited: ' + str(scratch))
        time.sleep(.2)
    else:
        raise RuntimeError('Workbench did not load: ' + str(scratch))
    runtime = json.loads(runtime_path.read_text())
    request = urllib.request.Request(runtime['origin'] + '/api/open', data=b'{}',
        headers={'Authorization': 'Bearer ' + runtime['control']})
    with opener.open(request) as response:
        link = json.load(response)['url']
    time.sleep(1.2)
    assert len(seen) == 0, 'plugin load must not probe models'
    status, _ = business()
    assert status == 200
    assert len(seen[-1]['input']) == 1 and 'id' not in seen[-1]['input'][0]
    assert seen[-1]['include'] == ['reasoning.encrypted_content']
    print('PASS real host loads one unified plugin; existing filtering works; startup sends no probes', flush=True)
    # Reproduce both failures directly against the loopback upstream. Neither
    # a native call nor its foreign resource IDs should reach it after filtering.
    bad = text_compaction()
    assert send(f'http://127.0.0.1:{mock.server_port}/v1/responses', bad)[0] == 400
    without_reasoning = {**bad, 'input': [i for i in bad['input'] if i.get('type') != 'reasoning']}
    assert send(f'http://127.0.0.1:{mock.server_port}/v1/responses', without_reasoning)[0] == 400
    foreign = {**bad, 'input': [bad['input'][0]]}
    status, response = send(f'http://127.0.0.1:{mock.server_port}/v1/responses', foreign)
    assert status == 400 and 'different Azure' in response
    expect_portable_summary()
    probe_start = len(seen)
    print('PASS text summarization removes native-search reasoning dependencies and Azure resource IDs', flush=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, **({'executable_path': os.environ['CHROME_PATH']} if os.environ.get('CHROME_PATH') else {}))
        page = browser.new_page(viewport={'width': 1440, 'height': 1000})
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto(link)
        expect(page.locator('#currentModel')).to_have_text('demo/gpt-6-astra')
        expect(page.locator('#currentModelSource')).to_contain_text('最近实际路由')
        expect(page.locator('#targetEmpty')).to_be_hidden()
        assert probe_index == 0
        assert page.locator('#targetDialog').evaluate('(e) => e.tagName') == 'SECTION'
        assert '#open=' not in page.url
        page.locator('#add').click()
        page.locator('#model').select_option('demo/gpt-6-astra')
        page.locator('#expected').select_option('gpt-6-astra')
        page.locator('#effort').select_option('low')
        page.locator('#targetForm [name=mode][value=protect]').check()
        page.locator('#targetForm [type=submit]').click()
        expect(page.locator('#confirmDialog')).to_be_visible()
        page.locator('#confirmDialog button[value=ok]').click()
        expect(page.locator('#targetDialog')).not_to_be_visible()
        assert probe_index == 0, 'saving a target must not probe immediately'
        page.locator('#currentCheck').click()
        page.locator('#confirmDialog button[value=ok]').click()
        expect(page.locator('#targetList')).to_contain_text('重复检测支持偏离', timeout=30000)
        expect(page.locator('#targetList')).to_contain_text('后续请求已暂停')
        assert probe_index == 6, probe_index
        for request_body in seen[probe_start:]:
            assert not request_body['model'].startswith('workbench-probe/'), 'internal alias leaked upstream'
            assert len(request_body['input']) == 1
            assert request_body['reasoning']['effort'] == 'low'
        time.sleep(1.2)
        before = len(seen)
        status, body = business()
        assert status == 409 and 'MODEL_WORKBENCH_PAUSED' in body, (status, body)
        assert len(seen) == before
        status, body = business('backup')
        assert status == 200, (status, body)
        assert len(seen[-1]['input']) == 2, 'backup should retain its default passthrough rule'
        print('PASS six independent probes confirm fixture deviation; only selected model is paused', flush=True)
        if args.screenshot_dir:
            dest = Path(args.screenshot_dir).resolve()
            dest.mkdir(parents=True, exist_ok=True)
            page.screenshot(path=str(dest / 'workbench-light.png'), full_page=True)
            page.locator('#themeToggle').click()
            page.screenshot(path=str(dest / 'workbench-dark.png'), full_page=True)
            page.locator('#themeToggle').click()
        page.get_by_role('button', name='详情', exact=True).click()
        expect(page.locator('#detailBody')).to_contain_text('第 2 轮')
        page.locator('#detailBody details').first.click()
        expect(page.locator('#detailBody pre').first).to_be_visible()
        page.locator('#detailClose').click()
        page.locator('[data-view=history]').click()
        expect(page.locator('#historyRows tr')).to_have_count(1)
        page.locator('[data-view=settings]').click()
        page.locator('#gatewayUrl').fill(origin + '/')
        page.wait_for_timeout(3400)
        expect(page.locator('#gatewayUrl')).to_have_value(origin + '/')
        page.locator('#testConnection').click()
        expect(page.locator('#toast')).to_contain_text('网关已连接')
        with page.expect_download() as download:
            page.locator('#diagnose').click()
        report_path = scratch / 'report.json'
        download.value.save_as(report_path)
        report = report_path.read_text()
        assert 'demo/' not in report and 'LOCAL_ONLY' not in report and 'control' not in report
        page.locator('[data-view=targets]').click()
        page.get_by_role('button', name='解除暂停', exact=True).click()
        page.locator('#confirmDialog button[value=ok]').click()
        expect(page.locator('#targetList')).not_to_contain_text('后续请求已暂停')
        time.sleep(1.2)
        assert business()[0] == 200
        assert len(seen[-1]['input']) == 1, 'resuming guard must preserve history filtering'
        gate_before = (workbench / 'workbench.middleware.js').read_bytes()
        state_before = (profile / '.config/magpie-model-workbench/state.json').read_bytes()
        listed = subprocess.run([str(binary), 'plugin', 'list', '--json'], cwd=app, env=env,
            capture_output=True, timeout=30, creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        assert listed.returncode == 0
        assert (workbench / 'workbench.middleware.js').read_bytes() == gate_before, 'CLI rewrote live probe gate'
        assert (profile / '.config/magpie-model-workbench/state.json').read_bytes() == state_before, 'CLI changed live state'
        print('PASS separate CLI inspection cannot overwrite live probe credentials or history', flush=True)
        # Unified console saves the SAME Options used by the native page.
        page.locator('[data-view=filters]').click()
        demo_filter = page.locator('#filterRows input[data-id=demo][data-field=historyFilter]')
        expect(demo_filter).to_be_checked()
        original_runtime = json.loads(runtime_path.read_text())
        demo_filter.uncheck()
        page.locator('#filterSave').click()
        expect(page.locator('#toast')).to_contain_text('过滤规则已保存')
        for _ in range(120):
            try:
                current_runtime = json.loads(runtime_path.read_text())
                if current_runtime['pid'] != original_runtime['pid'] and get(current_runtime['origin'] + '/health'):
                    break
            except Exception:
                pass
            time.sleep(.2)
        else:
            raise RuntimeError('Host did not reload after filter save: ' + str(scratch))
        assert current_runtime['origin'] == original_runtime['origin'], 'console address changed on options reload'
        page.locator('#filterRefresh').click()
        expect(demo_filter).not_to_be_checked()
        expect_reloaded_filter(2)
        # Restore filtering through the native Magpie page, then read it back
        # from the existing console session without another sign-in.
        native = browser.new_page(viewport={'width':1200, 'height':900}, locale='zh-CN')
        native.route('**/api/whatsnew*', lambda r: r.fulfill(content_type='application/json', body='{"show":false,"releases":[]}'))
        native.goto(web + '/?k=workbench-real-smoke-only')
        native.locator('button[data-plugin-page]').filter(has_text='Codex Workbench').click()
        frame = native.frame_locator('iframe.plugin-frame')
        frame.locator('input[data-id=demo][data-field=historyFilter]').check()
        frame.locator('#save').click()
        expect(frame.locator('#notice')).to_have_attribute('data-kind', 'success')
        expect_reloaded_filter(1)
        page.locator('#filterRefresh').click()
        expect(demo_filter).to_be_checked()
        assert probe_index == 6, 'filter settings generated unexpected paid probes'
        saved_options = json.loads((data / 'plugins.json').read_text())['plugins'][0]['options']
        assert saved_options['keepExtra'] == 'unchanged'
        assert saved_options['providers'] == history_options['providers']
        expect_portable_summary()
        if args.screenshot_dir:
            page.screenshot(path=str(dest / 'workbench-filters.png'), full_page=True)
        print('PASS console/native settings share rules; host reload retains console URL/session and history', flush=True)
        native.close()
        page.set_viewport_size({'width': 430, 'height': 900})
        assert page.locator('body').evaluate('(e) => e.scrollWidth <= innerWidth'), 'mobile overflow'
        if args.screenshot_dir:
            page.screenshot(path=str(dest / 'workbench-mobile.png'), full_page=True)
        assert not errors, errors
        browser.close()
    # A local source hotfix can refresh the Bun generator without editing any
    # saved options: Magpie notices the plugin list's timestamp independently.
    plugin_list = data / 'plugins.json'
    list_before = plugin_list.read_bytes()
    runtime_before = json.loads(runtime_path.read_text())
    os.utime(plugin_list, None)
    get(origin + '/v1/models')
    for _ in range(120):
        try:
            fresh = json.loads(runtime_path.read_text())
            if fresh['pid'] != runtime_before['pid'] and get(fresh['origin'] + '/health'):
                break
        except Exception:
            pass
        time.sleep(.2)
    else:
        raise RuntimeError('Host did not refresh after timestamp change: ' + str(scratch))
    assert plugin_list.read_bytes() == list_before
    expect_portable_summary()
    assert probe_index == 6
    print('PASS timestamp-only refresh loads the generator without changing options or starting probes', flush=True)
    # Simulate a broken optional console/detector import in a NEW host. The
    # already-built import-free request middleware must keep filtering.
    (workbench / 'server/http.mjs').write_text('throw new Error("mock detector startup failure");\n')
    reload_config = json.loads((data / 'plugins.json').read_text())
    reload_config['plugins'][0]['options']['restartFixture'] = True
    (data / 'plugins.json').write_text(json.dumps(reload_config))
    get(origin + '/v1/models')
    assert business()[0] == 200 and len(seen[-1]['input']) == 1
    expect_portable_summary()
    assert probe_index == 6
    print('PASS detector/console startup failure leaves history middleware operational', flush=True)
    assert config_hash == hashlib.sha256(config.read_bytes()).hexdigest()
    assert history_hash == hashlib.sha256((history_root / 'codex-history.middleware.js').read_bytes()).hexdigest()
    saved = json.loads((data / 'plugins.json').read_text())
    assert len(saved['plugins']) == 1
    assert saved['plugins'][0]['options']['providers'] == history_options['providers']
    print('PASS UI details, privacy export, narrow layout and resume preserve original filter/config', flush=True)
    print(json.dumps({'passed': True, 'realSupplierCalls': 0, 'probeRequests': probe_index, 'scratch': str(scratch)}), flush=True)
finally:
    if proc is not None:
        proc.terminate()
        proc.wait(timeout=10)
    log.close()
    mock.shutdown()
    mock.server_close()

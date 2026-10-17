"""Generate documentation screenshots using synthetic providers, never live state."""
from pathlib import Path
from copy import deepcopy
from datetime import datetime, timezone, timedelta
import argparse
import json
import os
import re
import subprocess
from playwright.sync_api import sync_playwright, expect

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--settings-only', action='store_true', help='Generate only the compatibility settings screenshot')
parser.add_argument('--theme', choices=['light', 'dark'], default='light', help='Appearance used for screenshots')
parser.add_argument('--output', type=Path, help='Optional directory for review screenshots')
args = parser.parse_args()

root = Path(__file__).resolve().parent.parent
output = args.output or root / 'docs/images'
output.mkdir(parents=True, exist_ok=True)
html = (root / 'web' / 'dashboard.html').read_text(encoding='utf-8').replace('__FILTER_TOKEN_JSON__', '"demo-only"')
version = int(re.search(r'FILTER_VERSION\s*=\s*(\d+)', (root / 'src' / 'proxy.cjs').read_text(encoding='utf-8')).group(1))
fixture_evidence = json.loads(subprocess.check_output(['node', 'tests/fixtures/guard-fixtures.cjs'], cwd=root, text=True))
off = {'historyFilter': False, 'preserveEncryptedInclude': True, 'stripResponsesLiteHeader': False}
providers = [
    {'id': 'demo-main', 'name': '演示供应商 · 日常开发', 'endpoint': 'https://api.example.com/v1', 'current': True, 'editable': True, 'source': 'custom', 'rule': {**off, 'historyFilter': True}},
    {'id': 'demo-backup', 'name': '备用供应商', 'endpoint': 'https://backup.example.com/v1', 'current': False, 'editable': True, 'source': 'custom', 'rule': {**off, 'historyFilter': True}},
    {'id': 'demo-team', 'name': '团队网关', 'endpoint': 'https://team.example.com/v1', 'current': False, 'editable': True, 'source': 'default', 'rule': off},
    {'id': 'demo-local', 'name': '本地测试端点', 'endpoint': 'http://127.0.0.1:19000/v1', 'current': False, 'editable': True, 'source': 'default', 'rule': off},
]
now = datetime(2026, 10, 16, 12, 0, tzinfo=timezone.utc)
record = {'key': 'demo-key', 'providerId': 'demo-main', 'providerName': providers[0]['name'], 'model': 'gpt-6-astra', 'effort': 'high', 'status': 'passed', 'reason': '演示数据：行为指纹与请求模型相符；不代表质量保证。', 'checkedAt': now.isoformat(), 'expiresAt': (now + timedelta(minutes=30)).isoformat(), 'prediction': 'gpt-6-astra', 'score': .936, 'rounds': 1, 'cacheValid': True, 'sampleEvidence': [fixture_evidence['pass']]}
history = [{**record, 'id': f'demo-history-{i}', 'source': 'manual' if i == 0 else 'automatic', 'checkedAt': (now - timedelta(minutes=30*i)).isoformat()} for i in range(24)]
history[1].update(status='unverified', prediction='gpt-6-luna', score=.999, sampleEvidence=[fixture_evidence['different']], reason='演示数据：已完成轮次有明显模型差异，复核未完成；没有新增持久锁定。')
history[2].update(status='unverified', score=None, prediction=None, sampleEvidence=[], reason='检测上游返回 HTTP 403：上游拒绝访问。演示数据，这不是降智结论。')
state = {'providers': providers, 'revision': 'demo-revision', 'productVersion': '1.0.8', 'currentPolicy': {'filter': True}, 'autoFailover': False,
    'aliasCompatibility': {'configured': False, 'enabled': False, 'activeCount': 0},
    'filter': {'filterVersion': version, 'state': 'filtering', 'stats': {'filteredRequests': 128, 'removedEncryptedContentItems': 436}},
    'guard': {'models': ['gpt-6-astra', 'gpt-6-sol'], 'providers': {'demo-main': {'enabled': True, 'ttlSeconds': 1800}}, 'settingsRevision': 'demo-guard', 'records': [record], 'history': history, 'historyLimit': 100, 'current': {'providerId': 'demo-main', 'model': record['model'], 'effort': record['effort'], 'available': True, 'key': record['key']}}}
configured_state = deepcopy(state)
for snapshot in [state, configured_state]:
    snapshot['guard'].update(failureCooldownSeconds=60,
        configured={'model': record['model'], 'effort': record['effort']},
        recentModels=[{'key': record['key'], 'model': record['model'], 'effort': record['effort'], 'observedAt': now.isoformat()}],
        currentRecords=[deepcopy(record)])
    snapshot['guard']['current'].update(modelSource='request', modelObservedAt=now.isoformat(), routeRevision='demo-route')
for provider in state['providers']:
    provider['rule'] = deepcopy(off)
    provider['source'] = 'default'
state['providers'][0]['rule'] = {**off, 'historyFilter': True}
state['providers'][0]['source'] = 'custom'
state['providers'][2]['rule'] = {**off, 'historyFilter': True}
state['providers'][2]['source'] = 'custom'
state['filter']['stats'] = {'filteredRequests': 0, 'removedEncryptedContentItems': 0}
state['guard'].update(providers={}, records=[], currentRecords=[], history=[])
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, **({'executable_path': os.environ['CHROME_PATH']} if os.environ.get('CHROME_PATH') else {}))
    page = browser.new_page(viewport={'width': 1440, 'height': 1180}, timezone_id='Asia/Shanghai', device_scale_factor=1)
    page.add_init_script("localStorage.setItem('codex-workbench-theme', " + json.dumps(args.theme) + ");")
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    def route_request(route):
        request = route.request
        if request.method != 'GET':
            raise AssertionError('Screenshot generator cannot change settings or run probes')
        if request.url.endswith('/ui'):
            route.fulfill(content_type='text/html; charset=utf-8', body=html)
        elif request.url.endswith('/favicon.svg'):
            route.fulfill(content_type='image/svg+xml', body=(root / 'web/assets/favicon.svg').read_text(encoding='utf-8'))
        elif request.url.endswith('/api/state'):
            route.fulfill(content_type='application/json', body=json.dumps(state, ensure_ascii=False))
        elif request.url.endswith(('/workbench-theme.css', '/current-selection.js')):
            asset = root / 'web/assets' / request.url.rsplit('/', 1)[-1]
            route.fulfill(content_type='text/css' if asset.suffix == '.css' else 'text/javascript', body=asset.read_bytes())
        else:
            route.abort()
    page.route('**/*', route_request)
    page.goto('http://127.0.0.1:19999/__codex_filter__/ui')
    expect(page.locator('#current')).to_have_text(providers[0]['name'])
    expect(page.locator('.side-links a')).to_have_count(2)
    screenshots = []
    for view in ([] if args.settings_only else ['providers', 'protection', 'history', 'settings']):
        if view == 'protection':
            state = configured_state
            page.locator('#refresh').click()
            expect(page.locator('#guardEnabled')).to_have_attribute('aria-checked', 'true')
        elif view == 'providers':
            expect(page.locator('#currentHistoryEnabled')).to_have_attribute('aria-checked', 'true')
            expect(page.locator('#guardEnabled')).to_have_attribute('aria-checked', 'false')
        page.locator('[data-view="' + view + '"]').click()
        expect(page.locator('#refresh')).to_have_attribute('aria-busy', 'false')
        page.locator('#toast').evaluate('(element) => { element.hidden = true; }')
        page.evaluate('window.scrollTo(0,0)')
        page.screenshot(path=str(output / (view + '.png')), animations='disabled')
        screenshots.append(view + '.png')
        if view == 'protection':
            page.locator('#guardAdjust').click()
            expect(page.locator('#guardSelectionEditor')).to_have_js_property('open', True)
            page.screenshot(path=str(output / 'monitor-settings.png'), animations='disabled', full_page=True)
            screenshots.append('monitor-settings.png')
            page.locator('#guardAdjust').click()
    state = deepcopy(configured_state)
    state['guard'].update(providers={}, records=[], currentRecords=[], history=[])
    settings_page = browser.new_page(viewport={'width': 1200, 'height': 1400}, timezone_id='Asia/Shanghai', device_scale_factor=2)
    settings_page.add_init_script("localStorage.setItem('codex-workbench-theme', " + json.dumps(args.theme) + ");")
    settings_page.on('pageerror', lambda error: errors.append(str(error)))
    settings_page.route('**/*', route_request)
    settings_page.goto('http://127.0.0.1:19999/__codex_filter__/ui')
    expect(settings_page.locator('#guardEnabled')).to_have_attribute('aria-checked', 'false')
    settings_page.locator('#providers tr').first.get_by_role('button', name='配置', exact=True).click()
    expect(settings_page.locator('#drawer')).to_be_visible()
    expect(settings_page.locator('#historyFilter')).to_be_checked()
    expect(settings_page.locator('#preserveEncryptedInclude')).to_be_checked()
    expect(settings_page.locator('#stripResponsesLiteHeader')).not_to_be_checked()
    panel = settings_page.locator('.drawer-panel').bounding_box()
    settings_page.screenshot(path=str(output / 'provider-settings.png'), clip=panel)
    screenshots.append('provider-settings.png')
    assert not errors, errors
    browser.close()
print(json.dumps({'screenshots': screenshots, 'theme': args.theme, 'data': 'synthetic', 'modelRequests': 0}))

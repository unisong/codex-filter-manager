"""Generate documentation screenshots using synthetic providers, never live state."""
from pathlib import Path
from copy import deepcopy
from datetime import datetime, timezone, timedelta
import json
import os
import re
from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parent.parent
output = root / 'docs/images'
output.mkdir(parents=True, exist_ok=True)
html = (root / 'dashboard.html').read_text(encoding='utf-8').replace('__FILTER_TOKEN_JSON__', '"demo-only"')
version = int(re.search(r'FILTER_VERSION\s*=\s*(\d+)', (root / 'proxy.cjs').read_text(encoding='utf-8')).group(1))
off = {'historyFilter': False, 'preserveEncryptedInclude': True, 'stripResponsesLiteHeader': False}
providers = [
    {'id': 'demo-main', 'name': '演示供应商 · 日常开发', 'endpoint': 'https://api.example.com/v1', 'current': True, 'editable': True, 'source': 'custom', 'rule': {**off, 'historyFilter': True}},
    {'id': 'demo-backup', 'name': '备用供应商', 'endpoint': 'https://backup.example.com/v1', 'current': False, 'editable': True, 'source': 'custom', 'rule': {**off, 'historyFilter': True}},
    {'id': 'demo-team', 'name': '团队网关', 'endpoint': 'https://team.example.com/v1', 'current': False, 'editable': True, 'source': 'default', 'rule': off},
    {'id': 'demo-local', 'name': '本地测试端点', 'endpoint': 'http://127.0.0.1:19000/v1', 'current': False, 'editable': True, 'source': 'default', 'rule': off},
]
now = datetime(2026, 10, 12, 6, 0, tzinfo=timezone.utc)
record = {'key': 'demo-key', 'providerId': 'demo-main', 'providerName': providers[0]['name'], 'model': 'gpt-6-astra', 'effort': 'high', 'status': 'passed', 'reason': '演示数据：行为指纹与请求模型相符；不代表质量保证。', 'checkedAt': now.isoformat(), 'expiresAt': (now + timedelta(minutes=30)).isoformat(), 'prediction': 'gpt-6-astra', 'score': .936, 'rounds': 1, 'cacheValid': True}
history = [{**record, 'id': f'demo-history-{i}', 'source': 'manual' if i == 0 else 'automatic', 'checkedAt': (now - timedelta(minutes=30*i)).isoformat()} for i in range(24)]
history[2].update(status='unverified', score=None, prediction=None, reason='演示数据：检测超时，受保护请求未放行。这不是确认降智。')
state = {'providers': providers, 'revision': 'demo-revision', 'currentPolicy': {'filter': True}, 'autoFailover': False,
    'aliasCompatibility': {'configured': False, 'enabled': False, 'activeCount': 0},
    'filter': {'filterVersion': version, 'state': 'filtering', 'stats': {'filteredRequests': 128, 'removedEncryptedContentItems': 436}},
    'guard': {'models': ['gpt-6-astra', 'gpt-6-sol'], 'providers': {'demo-main': {'enabled': True, 'ttlSeconds': 1800}}, 'settingsRevision': 'demo-guard', 'records': [record], 'history': history, 'historyLimit': 100, 'current': {'providerId': 'demo-main', 'model': record['model'], 'effort': record['effort'], 'available': True, 'key': record['key']}}}
configured_state = deepcopy(state)
for provider in state['providers']:
    provider.update(source='default', rule=deepcopy(off))
state['currentPolicy'] = {'filter': False}
state['filter']['stats'] = {'filteredRequests': 0, 'removedEncryptedContentItems': 0}
state['guard'].update(providers={}, records=[], history=[])
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, **({'executable_path': os.environ['CHROME_PATH']} if os.environ.get('CHROME_PATH') else {}))
    page = browser.new_page(viewport={'width': 1440, 'height': 1180}, timezone_id='Asia/Shanghai', device_scale_factor=1)
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    def route_request(route):
        request = route.request
        if request.method != 'GET':
            raise AssertionError('Screenshot generator cannot change settings or run probes')
        if request.url.endswith('/ui'):
            route.fulfill(content_type='text/html; charset=utf-8', body=html)
        elif request.url.endswith('/favicon.svg'):
            route.fulfill(content_type='image/svg+xml', body=(root / 'assets/favicon.svg').read_text(encoding='utf-8'))
        elif request.url.endswith('/api/state'):
            route.fulfill(content_type='application/json', body=json.dumps(state, ensure_ascii=False))
        else:
            route.abort()
    page.route('**/*', route_request)
    page.goto('http://127.0.0.1:19999/__codex_filter__/ui')
    expect(page.locator('#current')).to_have_text(providers[0]['name'])
    expect(page.locator('a.github-link')).to_have_count(2)
    for view in ['providers', 'protection', 'history']:
        if view == 'protection':
            state = configured_state
            page.locator('#refresh').click()
            expect(page.locator('#guardEnabled')).to_have_attribute('aria-checked', 'true')
        elif view == 'providers':
            expect(page.locator('#currentHistoryEnabled')).to_have_attribute('aria-checked', 'false')
            expect(page.locator('#guardEnabled')).to_have_attribute('aria-checked', 'false')
        page.locator('[data-view="' + view + '"]').click()
        page.evaluate('window.scrollTo(0,0)')
        page.screenshot(path=str(output / (view + '.png')))
    assert not errors, errors
    browser.close()
print(json.dumps({'screenshots': ['providers.png', 'protection.png', 'history.png'], 'data': 'synthetic', 'modelRequests': 0}))

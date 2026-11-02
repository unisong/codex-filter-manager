"""Render current Magpie documentation views with synthetic data and no live requests."""
from pathlib import Path
from urllib.parse import urlsplit
import argparse
import json
import os

from playwright.sync_api import expect, sync_playwright


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=Path, help='Override the documentation image directory')
args = parser.parse_args()
root = Path(__file__).resolve().parent.parent
plugin = root / 'magpie-workbench'
output = args.output or root / 'docs/images'
output.mkdir(parents=True, exist_ok=True)
version = json.loads((plugin / 'package.json').read_text(encoding='utf-8'))['version']
now = 1793498400000
providers = [
    {'id': 'demo-main', 'name': '演示供应商 · 日常开发'},
    {'id': 'demo-backup', 'name': '演示供应商 · 备用线路'},
    {'id': 'demo-schema', 'name': '演示供应商 · 协议兼容'},
    {'id': 'demo-local', 'name': '演示供应商 · 本机测试'},
]
options = {'providers': {
    'magpie:demo-main': {'historyFilter': True, 'preserveEncryptedInclude': True},
    'magpie:demo-backup': {'historyFilter': True, 'preserveEncryptedInclude': True},
    'magpie:demo-schema': {'historyFilter': False, 'deepSeekObjectRoot': True},
}, 'aliases': {}}
target = {
    'id': 'demo-observe', 'model': 'demo-main/gpt-6-astra', 'expected': 'gpt-6-astra',
    'effort': 'high', 'mode': 'observe', 'intervalMinutes': 30,
    'scheduleEnabled': True, 'nextAt': now + 20 * 60000, 'lastChecked': now - 10 * 60000,
    'running': False, 'stopping': False, 'paused': False, 'lastResult': 'matched',
}


def record(number, status, reason, model=None, rounds=1):
    started = now - (10 + number * 30) * 60000
    return {
        'id': 'demo-record-' + str(number), 'targetId': target['id'],
        'model': model or target['model'], 'expected': target['expected'], 'effort': 'high',
        'startedAt': started, 'finishedAt': started + 45000, 'status': status,
        'reason': reason, 'rounds': [{'samples': [{} for _ in range(3)]} for _ in range(rounds)],
    }


history = [
    record(0, 'matched', '演示数据：三个样本与目标指纹相符；不代表模型身份或质量保证。'),
    record(1, 'matched', '演示数据：本轮样本与目标指纹相符。'),
    record(2, 'incomplete', '演示数据：网络连接中断，本轮未完成评分；这不是降智结论。'),
    record(3, 'suspect', '演示数据：样本间存在分歧，需要重新取样。', 'demo-backup/gpt-6-astra'),
    record(4, 'deviated', '演示数据：两轮独立取样重复支持偏离。', 'demo-backup/gpt-6-astra', 2),
    record(5, 'matched', '演示数据：本轮样本与目标指纹相符。'),
]
state = {
    'version': version, 'health': '', 'revision': 1, 'targets': [target], 'history': history,
    'currentModel': {'model': target['model'], 'source': 'request', 'effort': 'high',
                     'observedAt': '2026-11-01T02:00:00Z', 'requestedModel': 'group/demo-coding'},
    'candidates': ['gpt-6-astra', 'gpt-6-luna'], 'bankVersion': 'demo-reference',
    'daily': {'used': 21, 'limit': 60, 'day': '2026-11-01'},
    'connection': {'url': 'http://127.0.0.1:3425', 'hasKey': False},
}
updates = {
    'currentVersion': version, 'releases': [], 'phase': 'idle', 'canInstall': True,
    'checkedAt': None, 'error': None, 'installReason': '',
    'downloadDirectory': r'D:\CodexUpdates', 'defaultDownloadDirectory': r'D:\CodexUpdates',
    'downloadDirectoryCustom': False,
}
models = [target['model'], 'demo-backup/gpt-6-astra', 'demo-schema/deepseek-chat', 'demo-local/gpt-6-luna']
origin = 'http://127.0.0.1:19998'
errors, unexpected, screenshots = [], [], []
content_types = {'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml'}


def routes(native=False):
    def handle(route):
        request = route.request
        parts = urlsplit(request.url)
        if request.method != 'GET' or parts.netloc != '127.0.0.1:19998':
            unexpected.append(request.method + ' ' + request.url)
            return route.abort()
        path = parts.path
        payloads = {
            '/api/state': state,
            '/api/models': {'models': models},
            '/api/filter': {'providers': providers, 'options': options, 'enabled': True},
            '/api/updates': updates,
            '/fixture/providers': providers,
            '/fixture/options': options,
        }
        if path in payloads:
            return route.fulfill(json=payloads[path])
        if native and path == '/_magpie/bridge.js':
            return route.fulfill(content_type='text/javascript', body='/* Offline bridge supplied by the screenshot harness. */')
        if path == '/history-settings.js':
            asset = plugin / 'history/page/settings.js'
        else:
            base = plugin / ('history/page' if native else 'web')
            asset = base / ('index.html' if path == '/' else path.lstrip('/'))
        if asset.is_file() and asset.suffix in content_types:
            return route.fulfill(content_type=content_types[asset.suffix], body=asset.read_bytes())
        unexpected.append(request.method + ' ' + request.url)
        route.abort()
    return handle


def capture(page, filename, full_page=False):
    page.evaluate('window.scrollTo(0, 0)')
    page.screenshot(path=str(output / filename), animations='disabled', full_page=full_page)
    screenshots.append(filename)


with sync_playwright() as playwright:
    launch_options = {'executable_path': os.environ['CHROME_PATH']} if os.environ.get('CHROME_PATH') else {}
    browser = playwright.chromium.launch(headless=True, **launch_options)
    context = browser.new_context(viewport={'width': 1440, 'height': 1040},
                                  timezone_id='Asia/Shanghai', device_scale_factor=1,
                                  service_workers='block')
    context.add_init_script("localStorage.setItem('codex-workbench-theme', 'dark');")
    context.route('**/*', routes())
    page = context.new_page()
    page.clock.set_fixed_time(now)
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(origin)
    expect(page.locator('#filterRows > div')).to_have_count(4)
    expect(page.locator('#filterCount')).to_have_text('共 4 个供应商 · 已开启 2 个')
    expect(page.locator('#stopService')).to_be_visible()
    expect(page.locator('#filterSave')).to_be_disabled()
    expect(page.locator('html')).to_have_attribute('data-theme', 'dark')
    capture(page, 'magpie-filters.png')

    page.locator('#themeToggle').click()
    page.locator('[data-view="targets"]').click()
    expect(page.locator('#currentModel')).to_have_text(target['model'])
    expect(page.locator('#monitoringStatus')).to_have_text('定期检测已开启 · 1 个模型')
    expect(page.locator('#currentResult')).to_have_text('指纹与目标相符')
    expect(page.locator('#stopAllChecks')).to_be_enabled()
    capture(page, 'magpie-monitor.png')

    page.locator('#add').click()
    expect(page.locator('#targetDialog')).to_be_visible()
    expect(page.locator('#model')).to_have_value(target['model'])
    assert page.locator('#interval option').evaluate_all('xs => xs.map(x => x.value)') == ['5', '10', '20', '30', '60', 'custom']
    page.locator('#interval').select_option('custom')
    page.locator('#customInterval').fill('15')
    expect(page.locator('#customIntervalField')).to_be_visible()
    capture(page, 'magpie-monitor-settings.png', full_page=True)
    page.locator('#cancelTarget').click()

    page.locator('[data-view="history"]').click()
    expect(page.locator('#historyRows > tr')).to_have_count(6)
    capture(page, 'magpie-history.png')
    page.locator('[data-view="settings"]').click()
    expect(page.locator('#updateStatus')).to_have_text('当前 v' + version + ' · 尚未检查')
    capture(page, 'magpie-settings.png', full_page=True)
    for view in ('filters', 'targets', 'history', 'settings'):
        page.locator('[data-view="' + view + '"]').click()
        page.set_viewport_size({'width': 390, 'height': 844})
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), view
    context.close()

    native = browser.new_context(viewport={'width': 1440, 'height': 800},
                                 timezone_id='Asia/Shanghai', device_scale_factor=1,
                                 color_scheme='light', service_workers='block')
    native.add_init_script("""globalThis.magpie = {
        ready: Promise.resolve({lang: 'zh-CN'}), onTheme() {},
        read: () => fetch('/fixture/providers').then(r => r.json()),
        options: {
            get: () => fetch('/fixture/options').then(r => r.json()),
            set: () => { throw Error('Screenshots must not save settings'); }
        }
    };""")
    native.route('**/*', routes(native=True))
    page = native.new_page()
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(origin)
    expect(page.locator('#providers > div')).to_have_count(4)
    expect(page.locator('#count')).to_have_text('共 4 个供应商 · 已开启 2 个')
    expect(page.locator('#save')).to_be_disabled()
    capture(page, 'magpie-native-filters.png')
    page.set_viewport_size({'width': 390, 'height': 844})
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), 'native filters'
    assert not errors, errors
    assert not unexpected, unexpected
    browser.close()

print(json.dumps({'screenshots': screenshots, 'data': 'synthetic', 'modelRequests': 0,
                  'settingsWrites': 0, 'pageErrors': errors, 'narrowLayout': 'passed'}))

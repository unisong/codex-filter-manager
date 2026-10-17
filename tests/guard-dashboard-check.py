"""Offline UI contract checks. All API requests are intercepted; no supplier calls."""
from pathlib import Path
from copy import deepcopy
from datetime import datetime, timezone, timedelta
import json
import os
import hashlib
import re
import subprocess
import tempfile
from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parent.parent
(root / '.runtime').mkdir(exist_ok=True)
html = (root / "web" / "dashboard.html").read_text(encoding="utf-8")
filter_version = int(re.search(r"FILTER_VERSION\s*=\s*(\d+)", (root / "src" / "proxy.cjs").read_text(encoding="utf-8")).group(1))
rule = {"historyFilter": False, "preserveEncryptedInclude": True, "stripResponsesLiteHeader": False}
state = {
    "providers": [
        {"id": "gugu", "name": "演示供应商", "current": True, "endpoint": "https://gugu.example", "editable": True, "source": "default", "rule": deepcopy(rule)},
        {"id": "other/encoded", "name": "其他供应商", "current": False, "endpoint": "https://other.example", "editable": True, "source": "default", "rule": deepcopy(rule)},
        {"id": "unsafe", "name": "<img src=x onerror=alert(1)>", "current": False, "endpoint": "https://unsafe.example", "editable": True, "source": "default", "rule": deepcopy(rule)},
    ],
    "revision": "offline", "currentPolicy": {"filter": False}, "autoFailover": False,
    "aliasCompatibility": {"configured": False, "enabled": False, "activeCount": 0},
    "filter": {"filterVersion": filter_version, "state": "filtering", "stats": {}},
    "guard": {"models": ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna"], "providers": {}, "records": [], "settingsRevision": "revision-0", "history": [], "historyLimit": 100,
              "configured": {"model": "gpt-6-astra", "effort": "high"}, "failureCooldownSeconds": 60,
              "current": {"providerId": "gugu", "model": "gpt-6-astra", "effort": "high", "available": True, "key": "fixture-key", "modelSource": "config", "routeRevision": "route-0"}},
}
fixture_evidence = json.loads(subprocess.check_output(["node", "tests/fixtures/guard-fixtures.cjs"], cwd=root, text=True))
calls = []
server_token = "offline-ui-test"
ui_loads = 0
revision_counter = 0
fail_next_state = False
now = datetime.now(timezone.utc)
record = {"key": "fixture-key", "providerId": "gugu", "providerName": "演示供应商", "model": "gpt-6-astra", "effort": "high", "status": "checking", "reason": "正在采样", "checkedAt": now.isoformat(), "expiresAt": (now + timedelta(minutes=10)).isoformat(), "rounds": 0, "sampleEvidence": [deepcopy(fixture_evidence["pass"])]}

def select_view(page, view):
    page.locator("#view" + view.capitalize()).click()
    expect(page.locator("#" + view + "View")).to_be_visible()
    expect(page.locator("#view" + view.capitalize())).to_have_attribute("aria-selected", "true")

def route_request(route):
    global ui_loads, revision_counter, fail_next_state
    request = route.request
    path = request.url.split("/__codex_filter__", 1)[-1]
    if path == "/ui":
        ui_loads += 1
        route.fulfill(status=200, content_type="text/html; charset=utf-8", body=html.replace("__FILTER_TOKEN_JSON__", json.dumps(server_token)))
        return
    if path in ("/workbench-theme.css", "/current-selection.js", "/favicon.svg"):
        asset = root / "web" / "assets" / path[1:]
        route.fulfill(status=200, content_type={".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml"}[asset.suffix], body=asset.read_bytes())
        return
    if not path.startswith("/api/"):
        route.fulfill(status=404, body="")
        return
    payload = request.post_data_json if request.post_data else None
    calls.append((request.method, path, payload))
    if request.headers.get("x-filter-token") != server_token:
        route.fulfill(status=403, content_type="application/json", body=json.dumps({"error": {"code": "invalid_control_token", "message": "Invalid local control token."}}))
        return
    if request.method == "GET" and path == "/api/state" and fail_next_state:
        fail_next_state = False
        route.fulfill(status=503, content_type="application/json", body=json.dumps({"error": {"code": "fixture_state_unavailable", "message": "暂时无法读取状态。"}}))
        return
    if request.method == "PUT" and path.startswith("/api/guard/providers/"):
        from urllib.parse import unquote
        if payload.get("revision") != state["guard"]["settingsRevision"]:
            route.fulfill(status=409, content_type="application/json", body=json.dumps({"error": {"code": "guard_settings_changed", "message": "保护设置已在其他页面更新。"}}))
            return
        state["guard"]["providers"][unquote(path.split("/api/guard/providers/")[1])] = {key: payload[key] for key in ("enabled", "ttlSeconds")}
        revision_counter += 1
        state["guard"]["settingsRevision"] = "revision-" + str(revision_counter)
    elif request.method == "POST" and path == "/api/guard/check":
        assert payload == {"providerId": "gugu", "model": "gpt-6-astra", "effort": "high", "routeRevision": state["guard"]["current"]["routeRevision"]}
        state["guard"]["records"] = [deepcopy(record)]
    elif request.method == "POST" and path == "/api/guard/clear":
        assert set(payload) == {"key"} and any(item["key"] == payload["key"] for item in state["guard"]["records"])
        state["guard"]["records"] = [{**item, "status": "unchecked", "reason": "锁定已清除，下次请求仍须重新检测。", "expiresAt": None, "cacheValid": False} if item["key"] == payload["key"] else item for item in state["guard"]["records"]]
    elif request.method != "GET":
        raise AssertionError((request.method, path, payload))
    if state.get("guard"):
        current = state["guard"].get("current", {})
        state["guard"]["currentRecords"] = [item for item in state["guard"].get("records", [])
            if item["providerId"] == current.get("providerId") and (not current.get("key") or item["key"] == current["key"])]
    route.fulfill(status=200, content_type="application/json", body=json.dumps(state, ensure_ascii=False))

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, **({'executable_path': os.environ['CHROME_PATH']} if os.environ.get('CHROME_PATH') else {}))
    page = browser.new_page(viewport={"width": 1440, "height": 1050}, device_scale_factor=1)
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.route("**/*", route_request)
    page.goto("http://127.0.0.1:19999/__codex_filter__/ui")
    expect(page.locator("#versionBadge")).to_contain_text("服务 v" + str(filter_version))
    expect(page.locator("#providersView")).to_be_visible()
    expect(page.locator("#protectionView")).to_be_hidden()
    expect(page.locator("#historyView")).to_be_hidden()
    expect(page.locator("#viewProviders")).to_have_attribute("aria-selected", "true")
    expect(page.locator("#viewProviders")).to_have_attribute("role", "tab")
    expect(page.locator("#providersView")).to_have_attribute("role", "tabpanel")
    expect(page.locator("#currentHistoryEnabled")).to_be_visible()
    expect(page.locator("#guardEnabled")).to_be_hidden()
    expect(page.locator("#currentHistoryEnabled")).to_have_attribute("aria-checked", "false")
    expect(page.locator("#guardEnabled")).to_have_attribute("aria-checked", "false")
    assert not any(call[0] != "GET" for call in calls), "Loading the UI must not enable settings or run probes"
    before_navigation_writes = len([call for call in calls if call[0] != "GET"])
    page.locator("#viewProviders").focus()
    page.keyboard.press("ArrowRight")
    expect(page.locator("#viewProtection")).to_be_focused()
    expect(page.locator("#protectionView")).to_be_visible()
    page.keyboard.press("End")
    expect(page.locator("#viewSettings")).to_be_focused()
    expect(page.locator("#settingsView")).to_be_visible()
    page.keyboard.press("ArrowLeft")
    expect(page.locator("#viewHistory")).to_be_focused()
    expect(page.locator("#historyView")).to_be_visible()
    page.keyboard.press("ArrowLeft")
    expect(page.locator("#viewProtection")).to_be_focused()
    page.keyboard.press("Home")
    expect(page.locator("#viewProviders")).to_be_focused()
    expect(page.locator("#providersView")).to_be_visible()
    assert len([call for call in calls if call[0] != "GET"]) == before_navigation_writes
    expect(page.locator("#guardLocksSection")).to_be_hidden()
    expect(page.locator("#guardReset")).to_be_hidden()
    select_view(page, "history")
    expect(page.locator("#guardHistorySection")).to_be_visible()
    expect(page.locator("#guardHistory")).to_contain_text("复用已通过的缓存不会新增记录")
    expect(page.locator("#guardHistoryCount")).to_have_text("共 0 条")
    expect(page.locator("#guardHistoryPrev")).to_be_disabled()
    expect(page.locator("#guardHistoryNext")).to_be_disabled()
    expect(page.locator("#currentHistoryEnabled")).to_be_hidden()
    expect(page.locator("#guardEnabled")).to_be_hidden()
    select_view(page, "protection")
    expect(page.locator("#guardPanel")).to_be_visible()
    expect(page.locator("#guardBadge")).to_have_text("未开启")
    expect(page.locator("#guardTest")).to_be_enabled()
    assert page.locator("#providers img").count() == 0

    expect(page.locator("#guardModelSource")).to_contain_text("配置文件的默认值")
    expect(page.locator("#guardManualModel")).to_have_value("gpt-6-astra")
    expect(page.locator("#guardSelectionEditor")).to_have_js_property("open", True)
    page.locator("#guardManualModel").select_option("gpt-6-sol")
    expect(page.locator("#guardManualEffort")).to_have_value("default")
    page.locator("#guardManualEffort").select_option("xhigh")
    state["guard"]["current"].update(model="gpt-6-luna", effort="low", modelSource="request", modelObservedAt=now.isoformat())
    state["guard"]["recentModels"] = [{"model": "gpt-6-luna", "effort": "low", "observedAt": now.isoformat()}]
    page.locator("#refresh").click()
    expect(page.locator("#guardModel")).to_contain_text("gpt-6-luna")
    expect(page.locator("#guardModelSource")).to_contain_text("不代表当前前台会话")
    expect(page.locator("#guardManualModel")).to_have_value("gpt-6-sol")
    expect(page.locator("#guardManualEffort")).to_have_value("xhigh")
    page.locator("#guardUseRecent").click()
    expect(page.locator("#guardManualModel")).to_have_value("gpt-6-luna")
    expect(page.locator("#guardManualEffort")).to_have_value("low")
    state["guard"]["current"]["routeRevision"] = "route-1"
    page.locator("#refresh").click()
    expect(page.locator("#guardManualModel")).to_have_value("gpt-6-luna")
    expect(page.locator("#guardManualEffort")).to_have_value("low")
    assert not any(call[1] == "/api/guard/check" for call in calls)
    state["guard"]["current"].update(model="gpt-6-astra", effort="high")
    page.locator("#refresh").click()

    select_view(page, "providers")
    page.get_by_role("switch", name="演示供应商 模型保护", exact=True).click()
    page.locator("#viewProtection").click()
    expect(page.locator("#guardEnabled")).to_have_attribute("aria-checked", "true")
    page.locator("#viewProviders").click()
    assert state["guard"]["providers"]["gugu"] == {"enabled": True, "ttlSeconds": 600}
    assert not state["providers"][0]["rule"]["historyFilter"]
    page.locator("#enabledOnly").click()
    # Model protection alone must not qualify as enabled history filtering.
    expect(page.locator("#providers tr")).to_have_count(0)
    page.locator("#enabledOnly").click()
    expect(page.locator("#providers tr")).to_have_count(len(state["providers"]))
    select_view(page, "protection")
    if not page.locator("#guardSelectionEditor").evaluate("e => e.open"):
        page.locator("#guardAdjust").click()
    page.locator("#guardTtl").select_option("0")
    expect(page.locator("#guardCurrentDetail")).to_contain_text("每次请求前检测")
    assert state["guard"]["providers"]["gugu"]["ttlSeconds"] == 0

    page.locator("#guardTest").click()
    expect(page.locator("#guardBadge")).to_have_text("检测中")
    expect(page.locator("#guardTest")).to_be_disabled()
    state["guard"]["checking"] = [{**record, "progress": {"round": 1, "sample": 2, "samplesPerRound": 3}}]
    page.locator("#refresh").click()
    expect(page.locator("#guardEvidence")).to_contain_text("第 1 轮 · 正在采集第 2/3 个样本")
    expect(page.locator("#guardActionNote")).to_contain_text("整次最多 10 分钟")
    state["guard"]["checking"] = []
    state["guard"]["records"][0].update(status="passed", reason="指纹一致", prediction="gpt-6-astra", score=0.92, rounds=1, cacheValid=True)
    expect(page.locator("#guardBadge")).to_have_text("独立样本匹配", timeout=4000)
    expect(page.locator("#guardEvidence")).to_contain_text("非概率")
    expect(page.locator("#guardProtectionState")).to_contain_text("结果可复用")
    evidence_panel = page.locator("#guardSampleEvidence details")
    evidence_panel.locator("summary").click()
    expect(evidence_panel.locator("textarea")).to_have_count(3)
    evidence_panel.locator("textarea").first.evaluate("el => {window.savedEvidenceElement=el;el.focus();el.setSelectionRange(3,12);}")
    page.locator("#refresh").click()
    expect(evidence_panel).to_have_js_property("open", True)
    assert page.evaluate("window.savedEvidenceElement===document.querySelector('#guardSampleEvidence textarea')")
    with page.expect_download() as download_info:
        evidence_panel.get_by_role("button", name="下载本条样本 JSON", exact=True).click()
    exported = json.loads(Path(download_info.value.path()).read_text(encoding="utf-8"))
    assert set(exported) == {"schemaVersion", "sampling", "model", "effort", "checkedAt", "status", "sampleEvidence"}
    assert len(exported["sampleEvidence"][0]["samples"]) == 3
    assert not any(key in json.dumps(exported) for key in ["providerId", "providerName", "authorization", "endpoint", "fixture-key"])
    evidence_panel.locator("summary").click()
    state["guard"]["records"][0].update(cacheValid=False, cacheReason="已设置每次请求检测，下次请求仍须重新检测。")
    page.locator("#refresh").click()
    expect(page.locator("#guardBadge")).to_have_text("等待重新检测")
    expect(page.locator("#guardVerdict")).to_have_text("通过 · 样本匹配")
    expect(page.locator("#guardProtectionState")).to_contain_text("下次请求前须重新检测")
    state["guard"]["records"][0].update(cacheValid=True)
    before_cooling_calls = len([call for call in calls if call[1] == "/api/guard/check"])
    saved_pass = deepcopy(state["guard"]["records"][0])
    state["guard"]["records"][0].update(status="unverified", reason="HTTP 503：模型不可用", cooldownActive=True, retryAt=(now + timedelta(seconds=60)).isoformat(), retryAfterSeconds=60)
    page.locator("#refresh").click()
    expect(page.locator("#guardTest")).to_have_text("立即手动重试")
    expect(page.locator("#guardActionNote")).to_contain_text("不产生重复检测")
    expect(page.locator("#guardTest")).to_be_enabled()
    assert len([call for call in calls if call[1] == "/api/guard/check"]) == before_cooling_calls
    state["guard"]["records"][0] = saved_pass
    # Severity follows evidence; disabled protection stays neutral.
    color_cases = [
        ("HTTP 403：上游拒绝访问", [], "不通过 · 上游拒绝访问（403）", "warn"),
        ("第 1/3 个样本数字不足", [], "不通过 · 样本无效", "warn"),
        ("复核仍最接近替代模型", [fixture_evidence["different"]], "不通过 · 明显模型差异", "bad"),
        ("样本冲突", [fixture_evidence["conflict"]], "不通过 · 模型异常（样本冲突）", "bad"),
    ]
    for reason, evidence, label, tone in color_cases:
        current_record = {**deepcopy(saved_pass), "status": "unverified", "reason": reason, "sampleEvidence": deepcopy(evidence)}
        state["guard"]["records"] = [current_record]
        state["guard"]["history"] = [{**deepcopy(current_record), "id": "color-history", "source": "manual"}]
        page.locator("#refresh").click()
        expect(page.locator("#guardVerdict")).to_have_text(label)
        expect(page.locator("#guardVerdict")).to_have_class("guard-result " + tone)
        expect(page.locator("#guardBadge")).to_have_class("guard-state " + tone)
        expect(page.locator("#guardAlert")).to_have_class("guard-banner" + (" warn" if tone == "warn" else ""))
        expect(page.locator("#guardHistory .guard-state")).to_have_class("guard-state " + tone)
    state["guard"]["providers"]["gugu"]["enabled"] = False
    page.locator("#refresh").click()
    expect(page.locator("#guardBadge")).to_have_text("未开启")
    expect(page.locator("#guardBadge")).not_to_have_class(re.compile("bad|warn"))
    expect(page.locator("#guardVerdict")).to_have_class("guard-result bad")
    expect(page.locator("#guardProtectionState")).to_contain_text("不拦截项目请求")
    state["guard"]["providers"]["gugu"]["enabled"] = True
    legacy_record = {**deepcopy(saved_pass), "sampleEvidence": []}
    state["guard"]["records"] = [legacy_record]
    page.locator("#refresh").click()
    expect(page.locator("#guardVerdict")).to_have_text("旧版结果 · 未逐样本校验")
    state["guard"]["records"] = [saved_pass]
    state["guard"]["history"] = []
    state["guard"]["current"].update(available=False, reason="路由切换中")
    page.locator("#refresh").click()
    expect(page.locator("#guardBadge")).to_have_text("未能验证")
    expect(page.locator("#guardVerdict")).to_have_text("通过 · 样本匹配")
    expect(page.locator("#guardTest")).to_be_disabled()
    state["guard"]["current"]["available"] = True

    state["guard"]["current"]["key"] = "new-route-key"
    page.locator("#refresh").click()
    expect(page.locator("#guardVerdict")).to_have_text("尚无检测记录")
    state["guard"]["current"]["key"] = "fixture-key"
    state["guard"]["records"][0].update(status="blocked", reason="<img src=x onerror=alert(1)> 上游声明了其他模型", prediction="gpt-6-sol", rounds=2)
    page.locator("#refresh").click()
    expect(page.locator("#guardBadge")).to_have_text("已切断并锁定")
    expect(page.locator("#guardLocksSection")).to_be_visible()
    expect(page.locator("#guardLocksCount")).to_contain_text("1")
    expect(page.locator("#guardAlert")).to_contain_text("<img")
    assert page.locator("#guardPanel img").count() == 0
    expect(page.locator("#guardReset")).to_be_enabled()
    state["guard"]["checking"] = [deepcopy(record)]
    page.locator("#refresh").click()
    expect(page.locator("#guardBadge")).to_have_text("重新检测中 · 保持锁定")
    expect(page.locator("#guardTest")).to_be_disabled()
    expect(page.locator("#guardReset")).to_be_disabled()
    state["guard"]["checking"] = []
    page.locator("#refresh").click()
    expect(page.locator("#guardBadge")).to_have_text("已切断并锁定")
    page.screenshot(path=str(root / ".runtime" / "guard-dashboard-blocked.png"), full_page=True)
    page.locator("#guardReset").click()
    expect(page.locator("#guardBadge")).to_have_text("等待检测")
    expect(page.locator("#guardReset")).to_be_hidden()
    expect(page.locator("#guardLocksSection")).to_be_hidden()

    state["guard"]["current"]["model"] = "gpt-6.1-sol"
    state["guard"]["current"]["key"] = "unsupported-model-route-key"
    page.locator("#refresh").click()
    page.locator("#guardManualModel").select_option("gpt-6.1-sol")
    expect(page.locator("#guardBadge")).to_have_text("模型尚不支持")
    expect(page.locator("#guardTest")).to_be_disabled()
    expect(page.locator("#guardAlert")).to_contain_text("参考库")

    state["guard"]["error"] = "配置校验失败"
    page.locator("#refresh").click()
    expect(page.locator("#guardBadge")).to_have_text("保护配置异常")
    expect(page.locator("#guardAlert")).to_contain_text("配置校验失败")
    expect(page.locator("#guardEnabled")).to_be_disabled()
    expect(page.locator("#guardTtl")).to_be_disabled()
    del state["guard"]["error"]
    page.locator("#refresh").click()

    select_view(page, "providers")
    page.locator("#search").fill("其他供应商")
    page.get_by_role("button", name="配置", exact=True).click()
    expect(page.locator("#drawerGuardStatus")).to_contain_text("待切换")
    page.locator("#drawerGuardEnabled").check()
    page.locator("#drawerGuardTtl").select_option("300")
    page.locator("#saveGuard").click()
    expect(page.locator("#drawer")).to_be_hidden()
    assert state["guard"]["providers"]["other/encoded"] == {"enabled": True, "ttlSeconds": 300}
    assert not state["providers"][1]["rule"]["historyFilter"]
    # An open form must retain its original revision even when polling refreshes
    # state. A stale TTL edit must not turn off protection enabled elsewhere.
    page.get_by_role("button", name="配置", exact=True).click()
    original_revision = state["guard"]["settingsRevision"]
    page.locator("#drawerGuardEnabled").uncheck()
    state["guard"]["providers"]["other/encoded"] = {"enabled": True, "ttlSeconds": 600}
    state["guard"]["settingsRevision"] = "other-page-revision"
    before_gets = len([call for call in calls if call[0] == "GET"])
    page.wait_for_timeout(6500)
    assert len([call for call in calls if call[0] == "GET"]) > before_gets, "State was not refreshed while editing"
    page.locator("#drawerGuardTtl").select_option("60")
    page.locator("#saveGuard").click()
    expect(page.locator("#toast")).to_contain_text("本次修改未保存")
    expect(page.locator("#drawer")).to_be_visible()
    assert state["guard"]["providers"]["other/encoded"] == {"enabled": True, "ttlSeconds": 600}
    assert [call for call in calls if call[0] == "PUT"][-1][2]["revision"] == original_revision
    fail_next_state = True
    page.locator("#saveGuard").click()
    expect(page.locator("#toast")).to_contain_text("最新状态读取失败")
    expect(page.locator("#toast")).not_to_contain_text("已读取最新")
    expect(page.locator("#drawerGuardEnabled")).not_to_be_checked()
    expect(page.locator("#drawerGuardTtl")).to_have_value("60")
    assert state["guard"]["providers"]["other/encoded"] == {"enabled": True, "ttlSeconds": 600}
    page.locator("#closeDrawer").click()
    page.get_by_role("button", name="配置", exact=True).click()
    expect(page.locator("#drawerGuardEnabled")).to_be_checked()
    page.locator("#drawerGuardTtl").select_option("60")
    page.locator("#saveGuard").click()
    expect(page.locator("#drawer")).to_be_hidden()
    assert state["guard"]["providers"]["other/encoded"] == {"enabled": True, "ttlSeconds": 60}
    page.locator("#search").fill("")
    page.set_viewport_size({"width": 390, "height": 844})
    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), "Mobile horizontal overflow"
    page.screenshot(path=str(root / ".runtime" / "guard-dashboard-mobile.png"), full_page=True)

    # Address/history incompatibility must not trap an already enabled policy.
    saved_state = deepcopy(state)
    state["guard"]["current"] = {"providerId": "gugu", "model": "gpt-6-astra", "effort": "high", "available": False, "reason": "供应商地址无法识别，请在 CC Switch 修复地址。"}
    state["guard"]["providers"].update({"gugu": {"enabled": True, "ttlSeconds": 600}, "other/encoded": {"enabled": True, "ttlSeconds": 300}})
    state["providers"][0].update(editable=False, endpoint="")
    state["providers"][1].update(editable=False, endpoint="")
    before_probes = len([call for call in calls if call[1] == "/api/guard/check"])
    before_rules = deepcopy([item["rule"] for item in state["providers"]])
    before_other_policy = deepcopy(state["guard"]["providers"].get("unsafe"))
    page.locator("#refresh").click()
    expect(page.locator("#guardEnabled")).to_be_enabled()
    expect(page.locator("#guardTest")).to_be_disabled()
    expect(page.get_by_role("switch", name="演示供应商 历史过滤", exact=True)).to_be_disabled()
    expect(page.locator("#providers tr").filter(has_text="演示供应商").get_by_role("button", name="配置", exact=True)).to_be_disabled()
    select_view(page, "protection")
    page.locator("#guardEnabled").click()
    expect(page.locator("#guardEnabled")).to_have_attribute("aria-checked", "false")
    expect(page.locator("#guardEnabled")).to_be_disabled()
    select_view(page, "providers")
    expect(page.get_by_role("switch", name="演示供应商 模型保护", exact=True)).to_be_disabled()
    expect(page.get_by_role("switch", name="其他供应商 模型保护", exact=True)).to_be_enabled()
    page.get_by_role("switch", name="其他供应商 模型保护", exact=True).click()
    expect(page.get_by_role("switch", name="其他供应商 模型保护", exact=True)).to_have_attribute("aria-checked", "false")
    expect(page.get_by_role("switch", name="其他供应商 模型保护", exact=True)).to_be_disabled()
    expect(page.get_by_role("switch", name="其他供应商 历史过滤", exact=True)).to_be_disabled()
    expect(page.locator("#providers tr").filter(has_text="其他供应商").get_by_role("button", name="配置", exact=True)).to_be_disabled()
    expect(page.locator("#guardTest")).to_be_disabled()
    assert state["guard"]["providers"]["gugu"] == {"enabled": False, "ttlSeconds": 600}
    assert state["guard"]["providers"]["other/encoded"] == {"enabled": False, "ttlSeconds": 300}
    assert state["guard"]["providers"].get("unsafe") == before_other_policy
    assert [item["rule"] for item in state["providers"]] == before_rules
    assert len([call for call in calls if call[1] == "/api/guard/check"]) == before_probes
    state.clear()
    state.update(saved_state)

    # Every persistent lock remains reachable even beyond the recent-history cap.
    saved_state = deepcopy(state)
    recent_records = [{**deepcopy(record), "key": f"{i + 1:064x}", "status": "passed", "cacheValid": False, "checkedAt": (now - timedelta(minutes=i)).isoformat()} for i in range(15)]
    locked_records = [{**deepcopy(record), "key": f"{i + 100:064x}", "providerName": f"较早锁定-{i}", "status": "blocked", "reason": "响应声明了不同模型", "checkedAt": (now - timedelta(days=i + 1)).isoformat()} for i in range(14)]
    state["guard"]["records"] = recent_records + locked_records
    state["guard"]["jobs"] = [locked_records[0]["key"]]
    page.locator("#refresh").click()
    select_view(page, "protection")
    expect(page.locator("#guardRecords .guard-record")).to_have_count(14)
    expect(page.locator("#guardLocksSection")).to_be_visible()
    expect(page.locator("#guardLocksCount")).to_contain_text("14")
    expect(page.locator("#guardRecords").get_by_role("button", name="清除 较早锁定-0 gpt-6-astra 的锁定", exact=True)).to_be_disabled()
    for i in range(1, 14):
        expect(page.locator("#guardRecords").get_by_role("button", name=f"清除 较早锁定-{i} gpt-6-astra 的锁定", exact=True)).to_be_enabled()
    oldest_key = locked_records[-1]["key"]
    page.locator("#guardRecords").get_by_role("button", name="清除 较早锁定-13 gpt-6-astra 的锁定", exact=True).click()
    expect(page.locator("#guardRecords .guard-record")).to_have_count(13)
    expect(page.locator("#guardLocksCount")).to_contain_text("13")
    assert [call for call in calls if call[1] == "/api/guard/clear"][-1][2] == {"key": oldest_key}
    cleared = next(item for item in state["guard"]["records"] if item["key"] == oldest_key)
    assert cleared["status"] == "unchecked" and not cleared["cacheValid"]
    assert len([item for item in state["guard"]["records"] if item["status"] == "blocked"]) == 13
    assert state["guard"]["providers"] == saved_state["guard"]["providers"]
    assert len([call for call in calls if call[1] == "/api/guard/check"]) == before_probes
    state.clear()
    state.update(saved_state)

    # Current passes belong in the overview/history, not a duplicate active list.
    saved_state = deepcopy(state)
    success_records = [{**deepcopy(record), "key": f"success-{i}", "providerName": f"成功供应商-{i}", "status": "passed", "reason": "指纹一致", "cacheValid": True} for i in range(2)]
    state["guard"]["records"] = success_records
    state["guard"]["history"] = [{**item, "id": f"success-history-{i}", "source": "manual"} for i, item in enumerate(success_records)]
    state["guard"]["current"] = {"providerId": "gugu", "model": "gpt-6-astra", "effort": "high", "available": True, "key": "success-0"}
    page.locator("#refresh").click()
    expect(page.locator("#guardVerdict")).to_have_text("通过 · 样本匹配")
    expect(page.locator("#guardLocksSection")).to_be_hidden()
    expect(page.locator("#guardRecords .guard-record")).to_have_count(0)
    select_view(page, "history")
    expect(page.locator("#guardHistory .guard-history-record")).to_have_count(2)
    expect(page.locator("#guardReset")).to_be_hidden()
    # A stored lock on a disabled provider is visible but labelled inactive.
    inactive_lock = {**deepcopy(record), "key": "inactive-lock", "providerId": "unsafe", "providerName": "已关闭保护的供应商", "status": "blocked", "reason": "此前发现模型不一致"}
    state["guard"]["records"] = [inactive_lock]
    state["guard"]["history"].insert(0, {**inactive_lock, "id": "inactive-lock-history", "source": "automatic"})
    page.locator("#refresh").click()
    select_view(page, "protection")
    expect(page.locator("#guardLocksSection")).to_be_visible()
    expect(page.locator("#guardLocksCount")).to_contain_text("1")
    expect(page.locator("#guardRecords")).to_contain_text("保留锁定 · 保护已关闭")
    expect(page.locator("#guardHistory .guard-history-record")).to_have_count(3)
    page.locator("#guardRecords").get_by_role("button", name="清除 已关闭保护的供应商 gpt-6-astra 的锁定", exact=True).click()
    expect(page.locator("#guardLocksSection")).to_be_hidden()
    expect(page.locator("#guardRecords .guard-record")).to_have_count(0)
    select_view(page, "history")
    expect(page.locator("#guardHistory .guard-history-record")).to_have_count(3)
    expect(page.locator("#guardHistory")).to_contain_text("当时已拦截")
    assert [call for call in calls if call[1] == "/api/guard/clear"][-1][2] == {"key": "inactive-lock"}
    state.clear()
    state.update(saved_state)

    # Repeated outcomes for the same route are independent immutable evidence.
    saved_state = deepcopy(state)
    history_statuses = ["passed", "blocked", "unverified", "unsupported"]
    history_sources = ["manual", "automatic", "response", "legacy"]
    state["guard"]["history"] = [{**deepcopy(record), "id": f"history-{i}", "source": history_sources[i % 4], "status": history_statuses[i % 4], "reason": f"当次结果-{i}", "score": .923, "prediction": "gpt-6-astra", "rounds": 1} for i in range(45)]
    state["guard"]["history"][0].update(providerName="<img src=x onerror=alert(1)>", reason="<svg onload=alert(1)> 历史内容")
    state["guard"]["records"] = [{**deepcopy(record), "status": "passed", "cacheValid": False, "cacheReason": "下次需要重新检测"}]
    state["guard"]["historyLimit"] = 100
    page.locator("#refresh").click()
    select_view(page, "history")
    expect(page.locator("#providersView")).to_be_hidden()
    expect(page.locator("#protectionView")).to_be_hidden()
    expect(page.locator("#guardHistory .guard-history-record")).to_have_count(10)
    expect(page.locator("#guardHistoryCount")).to_have_text("第 1–10 条 · 共 45 条")
    expect(page.locator("#guardHistoryPage")).to_have_text("第 1 / 5 页")
    expect(page.locator("#guardHistoryPrev")).to_be_disabled()
    expect(page.locator("#guardHistoryNext")).to_be_enabled()
    expect(page.locator("#guardHistoryViewport")).to_have_attribute("tabindex", "0")
    expect(page.locator("#guardHistory")).to_contain_text("非概率")
    expect(page.locator("#guardHistory")).to_contain_text("当时已拦截")
    expect(page.locator("#guardHistory")).to_contain_text("升级时保留")
    expect(page.locator("#guardHistory")).to_contain_text("项目响应检查")
    expect(page.locator("#guardHistory")).not_to_contain_text("已切断并锁定")
    expect(page.locator("#guardHistory")).not_to_contain_text("缓存")
    assert page.locator("#guardHistory img,#guardHistory svg").count() == 0
    assert page.locator("#guardHistory button").count() == page.locator("#guardHistory .guard-history-record").count()
    assert page.locator("#guardRecords button").count() == 0, "Historical block created an active clear action"
    first_detail = page.locator("#guardHistory .guard-history-details").first
    expect(first_detail).to_have_js_property("open", False)
    expect(page.locator("#guardHistory .guard-history-record").first.locator(".guard-record-meta").first).to_be_visible()
    first_detail.locator("summary").click()
    expect(first_detail).to_have_js_property("open", True)
    expect(first_detail).to_contain_text("<svg onload=alert(1)> 历史内容")
    assert page.locator("#guardHistory img,#guardHistory svg").count() == 0
    page.locator("#refresh").click()
    expect(first_detail).to_have_js_property("open", True)
    first_detail.locator("summary").click()
    assert page.locator("#guardHistoryMore,#guardHistoryCollapse").count() == 0
    before_history_writes = len([call for call in calls if call[0] != "GET"])
    page.locator("#guardHistoryNext").click()
    expect(page.locator("#guardHistory .guard-history-record")).to_have_count(10)
    expect(page.locator("#guardHistoryCount")).to_have_text("第 11–20 条 · 共 45 条")
    expect(page.locator("#guardHistoryPage")).to_have_text("第 2 / 5 页")
    expect(page.locator("#guardHistory .guard-history-record").first).to_have_attribute("data-history-id", "history-10")
    page.locator("#guardHistory .guard-history-details").first.locator("summary").click()
    # An older page stays anchored to its first record while new items arrive.
    state["guard"]["history"].insert(0, {**deepcopy(record), "id": "history-new", "source": "automatic", "status": "passed", "reason": "刷新期间新增的检测"})
    page.wait_for_timeout(6500)
    expect(page.locator("#historyView")).to_be_visible()
    expect(page.locator("#viewHistory")).to_have_attribute("aria-selected", "true")
    expect(page.locator("#guardHistoryCount")).to_have_text("第 12–21 条 · 共 46 条")
    expect(page.locator("#guardHistoryPage")).to_have_text("第 2 / 5 页")
    expect(page.locator("#guardHistory .guard-history-record").first).to_have_attribute("data-history-id", "history-10")
    expect(page.locator("#guardHistory .guard-history-details").first).to_have_js_property("open", True)
    displayed_ids = page.locator("#guardHistory .guard-history-record").evaluate_all("rows => rows.map(row => row.dataset.historyId)")
    assert len(set(displayed_ids)) == len(displayed_ids) == 10
    page.locator("#guardHistoryLatest").click()
    expect(page.locator("#guardHistory .guard-history-record").first).to_have_attribute("data-history-id", "history-new")
    expect(page.locator("#guardHistoryPage")).to_have_text("第 1 / 5 页")
    expect(page.locator("#guardHistoryCount")).to_have_text("第 1–10 条 · 共 46 条")
    page.locator("#guardHistoryNext").click()
    page.locator("#guardHistoryPrev").click()
    expect(page.locator("#guardHistoryPage")).to_have_text("第 1 / 5 页")
    state["guard"]["history"].insert(0, {**deepcopy(record), "id": "history-newest", "source": "automatic", "status": "passed", "reason": "首页显示最新结果"})
    page.locator("#refresh").click()
    expect(page.locator("#guardHistory .guard-history-record").first).to_have_attribute("data-history-id", "history-newest")
    # Every record at the backend's 100-entry cap can be reached without writes.
    state["guard"]["history"] = [{**deepcopy(record), "id": f"capped-{i}", "source": "manual", "status": "passed", "reason": f"相同模型第 {i} 次检测"} for i in range(100)]
    page.locator("#refresh").click()
    expect(page.locator("#guardHistoryCount")).to_have_text("第 1–10 条 · 共 100 条")
    seen_ids = []
    for page_number in range(1, 11):
        expect(page.locator("#guardHistory .guard-history-record")).to_have_count(10)
        expect(page.locator("#guardHistoryPage")).to_have_text(f"第 {page_number} / 10 页")
        seen_ids.extend(page.locator("#guardHistory .guard-history-record").evaluate_all("rows => rows.map(row => row.dataset.historyId)"))
        if page_number < 10:
            page.locator("#guardHistoryNext").click()
    assert seen_ids == [f"capped-{i}" for i in range(100)]
    expect(page.locator("#guardHistoryNext")).to_be_disabled()
    assert len([call for call in calls if call[0] != "GET"]) == before_history_writes
    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), "History caused mobile overflow"
    assert page.locator("#guardHistoryViewport").evaluate("el => el.clientHeight <= innerHeight * .65"), "History viewport grows beyond bounded region"
    select_view(page, "providers")
    expect(page.locator("#providers")).to_be_visible()
    expect(page.locator("#historyView")).to_be_hidden()
    expect(page.locator("#guardHistory")).to_be_hidden()
    select_view(page, "history")
    expect(page.locator("#guardHistoryPage")).to_have_text("第 10 / 10 页")
    # Clamp the current page when records are removed and the anchor disappears.
    state["guard"]["history"] = state["guard"]["history"][:12]
    page.locator("#refresh").click()
    expect(page.locator("#guardHistoryPage")).to_have_text("第 2 / 2 页")
    expect(page.locator("#guardHistory .guard-history-record")).to_have_count(2)
    page.locator("#guardHistoryLatest").click()
    page.evaluate("window.scrollTo(0, document.documentElement.scrollHeight)")
    nav_box = page.locator("#viewHistory").bounding_box()
    assert nav_box and 0 <= nav_box["y"] < 180 and abs(page.locator(".side").bounding_box()["y"]) <= 1, "Mobile navigation is not sticky at the top"
    page.locator("#guardHistorySection").screenshot(path=str(root / ".runtime" / "guard-history-mobile.png"))
    del state["guard"]["history"]
    page.locator("#refresh").click()
    expect(page.locator("#guardHistorySection")).to_be_hidden()
    expect(page.locator("#guardLocksSection")).to_be_hidden()
    state.clear()
    state.update(saved_state)

    del state["guard"]
    page.locator("#refresh").click()
    expect(page.locator("#providersView")).to_be_visible()
    expect(page.locator("#viewProtection")).to_be_hidden()
    expect(page.locator("#viewHistory")).to_be_hidden()
    expect(page.locator("#currentHistoryEnabled")).to_be_visible()
    expect(page.locator("#guardPanel")).to_be_hidden()
    expect(page.locator("#guardColumn")).to_be_hidden()
    expect(page.locator("#error")).to_be_hidden()
    # Read-only stale credentials recover at most once without replaying writes.
    before_loads = ui_loads
    server_token = "restarted-service-1"
    # The old DOM already has this version and a hidden error banner. Wait for
    # the recovery navigation itself before asserting the newly loaded state.
    with page.expect_response(lambda response: response.url.endswith('/ui') and response.request.is_navigation_request(), timeout=10000):
        page.locator("#refresh").click()
    page.wait_for_load_state('domcontentloaded')
    expect(page.locator("#versionBadge")).to_contain_text("服务 v" + str(filter_version))
    expect(page.locator("#error")).to_be_hidden(timeout=4000)
    assert ui_loads == before_loads + 1
    page.wait_for_timeout(200)
    server_token = "restarted-service-2"
    page.locator("#refresh").click()
    expect(page.locator("#reconnect")).to_be_visible()
    expect(page.locator("#refresh")).to_be_disabled()
    before_calls = len(calls)
    page.wait_for_timeout(6500)
    assert len(calls) == before_calls, "Expired token kept polling"
    assert ui_loads == before_loads + 1, "Credential recovery reload loop"
    page.locator("#reconnect").click()
    expect(page.locator("#error")).to_be_hidden()

    # A failed mutation is never retried automatically after credentials expire.
    state["guard"] = {"models": ["gpt-6-astra"], "providers": {}, "records": [], "settingsRevision": "recovered-revision", "current": {"providerId": "gugu", "model": "gpt-6-astra", "effort": "high", "available": True}}
    page.locator("#refresh").click()
    expect(page.locator("#guardEnabled")).to_be_enabled()
    server_token = "restarted-service-3"
    before_loads = ui_loads
    before_puts = len([call for call in calls if call[0] == "PUT"])
    select_view(page, "protection")
    page.locator("#guardEnabled").click()
    expect(page.locator("#reconnect")).to_be_visible()
    expect(page.locator("#guardEnabled")).to_be_disabled()
    expect(page.locator("#toast")).to_have_text("本次操作未保存，请重新连接管理页后再试。")
    assert ui_loads == before_loads
    assert len([call for call in calls if call[0] == "PUT"]) == before_puts + 1
    assert state["guard"]["providers"] == {}
    page.locator("#reconnect").click()
    expect(page.locator("#guardEnabled")).to_have_attribute("aria-checked", "false")
    # An open draft prevents automatic GET recovery even with a fresh cooldown.
    page.evaluate("sessionStorage.removeItem('codex-filter-auth-recovery')")
    page.locator("#search").fill("其他供应商")
    page.get_by_role("button", name="配置", exact=True).click()
    page.locator("#drawerGuardTtl").select_option("1800")
    server_token = "restarted-service-4"
    before_loads = ui_loads
    expect(page.locator("#reconnect")).to_be_visible(timeout=8000)
    expect(page.locator("#error")).to_contain_text("未提交的设置不会自动保存")
    expect(page.locator("#drawer")).to_be_visible()
    expect(page.locator("#drawerGuardTtl")).to_have_value("1800")
    expect(page.locator("#drawerGuardTtl")).to_be_disabled()
    assert ui_loads == before_loads, "Expired GET discarded an open draft"
    assert page.evaluate("sessionStorage.getItem('codex-filter-auth-recovery')") is None, "Open-draft recovery used the cooldown branch"
    before_calls = len(calls)
    page.wait_for_timeout(6500)
    assert len(calls) == before_calls, "Expired GET continued polling while a draft was open"
    expect(page.locator("#drawerGuardTtl")).to_have_value("1800")
    page.locator("#closeDrawer").click()
    expect(page.locator("#reconnect")).to_be_enabled()
    page.locator("#reconnect").click()
    expect(page.locator("#error")).to_be_hidden()
    assert not errors, errors
    browser.close()

node_source = r'''
const fs=require('node:fs'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {makeProxy}=require('./src/proxy.cjs');
const {createManagement}=require('./src/management.cjs');
const {createGuardService}=require('./src/guard-service.cjs');
const {createGuard}=require('./src/guard.cjs');
const runtime=process.argv[1],databasePath=path.join(runtime,'fixture.db'),configPath=path.join(runtime,'config.toml');
const db=new DatabaseSync(databasePath);
db.exec("PRAGMA user_version=19; CREATE TABLE providers(id TEXT,name TEXT,app_type TEXT,is_current INTEGER,settings_config TEXT,sort_index INTEGER); CREATE TABLE proxy_config(app_type TEXT,auto_failover_enabled INTEGER); INSERT INTO proxy_config VALUES('codex',0)");
for(const [id,name,current] of [['fixture','真实后端离线夹具',1],['second','次要供应商',0]]) db.prepare('INSERT INTO providers VALUES(?,?,?,?,?,0)').run(id,name,'codex',current,JSON.stringify({config:'model_provider="custom"\n[model_providers.custom]\nbase_url="https://fixture.invalid/v1"'}));
db.close();
fs.writeFileSync(configPath,'model="gpt-6-astra"\nmodel_reasoning_effort="high"\nmodel_provider="custom"\n[model_providers.custom]\nbase_url="http://127.0.0.1:1/v1"\n');
fs.writeFileSync(path.join(runtime,'auth.json'),JSON.stringify({OPENAI_API_KEY:'local-test-placeholder'}));
const {numbers}=require('./tests/fixtures/guard-fixtures.cjs');let sampleIndex=0;const modeFile=path.join(runtime,'fixture-mode.txt');
fs.writeFileSync(modeFile,'pass');
const guard=createGuardService({runtime,databasePath,configPath,getUpstream:()=> 'http://127.0.0.1:1',
 probe:async()=>{await new Promise(r=>setTimeout(r,100));const mismatch=fs.readFileSync(modeFile,'utf8')==='block';return {text:numbers(mismatch?'gpt-6-luna':'gpt-6-astra',sampleIndex++).join(','),model:'gpt-6-astra'};}});
const management=createManagement({runtime,databasePath,guard});
const server=makeProxy({token:'real-backend-ui',getUpstream:()=> 'http://127.0.0.1:1',dashboard:management,guard,getFilterPolicy:management.policy,getState:()=>({state:'filtering',currentPolicy:management.policy()})});
server.listen(0,'127.0.0.1',()=>console.log('http://127.0.0.1:'+server.address().port+'/__codex_filter__/ui'));
'''

with tempfile.TemporaryDirectory(prefix="codex-guard-ui-backend-") as scratch:
    proc = subprocess.Popen(["node", "-e", node_source, scratch], cwd=root,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
    try:
        url = proc.stdout.readline().strip()
        assert url.startswith("http://127.0.0.1:"), "Backend preview failed to start"
        db = Path(scratch) / "fixture.db"
        db_hash = hashlib.sha256(db.read_bytes()).hexdigest()
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True, **({'executable_path': os.environ['CHROME_PATH']} if os.environ.get('CHROME_PATH') else {}))
            page = browser.new_page(viewport={"width": 1440, "height": 1050})
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.goto(url)
            expect(page.locator("#versionBadge")).to_contain_text("服务 v" + str(filter_version))
            expect(page.locator("#guardEnabled")).to_have_attribute("aria-checked", "false")
            select_view(page, "protection")
            expect(page.locator("#guardTest")).to_be_enabled()
            page.locator("#guardTest").click()
            expect(page.locator("#guardVerdict")).to_have_text("通过 · 样本匹配", timeout=6000)
            expect(page.locator("#guardHistory .guard-history-record")).to_have_count(1)
            expect(page.locator("#guardEnabled")).to_have_attribute("aria-checked", "false")
            expect(page.locator("#guardBadge")).to_have_text("未开启")
            select_view(page, "protection")
            page.locator("#guardEnabled").click()
            expect(page.locator("#guardBadge")).to_have_text("等待重新检测")
            expect(page.locator("#guardVerdict")).to_have_text("通过 · 样本匹配")
            settings = json.loads((Path(scratch) / "model-guard.json").read_text(encoding="utf-8"))
            assert settings["providers"]["fixture"]["enabled"]
            assert not (Path(scratch) / "provider-rules.json").exists(), "Guard toggle changed history rules"
            (Path(scratch) / "fixture-mode.txt").write_text("block", encoding="utf-8")
            page.locator("#guardTest").click()
            expect(page.locator("#guardVerdict")).to_have_text("已切断并锁定", timeout=6000)
            expect(page.locator("#guardHistory .guard-history-record")).to_have_count(2)
            expect(page.locator("#guardHistory .guard-history-record").first).to_contain_text("当时已拦截")
            expect(page.locator("#guardReset")).to_be_enabled()
            page.reload()
            select_view(page, "protection")
            expect(page.locator("#guardVerdict")).to_have_text("已切断并锁定")
            page.screenshot(path=str(root / ".runtime" / "guard-dashboard-backend.png"), full_page=True)
            page.locator("#guardReset").click()
            expect(page.locator("#guardVerdict")).to_have_text("等待检测")
            select_view(page, "history")
            expect(page.locator("#guardHistory .guard-history-record")).to_have_count(2)
            assert page.locator("#guardHistory button").count() == page.locator("#guardHistory .guard-history-record").count()
            select_view(page, "protection")
            (Path(scratch) / "fixture-mode.txt").write_text("pass", encoding="utf-8")
            page.locator("#guardTest").click()
            expect(page.locator("#guardVerdict")).to_have_text("通过 · 样本匹配", timeout=6000)
            expect(page.locator("#guardHistory .guard-history-record")).to_have_count(3)
            if not page.locator("#guardSelectionEditor").evaluate("e => e.open"):
                page.locator("#guardAdjust").click()
            page.locator("#guardTtl").select_option("0")
            expect(page.locator("#guardBadge")).to_have_text("等待重新检测")
            page.locator("#guardTest").click()
            expect(page.locator("#guardVerdict")).to_have_text("通过 · 样本匹配", timeout=6000)
            expect(page.locator("#guardHistory .guard-history-record")).to_have_count(4)
            expect(page.locator("#guardBadge")).to_have_text("等待重新检测")
            expect(page.locator("#guardProtectionState")).to_contain_text("下次请求前须重新检测")
            page.reload()
            select_view(page, "history")
            expect(page.locator("#guardHistory .guard-history-record")).to_have_count(4)
            stored_history = json.loads((Path(scratch) / "model-guard.json").read_text(encoding="utf-8"))["history"]
            assert len(stored_history) == 4 and len({item["id"] for item in stored_history}) == 4
            assert len({item["key"] for item in stored_history}) == 1
            assert all(item["source"] == "manual" for item in stored_history)
            # Quick history filtering in the supplier view preserves the other
            # compatibility flags and unrelated providers in the real backend.
            rules_path = Path(scratch) / "provider-rules.json"
            select_view(page, "providers")
            page.locator("#providers tr").filter(has_text="真实后端离线夹具").get_by_role("button", name="配置", exact=True).click()
            page.locator("#preserveEncryptedInclude").uncheck()
            page.locator("#stripResponsesLiteHeader").check()
            page.locator("#saveRule").click()
            expect(page.locator("#drawer")).to_be_hidden()
            page.locator("#providers tr").filter(has_text="次要供应商").get_by_role("switch", name="次要供应商 历史过滤", exact=True).click()
            expect(page.locator("#refresh")).to_be_enabled()
            saved_rules = json.loads(rules_path.read_text(encoding="utf-8"))["providers"]
            guard_settings_before = json.loads((Path(scratch) / "model-guard.json").read_text(encoding="utf-8"))["providers"]
            select_view(page, "history")
            expect(page.locator("#currentHistoryEnabled")).to_be_hidden()
            expect(page.locator("#guardEnabled")).to_be_hidden()
            select_view(page, "providers")
            expect(page.locator("#currentHistoryEnabled")).to_be_visible()
            page.locator("#currentHistoryEnabled").click()
            expect(page.locator("#currentHistoryEnabled")).to_have_attribute("aria-checked", "true")
            expect(page.locator("#refresh")).to_be_enabled()
            changed_rules = json.loads(rules_path.read_text(encoding="utf-8"))["providers"]
            assert changed_rules["fixture"] == {**saved_rules["fixture"], "historyFilter": True}
            assert changed_rules["second"] == saved_rules["second"]
            assert json.loads((Path(scratch) / "model-guard.json").read_text(encoding="utf-8"))["providers"] == guard_settings_before
            select_view(page, "providers")
            expect(page.get_by_role("switch", name="真实后端离线夹具 历史过滤", exact=True)).to_have_attribute("aria-checked", "true")
            page.locator("#currentHistoryEnabled").click()
            expect(page.get_by_role("switch", name="真实后端离线夹具 历史过滤", exact=True)).to_have_attribute("aria-checked", "false")
            expect(page.locator("#refresh")).to_be_enabled()
            assert json.loads(rules_path.read_text(encoding="utf-8"))["providers"] == saved_rules
            page.set_viewport_size({"width": 390, "height": 844})
            assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
            assert not errors, errors
            browser.close()
        assert hashlib.sha256(db.read_bytes()).hexdigest() == db_hash, "CC Switch fixture database changed"
    finally:
        proc.terminate()
        proc.wait(timeout=10)

print(json.dumps({"passed": True, "checks": ["version", "independent-provider-switch", "ttl", "manual-check", "checking-poll", "score-not-probability", "persistent-lock-ui", "clear-needs-recheck", "unsupported-model", "encoded-provider-id", "drawer-settings", "xss-escaping", "mobile-layout", "legacy-state", "fatal-state", "exact-route-record", "real-backend-manual-while-disabled", "real-backend-lock-clear-retest", "no-live-upstream", "stale-drawer-cas", "stale-token-get-recovery", "recovery-loop-limit", "expired-token-stops-polling", "expired-write-no-replay", "ttl-zero-history-kept", "unavailable-route-not-passed", "conflict-refresh-failure-truthful", "expired-write-chinese-message", "expired-get-preserves-open-draft", "invalid-current-provider-can-disable-only", "invalid-other-provider-can-disable-only", "all-old-locks-remain-visible", "old-lock-clear-exact-key-needs-recheck", "history-empty-cache-explanation", "history-same-key-multiple-results", "history-safe-text-source-labels", "history-independent-of-active-locks", "history-page-navigation-no-writes", "history-poll-preserves-page-anchor-details-no-duplicates", "history-100-entry-navigation", "legacy-backend-history-hidden", "real-backend-same-key-history-persisted", "successful-latest-records-not-duplicated", "disabled-provider-lock-labelled-inactive", "last-lock-clear-hides-section-preserves-history", "history-reason-details-collapsed-safe", "exclusive-default-provider-view", "keyboard-accessible-view-navigation", "poll-keeps-current-view", "sticky-mobile-navigation", "bounded-history-viewport", "history-shrink-clamps-page", "real-backend-quick-current-history-toggle-preserves-other-settings", "sample-evidence-export-whitelist", "sample-evidence-poll-preserves-dom", "red-model-evidence-vs-yellow-403", "disabled-protection-neutral-badge", "legacy-pass-no-fabricated-validation"]}, ensure_ascii=False))

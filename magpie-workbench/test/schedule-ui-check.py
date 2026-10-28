"""Offline checks for the visible schedule status and one-click stop controls."""
from pathlib import Path
import json
import os
from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parent.parent
now = 1_800_000_000_000
state = {
    "version": "fixture", "health": "", "revision": 1,
    "targets": [
        {"id": "observe", "model": "demo/gpt-6-astra", "expected": "gpt-6-astra",
         "effort": "default", "mode": "observe", "intervalMinutes": 30,
         "scheduleEnabled": True, "nextAt": now + 20 * 60_000, "running": False,
         "stopping": False, "paused": False, "lastChecked": now - 10 * 60_000},
        {"id": "protect", "model": "backup/gpt-6-astra", "expected": "gpt-6-astra",
         "effort": "low", "mode": "protect", "intervalMinutes": 10,
         "scheduleEnabled": False, "nextAt": 0, "running": False,
         "stopping": False, "paused": True, "pauseReason": "两轮独立检测支持偏离",
         "lastChecked": now - 60_000},
    ],
    "history": [], "currentModel": {"model": "demo/gpt-6-astra", "source": "request",
                                    "effort": "default", "observedAt": "2026-10-18T10:00:00Z"},
    "candidates": ["gpt-6-astra"], "bankVersion": "fixture",
    "daily": {"used": 3, "limit": 60, "day": "2026-10-18"},
    "connection": {"url": "http://127.0.0.1:3425", "hasKey": False},
}
writes, errors = [], []


def route_request(route):
    path = route.request.url.split("19997", 1)[-1]
    if route.request.method == "GET":
        if path == "/api/state":
            return route.fulfill(content_type="application/json", body=json.dumps(state))
        if path == "/api/models":
            return route.fulfill(content_type="application/json",
                                  body=json.dumps({"models": [t["model"] for t in state["targets"]]}))
        asset = root / "history/page/settings.js" if path == "/history-settings.js" else root / "web" / (
            "index.html" if path == "/" else path.lstrip("/"))
        if asset.is_file():
            kind = {".html": "text/html", ".js": "text/javascript", ".css": "text/css",
                    ".svg": "image/svg+xml"}[asset.suffix]
            return route.fulfill(content_type=kind, body=asset.read_bytes())
        return route.fulfill(status=404, body="")
    body = route.request.post_data_json
    writes.append((path, body))
    if path != "/api/schedule":
        return route.fulfill(status=500, content_type="application/json",
                             body=json.dumps({"error": "unexpected write"}))
    selected = [t for t in state["targets"] if body.get("id") in (None, t["id"])]
    for target in selected:
        if body["action"] == "stop":
            target.update(scheduleEnabled=False, nextAt=0, running=False, stopping=False)
        else:
            target.update(scheduleEnabled=True, nextAt=now + target["intervalMinutes"] * 60_000)
    return route.fulfill(content_type="application/json", body=json.dumps({"ok": True}))


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, **({"executable_path": os.environ["CHROME_PATH"]}
                                                if os.environ.get("CHROME_PATH") else {}))
    page = browser.new_page(viewport={"width": 1440, "height": 1000})
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.route("**/*", route_request)
    page.goto("http://127.0.0.1:19997/")
    page.locator('[data-view="targets"]').click()
    expect(page.locator("#monitoringStatus")).to_have_text("定期检测已开启 · 1 个模型")
    expect(page.locator("#monitoringDetail")).to_contain_text("任务结束后点右侧停止")
    observe = page.locator('article.target[data-id="observe"]')
    protect = page.locator('article.target[data-id="protect"]')
    expect(observe).to_contain_text("定期检测已开启")
    expect(protect).to_contain_text("定期检测已停止")
    expect(protect).to_contain_text("解除模型暂停")
    expect(page.locator("#currentSchedule")).to_have_text("停止定期检测")
    page.locator("#stopAllChecks").click()
    expect(page.locator("#monitoringStatus")).to_have_text("定期检测已停止")
    assert writes[-1] == ("/api/schedule", {"action": "stop"})
    expect(protect).to_contain_text("两轮独立检测支持偏离")

    protect.get_by_role("button", name="恢复定期检测").click()
    expect(page.locator("#confirmText")).to_contain_text("每 10 分钟")
    page.locator('#confirmDialog button[value="ok"]').click()
    expect(page.locator("#monitoringStatus")).to_have_text("定期检测已开启 · 1 个模型")
    assert writes[-1] == ("/api/schedule", {"id": "protect", "action": "start"})

    observe_state = next(t for t in state["targets"] if t["id"] == "observe")
    observe_state.update(scheduleEnabled=True, running=True, stopping=False,
                         nextAt=now + 20 * 60_000)
    page.locator("#refresh").click()
    expect(page.locator("#monitoringStatus")).to_have_text("定期检测已开启 · 2 个模型")
    expect(observe.get_by_role("button", name="取消本轮")).to_be_visible()
    observe.get_by_role("button", name="停止定期检测").click()
    expect(observe).to_contain_text("定期检测已停止")
    assert writes[-1] == ("/api/schedule", {"id": "observe", "action": "stop"})

    output = root / ".runtime/schedule-ui"
    output.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(output / "schedule-controls-dark.png"), full_page=True)
    page.locator("#themeToggle").click()
    page.screenshot(path=str(output / "schedule-controls-light.png"), full_page=True)
    for width in (390, 768):
        page.set_viewport_size({"width": width, "height": 844})
        expect(page.locator("#monitoringControl")).to_be_visible()
        assert page.evaluate("document.documentElement.scrollWidth <= innerWidth + 1"), width
    page.screenshot(path=str(output / "schedule-controls-mobile.png"), full_page=True)

    assert all(path == "/api/schedule" for path, _ in writes), writes
    assert not errors, errors
    browser.close()
print("PASS visible schedule state; stop-all, per-target stop/resume; paused holds preserved; mobile; no model requests")

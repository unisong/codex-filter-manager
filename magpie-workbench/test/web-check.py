"""Offline browser checks for auto selection and the inline manual fallback."""
from pathlib import Path
import json
import os
from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parent.parent
state = {"version": json.loads((root / 'package.json').read_text(encoding='utf-8'))['version'], "health": "", "targets": [], "history": [], "currentModel": None,
    "candidates": ["gpt-6-astra", "gpt-6-luna"], "bankVersion": "fixture",
    "daily": {"used": 0, "limit": 60, "day": "2026-10-16"}, "connection": {"url": "http://127.0.0.1:3425", "hasKey": False}}
writes = []


def route_request(route):
    request = route.request
    path = request.url.split("19998", 1)[-1]
    if request.method != "GET":
        writes.append(path)
    if path == "/api/state":
        return route.fulfill(content_type="application/json", body=json.dumps(state))
    if path == "/api/models":
        return route.fulfill(content_type="application/json", body=json.dumps({"models": ["demo/gpt-6-astra", "backup/gpt-6-luna"]}))
    if path == "/history-settings.js":
        return route.fulfill(content_type="text/javascript", body=(root / "history/page/settings.js").read_bytes())
    asset = root / "web" / ("index.html" if path == "/" else path.lstrip("/"))
    if asset.is_file():
        return route.fulfill(content_type={".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml"}[asset.suffix], body=asset.read_bytes())
    route.fulfill(status=404, body="")


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, **({"executable_path": os.environ["CHROME_PATH"]} if os.environ.get("CHROME_PATH") else {}))
    page = browser.new_page(viewport={"width": 1440, "height": 1000})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.route("**/*", route_request)
    page.goto("http://127.0.0.1:19998/")
    expect(page.locator("#filters")).to_be_visible()
    expect(page.locator("#targets")).to_be_hidden()
    expect(page.locator('[data-view="filters"]')).to_have_class("nav active")
    expect(page.locator("#pageTitle")).to_have_text("历史过滤")
    page.locator('[data-view="targets"]').click()
    expect(page.locator("#targets")).to_be_visible()
    expect(page.locator("#filters")).to_be_hidden()
    expect(page.locator("#targetDialog")).to_be_visible()
    assert page.locator("#targetDialog").evaluate("e => e.tagName") == "SECTION"
    expect(page.locator("#currentCheck")).to_be_disabled()
    page.locator("#model").select_option("backup/gpt-6-luna")
    expect(page.locator("#expected")).to_have_value("gpt-6-luna")
    page.locator("#refresh").click()
    expect(page.locator("#model")).to_have_value("backup/gpt-6-luna")
    page.locator("#cancelTarget").click()
    expect(page.locator("#targetDialog")).to_be_hidden()
    # A real route automatically replaces the empty state, without saving a target.
    state["currentModel"] = {"model": "demo/gpt-6-astra", "source": "request", "effort": "high",
        "observedAt": "2026-10-16T12:00:00Z", "requestedModel": "group/coding", "reportedModel": "gpt-6-luna"}
    page.locator("#refresh").click()
    expect(page.locator("#currentModel")).to_have_text("demo/gpt-6-astra")
    expect(page.locator("#currentModelRoute")).to_have_text("请求入口：group/coding")
    expect(page.locator("#currentCheck")).to_be_enabled()
    expect(page.locator("#targetDialog")).to_be_hidden()
    page.locator("#add").click()
    expect(page.locator("#model")).to_have_value("demo/gpt-6-astra")
    expect(page.locator("#expected")).to_have_value("gpt-6-astra")
    expect(page.locator("#effort")).to_have_value("high")
    page.locator("#closeTarget").click()
    page.locator("#themeToggle").click()
    expect(page.locator("html")).to_have_attribute("data-theme", "dark")
    expect(page.locator("#themeToggle")).to_have_attribute("aria-label", "切换为浅色")
    assert page.locator("#targets .notice").evaluate("e => getComputedStyle(e).backgroundColor") == "rgb(41, 38, 32)"
    page.reload()
    expect(page.locator("html")).to_have_attribute("data-theme", "dark")
    expect(page.locator("#filters")).to_be_visible()
    expect(page.locator("#targetDialog")).to_be_hidden()
    page.locator('[data-view="targets"]').click()
    expect(page.locator("#targets")).to_be_visible()
    # History is used only when there is no business route to display.
    state["currentModel"] = None
    state["history"] = [{"id": "one", "model": "backup/gpt-6-luna", "expected": "gpt-6-luna", "effort": "low",
        "status": "matched", "startedAt": 1792152000000, "finishedAt": 1792152010000, "reason": "fixture only", "rounds": []}]
    page.locator("#refresh").click()
    expect(page.locator("#currentModel")).to_have_text("backup/gpt-6-luna")
    expect(page.locator("#currentModelSource")).to_contain_text("最近检测记录")
    output = root / ".runtime/ui-v03"
    output.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(output / "monitor-dark.png"), full_page=True)
    page.locator("#themeToggle").click()
    page.screenshot(path=str(output / "monitor-light.png"), full_page=True)
    for width in (390, 768):
        page.set_viewport_size({"width": width, "height": 844})
        assert page.evaluate("document.documentElement.scrollWidth <= innerWidth + 1"), width
    page.screenshot(path=str(output / "monitor-mobile.png"), full_page=True)
    assert not writes, writes
    assert not errors, errors
    browser.close()
print("PASS auto route > history > inline fallback; exact reference prefill; persistent icon theme; no writes or probes; desktop/mobile")

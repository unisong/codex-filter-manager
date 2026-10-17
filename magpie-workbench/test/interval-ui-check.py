"""Offline checks for preset/custom monitoring intervals and edit round-trips."""
from pathlib import Path
import json
import os
from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parent.parent
target = {"id": "fixture", "model": "demo/gpt-6-astra", "expected": "gpt-6-astra",
          "effort": "default", "mode": "manual", "intervalMinutes": 30, "paused": False}
state = {"version": "fixture", "health": "", "targets": [target], "history": [],
         "currentModel": {"model": target["model"], "source": "request"},
         "candidates": [target["expected"]], "bankVersion": "fixture",
         "daily": {"used": 0, "limit": 60, "day": "fixture"},
         "connection": {"url": "http://127.0.0.1:3425", "hasKey": False}}
writes, errors = [], []


def route_request(route):
    path = route.request.url.split("19998", 1)[-1]
    if route.request.method != "GET":
        writes.append(path)
        assert path == "/api/targets", "unexpected write or model request: " + path
        target.update(route.request.post_data_json)
        return route.fulfill(content_type="application/json", body=json.dumps(target))
    if path == "/api/state":
        return route.fulfill(content_type="application/json", body=json.dumps(state))
    if path == "/api/models":
        return route.fulfill(content_type="application/json", body=json.dumps({"models": [target["model"]]}))
    asset = root / "history/page/settings.js" if path == "/history-settings.js" else root / "web" / (
        "index.html" if path == "/" else path.lstrip("/"))
    if asset.is_file():
        return route.fulfill(content_type={".html": "text/html", ".js": "text/javascript",
                             ".css": "text/css", ".svg": "image/svg+xml"}[asset.suffix], body=asset.read_bytes())
    route.fulfill(status=404, body="")


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, **({"executable_path": os.environ["CHROME_PATH"]}
                                                if os.environ.get("CHROME_PATH") else {}))
    page = browser.new_page(viewport={"width": 1440, "height": 1000})
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.route("**/*", route_request)
    page.goto("http://127.0.0.1:19998/")
    assert page.locator("#interval option").evaluate_all("xs => xs.map(x => x.value)") == [
        "5", "10", "20", "30", "60", "custom"]
    for minutes in (5, 20, 17):
        page.locator("#add").click()
        if minutes == 17:
            page.locator("#interval").select_option("custom")
            expect(page.locator("#customInterval")).to_be_visible()
            for invalid in ("0", "1.5", "10081", ""):
                page.locator("#customInterval").fill(invalid)
                assert not page.locator("#customInterval").evaluate("e => e.checkValidity()")
            page.locator("#customInterval").fill("17")
        else:
            page.locator("#interval").select_option(str(minutes))
            expect(page.locator("#customInterval")).to_be_hidden()
        page.locator('#targetForm [type="submit"]').click()
        expect(page.locator("#targetDialog")).to_be_hidden()
        assert target["intervalMinutes"] == minutes
    page.reload()
    page.locator("#add").click()
    expect(page.locator("#interval")).to_have_value("custom")
    expect(page.locator("#customInterval")).to_have_value("17")
    page.locator('[name="mode"][value="observe"]').check()
    page.locator('#targetForm [type="submit"]').click()
    expect(page.locator("#confirmText")).to_contain_text("每 17 分钟")
    page.locator('#confirmDialog button[value="ok"]').click()
    expect(page.locator("#targetDialog")).to_be_hidden()
    assert target["mode"] == "observe"
    page.locator("#add").click()
    page.locator("#themeToggle").click()
    output = root / ".runtime/interval-ui"
    output.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(output / "custom-interval.png"), full_page=True)
    for width in (390, 768):
        page.set_viewport_size({"width": width, "height": 844})
        assert page.evaluate("document.documentElement.scrollWidth <= innerWidth + 1"), width
    assert writes == ["/api/targets"] * 4, writes
    assert not errors, errors
    browser.close()
print("PASS 5/20/custom intervals, validation, reload/edit round-trip, scheduling confirmation and mobile; no model requests")

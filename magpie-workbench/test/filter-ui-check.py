"""Offline checks of saved-order editing in both full-workbench filter pages."""
from pathlib import Path
from copy import deepcopy
import json
import os
from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parent.parent
providers = [{"id": "zulu", "name": "Zulu"}, {"id": "beta", "name": "Beta"},
             {"id": "alpha", "name": "Alpha"},
             {"id": "deleted-provider", "name": "", "hidden": True}]
initial = {"providers": {"magpie:zulu": {"historyFilter": True, "preserveEncryptedInclude": True},
                         "magpie:beta": {"historyFilter": False, "preserveEncryptedInclude": True}}, "aliases": {}}
output = root / ".runtime/filter-ui"
output.mkdir(parents=True, exist_ok=True)

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, **({"executable_path": os.environ["CHROME_PATH"]}
                                                if os.environ.get("CHROME_PATH") else {}))
    for native in (False, True):
        context = browser.new_context(viewport={"width": 1440, "height": 1000})
        page = context.new_page()
        saved = deepcopy(initial)
        fail_save = True
        writes, errors = [], []
        page.on("pageerror", lambda e: errors.append(str(e)))
        prefix = "http://127.0.0.1:19998"
        if native:
            context.add_init_script("""globalThis.magpie = {
                ready: Promise.resolve({lang:'zh-CN'}), onTheme() {},
                read: () => fetch('/fixture/providers').then(r=>r.json()),
                options: {
                    get: () => fetch('/fixture/options').then(r=>r.json()),
                    set: async options => {
                        const r = await fetch('/fixture/options', {method:'POST', body:JSON.stringify(options)});
                        if (!r.ok) throw Error('fixture save failure');
                        return r.json();
                    }
                }
            };""")

        def route_request(route):
            nonlocal_path = route.request.url.removeprefix(prefix)
            if nonlocal_path in ("/fixture/providers", "/fixture/options", "/api/filter"):
                if route.request.method == "POST":
                    writes.append(nonlocal_path)
                    if fail_save:
                        return route.fulfill(status=409, content_type="application/json",
                                             body=json.dumps({"error": "fixture save failure"}))
                    value = route.request.post_data_json
                    saved.clear()
                    saved.update(value if native else value["draft"])
                value = providers if nonlocal_path == "/fixture/providers" else saved if native else {
                    "providers": providers, "options": saved, "enabled": True}
                return route.fulfill(content_type="application/json", body=json.dumps(value))
            if nonlocal_path == "/api/state":
                return route.fulfill(content_type="application/json", body=json.dumps({
                    "version": "fixture", "health": "", "targets": [], "history": [],
                    "currentModel": {"model": "zulu/gpt-6-astra", "source": "request"},
                    "candidates": ["gpt-6-astra"], "bankVersion": "fixture",
                    "daily": {"used": 0, "limit": 60, "day": "fixture"},
                    "connection": {"url": prefix, "hasKey": False}}))
            if nonlocal_path == "/api/models":
                return route.fulfill(content_type="application/json", body='{"models":[]}')
            if nonlocal_path in ("/_magpie/bridge.js", "/icon.svg") and native:
                asset = root / "history/page" / nonlocal_path.lstrip("/")
            elif nonlocal_path == "/history-settings.js":
                asset = root / "history/page/settings.js"
            else:
                asset = root / ("history/page" if native else "web") / (
                    "index.html" if nonlocal_path == "/" else nonlocal_path.lstrip("/"))
            if asset.is_file():
                return route.fulfill(content_type={".html": "text/html", ".js": "text/javascript",
                                     ".css": "text/css", ".svg": "image/svg+xml"}[asset.suffix], body=asset.read_bytes())
            route.fulfill(status=404, body="")

        page.route("**/*", route_request)
        page.goto(prefix)
        if not native:
            page.locator('[data-view="filters"]').click()
        ids = {"list": "providers" if native else "filterRows", "toggle": "enabledOnly" if native else "filterEnabledOnly",
               "search": "search" if native else "filterSearch", "save": "save" if native else "filterSave",
               "refresh": "refresh" if native else "filterRefresh", "count": "count" if native else "filterCount",
               "empty": "empty" if native else "filterEmpty", "discard": "discard" if native else "filterDiscard"}
        def control(name):
            return page.locator("#" + ids[name])
        rows = page.locator("#" + ids["list"] + " > div")
        def row_ids():
            return rows.locator('input[data-field="historyFilter"]').evaluate_all("xs => xs.map(x=>x.dataset.id)")
        def switch(provider):
            return page.locator(f'#{ids["list"]} input[data-id="{provider}"][data-field="historyFilter"]')

        expect(rows).to_have_count(3)
        assert "deleted-provider" not in row_ids(), "hidden provider tombstones must not appear"
        assert row_ids() == ["zulu", "alpha", "beta"], "saved-but-off rules must not affect name sorting"
        expect(control("count")).to_have_text("共 3 个供应商 · 已开启 1 个")
        control("toggle").click()
        expect(control("toggle")).to_have_attribute("aria-pressed", "true")
        expect(rows).to_have_count(1)
        control("search").fill("alpha")
        expect(control("empty")).to_contain_text("取消筛选以搜索全部供应商")
        expect(control("count")).to_have_text("共 3 个供应商 · 已开启 1 个 · 找到 0 个")
        control("toggle").click()
        expect(rows).to_have_count(1)
        expect(switch("alpha")).not_to_be_checked()
        control("search").fill("")
        control("toggle").click()
        switch("zulu").uncheck()
        expect(rows).to_have_count(1)
        expect(switch("zulu")).not_to_be_checked()
        expect(control("toggle")).to_have_text("只看已开启 · 1")
        control("refresh").click()
        expect(control("refresh")).to_be_enabled()
        expect(switch("zulu")).not_to_be_checked()
        control("save").click()
        expect(control("save")).to_be_enabled(timeout=5000)
        expect(rows).to_have_count(1)
        assert saved["providers"]["magpie:zulu"]["historyFilter"] is True
        fail_save = False
        control("save").click()
        expect(rows).to_have_count(0)
        expect(control("toggle")).to_have_text("只看已开启 · 0")
        control("toggle").click()
        assert row_ids() == ["alpha", "beta", "zulu"]
        switch("beta").check()
        assert row_ids() == ["alpha", "beta", "zulu"], "unsaved toggle reordered the list"
        control("discard").click()
        expect(switch("beta")).not_to_be_checked()
        switch("beta").check()
        expect(control("save")).to_be_enabled(timeout=5000)
        control("save").click()
        expect(control("save")).to_be_disabled()
        expect(switch("beta")).to_be_checked()
        expect(control("count")).to_have_text("共 3 个供应商 · 已开启 1 个")
        assert row_ids() == ["beta", "alpha", "zulu"]
        control("search").fill("zulu")
        expect(rows).to_have_count(1)
        control("search").fill("")
        page.screenshot(path=str(output / ("native.png" if native else "workbench.png")), full_page=True)
        for width in (390, 768):
            page.set_viewport_size({"width": width, "height": 844})
            assert page.evaluate("document.documentElement.scrollWidth <= innerWidth + 1"), (native, width)
        assert len(writes) == 3, writes
        assert not errors, errors
        context.close()
    browser.close()
print("PASS both filter pages: saved ordering, enabled-only toggle, search hint, retained edits, failed/successful save, discard, mobile layout; no real requests")

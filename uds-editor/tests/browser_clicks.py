import asyncio
from playwright.async_api import async_playwright
# Настоящие клики мышью по карте: дорога, светофор, узел перекрёстка, кружок проблемы — в том числе при включённой зоне доступности
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        page = await b.new_page(viewport={"width": 1440, "height": 900})
        errs=[]; page.on("pageerror", lambda e: errs.append(str(e)))
        page.on("dialog", lambda d: asyncio.ensure_future(d.accept()))
        await page.goto("http://localhost:8765/index.html?file=example.osm")
        await page.wait_for_function("window.editor.state.doc !== null"); await page.wait_for_timeout(600)
        mb = await page.locator("#map").bounding_box()
        async def click_ll(lat, lon, dx=0):
            pt = await page.evaluate(f"(()=>{{const p=window.editor.map.latLngToContainerPoint([{lat},{lon}]);return [p.x,p.y]}})()")
            await page.mouse.click(mb["x"]+pt[0]+dx, mb["y"]+pt[1]); await page.wait_for_timeout(400)
            return await page.evaluate("JSON.stringify(window.editor.state.sel)")
        results = {}
        for label, setup in [("обычная карта", ""), ("с зоной доступности", "zone")]:
            await page.evaluate("(()=>{window.editor.select(null);window.editor.setMode('select');return null})()")
            if setup == "zone":
                await page.click(".tabs button[data-tab=ot]"); await page.click("#tab-ot button:has-text('Показать зону')"); await page.wait_for_timeout(1200)
            # середина отрезка Лермонтова
            mid = await page.evaluate("(()=>{const d=window.editor.state.doc,w=d.ways.get('81608266'),a=d.nodes.get(w.nodes[0]),b=d.nodes.get(w.nodes[1]);window.editor.map.setView([(a.lat+b.lat)/2,(a.lon+b.lon)/2],18,{animate:false});return [(a.lat+b.lat)/2,(a.lon+b.lon)/2]})()")
            await page.wait_for_timeout(500)
            r1 = await click_ll(*mid)
            # светофор
            sig = await page.evaluate("(()=>{const n=window.editor.state.doc.nodes.get('1498865642');window.editor.select(null);window.editor.map.setView([n.lat,n.lon],18,{animate:false});return [n.lat,n.lon]})()")
            await page.wait_for_timeout(500)
            r2 = await click_ll(*sig)
            # кружок проблемы
            iss = await page.evaluate("(()=>{const i=window.editor.state.issues.find(x=>x.type==='gap');window.editor.map.setView([i.lat,i.lon],18,{animate:false});return [i.lat,i.lon]})()")
            await page.wait_for_timeout(500)
            await click_ll(*iss, dx=9)
            r3 = await page.evaluate("document.querySelectorAll('#tab-issues .issue.active').length")
            results[label] = (r1, r2, r3)
        for k,v in results.items(): print(k, "| дорога:", v[0], "| светофор:", v[1], "| проблема выделена:", v[2])
        print("ERR", errs)
        await b.close()
asyncio.run(main())

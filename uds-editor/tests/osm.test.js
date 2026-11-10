// Тесты ядра: node tests/osm.test.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { DOMParser } = require("@xmldom/xmldom");
const OSMlib = require("../js/osm.js");
const { OsmDoc, isDrivable, angleDiff } = OSMlib;

const P = DOMParser;
let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log("ok  ", name); }
  catch (e) { console.error("FAIL", name, "\n", e); process.exitCode = 1; }
}

const SMALL = `<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6" generator="test">
 <bounds minlat="52.0" minlon="104.0" maxlat="52.01" maxlon="104.01"/>
 <node id="1" version="1" lat="52.005" lon="104.002"/>
 <node id="2" version="1" lat="52.005" lon="104.004"/>
 <node id="3" version="1" lat="52.005" lon="104.008"><tag k="highway" v="crossing"/></node>
 <node id="4" version="1" lat="52.003" lon="104.005"/>
 <node id="5" version="1" lat="52.007" lon="104.005"/>
 <way id="10" version="1"><nd ref="1"/><nd ref="2"/><nd ref="3"/><tag k="highway" v="primary"/><tag k="name" v="Ленина &amp; Ко"/><tag k="lanes:forward" v="2"/></way>
 <way id="11" version="1"><nd ref="4"/><nd ref="5"/><tag k="highway" v="residential"/></way>
 <relation id="20" version="1"><member type="way" ref="10" role=""/><member type="node" ref="3" role="stop"/><tag k="type" v="route"/></relation>
</osm>`;

const load = (t) => OsmDoc.parse(t, P);

test("чтение: узлы, линии, отношения, теги, экранирование", () => {
  const d = load(SMALL);
  assert.strictEqual(d.nodes.size, 5);
  assert.strictEqual(d.ways.size, 2);
  assert.strictEqual(d.ways.get("10").tags.name, "Ленина & Ко");
  assert.deepStrictEqual(d.relations.get("20").members[1], { type: "node", ref: "3", role: "stop" });
  assert.strictEqual(d.nextId, 21);
});

test("запись → чтение без потерь", () => {
  const d = load(SMALL);
  const d2 = load(d.serialize());
  assert.strictEqual(d2.serialize(), d.serialize());
  assert.ok(d.serialize().includes('v="Ленина &amp; Ко"'));
  assert.ok(d.serialize().includes('<bounds minlat="52.0"'));
});

test("example.osm: запись → чтение без потерь", () => {
  const text = fs.readFileSync(path.join(__dirname, "..", "example.osm"), "utf8");
  const d = load(text);
  const out = d.serialize();
  const d2 = load(out);
  assert.strictEqual(d2.nodes.size, d.nodes.size);
  assert.strictEqual(d2.ways.size, d.ways.size);
  assert.strictEqual(d2.relations.size, d.relations.size);
  assert.strictEqual(d2.serialize(), out);
  // Координаты не теряют точность
  for (const [id, n] of d.nodes) {
    const m = d2.nodes.get(id);
    assert.ok(Math.abs(n.lat - m.lat) < 1e-7 && Math.abs(n.lon - m.lon) < 1e-7, id);
  }
});

test("теги, отмена и повтор", () => {
  const d = load(SMALL);
  d.edit("полосы", () => d.setTag("way", "10", "lanes", "4"));
  assert.strictEqual(d.ways.get("10").tags.lanes, "4");
  d.undo();
  assert.strictEqual(d.ways.get("10").tags.lanes, undefined);
  d.redo();
  assert.strictEqual(d.ways.get("10").tags.lanes, "4");
  assert.ok(d.dirty);
});

test("пустая правка не создаёт шаг отмены", () => {
  const d = load(SMALL);
  d.edit("ничего", () => d.setTag("way", "10", "highway", "primary"));
  assert.strictEqual(d.undoStack.length, 0);
});

test("ошибка внутри правки откатывает изменения", () => {
  const d = load(SMALL);
  assert.throws(() => d.edit("сломать", () => { d.setTag("way", "10", "lanes", "9"); d.splitWay("10", "1"); }));
  assert.strictEqual(d.ways.get("10").tags.lanes, undefined);
});

test("разворот: порядок узлов и forward/backward", () => {
  const d = load(SMALL);
  d.edit("разворот", () => d.reverseWay("10"));
  assert.deepStrictEqual(d.ways.get("10").nodes, ["3", "2", "1"]);
  assert.strictEqual(d.ways.get("10").tags["lanes:backward"], "2");
  assert.strictEqual(d.ways.get("10").tags["lanes:forward"], undefined);
});

test("разрезание: новая линия с теми же тегами и в тех же отношениях", () => {
  const d = load(SMALL);
  const nid = d.edit("разрез", () => d.splitWay("10", "2"));
  assert.deepStrictEqual(d.ways.get("10").nodes, ["1", "2"]);
  assert.deepStrictEqual(d.ways.get(nid).nodes, ["2", "3"]);
  assert.strictEqual(d.ways.get(nid).tags.highway, "primary");
  assert.deepStrictEqual(d.relations.get("20").members.map((m) => m.ref), ["10", nid, "3"]);
  d.undo();
  assert.deepStrictEqual(d.ways.get("10").nodes, ["1", "2", "3"]);
  assert.ok(!d.ways.has(nid));
  assert.strictEqual(d.relations.get("20").members.length, 2);
});

test("удаление узла и линии, чистка отношений и сирот", () => {
  const d = load(SMALL);
  d.edit("удалить узел", () => d.deleteNode("2"));
  assert.deepStrictEqual(d.ways.get("10").nodes, ["1", "3"]);
  d.edit("удалить линию", () => d.deleteWay("11"));
  assert.ok(!d.ways.has("11"));
  assert.ok(!d.nodes.has("4") && !d.nodes.has("5"), "узлы без тегов и линий удаляются");
  d.edit("удалить ещё", () => d.deleteWay("10"));
  assert.ok(d.nodes.has("3"), "узел с тегами остаётся");
  assert.deepStrictEqual(d.relations.get("20").members.map((m) => m.ref), ["3"]);
  d.undo(); d.undo(); d.undo();
  assert.strictEqual(load(d.serialize()).serialize(), load(SMALL).serialize());
});

test("слияние узлов соединяет дороги в перекрёсток", () => {
  const d = load(SMALL);
  // Узел 4 — начало улицы 11 — сливаем с узлом 2 улицы 10
  d.edit("слить", () => d.mergeNodes("2", "4"));
  assert.deepStrictEqual(d.ways.get("11").nodes, ["2", "5"]);
  assert.ok(!d.nodes.has("4"));
  assert.deepStrictEqual([...d.nodeWays.get("2")].sort(), ["10", "11"]);
});

test("новая дорога и вставка узла", () => {
  const d = load(SMALL);
  const wid = d.edit("новая", () => {
    const a = d.addNode(52.006, 104.001);
    return d.addWay([a, "1"], { highway: "service" });
  });
  assert.strictEqual(d.ways.get(wid).nodes[1], "1");
  assert.ok(Number(wid) > 20);
  const n = d.edit("вставка", () => d.insertNode("10", 0, 52.005, 104.0035));
  assert.deepStrictEqual(d.ways.get("10").nodes, ["1", n, "2", "3"]);
  const out = d.serialize();
  assert.ok(out.includes(`<way id="${wid}" visible="true" version="1">`));
});

test("перемещение узла и отмена", () => {
  const d = load(SMALL);
  d.edit("сдвиг", () => d.moveNode("2", 52.0055, 104.0041));
  assert.strictEqual(d.nodes.get("2").lat, 52.0055);
  d.undo();
  assert.strictEqual(d.nodes.get("2").lat, 52.005);
});

test("проверка: пересечение без узла и исправление", () => {
  const d = load(SMALL);
  const issues = d.validate();
  const x = issues.find((i) => i.type === "crossing");
  assert.ok(x, "пересечение 10 и 11 найдено");
  assert.ok(issues.some((i) => i.type === "isolated"), "до соединения улица 11 изолирована");
  d.edit("соединить", () => d.applyFix(x.fix));
  const after = d.validate();
  assert.ok(!after.some((i) => i.type === "crossing"));
  assert.ok(!after.some((i) => i.type === "isolated"));
});

test("проверка: разорванный перекрёсток и односторонний тупик", () => {
  const t = SMALL.replace('<node id="4" version="1" lat="52.003" lon="104.005"/>',
                          '<node id="4" version="1" lat="52.00502" lon="104.005"/>')
                 .replace('<tag k="highway" v="residential"/>', '<tag k="highway" v="residential"/><tag k="oneway" v="yes"/>')
                 .replace('<nd ref="4"/><nd ref="5"/>', '<nd ref="5"/><nd ref="4"/>');
  const d = load(t);
  const issues = d.validate();
  const gap = issues.find((i) => i.type === "gap");
  assert.ok(gap, "разрыв ~2 м найден");
  assert.ok(issues.some((i) => i.type === "deadend"), "односторонняя улица упирается в никуда");
  assert.strictEqual(gap.fix.kind, "snap", "конец рядом с серединой дороги — притянуть на отрезок");
  d.edit("исправить", () => d.applyFix(gap.fix));
  assert.ok(d.ways.get("10").nodes.includes("4"));
  const after = d.validate();
  assert.ok(!after.some((i) => i.type === "gap"));
  // тупик в узле 4 (въезд без выезда) исчез: улица теперь выходит на улицу 10
  assert.ok(!after.some((i) => i.type === "deadend" && i.nodes.includes("4")));
});

test("разрыв у самого узла другой дороги — слияние узлов", () => {
  const t = SMALL.replace('<node id="4" version="1" lat="52.003" lon="104.005"/>',
                          '<node id="4" version="1" lat="52.00501" lon="104.00401"/>');
  const d = load(t);
  const gap = d.validate().find((i) => i.type === "gap");
  assert.ok(gap);
  assert.deepStrictEqual([gap.fix.kind, gap.fix.keep], ["merge", "2"]);
  d.edit("исправить", () => d.applyFix(gap.fix));
  assert.ok(!d.nodes.has("4"));
  assert.ok(!d.validate().some((i) => i.type === "gap" || i.type === "isolated"));
});

test("автоисправление моста добавляет layer", () => {
  const d = load(SMALL.replace('<tag k="highway" v="residential"/>', '<tag k="highway" v="residential"/><tag k="bridge" v="yes"/>'));
  const b = d.validate().find((i) => i.type === "bridge");
  d.edit("мост", () => d.applyFix(b.fix));
  assert.strictEqual(d.ways.get("11").tags.layer, "1");
  assert.ok(!d.validate().some((i) => i.type === "bridge"));
});

test("полосы по направлениям", () => {
  const d = load(SMALL);
  d.edit("полосы", () => d.setLanes("11", 2, 1));
  assert.deepStrictEqual(
    [d.ways.get("11").tags.lanes, d.ways.get("11").tags["lanes:forward"], d.ways.get("11").tags["lanes:backward"]], ["3", "2", "1"]);
  assert.deepStrictEqual(d.lanesOf(d.ways.get("11")), { forward: 2, backward: 1, total: 3, known: true });
  d.edit("одностор", () => { d.setTag("way", "11", "oneway", "yes"); d.setLanes("11", 2, 0); });
  assert.strictEqual(d.ways.get("11").tags.lanes, "2");
  assert.ok(!("lanes:forward" in d.ways.get("11").tags));
  assert.deepStrictEqual(d.lanesOf({ tags: { highway: "primary", lanes: "4" } }), { forward: 2, backward: 2, total: 4, known: true });
});

test("массовая правка одним шагом отмены", () => {
  const d = load(SMALL);
  const n = d.edit("пешеходы", () => d.bulkSetTag((w) => w.tags.highway === "primary", "foot", "no"));
  assert.strictEqual(n, 1);
  assert.strictEqual(d.ways.get("10").tags.foot, "no");
  d.undo();
  assert.strictEqual(d.ways.get("10").tags.foot, undefined);
});

test("example.osm: проверка находит проблемы и работает быстро", () => {
  const d = load(fs.readFileSync(path.join(__dirname, "..", "example.osm"), "utf8"));
  const t0 = Date.now();
  const issues = d.validate();
  const ms = Date.now() - t0;
  const by = {};
  for (const i of issues) by[i.type] = (by[i.type] || 0) + 1;
  console.log("     проблемы в example.osm:", JSON.stringify(by), `(${ms} мс)`, JSON.stringify(d.stats()));
  assert.ok(ms < 3000);
});


// ---------- файлы из других источников ----------

test("файл из JOSM: отрицательные id, action=modify/delete", () => {
  const t = `<?xml version='1.0' encoding='UTF-8'?>
<osm version='0.6' upload='false' generator='JOSM'>
  <node id='-101' action='modify' lat='52.0' lon='104.0' />
  <node id='-102' action='modify' lat='52.0' lon='104.001' />
  <node id='55' action='delete' visible='true' version='3' lat='52.0' lon='104.002' />
  <way id='-201' action='modify'><nd ref='-101' /><nd ref='-102' /><tag k='highway' v='residential' /></way>
</osm>`;
  const d = load(t);
  assert.strictEqual(d.nodes.size, 2, "удалённый в JOSM узел не читается");
  const nid = d.edit("новый", () => d.addNode(52.1, 104.1));
  assert.ok(!d.nodes.has(nid) || Number(nid) > 0);
  assert.ok(!["-101", "-102", "-201"].includes(nid), "новые id не совпадают с существующими");
  assert.strictEqual(load(d.serialize()).ways.get("-201").nodes.length, 2);
});

test("выгрузка Overpass: note, meta, без bounds, без version", () => {
  const t = `<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6" generator="Overpass API 0.7.62">
<note>The data included in this document is from www.openstreetmap.org.</note>
<meta osm_base="2026-11-09T05:00:00Z"/>
  <node id="1" lat="52.1" lon="104.1"/>
  <node id="2" lat="52.1" lon="104.2"/>
  <way id="3"><nd ref="1"/><nd ref="2"/><tag k="highway" v="primary"/></way>
</osm>`;
  const d = load(t);
  const out = d.serialize();
  assert.ok(out.includes("<note>") && out.includes("<meta osm_base"), "служебные элементы сохраняются");
  assert.strictEqual(load(out).serialize(), out);
  assert.ok(Array.isArray(d.validate()));
});

test("неполная выгрузка: линия ссылается на отсутствующие узлы", () => {
  const t = `<osm version="0.6"><node id="1" lat="52" lon="104"/><node id="2" lat="52" lon="104.001"/>
  <way id="3"><nd ref="1"/><nd ref="2"/><nd ref="999"/><tag k="highway" v="service"/></way>
  <way id="4"><nd ref="998"/><nd ref="999"/><tag k="highway" v="service"/></way></osm>`;
  const d = load(t);
  assert.deepStrictEqual(d.ways.get("3").nodes, ["1", "2"]);
  assert.ok(!d.ways.has("4"));
  assert.strictEqual(d.missingNodeRefs, 3);
});

test("не OSM и битый XML — понятная ошибка", () => {
  assert.throws(() => load("<gpx></gpx>"), /<osm>/);
  assert.throws(() => load("<osm><node id='1'"), /XML/);
});


// ---------- ловушки, склейки, направления, автозаполнение, правки ----------

const GRID = (extra) => `<osm version="0.6">
 <bounds minlat="51.99" minlon="103.99" maxlat="52.02" maxlon="104.02"/>
 <node id="1" lat="52.000" lon="104.000"/><node id="2" lat="52.000" lon="104.003"/><node id="3" lat="52.000" lon="104.006"/>
 <node id="4" lat="52.003" lon="104.000"/><node id="5" lat="52.003" lon="104.003"/><node id="6" lat="52.003" lon="104.006"/>
 <node id="7" lat="52.006" lon="104.003"/><node id="8" lat="52.006" lon="104.006"/>
 <way id="10"><nd ref="1"/><nd ref="2"/><nd ref="3"/><tag k="highway" v="secondary"/></way>
 <way id="11"><nd ref="4"/><nd ref="5"/><nd ref="6"/><tag k="highway" v="secondary"/></way>
 <way id="12"><nd ref="1"/><nd ref="4"/><tag k="highway" v="residential"/></way>
 <way id="13"><nd ref="3"/><nd ref="6"/><tag k="highway" v="residential"/></way>
 ${extra}
</osm>`;

test("ловушка из нескольких улиц находится, обычная сеть — нет", () => {
  assert.ok(!load(GRID("")).validate().some((i) => i.type === "trap"));
  // Въезд по односторонней 5→7, дальше петля 7-8 в обе стороны, выезда нет
  const d = load(GRID(`<way id="14"><nd ref="5"/><nd ref="7"/><tag k="highway" v="residential"/><tag k="oneway" v="yes"/></way>
    <way id="15"><nd ref="7"/><nd ref="8"/><tag k="highway" v="residential"/></way>`));
  const trap = d.validate().find((i) => i.type === "trap");
  assert.ok(trap, "ловушка найдена");
  assert.ok(trap.ways.includes("15"));
  assert.ok(/въехать, но нельзя выехать/.test(trap.message));
  // Сделали 5-7 двусторонней — ловушки нет
  d.edit("двусторонняя", () => d.setTag("way", "14", "oneway", ""));
  assert.ok(!d.validate().some((i) => i.type === "trap"));
});

test("склеенный перекрёсток: мост с общим узлом посередине и расклейка", () => {
  const d = load(GRID(`<node id="9" lat="52.0015" lon="104.003"/>
    <way id="16"><nd ref="2"/><nd ref="9"/><nd ref="5"/><tag k="highway" v="secondary"/><tag k="bridge" v="yes"/><tag k="layer" v="1"/></way>
    <way id="17"><nd ref="12345"/></way>
    <node id="20" lat="52.0015" lon="104.001"/><node id="21" lat="52.0015" lon="104.005"/>
    <way id="18"><nd ref="20"/><nd ref="9"/><nd ref="21"/><tag k="highway" v="residential"/></way>`));
  const glued = d.validate().find((i) => i.type === "glued");
  assert.ok(glued, "склейка найдена");
  d.edit("расклеить", () => d.applyFix(glued.fix));
  assert.ok(!d.validate().some((i) => i.type === "glued"));
  assert.notStrictEqual(d.ways.get("18").nodes[1], "9");
  assert.strictEqual(d.ways.get("16").nodes[1], "9");
});

test("встречные односторонние части одной улицы", () => {
  const d = load(GRID(`<way id="14"><nd ref="4"/><nd ref="7"/><tag k="highway" v="residential"/><tag k="oneway" v="yes"/><tag k="name" v="Тестовая"/></way>
    <way id="15"><nd ref="8"/><nd ref="7"/><tag k="highway" v="residential"/><tag k="oneway" v="yes"/><tag k="name" v="Тестовая"/></way>
    <way id="19"><nd ref="7"/><nd ref="5"/><tag k="highway" v="service"/><tag k="oneway" v="yes"/></way>`));
  assert.ok(d.validate().some((i) => i.type === "direction"));
});

test("автозаполнение: план без изменений, применение одним шагом", () => {
  const d = load(GRID(""));
  const plan = d.autofillPlan({ secondary: { lanes: 2, oneLanes: 2, maxspeed: 60 }, residential: { lanes: 2, oneLanes: 1, maxspeed: 40 } });
  assert.strictEqual(plan.length, 8);
  assert.strictEqual(d.ways.get("10").tags.lanes, undefined, "план ничего не меняет");
  d.edit("автозаполнение", () => d.applyAutofill(plan));
  assert.deepStrictEqual([d.ways.get("10").tags.lanes, d.ways.get("10").tags["lanes:forward"], d.ways.get("12").tags.maxspeed], ["2", "1", "40"]);
  d.undo();
  assert.strictEqual(d.ways.get("10").tags.lanes, undefined);
});

test("было — стало", () => {
  const d = load(GRID(""));
  d.snapshotBase();
  d.edit("правки", () => {
    d.setTag("way", "10", "lanes", "4");
    d.deleteWay("13");
    const a = d.addNode(52.004, 104.004);
    d.addWay([a, "5"], { highway: "service" });
  });
  const kinds = {};
  for (const c of d.diff()) kinds[c.type + ":" + c.kind] = (kinds[c.type + ":" + c.kind] || 0) + 1;
  assert.strictEqual(kinds["way:modified"], 1);
  assert.strictEqual(kinds["way:deleted"], 1);
  assert.strictEqual(kinds["way:added"], 1);
  assert.strictEqual(kinds["node:added"], 1);
});

test("обмен правками между двумя участниками", () => {
  const A = load(GRID("")), B = load(GRID(""));
  A.snapshotBase(); B.snapshotBase();
  A.edit("A", () => { A.setTag("way", "10", "lanes", "4"); const n = A.addNode(52.004, 104.004); A.addWay([n, "5"], { highway: "service", name: "A" }); });
  B.edit("B", () => { B.setTag("way", "11", "maxspeed", "40"); const n = B.addNode(52.005, 104.005); B.addWay([n, "6"], { highway: "service", name: "B" }); });
  const patch = JSON.parse(JSON.stringify(A.exportPatch()));
  const res = B.edit("слить", () => B.applyPatch(patch));
  assert.strictEqual(res.conflicts.length, 0);
  assert.strictEqual(B.ways.get("10").tags.lanes, "4");
  assert.strictEqual(B.ways.get("11").tags.maxspeed, "40");
  const names = [...B.ways.values()].filter((w) => w.tags.highway === "service").map((w) => w.tags.name).sort();
  assert.deepStrictEqual(names, ["A", "B"], "обе новые дороги на месте, id не столкнулись");
  for (const w of B.ways.values()) for (const n of w.nodes) assert.ok(B.nodes.has(n), "все ссылки целы");
  // Конфликт: оба правили одну дорогу по-разному
  const C = load(GRID("")); C.snapshotBase();
  C.edit("C", () => C.setTag("way", "10", "lanes", "2"));
  const r2 = C.edit("слить", () => C.applyPatch(patch));
  assert.strictEqual(r2.conflicts.length, 1);
  assert.strictEqual(C.ways.get("10").tags.lanes, "2");
  // Сохранённый результат снова читается
  assert.ok(load(B.serialize()).ways.size > 0);
});


// ---------- пешеходный анализ ----------
const Ped = require("../js/pedestrians.js");

test("пешеходы: маршрут через переход и поиск перехода вне разметки", () => {
  // Магистраль 1-2-3 по широте 52.000; тротуары по обе стороны соединены дорожкой через узел 2 магистрали
  const t = `<osm version="0.6">
   <node id="1" lat="52.000" lon="104.000"/><node id="2" lat="52.000" lon="104.002"/><node id="3" lat="52.000" lon="104.004"/>
   <node id="11" lat="51.9995" lon="104.000"/><node id="12" lat="51.9995" lon="104.002"/><node id="13" lat="51.9995" lon="104.004"/>
   <node id="21" lat="52.0005" lon="104.000"/><node id="22" lat="52.0005" lon="104.002"/><node id="23" lat="52.0005" lon="104.004"/>
   <way id="1"><nd ref="1"/><nd ref="2"/><nd ref="3"/><tag k="highway" v="primary"/></way>
   <way id="2"><nd ref="11"/><nd ref="12"/><nd ref="13"/><tag k="highway" v="footway"/></way>
   <way id="3"><nd ref="21"/><nd ref="22"/><nd ref="23"/><tag k="highway" v="footway"/></way>
   <way id="4"><nd ref="12"/><nd ref="2"/><nd ref="22"/><tag k="highway" v="footway"/></way>
   <node id="31" lat="51.9993" lon="104.000"/><node id="32" lat="51.9993" lon="104.0003"/><node id="33" lat="51.9991" lon="104.0003"/>
   <way id="5"><nd ref="31"/><nd ref="32"/><nd ref="33"/><nd ref="31"/><tag k="building" v="yes"/><tag k="building:levels" v="5"/></way>
   <node id="41" lat="52.0007" lon="104.004"><tag k="highway" v="bus_stop"/></node>
  </osm>`;
  const d = load(t);
  assert.ok(!Ped.walkable(d.ways.get("1")), "вдоль магистрали без тротуара не ходят");
  const r = Ped.analyze(d, { trips: 50, toStopsShare: 1 });
  assert.ok(r.stats.routed > 0, "маршруты построены");
  assert.strictEqual(r.crossings[0].node, "2", "переход через узел 2 без разметки найден");
  // Поставили переход — больше не «где попало»
  d.edit("зебра", () => d.setTags("node", "2", { highway: "crossing", crossing: "uncontrolled" }));
  assert.strictEqual(Ped.analyze(d, { trips: 50, toStopsShare: 1 }).crossings.length, 0);
});

test("пешеходы: example.osm считается быстро и повторяемо", () => {
  const d = load(fs.readFileSync(path.join(__dirname, "..", "example.osm"), "utf8"));
  const t0 = Date.now();
  const r = Ped.analyze(d, { trips: 400 });
  const ms = Date.now() - t0;
  const r2 = Ped.analyze(d, { trips: 400 });
  console.log("     пешеходы example.osm:", JSON.stringify(r.stats), "переходов вне разметки:", r.crossings.length, `(${ms} мс)`);
  assert.ok(r.stats.routed > 300);
  assert.deepStrictEqual(r.crossings.map((c) => c.node), r2.crossings.map((c) => c.node));
  assert.ok(ms < 5000);
});


// ---------- дворы, светофоры ----------

test("тупик во дворе — предупреждение, noexit=yes убирает его", () => {
  const d = load(GRID(`<node id="30" lat="52.0045" lon="104.0015"/>
    <way id="31"><nd ref="5"/><nd ref="30"/><tag k="highway" v="service"/><tag k="oneway" v="yes"/></way>`));
  const dead = d.validate().find((i) => i.type === "deadend" || i.type === "trap");
  assert.ok(dead, "односторонний въезд во двор найден");
  assert.strictEqual(dead.severity, "warning", "во дворе — не ошибка, а предупреждение");
  d.edit("норма", () => d.applyFix(dead.fix));
  assert.strictEqual(d.nodes.get(dead.fix.node).tags.noexit, "yes");
  assert.ok(!d.validate().some((i) => i.type === "deadend" || i.type === "trap"));
});

test("односторонний тупик на улице — по-прежнему ошибка", () => {
  const d = load(GRID(`<node id="30" lat="52.0045" lon="104.0015"/>
    <way id="31"><nd ref="5"/><nd ref="30"/><tag k="highway" v="residential"/><tag k="oneway" v="yes"/></way>`));
  const dead = d.validate().find((i) => i.type === "deadend");
  assert.strictEqual(dead.severity, "error");
});

test("изолированный двор — предупреждение", () => {
  const d = load(GRID(`<node id="40" lat="52.010" lon="104.010"/><node id="41" lat="52.011" lon="104.010"/>
    <way id="42"><nd ref="40"/><nd ref="41"/><tag k="highway" v="service"/></way>`));
  const iso = d.validate().find((i) => i.type === "isolated");
  assert.strictEqual(iso.severity, "warning");
});

test("подъезды к перекрёстку и программа по умолчанию", () => {
  const d = load(GRID(""));
  // узел 4: улица 11 на восток и улица 12 на юг — Т-образный
  const a = d.approaches("4");
  assert.deepStrictEqual(a.map((x) => x.bearing).sort((x, y) => x - y), [90, 180]);
  assert.ok(a.every((x) => x.incoming));
  const p = d.defaultTlsProgram("4");
  assert.strictEqual(p.phases.length, 2);
  d.edit("tls", () => d.setTlsProgram("4", p));
  assert.strictEqual(d.nodes.get("4").tags.highway, "traffic_signals");
  assert.deepStrictEqual(d.tlsProgram("4").phases.map((x) => x.green.length), [1, 1]);
  assert.ok(!d.validate().some((i) => i.type === "tls"));
  // фазу удалили — один подъезд никогда не получает зелёный
  d.edit("tls", () => d.setTlsProgram("4", Object.assign(p, { phases: [p.phases[0]] })));
  assert.ok(d.validate().some((i) => i.type === "tls" && i.severity === "error"));
});

test("светофор на подходе — перенос на перекрёсток", () => {
  const d = load(GRID(`<node id="50" lat="52.003" lon="104.0028"><tag k="highway" v="traffic_signals"/></node>`)
    .replace('<nd ref="4"/><nd ref="5"/><nd ref="6"/>', '<nd ref="4"/><nd ref="50"/><nd ref="5"/><nd ref="6"/>')
    .replace("</osm>", '<node id="60" lat="52.006" lon="104.0035"/><way id="61"><nd ref="5"/><nd ref="60"/><tag k="highway" v="residential"/></way></osm>'));
  const sig = d.validate().find((i) => i.type === "signal_approach");
  assert.ok(sig, "светофор на подходе найден");
  assert.strictEqual(sig.fix.junction, "5");
  d.edit("перенос", () => d.applyFix(sig.fix));
  assert.strictEqual(d.nodes.get("5").tags.highway, "traffic_signals");
  assert.ok(!d.nodes.get("50").tags.highway);
  assert.ok(!d.validate().some((i) => i.type === "signal_approach"));
});


// ---------- полосы со стрелками, манёвры, расчёт перекрёстка ----------

test("стрелки на полосах: чтение и запись", () => {
  const d = load(GRID(""));
  d.edit("полосы", () => d.setLanes("10", 2, 1));
  d.edit("стрелки", () => d.setTurnLanes("10", "forward", ["left", "through;right"]));
  assert.strictEqual(d.ways.get("10").tags["turn:lanes:forward"], "left|through;right");
  assert.deepStrictEqual(d.turnLanes(d.ways.get("10"), "forward"), ["left", "through;right"]);
  assert.deepStrictEqual(d.turnLanes(d.ways.get("10"), "backward"), [""]);
  d.edit("убрать", () => d.setTurnLanes("10", "forward", ["", ""]));
  assert.ok(!("turn:lanes:forward" in d.ways.get("10").tags));
});

test("манёвры на перекрёстке и запрет по стрелкам", () => {
  const d = load(GRID(`<node id="60" lat="52.006" lon="104.003"/><way id="61"><nd ref="5"/><nd ref="60"/><tag k="highway" v="residential"/></way>
    <node id="62" lat="52.000" lon="104.003"/><way id="63"><nd ref="62"/><nd ref="5"/><tag k="highway" v="residential"/></way>`));
  // узел 5 — крестовина: подъезды с З (4), В (6), С (60), Ю (62)
  const m = d.movements("5");
  const fromSouth = m.filter((x) => angleDiff(x.from.bearing, 180) < 10);
  const types = Object.fromEntries(fromSouth.map((x) => [x.type, x.allowed]));
  assert.deepStrictEqual(Object.keys(types).sort(), ["left", "reverse", "right", "through"]);
  assert.strictEqual(types.reverse, false, "разворот без стрелки запрещён");
  // на подъезде с юга одна полоса «только прямо»
  d.edit("стрелки", () => { d.setTag("way", "63", "lanes", "2"); d.setLanes("63", 1, 1); d.setTurnLanes("63", "forward", ["through"]); });
  const t2 = Object.fromEntries(d.movements("5").filter((x) => angleDiff(x.from.bearing, 180) < 10).map((x) => [x.type, x.allowed]));
  assert.deepStrictEqual([t2.through, t2.left, t2.right], [true, false, false]);
});

test("расчёт по Вебстеру: пропускная способность, задержка, очередь, оптимальный цикл", () => {
  const d = load(GRID(""));
  const p = d.defaultTlsProgram("4");
  p.phases.forEach((ph) => { ph.dur = 27; ph.yellow = 3; ph.red = 0; });
  p.flows = { "90": 500, "180": 300 };
  d.edit("tls", () => d.setTlsProgram("4", p));
  const c = d.tlsCapacity("4");
  assert.strictEqual(c.cycle, 60);
  const east = c.rows.find((r) => r.bearing === 90);
  assert.strictEqual(east.green, 30);
  assert.strictEqual(east.capacity, 900, "1800 × 30/60");
  assert.ok(Math.abs(east.x - 500 / 900) < 1e-9);
  assert.ok(east.delay > 5 && east.delay < 40, "задержка правдоподобна: " + east.delay);
  assert.ok(east.queue.veh >= 4 && east.queue.m > 20);
  assert.ok(c.C0 >= 30 && c.C0 <= 150);
  const w = d.websterProgram("4", p);
  assert.ok(w.phases[0].dur > w.phases[1].dur, "больше зелёного — более загруженному подъезду");
  // перегруз
  p.flows = { "90": 1200, "180": 300 };
  const c2 = d.tlsCapacity("4", p);
  assert.strictEqual(c2.rows.find((r) => r.bearing === 90).los, "F");
});


test("знаки приоритета по данным: второстепенным — «Уступите», главной — «Главная»", () => {
  const d = load(GRID(`<node id="60" lat="52.006" lon="104.003"/><way id="61"><nd ref="5"/><nd ref="60"/><tag k="highway" v="residential"/></way>`));
  // узел 5: улица 11 (secondary) насквозь + residential 61 на север — Т-образный
  assert.deepStrictEqual(d.suggestSigns().filter((x) => x.junction === "5").map((x) => x.kind), ["give_way"]);
  const sg = d.suggestSigns({ main: true }).filter((x) => x.junction === "5");
  assert.deepStrictEqual(sg.map((x) => x.kind).sort(), ["give_way", "main", "main"]);
  const n = d.edit("знаки", () => d.placeSigns(sg));
  assert.strictEqual(n, 3);
  const gw = [...d.nodes.values()].find((x) => x.tags.highway === "give_way");
  assert.ok(gw && d.waysOfNode(gw.id)[0].id === "61");
  assert.ok(Math.abs(OSMlib.distM(gw, d.nodes.get("5")) - 12) < 1);
  assert.strictEqual(d.suggestSigns({ main: true }).filter((x) => x.junction === "5").length, 0, "повторно не предлагает");
});


test("стык 3 полосы → 2: края сходятся, ширина меняется плавно", () => {
  const d = load(`<osm version="0.6">
   <node id="1" lat="52.000" lon="104.000"/><node id="2" lat="52.000" lon="104.001"/><node id="3" lat="52.000" lon="104.002"/>
   <way id="10"><nd ref="1"/><nd ref="2"/><tag k="highway" v="primary"/><tag k="oneway" v="yes"/><tag k="lanes" v="3"/></way>
   <way id="11"><nd ref="3"/><nd ref="2"/><tag k="highway" v="primary"/><tag k="oneway" v="-1"/><tag k="lanes" v="2"/></way></osm>`);
  const a = d.ways.get("10"), b = d.ways.get("11");
  const ea = d.endProfile(a, true), eb = d.endProfile(b, true); // у обеих стык — в конце линии
  assert.ok(ea && eb, "продолжение найдено, хоть вторая линия нарисована навстречу");
  const own = d.crossSection(a), ownB = d.crossSection(b);
  const pa = OSMlib.taperProfile(70, 0, own, null, ea, 25), pb = OSMlib.taperProfile(70, 0, ownB, null, eb, 25);
  // на стыке обе линии одинаковой ширины: края совпадают (у второй лево и право меняются местами)
  assert.ok(Math.abs(pa.left - pa.right - (pb.left - pb.right)) < 1e-9);
  assert.ok(Math.abs(pa.left + pb.right) < 1e-9 && Math.abs(pa.right + pb.left) < 1e-9);
  // за 25 м от стыка — своя ширина
  const far = OSMlib.taperProfile(0, 30, own, null, ea, 25);
  assert.ok(Math.abs(far.left - far.right - 9.6) < 1e-9);
});


test("улица расходится на две проезжие части: каждая выходит из своей половины", () => {
  const d = load(`<osm version="0.6">
   <node id="1" lat="52.000" lon="104.000"/><node id="2" lat="52.000" lon="104.001"/>
   <node id="3" lat="52.0001" lon="104.002"/><node id="4" lat="51.9999" lon="104.002"/>
   <way id="10"><nd ref="1"/><nd ref="2"/><tag k="highway" v="primary"/><tag k="name" v="Лермонтова"/><tag k="lanes" v="4"/></way>
   <way id="11"><nd ref="3"/><nd ref="2"/><tag k="highway" v="primary"/><tag k="name" v="Лермонтова"/><tag k="oneway" v="yes"/><tag k="lanes" v="2"/></way>
   <way id="12"><nd ref="2"/><nd ref="4"/><tag k="highway" v="primary"/><tag k="name" v="Лермонтова"/><tag k="oneway" v="yes"/><tag k="lanes" v="2"/></way></osm>`);
  assert.strictEqual(d.endProfile(d.ways.get("10"), true), null, "двусторонняя улица остаётся во всю ширину");
  const out = d.endProfile(d.ways.get("12"), false);  // по ходу движения улицы 10 — правая половина
  assert.ok(out && out.exact);
  assert.ok(Math.abs(out.left - 0) < 1e-9 && Math.abs(out.right + 6.4) < 1e-9, JSON.stringify(out));
  const inn = d.endProfile(d.ways.get("11"), true);
  assert.ok(inn && inn.exact && Math.abs(inn.left - 0) < 1e-9 && Math.abs(inn.right + 6.4) < 1e-9, JSON.stringify(inn));
});


// ---------- запреты, ОТ, стрелки по умолчанию, неполные данные, симуляция, доступность ----------

const CROSS = GRID(`<node id="60" lat="52.006" lon="104.003"/><way id="61"><nd ref="5"/><nd ref="60"/><tag k="highway" v="residential"/></way>
  <node id="62" lat="52.000" lon="104.003"/><way id="63"><nd ref="62"/><nd ref="5"/><tag k="highway" v="residential"/></way>`);

test("запрет манёвра из файла учитывается в манёврах", () => {
  const d = load(CROSS.replace("</osm>", `<relation id="90"><member type="way" ref="63" role="from"/><member type="node" ref="5" role="via"/>
    <member type="way" ref="11" role="to"/><tag k="type" v="restriction"/><tag k="restriction" v="no_left_turn"/></relation></osm>`));
  const m = d.movements("5").filter((x) => angleDiff(x.from.bearing, 180) < 10);
  const left = m.find((x) => x.type === "left");
  assert.strictEqual(left.allowed, false);
  assert.strictEqual(left.restriction.kind, "no_left_turn");
  assert.ok(m.find((x) => x.type === "through").allowed);
  assert.strictEqual(d.restrictions().length, 1);
});

test("example.osm: маршруты и остановки ОТ из файла", () => {
  const d = load(fs.readFileSync(path.join(__dirname, "..", "example.osm"), "utf8"));
  const r = d.transitRoutes();
  assert.ok(r.filter((x) => x.mode === "bus").length >= 40);
  assert.ok(r.some((x) => x.mode === "tram") && r.some((x) => x.mode === "trolleybus"));
  assert.ok(d.transitStops().length >= 15);
  assert.ok(d.restrictions().length >= 20);
});

test("стрелки по умолчанию: левая — налево и прямо, правая — прямо и направо", () => {
  const d = load(CROSS);
  d.edit("полосы", () => d.setLanes("63", 2, 1));
  assert.deepStrictEqual(d.defaultTurnLanes(d.ways.get("63"), "forward"), ["left;through", "through;right"]);
  d.edit("полосы", () => d.setLanes("63", 3, 1));
  assert.deepStrictEqual(d.defaultTurnLanes(d.ways.get("63"), "forward"), ["left", "through", "through;right"]);
});

test("неполные данные и заполнение по нормам", () => {
  const d = load(GRID(""));
  const m = d.missingData();
  assert.strictEqual(m.total, 4);
  assert.strictEqual(m.fields.width.length, 4);
  const plan = d.autofillPlan({ secondary: { lanes: 2, oneLanes: 2, maxspeed: 60, laneWidth: 3.5, surface: "asphalt" },
    residential: { lanes: 2, oneLanes: 1, maxspeed: 40, laneWidth: 3.0, surface: "asphalt" } }, ["lanes", "maxspeed", "width", "surface"]);
  d.edit("нормы", () => d.applyAutofill(plan));
  assert.strictEqual(d.ways.get("10").tags.width, "7");
  assert.strictEqual(d.ways.get("12").tags.width, "6");
  assert.strictEqual(d.missingData().fields.width.length, 0);
});

test("симуляция перекрёстка: недогруз — все уехали, перегруз — очередь растёт", () => {
  const d = load(GRID(""));
  const p = d.defaultTlsProgram("4");
  p.phases.forEach((ph) => { ph.dur = 27; ph.yellow = 3; ph.red = 0; });
  p.flows = { "90": 400, "180": 300 };
  const sim = d.simulateJunction("4", p, { runs: 3 });
  const east = sim.rows.find((r) => r.bearing === 90);
  assert.ok(Math.abs(east.arrived - 400) < 80, "пришло около 400: " + east.arrived);
  assert.ok(east.leftInQueue < 15);
  assert.ok(east.avgDelay > 3 && east.avgDelay < 40, "задержка: " + east.avgDelay);
  assert.ok(east.maxQueueM > 0);
  p.flows = { "90": 1500, "180": 300 };
  const over = d.simulateJunction("4", p, { runs: 2 }).rows.find((r) => r.bearing === 90);
  assert.ok(over.leftInQueue > 100, "перегруз: осталось " + over.leftInQueue);
  assert.ok(over.failedCycles > 0.9);
});

test("пешеходная доступность остановок", () => {
  const d = load(fs.readFileSync(path.join(__dirname, "..", "example.osm"), "utf8"));
  const stops = d.transitStops();
  const a = Ped.accessibility(d, stops, { minutes: 5 });
  assert.ok(a.edges.length > 50);
  assert.ok(a.covered > 0 && a.covered <= a.buildings);
  const fewer = Ped.accessibility(d, stops.slice(0, 2), { minutes: 5 });
  assert.ok(fewer.covered < a.covered, "меньше остановок — меньше охват");
  console.log(`     доступность: ${a.covered} из ${a.buildings} зданий в 5 минутах от остановки`);
});

console.log(`\n${passed} тестов пройдено`);

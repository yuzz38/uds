/* Интерфейс редактора графа УДС. Модель и все правки — в js/osm.js. */
(function () {
  "use strict";
  const { OsmDoc, isDrivable, onewayDir, label, distM, plural } = window.OSM;

  // ---------------------------------------------------------------------------
  // Справочники
  // ---------------------------------------------------------------------------

  // Своя палитра по классу дороги (не как в OSM): от тёмно-фиолетовых магистралей к серым проездам
  const CLASS_STYLE = {
    motorway: ["#3b1f8f", 7], trunk: ["#4527a0", 7], primary: ["#5f3dc4", 6], secondary: ["#1971c2", 5],
    tertiary: ["#0c8599", 4.5], unclassified: ["#2f9e44", 3.5], residential: ["#2f9e44", 3.5],
    living_street: ["#e67700", 3], service: ["#868e96", 2.5], road: ["#868e96", 3],
    motorway_link: ["#3b1f8f", 4], trunk_link: ["#4527a0", 4], primary_link: ["#7950f2", 4],
    secondary_link: ["#4dabf7", 3.5], tertiary_link: ["#22b8cf", 3],
  };

  // Раскраски дорог: обычная по классу и тематические — сразу видно, где не хватает данных
  const VIEWS = {
    class: "По классу дороги",
    lanes: "По числу полос",
    speed: "По скорости",
    foot: "Пешеходы на проезжей части",
  };

  const SPEED_ALIASES = { "RU:urban": 60, "RU:living_street": 20, "RU:rural": 90, "RU:motorway": 110 };
  function speedOf(w) {
    const v = w.tags.maxspeed;
    if (!v) return w.tags.highway === "living_street" ? 20 : null;
    if (SPEED_ALIASES[v]) return SPEED_ALIASES[v];
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
  }

  // Дорожные знаки (ПДД РФ) — ставятся точкой на дорогу, теги по правилам OSM
  const SIGNS = [
    { id: "give_way", name: "2.4 Уступите дорогу", tags: { highway: "give_way", traffic_sign: "RU:2.4" } },
    { id: "stop", name: "2.5 STOP", tags: { highway: "stop", traffic_sign: "RU:2.5" } },
    { id: "main", name: "2.1 Главная дорога", tags: { traffic_sign: "RU:2.1" } },
    { id: "noentry", name: "3.1 Въезд запрещён", tags: { traffic_sign: "RU:3.1" } },
    { id: "speed20", name: "3.24 Ограничение 20", tags: { traffic_sign: "RU:3.24", maxspeed: "20" }, speed: "20" },
    { id: "speed40", name: "3.24 Ограничение 40", tags: { traffic_sign: "RU:3.24", maxspeed: "40" }, speed: "40" },
    { id: "speed60", name: "3.24 Ограничение 60", tags: { traffic_sign: "RU:3.24", maxspeed: "60" }, speed: "60" },
    { id: "living", name: "5.21 Жилая зона", tags: { traffic_sign: "RU:5.21" } },
  ];
  const SIGN_KEYS = ["traffic_sign", "maxspeed", "direction"];

  // Пешеходные переходы: наземные — точка на дороге, надземные и подземные — линия поперёк дороги
  const CROSSINGS = [
    { id: "zebra", name: "Наземный нерегулируемый (зебра)", tags: { highway: "crossing", crossing: "uncontrolled", "crossing:markings": "zebra" } },
    { id: "signals", name: "Наземный со светофором", tags: { highway: "crossing", crossing: "traffic_signals", "crossing:signals": "yes", "crossing:markings": "zebra" } },
    { id: "over", name: "Надземный — нарисовать линию", template: "Надземный переход" },
    { id: "under", name: "Подземный — нарисовать линию", template: "Подземный переход" },
  ];

  const FOOT = new Set(["footway", "path", "steps", "pedestrian", "cycleway", "bridleway", "track", "corridor", "sidewalk", "crossing"]);

  const HIGHWAY_TYPES = [
    ["primary", "Магистральная (primary)"], ["secondary", "Районная (secondary)"], ["tertiary", "Улица (tertiary)"],
    ["residential", "Жилая (residential)"], ["unclassified", "Без класса (unclassified)"], ["living_street", "Жилая зона"],
    ["service", "Проезд (service)"], ["primary_link", "Съезд primary_link"], ["secondary_link", "Съезд secondary_link"],
    ["tertiary_link", "Съезд tertiary_link"], ["trunk", "Скоростная (trunk)"], ["footway", "Тротуар (footway)"],
    ["path", "Тропа (path)"], ["steps", "Лестница (steps)"], ["cycleway", "Велодорожка"], ["pedestrian", "Пешеходная улица"],
  ];

  const TEMPLATES = [
    { name: "Магистраль 2+2", tags: { highway: "primary", lanes: "4", "lanes:forward": "2", "lanes:backward": "2", maxspeed: "60", foot: "no" } },
    { name: "Улица 1+1", tags: { highway: "secondary", lanes: "2", "lanes:forward": "1", "lanes:backward": "1", maxspeed: "60" } },
    { name: "Местная улица", tags: { highway: "residential", lanes: "2", "lanes:forward": "1", "lanes:backward": "1", maxspeed: "40" } },
    { name: "Односторонняя, 2 полосы", tags: { highway: "secondary", oneway: "yes", lanes: "2", maxspeed: "60" } },
    { name: "Односторонняя, 1 полоса", tags: { highway: "tertiary", oneway: "yes", lanes: "1", maxspeed: "40" } },
    { name: "Съезд (1 полоса)", tags: { highway: "secondary_link", oneway: "yes", lanes: "1", maxspeed: "40" } },
    { name: "Двор — жилая зона", tags: { highway: "living_street", maxspeed: "20", foot: "yes" } },
    { name: "Проезд во дворе", tags: { highway: "service", maxspeed: "20", foot: "yes" } },
    { name: "Надземный переход", tags: { highway: "footway", footway: "crossing", bridge: "yes", layer: "1" }, noRoadSnap: true },
    { name: "Подземный переход", tags: { highway: "footway", footway: "crossing", tunnel: "yes", layer: "-1" }, noRoadSnap: true },
    { name: "Парковка (площадка)", tags: { amenity: "parking", parking: "surface" }, area: true, noRoadSnap: true },
    { name: "Тротуар", tags: { highway: "footway" } },
    { name: "Трамвайные пути", tags: { railway: "tram" } },
  ];
  // Теги, которые шаблон заменяет целиком, если применяется к существующей дороге
  const TEMPLATE_KEYS = ["highway", "railway", "lanes", "lanes:forward", "lanes:backward", "oneway", "maxspeed"];

  // На сенсорных экранах палец толще курсора — зоны попадания больше
  const COARSE = window.matchMedia && matchMedia("(pointer: coarse)").matches;
  const SNAP_NODE_PX = COARSE ? 20 : 12;
  const SNAP_SEG_PX = COARSE ? 16 : 9;
  const isMobile = () => window.matchMedia && matchMedia("(max-width: 760px)").matches;

  // ---------------------------------------------------------------------------
  // Состояние
  // ---------------------------------------------------------------------------

  const state = {
    doc: null,
    fileLabel: "",
    mode: "select",
    sel: null,          // {type:"way", id} | {type:"node", id, way}
    draw: null,         // {points:[...]} в режиме рисования
    issues: [],
    issuesFresh: false,
    view: "class",
  };

  const $ = (sel) => document.querySelector(sel);
  const el = (tag, attrs, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === "class") e.className = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else if (v === true) e.setAttribute(k, "");
      else if (v !== false && v != null) e.setAttribute(k, v);
    }
    for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : String(k));
    return e;
  };

  // ---------------------------------------------------------------------------
  // Карта и слои
  // ---------------------------------------------------------------------------

  const map = L.map("map", { preferCanvas: true, doubleClickZoom: false, zoomControl: true, maxZoom: 21, boxZoom: false })
    .setView([52.2603, 104.2621], 16);
  const renderer = L.canvas({ padding: 0.5, tolerance: COARSE ? 14 : 6 });
  // Подпись библиотеки без флажка (по умолчанию Leaflet 1.8+ добавляет его к своей ссылке)
  map.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>');

  // Яндекс рисует тайлы в эллипсоидальной проекции (EPSG:3395), остальные карты — в сферической
  // (EPSG:3857). В Иркутске разница — десятки километров по вертикали, поэтому каждый тайл
  // собирается из двух тайлов Яндекса со сдвигом.
  const YandexLayer = L.GridLayer.extend({
    initialize(url, options) { this._url = url; L.GridLayer.prototype.initialize.call(this, options); },
    createTile(coords, done) {
      const tile = document.createElement("div");
      tile.style.overflow = "hidden";
      const z = coords.z, size = 256, e = 0.0818191908426;
      const n = Math.PI - (2 * Math.PI * coords.y) / Math.pow(2, z);
      const lat = Math.atan(Math.sinh(n));
      const v = Math.log(Math.tan(Math.PI / 4 + lat / 2) * Math.pow((1 - e * Math.sin(lat)) / (1 + e * Math.sin(lat)), e / 2));
      const py = ((1 - v / Math.PI) / 2) * size * Math.pow(2, z);
      const ty = Math.floor(py / size), off = py - ty * size;
      let pending = 2;
      const finish = () => { if (--pending === 0) done(null, tile); };
      [0, 1].forEach((k) => {
        const img = document.createElement("img");
        img.alt = "";
        img.style.cssText = `position:absolute;left:0;top:${k * size - off}px;width:${size}px;height:${size}px;`;
        img.onload = finish; img.onerror = finish;
        img.src = this._url.replace("{x}", coords.x).replace("{y}", ty + k).replace("{z}", z);
        tile.append(img);
      });
      return tile;
    },
  });

  const bases = {
    "2ГИС": L.tileLayer("https://tile2.maps.2gis.com/tiles?x={x}&y={y}&z={z}", {
      maxNativeZoom: 18, maxZoom: 21, attribution: "© 2ГИС" }),
    "Яндекс": new YandexLayer("https://core-renderer-tiles.maps.yandex.net/tiles?l=map&x={x}&y={y}&z={z}&scale=1&lang=ru_RU", {
      maxNativeZoom: 19, maxZoom: 21, attribution: "© Яндекс" }),
    "Яндекс спутник": new YandexLayer("https://core-sat.maps.yandex.net/tiles?l=sat&x={x}&y={y}&z={z}&lang=ru_RU", {
      maxNativeZoom: 19, maxZoom: 21, attribution: "© Яндекс" }),
    "Google": L.tileLayer("https://mt{s}.google.com/vt/lyrs=m&hl=ru&x={x}&y={y}&z={z}", {
      subdomains: "0123", maxNativeZoom: 20, maxZoom: 21, attribution: "© Google" }),
    "Google гибрид": L.tileLayer("https://mt{s}.google.com/vt/lyrs=y&hl=ru&x={x}&y={y}&z={z}", {
      subdomains: "0123", maxNativeZoom: 20, maxZoom: 21, attribution: "© Google" }),
    "Спутник Esri": L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
      maxNativeZoom: 19, maxZoom: 21, attribution: "© Esri, Maxar" }),
    "OpenStreetMap": L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxNativeZoom: 19, maxZoom: 21, attribution: "© участники OpenStreetMap" }),
    "Без подложки": L.layerGroup(),
  };
  bases["2ГИС"].addTo(map);

  const g = {
    other: L.layerGroup().addTo(map),
    buildings: L.layerGroup().addTo(map),
    parking: L.layerGroup().addTo(map),
    foot: L.layerGroup().addTo(map),
    rail: L.layerGroup().addTo(map),
    roads: L.layerGroup().addTo(map),
    arrows: L.layerGroup().addTo(map),
    nodes: L.layerGroup().addTo(map),
    ped: L.layerGroup().addTo(map),
    diff: L.layerGroup().addTo(map),
    measure: L.layerGroup().addTo(map),
    issues: L.layerGroup().addTo(map),
    sel: L.layerGroup().addTo(map),
    handles: L.layerGroup().addTo(map),
    draw: L.layerGroup().addTo(map),
  };
  L.control.layers(bases, {
    "Дороги для машин": g.roads,
    "Стрелки одностороннего движения": g.arrows,
    "Светофоры, знаки, переходы": g.nodes,
    "Тротуары и тропы": g.foot,
    "Трамвай и ж/д": g.rail,
    "Парковки": g.parking,
    "Здания": g.buildings,
    "Прочее": g.other,
    "Проблемы": g.issues,
    "Пешеходный поток": g.ped,
    "Изменения": g.diff,
  }, { collapsed: true, position: "topright" }).addTo(map);
  L.control.scale({ imperial: false }).addTo(map);

  function setBaseOpacity(v) {
    for (const b of Object.values(bases)) if (b.setOpacity) b.setOpacity(v);
  }
  $("#base-opacity").addEventListener("input", (e) => setBaseOpacity(e.target.value / 100));
  setBaseOpacity(0.7);

  const wayLayers = new Map();    // id линии -> слой
  const arrowLayers = new Map();  // id линии -> [слои]
  const nodeLayers = new Map();   // id узла -> слой

  // ---------------------------------------------------------------------------
  // Отрисовка
  // ---------------------------------------------------------------------------

  function category(w) {
    if (w.tags.building || w.tags["building:part"]) return "buildings";
    if (w.tags.amenity === "parking") return "parking";
    if (w.tags.railway && w.tags.railway !== "platform") return "rail";
    if (w.tags.highway) {
      if (isDrivable(w)) return "roads";
      if (FOOT.has(w.tags.highway)) return "foot";
    }
    return "other";
  }

  function laneWeight(w, fallback) {
    const l = state.doc.lanesOf(w);
    return l.total ? Math.min(2 + l.total * 1.6, 12) : fallback;
  }

  function roadColor(w) {
    const [classColor] = CLASS_STYLE[w.tags.highway] || ["#868e96"];
    if (state.view === "lanes") {
      const l = state.doc.lanesOf(w);
      if (!l.total) return { color: "#e03131", dash: "3 5" };
      return { color: ["#a5d8ff", "#4dabf7", "#1c7ed6", "#1864ab", "#0b2e5c"][Math.min(l.total, 5) - 1] };
    }
    if (state.view === "speed") {
      const v = speedOf(w);
      if (v == null) return { color: "#adb5bd", dash: "3 5" };
      return { color: v <= 20 ? "#2f9e44" : v <= 40 ? "#94d82d" : v <= 60 ? "#f59f00" : "#e8590c" };
    }
    if (state.view === "foot") {
      const t = w.tags;
      if (t.foot === "no") return { color: "#e03131" };
      if (t.highway === "living_street" || t.foot === "yes" || t.foot === "designated") return { color: "#2f9e44" };
      if (["sidewalk", "sidewalk:both", "sidewalk:left", "sidewalk:right"].some((k) => t[k] && t[k] !== "no" && t[k] !== "none")) return { color: "#1c7ed6" };
      return { color: "#adb5bd", dash: "3 5" };
    }
    return { color: classColor };
  }

  function wayStyle(w, cat) {
    if (cat === "buildings") return { color: "#868e96", weight: 1, fillColor: "#ced4da", fillOpacity: 0.4 };
    if (cat === "parking") return { color: "#1864ab", weight: 1.5, fillColor: "#4dabf7", fillOpacity: 0.3, dashArray: "4 3" };
    if (cat === "rail") return { color: "#343a40", weight: 2.5, dashArray: "6 4" };
    if (cat === "foot") {
      const over = w.tags.bridge && w.tags.bridge !== "no", under = w.tags.tunnel && w.tags.tunnel !== "no";
      if (over || under) return { color: "#c2255c", weight: 4, opacity: 0.95, dashArray: under ? "2 4" : null };
      return { color: "#ae3ec9", weight: 1.5, opacity: state.view === "foot" ? 0.95 : 0.6, dashArray: w.tags.highway === "steps" ? "2 3" : "5 4" };
    }
    if (cat === "other") return { color: "#a5d8ff", weight: 1, fillOpacity: 0.1, opacity: 0.5 };
    const [, classWeight] = CLASS_STYLE[w.tags.highway] || ["#868e96", 3];
    const c = roadColor(w);
    const st = { color: c.color, weight: laneWeight(w, classWeight), opacity: 0.92, lineCap: "round", dashArray: c.dash || null };
    if (w.tags.bridge && w.tags.bridge !== "no") st.color = shade(st.color);
    if (w.tags.tunnel && w.tags.tunnel !== "no") st.dashArray = "4 6";
    return st;
  }

  function shade(hex) { // мосты чуть темнее и толще
    const n = parseInt(hex.slice(1), 16);
    const r = Math.round(((n >> 16) & 255) * 0.7), gg = Math.round(((n >> 8) & 255) * 0.7), b = Math.round((n & 255) * 0.7);
    return "#" + ((1 << 24) + (r << 16) + (gg << 8) + b).toString(16).slice(1);
  }

  const ll = (n) => [n.lat, n.lon];

  function drawWay(id) {
    const doc = state.doc;
    const old = wayLayers.get(id);
    if (old) { old.remove(); wayLayers.delete(id); }
    for (const a of arrowLayers.get(id) || []) a.remove();
    arrowLayers.delete(id);
    const w = doc.ways.get(id);
    if (!w) return;
    const pts = w.nodes.map((n) => doc.nodes.get(n)).filter(Boolean).map(ll);
    if (pts.length < 2) return;
    const cat = category(w);
    const closed = w.nodes[0] === w.nodes[w.nodes.length - 1];
    const area = closed && (cat === "buildings" || cat === "parking" || (cat === "other" && w.tags.area !== "no"));
    const opts = Object.assign({ renderer, interactive: true, bubblingMouseEvents: false }, wayStyle(w, cat));
    const layer = area ? L.polygon(pts.slice(0, -1), opts) : L.polyline(pts, Object.assign({ fill: false }, opts));
    layer.wayId = id;
    layer.on("click", (e) => onWayClick(id, e));
    if (cat === "parking") layer.bindTooltip("Парковка" + (w.tags.capacity ? `, ${w.tags.capacity} мест` : ""), { sticky: true });
    layer.addTo(g[cat]);
    wayLayers.set(id, layer);
    if (cat === "roads") drawArrows(w);
  }

  // Стрелки направления на односторонних дорогах — постоянного размера на экране,
  // по одной на отрезок, если он на экране длиннее 40 пикселей
  function metersPerPixel(lat) {
    return (40075016.686 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, map.getZoom() + 8);
  }

  function drawArrows(w) {
    for (const a of arrowLayers.get(w.id) || []) a.remove();
    arrowLayers.delete(w.id);
    const dir = onewayDir(w);
    if (!dir || map.getZoom() < 15) return;
    const doc = state.doc;
    const out = [];
    for (let i = 1; i < w.nodes.length; i++) {
      let a = doc.nodes.get(w.nodes[i - 1]), b = doc.nodes.get(w.nodes[i]);
      if (!a || !b) continue;
      if (dir < 0) [a, b] = [b, a];
      const len = distM(a, b);
      const mpp = metersPerPixel(a.lat);
      if (len / mpp < 40) continue;
      const k = Math.cos((a.lat * Math.PI) / 180);
      const dx = (b.lon - a.lon) * k, dy = b.lat - a.lat;
      const L2 = Math.hypot(dx, dy);
      const ux = dx / L2, uy = dy / L2;
      const size = (6 * mpp) / 111320; // ~6 пикселей
      const mx = (a.lon + b.lon) / 2, my = (a.lat + b.lat) / 2;
      const tip = [my + uy * size, mx + (ux * size) / k];
      const left = [my - uy * size + ux * size * 0.8, mx + (-ux * size - uy * size * 0.8) / k];
      const right = [my - uy * size - ux * size * 0.8, mx + (-ux * size + uy * size * 0.8) / k];
      out.push(L.polyline([left, tip, right], { renderer, color: "#212529", weight: 2, opacity: 0.85, interactive: false }).addTo(g.arrows));
    }
    arrowLayers.set(w.id, out);
  }

  function signOf(n) {
    const t = n.tags;
    if (t.highway === "stop" || t.traffic_sign === "RU:2.5") return "stop";
    if (t.highway === "give_way" || t.traffic_sign === "RU:2.4") return "give_way";
    if (!t.traffic_sign) return null;
    if (t.traffic_sign.startsWith("RU:3.24")) return "speed";
    if (t.traffic_sign === "RU:2.1") return "main";
    if (t.traffic_sign === "RU:3.1") return "noentry";
    if (t.traffic_sign === "RU:5.21") return "living";
    return "other";
  }

  function signSvg(kind, n) {
    const speed = (n.tags.maxspeed || "").replace(/\D/g, "") || "?";
    const svg = {
      give_way: '<path d="M2 3h16L10 17z" fill="#fff" stroke="#e03131" stroke-width="2.5"/>',
      stop: '<path d="M6 1h8l5 5v8l-5 5H6l-5-5V6z" fill="#e03131" stroke="#fff"/><text x="10" y="13" font-size="6" fill="#fff" text-anchor="middle" font-weight="700">STOP</text>',
      main: '<path d="M10 1l9 9-9 9-9-9z" fill="#fab005" stroke="#fff" stroke-width="2.5"/>',
      noentry: '<circle cx="10" cy="10" r="9" fill="#e03131" stroke="#fff"/><rect x="4" y="8" width="12" height="4" fill="#fff"/>',
      speed: `<circle cx="10" cy="10" r="8.5" fill="#fff" stroke="#e03131" stroke-width="2.5"/><text x="10" y="13.5" font-size="${speed.length > 2 ? 7 : 9}" text-anchor="middle" font-weight="700" fill="#000">${speed}</text>`,
      living: '<rect x="1" y="1" width="18" height="18" rx="2" fill="#1c7ed6" stroke="#fff"/><path d="M5 11l5-5 5 5v5H5z" fill="#fff"/>',
      other: '<rect x="2" y="2" width="16" height="16" rx="3" fill="#fff" stroke="#495057" stroke-width="2"/><text x="10" y="14" font-size="9" text-anchor="middle">?</text>',
    }[kind];
    return `<svg width="20" height="20" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg">${svg}</svg>`;
  }

  function nodeKind(n) {
    const t = n.tags;
    if (t.highway === "traffic_signals" || t.crossing === "traffic_signals" || t["crossing:signals"] === "yes") return "signal";
    if (signOf(n)) return "sign";
    if (t.highway === "crossing" || t.railway === "crossing" || t.railway === "tram_crossing") return "crossing";
    if (t.highway === "bus_stop" || t.public_transport === "stop_position" || t.railway === "tram_stop") return "stop";
    return null;
  }

  function drawNode(id) {
    const old = nodeLayers.get(id);
    if (old) { old.remove(); nodeLayers.delete(id); }
    const n = state.doc.nodes.get(id);
    if (!n) return;
    const kind = nodeKind(n);
    if (!kind) return;
    if (kind === "sign") {
      const sk = signOf(n);
      const m = L.marker(ll(n), {
        icon: L.divIcon({ className: "sign-icon", html: signSvg(sk, n), iconSize: [20, 20] }),
        title: SIGNS.find((x) => x.tags.traffic_sign === n.tags.traffic_sign)?.name || n.tags.traffic_sign || n.tags.highway,
        zIndexOffset: 300, bubblingMouseEvents: false,
      });
      m.on("click", (e) => {
        L.DomEvent.stop(e);
        if (state.mode === "sign") return onSignClick(e.latlng);
        const ways = state.doc.waysOfNode(id);
        select({ type: "node", id, way: ways[0] && ways[0].id });
      });
      m.addTo(g.nodes);
      nodeLayers.set(id, m);
      return;
    }
    const style = {
      signal: { radius: 6, color: "#fff", weight: 2, fillColor: "#e03131", fillOpacity: 1 },
      crossing: { radius: 3.5, color: "#212529", weight: 1, fillColor: "#fff", fillOpacity: 1 },
      stop: { radius: 4, color: "#fff", weight: 1.5, fillColor: "#1971c2", fillOpacity: 1 },
    }[kind];
    const m = L.circleMarker(ll(n), Object.assign({ renderer, bubblingMouseEvents: false }, style));
    m.on("click", (e) => {
      if (state.mode === "signal") return onSignalClick(e.latlng);
      if (state.mode === "crossing") return onCrossingClick(e.latlng);
      if (state.mode === "sign") return onSignClick(e.latlng);
      L.DomEvent.stop(e);
      const ways = state.doc.waysOfNode(id);
      select({ type: "node", id, way: ways[0] && ways[0].id });
    });
    m.bindTooltip(kind === "signal" ? "Светофор" : kind === "crossing" ? "Переход" : (n.tags.name || "Остановка"), { direction: "top" });
    m.addTo(g.nodes);
    nodeLayers.set(id, m);
  }

  map.on("zoomend", () => {
    if (!state.doc) return;
    for (const w of state.doc.ways.values()) if (category(w) === "roads") drawArrows(w);
  });

  function drawAll() {
    for (const grp of Object.values(g)) grp.clearLayers();
    wayLayers.clear(); arrowLayers.clear(); nodeLayers.clear();
    for (const id of state.doc.ways.keys()) drawWay(id);
    for (const id of state.doc.nodes.keys()) drawNode(id);
  }

  // ---------------------------------------------------------------------------
  // Загрузка и сохранение
  // ---------------------------------------------------------------------------

  function loadText(text, label, opts) {
    let doc;
    try {
      doc = OsmDoc.parse(text);
    } catch (e) {
      toast("Не удалось открыть: " + e.message);
      return;
    }
    if (opts && opts.baseText) {
      try { doc.snapshotBase(OsmDoc.parse(opts.baseText)); } catch (e) { doc.snapshotBase(); }
      doc.dirty = true;
    } else doc.snapshotBase();
    state.baseText = opts && opts.baseText ? opts.baseText : text;
    state.ped = null;
    g.ped.clearLayers(); g.diff.clearLayers();
    stopPedAnimation();
    state.doc = doc;
    state.fileLabel = label;
    state.sel = null;
    state.issues = [];
    state.issuesFresh = false;
    doc.on(onDocChange);
    const empty = document.querySelector(".empty-state");
    if (empty) empty.remove();
    drawAll();
    fitDoc();
    fillStreetNames();
    runValidation();
    renderPanel();
    updateStatus();
    const s = doc.stats();
    if (doc.missingNodeRefs) {
      toast(`Внимание: выгрузка неполная — ${doc.missingNodeRefs} ссылок на узлы, которых нет в файле. ` +
        "Такие куски линий не показаны и не попадут в сохранённый файл. Выгрузите район целиком (с узлами).");
    } else {
      toast(`Открыт ${label}: ${s.drivable} дорог для машин, ${s.nodes} узлов`);
    }
    const m = /^([A-Za-z0-9][A-Za-z0-9_-]*)\.osm$/i.exec(label);
    if (m && m[1] !== "example") $("#team-name").value = m[1];
  }

  function fitDoc() {
    const b = state.doc.bounds;
    if (b && b.minlat) map.fitBounds([[+b.minlat, +b.minlon], [+b.maxlat, +b.maxlon]]);
    else {
      const layers = [...wayLayers.values()];
      if (layers.length) map.fitBounds(L.featureGroup(layers).getBounds());
    }
  }

  function openFile(file) {
    if (!file) return;
    if (!confirmDiscard()) return;
    const reader = new FileReader();
    toast("Загрузка " + file.name + "…");
    reader.onload = () => loadText(reader.result, file.name);
    reader.onerror = () => toast("Не удалось прочитать файл");
    reader.readAsText(file, "utf-8");
  }

  function confirmDiscard() {
    return !state.doc || !state.doc.dirty || confirm("Есть несохранённые правки. Открыть другой файл и потерять их?");
  }

  /** Открыть .osm по адресу рядом с редактором (кнопка «Пример», ссылка ?file=...). */
  async function openUrl(file, silent) {
    const r = await fetch(file);
    if (!r.ok) throw new Error("HTTP " + r.status);
    loadText(await r.text(), file.split("/").pop().split("?")[0]);
    state.sourceFile = file;
    // адрес страницы запоминает файл — по этой ссылке (и QR-коду) карта откроется сразу
    try { history.replaceState(null, "", "?file=" + encodeURIComponent(file)); } catch (e) { /* file:// */ }
  }

  async function openExample() {
    if (!confirmDiscard()) return;
    try {
      await openUrl("example.osm");
    } catch (e) {
      toast("example.osm доступен, только если редактор запущен через сервер (Docker или run.bat). Откройте файл кнопкой «Открыть».");
    }
  }

  function teamName() {
    const v = $("#team-name").value.trim();
    return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(v) ? v : null;
  }

  function save() {
    if (!state.doc) return toast("Сначала откройте файл .osm");
    const team = teamName();
    if (!team) {
      $("#team-name").focus();
      return toast("Имя команды: латиница, цифры, «-» и «_» — так сервер проверки узнаёт команду");
    }
    runValidation();
    const errors = state.issues.filter((i) => i.severity === "error").length;
    if (errors && !confirm(`Проверка нашла ${errors} ${plural(errors, "ошибку", "ошибки", "ошибок")} графа (вкладка «Проблемы»). ` +
        "На сервере они дадут обрывы и телепортации. Всё равно сохранить?")) {
      showTab("issues");
      return;
    }
    const blob = new Blob([state.doc.serialize()], { type: "application/xml" });
    const a = el("a", { href: URL.createObjectURL(blob), download: team + ".osm" });
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    state.doc.dirty = false;
    idb.del("current").catch(() => {});
    $("#status-saved").textContent = "";
    updateStatus();
    toast(`Сохранено: ${team}.osm`);
  }

  // ---------------------------------------------------------------------------
  // Правки и перерисовка
  // ---------------------------------------------------------------------------

  function run(label, fn) {
    if (!state.doc) return null;
    try {
      return state.doc.edit(label, fn);
    } catch (e) {
      toast(e.message);
      return null;
    }
  }

  function onDocChange(change) {
    const doc = state.doc;
    const ways = new Set(), nodes = new Set();
    for (const key of change.keys) {
      const [type, id] = key.split(/:(.+)/);
      if (type === "way") ways.add(id);
      if (type === "node") {
        nodes.add(id);
        for (const w of doc.waysOfNode(id)) ways.add(w.id); // сдвиг узла меняет геометрию его линий
      }
    }
    for (const id of ways) drawWay(id);
    for (const id of nodes) drawNode(id);
    if (state.sel) {
      const s = state.sel;
      const exists = s.type === "way" ? doc.ways.has(s.id) : doc.nodes.has(s.id);
      if (!exists) state.sel = null;
      else if (s.type === "node" && s.way && !(doc.ways.get(s.way) || { nodes: [] }).nodes.includes(s.id)) {
        const w = doc.waysOfNode(s.id)[0];
        s.way = w && w.id;
      }
    }
    if (change.kind !== "commit") toast((change.kind === "undo" ? "Отменено: " : "Повторено: ") + change.label);
    drawSelection();
    renderPanel();
    updateStatus();
    scheduleValidation();
    scheduleAutosave();
    if (activeTab() === "changes") renderChanges();
    refresh3d();
  }

  let validationTimer = null;
  function scheduleValidation() {
    state.issuesFresh = false;
    clearTimeout(validationTimer);
    validationTimer = setTimeout(() => { runValidation(); if (activeTab() === "issues") renderIssues(); }, 400);
  }

  function runValidation() {
    if (!state.doc) return;
    state.issues = state.doc.validate();
    state.issuesFresh = true;
    g.issues.clearLayers();
    for (const is of state.issues) {
      L.circleMarker([is.lat, is.lon], {
        renderer, radius: 9, color: is.severity === "error" ? "#c92a2a" : "#e67700", weight: 3, fill: false, interactive: false,
      }).addTo(g.issues);
    }
    const errors = state.issues.filter((i) => i.severity === "error").length;
    $("#issues-count").textContent = errors ? String(errors) : "";
  }

  // ---------------------------------------------------------------------------
  // Выбор
  // ---------------------------------------------------------------------------

  function select(sel) {
    state.sel = sel;
    drawSelection();
    renderPanel();
    if (sel) showTab("object");
    if (sel && isMobile() && document.body.classList.contains("sheet-collapsed")) setSheet("half");
    refresh3d();
  }

  function drawSelection() {
    g.sel.clearLayers();
    g.handles.clearLayers();
    const s = state.sel, doc = state.doc;
    if (!s || !doc) return;
    const wayId = s.type === "way" ? s.id : s.way;
    const w = wayId && doc.ways.get(wayId);
    if (w) {
      const pts = w.nodes.map((n) => ll(doc.nodes.get(n)));
      L.polyline(pts, { renderer, color: "#f2b705", weight: 14, opacity: 0.45, interactive: false }).addTo(g.sel);
      if (state.mode === "select") drawHandles(w);
    }
    if (s.type === "node") {
      const n = doc.nodes.get(s.id);
      if (n) L.circleMarker(ll(n), { renderer, radius: 11, color: "#000", weight: 2, fill: false, interactive: false }).addTo(g.sel);
    }
  }

  function vertexIcon(cls) {
    return L.divIcon({ className: "", html: `<div class="${cls}" style="width:100%;height:100%"></div>`, iconSize: cls.includes("mid") ? [10, 10] : [13, 13] });
  }

  // Точки линии можно тащить; полупрозрачные точки посередине отрезков добавляют новый узел
  function drawHandles(w) {
    const doc = state.doc;
    w.nodes.forEach((id, i) => {
      if (i === w.nodes.length - 1 && id === w.nodes[0]) return; // кольцо: последняя точка = первая
      const n = doc.nodes.get(id);
      const shared = (doc.nodeWays.get(id) || new Set()).size > 1;
      const selected = state.sel && state.sel.type === "node" && state.sel.id === id;
      const m = L.marker(ll(n), {
        draggable: true, icon: vertexIcon("vtx" + (shared ? " shared" : "") + (selected ? " selected" : "")),
        title: shared ? "Перекрёсток (общий узел)" : "Узел — тащите, чтобы сдвинуть; на другой узел — чтобы соединить",
        zIndexOffset: shared ? 200 : 100,
      });
      m.on("click", (e) => { L.DomEvent.stop(e); select({ type: "node", id, way: w.id }); });
      m.on("drag", (e) => previewMove(id, e.target.getLatLng()));
      m.on("dragend", (e) => finishMove(id, e.target.getLatLng(), e));
      m.addTo(g.handles);
    });
    if (w.nodes.length > 60) return; // на длинных линиях не загромождаем
    for (let i = 1; i < w.nodes.length; i++) {
      const a = doc.nodes.get(w.nodes[i - 1]), b = doc.nodes.get(w.nodes[i]);
      if (map.latLngToContainerPoint(ll(a)).distanceTo(map.latLngToContainerPoint(ll(b))) < 30) continue;
      const mid = L.marker([(a.lat + b.lat) / 2, (a.lon + b.lon) / 2], {
        draggable: true, icon: vertexIcon("vtx-mid"), title: "Тащите, чтобы добавить узел", opacity: 0.85,
      });
      const seg = i - 1;
      mid.on("dragend", (e) => {
        const p = e.target.getLatLng();
        const nid = run("добавить узел", () => state.doc.insertNode(w.id, seg, p.lat, p.lng));
        if (nid) select({ type: "node", id: nid, way: w.id });
      });
      mid.addTo(g.handles);
    }
  }

  function previewMove(nodeId, latlng) {
    const doc = state.doc;
    for (const w of doc.waysOfNode(nodeId)) {
      const layer = wayLayers.get(w.id);
      if (!layer) continue;
      const pts = w.nodes.map((n) => (n === nodeId ? latlng : ll(doc.nodes.get(n))));
      layer.setLatLngs(layer instanceof L.Polygon ? pts.slice(0, -1) : pts);
    }
    const sel = g.sel.getLayers()[0];
    const wId = state.sel && (state.sel.type === "way" ? state.sel.id : state.sel.way);
    if (sel && wId && doc.ways.get(wId)) sel.setLatLngs(doc.ways.get(wId).nodes.map((n) => (n === nodeId ? latlng : ll(doc.nodes.get(n)))));
  }

  function finishMove(nodeId, latlng, e) {
    const alt = e && e.originalEvent && e.originalEvent.altKey; // Alt — не прилипать
    const target = alt ? null : nearestNode(latlng, SNAP_NODE_PX, (id) => id !== nodeId);
    if (target) {
      const keep = target.id;
      run("соединить узлы", () => state.doc.mergeNodes(keep, nodeId));
      const w = state.doc.waysOfNode(keep)[0];
      select({ type: "node", id: keep, way: (state.sel && state.sel.way && state.doc.ways.has(state.sel.way)) ? state.sel.way : w && w.id });
      toast("Узлы соединены — теперь это перекрёсток");
    } else {
      run("сдвинуть узел", () => state.doc.moveNode(nodeId, latlng.lat, latlng.lng));
    }
  }

  // ---------------------------------------------------------------------------
  // Поиск ближайших узлов и отрезков (в пикселях экрана)
  // ---------------------------------------------------------------------------

  function nearestNode(latlng, px, filter, onlyDrivable) {
    const doc = state.doc;
    const p = map.latLngToContainerPoint(latlng);
    let best = null;
    for (const [id, ways] of doc.nodeWays) {
      if (filter && !filter(id)) continue;
      if (onlyDrivable && ![...ways].some((w) => isDrivable(doc.ways.get(w)))) continue;
      if (!onlyDrivable && ![...ways].some((w) => visibleWay(w))) continue;
      const n = doc.nodes.get(id);
      const d = map.latLngToContainerPoint(ll(n)).distanceTo(p);
      if (d <= px && (!best || d < best.d)) best = { id, d };
    }
    return best;
  }

  function visibleWay(id) {
    const layer = wayLayers.get(id);
    if (!layer) return false;
    const w = state.doc.ways.get(id);
    return map.hasLayer(g[category(w)]) && category(w) !== "buildings" && category(w) !== "other";
  }

  function nearestSegment(latlng, px, onlyDrivable) {
    const doc = state.doc;
    const p = map.latLngToContainerPoint(latlng);
    let best = null;
    const bounds = map.getBounds().pad(0.1);
    for (const w of doc.ways.values()) {
      if (onlyDrivable ? !isDrivable(w) : !visibleWay(w.id)) continue;
      for (let i = 1; i < w.nodes.length; i++) {
        const a = doc.nodes.get(w.nodes[i - 1]), b = doc.nodes.get(w.nodes[i]);
        if (!bounds.contains(ll(a)) && !bounds.contains(ll(b))) continue;
        const pa = map.latLngToContainerPoint(ll(a)), pb = map.latLngToContainerPoint(ll(b));
        const dx = pb.x - pa.x, dy = pb.y - pa.y;
        const len2 = dx * dx + dy * dy;
        const t = len2 ? Math.max(0, Math.min(1, ((p.x - pa.x) * dx + (p.y - pa.y) * dy) / len2)) : 0;
        const q = L.point(pa.x + dx * t, pa.y + dy * t);
        const d = q.distanceTo(p);
        if (d <= px && (!best || d < best.d)) {
          best = { way: w.id, seg: i - 1, na: w.nodes[i - 1], nb: w.nodes[i], d, latlng: map.containerPointToLatLng(q) };
        }
      }
    }
    return best;
  }

  // ---------------------------------------------------------------------------
  // Режимы
  // ---------------------------------------------------------------------------

  function setMode(mode) {
    if (state.mode === "draw" && mode !== "draw") cancelDraw();
    state.mode = mode;
    document.body.dataset.mode = mode;
    document.querySelectorAll(".modes button").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
    const c = map.getContainer();
    c.classList.toggle("mode-draw", mode === "draw");
    c.classList.toggle("mode-signal", mode === "signal" || mode === "sign" || mode === "crossing" || mode === "measure");
    if (mode === "draw") state.draw = { points: [] };
    // В панели инструментов — выбор подходящий к режиму: шаблон, знак или тип перехода
    $("#tpl-group").hidden = !(mode === "select" || mode === "draw");
    $("#sign-type").hidden = mode !== "sign";
    $("#crossing-type").hidden = mode !== "crossing";
    if (mode !== "measure") { measure.pts = []; g.measure.clearLayers(); }
    drawSelection();
    updateStatus();
  }

  function onWayClick(id, e) {
    L.DomEvent.stop(e);
    if (state.mode === "draw") return onDrawClick(e.latlng);
    if (state.mode === "signal") return onSignalClick(e.latlng);
    if (state.mode === "sign") return onSignClick(e.latlng);
    if (state.mode === "crossing") return onCrossingClick(e.latlng);
    if (state.mode === "measure") return onMeasureClick(e.latlng);
    select({ type: "way", id });
  }

  map.on("click", (e) => {
    if (!state.doc) return;
    if (state.mode === "draw") return onDrawClick(e.latlng);
    if (state.mode === "signal") return onSignalClick(e.latlng);
    if (state.mode === "sign") return onSignClick(e.latlng);
    if (state.mode === "crossing") return onCrossingClick(e.latlng);
    if (state.mode === "measure") return onMeasureClick(e.latlng);
    select(null);
  });

  // ----- рисование новой дороги -----

  function currentTemplate() { return TEMPLATES[$("#template").selectedIndex] || TEMPLATES[0]; }

  function snapPoint(latlng) {
    const tpl = currentTemplate();
    if (tpl.noRoadSnap) {
      // Надземный/подземный переход и парковка не должны создавать перекрёсток с проезжей частью
      const d = state.draw;
      if (tpl.area && d && d.points.length >= 3) {
        const first = d.points[0];
        if (map.latLngToContainerPoint([first.lat, first.lon]).distanceTo(map.latLngToContainerPoint(latlng)) < SNAP_NODE_PX) {
          return { lat: first.lat, lon: first.lon, closeRing: true };
        }
      }
      const node = nearestNode(latlng, SNAP_NODE_PX, (id) => !state.doc.waysOfNode(id).some(isDrivable));
      if (node && !tpl.area) {
        const n = state.doc.nodes.get(node.id);
        return { lat: n.lat, lon: n.lon, nodeId: node.id };
      }
      return { lat: latlng.lat, lon: latlng.lng };
    }
    const node = nearestNode(latlng, SNAP_NODE_PX);
    if (node) {
      const n = state.doc.nodes.get(node.id);
      return { lat: n.lat, lon: n.lon, nodeId: node.id };
    }
    const seg = nearestSegment(latlng, SNAP_SEG_PX);
    if (seg) return { lat: seg.latlng.lat, lon: seg.latlng.lng, onWay: seg.way, na: seg.na, nb: seg.nb };
    return { lat: latlng.lat, lon: latlng.lng };
  }

  function onDrawClick(latlng) {
    if (!state.doc) return;
    const d = state.draw || (state.draw = { points: [] });
    const p = snapPoint(latlng);
    if (p.closeRing) { finishDraw(true); return; }
    const last = d.points[d.points.length - 1];
    if (last && map.latLngToContainerPoint([last.lat, last.lon]).distanceTo(map.latLngToContainerPoint([p.lat, p.lon])) < 4) return;
    d.points.push(p);
    renderDraw();
    updateStatus();
  }

  function renderDraw(cursor) {
    g.draw.clearLayers();
    const d = state.draw;
    if (!d) return;
    const pts = d.points.map((p) => [p.lat, p.lon]);
    if (pts.length) L.polyline(pts, { renderer, color: "#1c64d8", weight: 4, interactive: false }).addTo(g.draw);
    d.points.forEach((p) => L.circleMarker([p.lat, p.lon], {
      renderer, radius: p.nodeId || p.onWay ? 6 : 4, color: "#fff", weight: 2,
      fillColor: p.nodeId || p.onWay ? "#e8590c" : "#1c64d8", fillOpacity: 1, interactive: false,
    }).addTo(g.draw));
    if (cursor) {
      if (pts.length) L.polyline([pts[pts.length - 1], [cursor.lat, cursor.lon]], { renderer, color: "#1c64d8", weight: 2, dashArray: "6 6", interactive: false }).addTo(g.draw);
      if (cursor.nodeId || cursor.onWay) L.circleMarker([cursor.lat, cursor.lon], { renderer, radius: 8, color: "#e8590c", weight: 2, fill: false, interactive: false }).addTo(g.draw);
    }
  }

  function finishDraw(closeRing) {
    const d = state.draw;
    const tpl = currentTemplate();
    if (tpl.area && d && d.points.length >= 3) closeRing = true;
    if (!d || d.points.length < (closeRing ? 3 : 2)) { toast(tpl.area ? "Нужно минимум три точки" : "Нужно минимум две точки"); return; }
    const wid = run("новая дорога", () => {
      const doc = state.doc;
      const ids = d.points.map((p) => {
        if (p.nodeId) return p.nodeId;
        if (p.onWay) {
          // Индекс отрезка ищем заново: предыдущие точки могли вставить узлы в ту же линию
          const w = doc.ways.get(p.onWay);
          let seg = -1;
          for (let i = 1; i < w.nodes.length; i++) {
            const a = w.nodes[i - 1], b = w.nodes[i];
            if ((a === p.na && b === p.nb) || (a === p.nb && b === p.na)) { seg = i - 1; break; }
          }
          if (seg < 0) seg = closestSegIndex(w, p);
          const nid = doc.insertNode(p.onWay, seg, p.lat, p.lon);
          p.nb = nid; // следующая точка на этом же отрезке попадёт в его новую часть
          return nid;
        }
        return doc.addNode(p.lat, p.lon);
      });
      const clean = ids.filter((id, i) => i === 0 || id !== ids[i - 1]);
      if (clean.length < 2) throw new Error("Точки совпадают — дорога не создана");
      if (closeRing && clean[0] !== clean[clean.length - 1]) clean.push(clean[0]);
      return doc.addWay(clean, tpl.tags);
    });
    state.draw = { points: [] };
    g.draw.clearLayers();
    if (wid) {
      setMode("select");
      select({ type: "way", id: wid });
      toast(tpl.area ? `${tpl.name} создана. Укажите число мест справа.` : `Создано по шаблону «${tpl.name}». Поправьте атрибуты справа.`);
    }
  }

  function closestSegIndex(w, p) {
    let best = 0, bd = Infinity;
    for (let i = 1; i < w.nodes.length; i++) {
      const a = state.doc.nodes.get(w.nodes[i - 1]), b = state.doc.nodes.get(w.nodes[i]);
      const d = distM(p, { lat: (a.lat + b.lat) / 2, lon: (a.lon + b.lon) / 2 });
      if (d < bd) { bd = d; best = i - 1; }
    }
    return best;
  }

  function cancelDraw() {
    state.draw = { points: [] };
    g.draw.clearLayers();
  }

  map.on("mousemove", (e) => {
    $("#status-coords").textContent = `${e.latlng.lat.toFixed(6)}, ${e.latlng.lng.toFixed(6)}`;
    if (state.mode === "draw" && state.doc && state.draw) renderDraw(snapPoint(e.latlng));
    if (state.mode === "measure" && measure.pts.length) renderMeasure(e.latlng);
  });
  map.on("dblclick", () => { if (state.mode === "draw") finishDraw(); });

  // ----- светофоры -----

  function onSignalClick(latlng) {
    if (!state.doc) return;
    const doc = state.doc;
    const node = nearestNode(latlng, 14, null, true);
    if (node) {
      const n = doc.nodes.get(node.id);
      const on = nodeKind(n) === "signal";
      run(on ? "убрать светофор" : "поставить светофор", () => {
        const tags = { ...n.tags };
        if (on) {
          if (tags.highway === "traffic_signals") delete tags.highway;
          if (tags.crossing === "traffic_signals") tags.crossing = "uncontrolled";
          delete tags["crossing:signals"];
        } else if (tags.highway === "crossing") {
          tags.crossing = "traffic_signals";
          tags["crossing:signals"] = "yes";
        } else {
          tags.highway = "traffic_signals";
        }
        doc.setTags("node", node.id, tags);
      });
      select({ type: "node", id: node.id, way: (doc.waysOfNode(node.id)[0] || {}).id });
      return;
    }
    const seg = nearestSegment(latlng, SNAP_SEG_PX, true);
    if (seg) {
      const nid = run("поставить светофор", () => {
        const id = doc.insertNode(seg.way, seg.seg, seg.latlng.lat, seg.latlng.lng);
        doc.setTags("node", id, { highway: "traffic_signals" });
        return id;
      });
      if (nid) select({ type: "node", id: nid, way: seg.way });
      return;
    }
    toast("Кликните по дороге или по её узлу");
  }

  // ----- общая точка на дороге для знака или перехода -----

  /** Узел дороги под курсором (не перекрёсток) или новый узел на отрезке. Внутри edit(). */
  function pointOnRoad(latlng, label) {
    const doc = state.doc;
    const node = nearestNode(latlng, 12, (id) => (doc.nodeWays.get(id) || new Set()).size === 1, true);
    if (node) return { id: node.id, existed: true };
    const seg = nearestSegment(latlng, SNAP_SEG_PX, true);
    if (!seg) return null;
    return { id: doc.insertNode(seg.way, seg.seg, seg.latlng.lat, seg.latlng.lng), existed: false, way: seg.way };
  }

  function onSignClick(latlng) {
    if (!state.doc) return;
    const doc = state.doc;
    const sign = SIGNS[$("#sign-type").selectedIndex];
    // клик по уже стоящему знаку того же типа — убрать его
    const hit = nearestNode(latlng, 12, (id) => {
      const n = doc.nodes.get(id);
      return n && signOf(n);
    });
    let target = null;
    const ok = run("знак " + sign.name, () => {
      if (hit) {
        const n = doc.nodes.get(hit.id);
        const same = n.tags.traffic_sign === sign.tags.traffic_sign && (!sign.speed || n.tags.maxspeed === sign.speed);
        const tags = { ...n.tags };
        if (tags.highway === "stop" || tags.highway === "give_way") delete tags.highway;
        for (const k of SIGN_KEYS) delete tags[k];
        doc.setTags("node", hit.id, same ? tags : Object.assign(tags, sign.tags));
        target = { id: hit.id, removed: same };
        return true;
      }
      const p = pointOnRoad(latlng);
      if (!p) return false;
      const n = doc.nodes.get(p.id);
      if (sign.tags.highway && n.tags.highway && n.tags.highway !== sign.tags.highway) {
        throw new Error("В этом узле уже " + n.tags.highway + " — поставьте знак чуть в стороне");
      }
      doc.setTags("node", p.id, Object.assign({ ...n.tags }, sign.tags));
      if (sign.speed) {
        // Ограничение скорости действует на дорогу — SUMO берёт скорость из maxspeed линии
        for (const w of doc.waysOfNode(p.id).filter(isDrivable)) doc.setTag("way", w.id, "maxspeed", sign.speed);
      }
      target = { id: p.id, removed: false };
      return true;
    });
    if (ok === false || ok == null) { if (ok === false) toast("Кликните по дороге"); return; }
    if (target && !target.removed) {
      select({ type: "node", id: target.id, way: (doc.waysOfNode(target.id)[0] || {}).id });
      toast(sign.speed ? `Знак поставлен, скорость дороги — ${sign.speed} км/ч` : "Знак поставлен");
    } else toast("Знак убран");
  }

  function onCrossingClick(latlng) {
    if (!state.doc) return;
    const doc = state.doc;
    const type = CROSSINGS[$("#crossing-type").selectedIndex];
    if (type.template) return startTemplateDraw(type.template);
    const existing = nearestNode(latlng, 12, (id) => doc.nodes.get(id).tags.highway === "crossing", true);
    let nid = null;
    const ok = run("переход: " + type.name, () => {
      if (existing) {
        const n = doc.nodes.get(existing.id);
        const tags = { ...n.tags };
        const same = tags.crossing === type.tags.crossing;
        for (const k of ["highway", "crossing", "crossing:signals", "crossing:markings", "crossing_ref"]) delete tags[k];
        doc.setTags("node", existing.id, same ? tags : Object.assign(tags, type.tags));
        nid = same ? null : existing.id;
        return true;
      }
      const p = pointOnRoad(latlng);
      if (!p) return false;
      const n = doc.nodes.get(p.id);
      if (n.tags.highway && n.tags.highway !== "crossing") throw new Error("В этом узле уже " + n.tags.highway + " — поставьте переход чуть в стороне");
      doc.setTags("node", p.id, Object.assign({ ...n.tags }, type.tags));
      nid = p.id;
      return true;
    });
    if (ok === false) return toast("Кликните по дороге");
    if (ok && nid) { select({ type: "node", id: nid, way: (doc.waysOfNode(nid)[0] || {}).id }); toast("Переход поставлен"); }
    else if (ok) toast("Переход убран");
  }

  function startTemplateDraw(name) {
    const idx = TEMPLATES.findIndex((t) => t.name === name);
    $("#template").selectedIndex = idx;
    setMode("draw");
    toast(TEMPLATES[idx].area
      ? "Обведите площадку кликами, замкните кликом по первой точке"
      : "Нарисуйте переход поперёк дороги — он не соединится с проезжей частью, Enter — готово");
  }

  // ---------------------------------------------------------------------------
  // Боковая панель
  // ---------------------------------------------------------------------------

  function activeTab() {
    const b = document.querySelector(".tabs button.active");
    return b && b.dataset.tab;
  }

  function showTab(name) {
    document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.id === "tab-" + name));
    if (name === "issues") { if (!state.issuesFresh) runValidation(); renderIssues(); }
    if (name === "help") renderHelp();
    if (name === "changes") renderChanges();
    if (name === "ped") renderPed();
  }
  document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => {
    showTab(b.dataset.tab);
    if (isMobile() && document.body.classList.contains("sheet-collapsed")) setSheet("half");
  }));

  // ----- телефон: шторка с панелью и меню ☰ -----
  function setSheet(stateName) {
    document.body.classList.toggle("sheet-collapsed", stateName === "collapsed");
    document.body.classList.toggle("sheet-full", stateName === "full");
  }
  $("#sheet-handle").addEventListener("click", () => {
    const b = document.body.classList;
    setSheet(b.contains("sheet-collapsed") ? "half" : b.contains("sheet-full") ? "collapsed" : "full");
  });
  // жест: потянуть шторку вверх или вниз за ручку
  let sheetTouch = null;
  $("#sheet-handle").addEventListener("touchstart", (e) => { sheetTouch = e.touches[0].clientY; }, { passive: true });
  $("#sheet-handle").addEventListener("touchend", (e) => {
    if (sheetTouch == null) return;
    const dy = e.changedTouches[0].clientY - sheetTouch;
    sheetTouch = null;
    if (Math.abs(dy) < 25) return;
    const b = document.body.classList;
    if (dy < 0) setSheet(b.contains("sheet-collapsed") ? "half" : "full");
    else setSheet(b.contains("sheet-full") ? "half" : "collapsed");
    e.preventDefault();
  });
  if (isMobile()) setSheet("collapsed");

  function closeMenu() { document.body.classList.remove("menu-open"); $("#btn-menu").setAttribute("aria-expanded", "false"); }
  $("#btn-menu").addEventListener("click", (e) => {
    e.stopPropagation();
    const open = !document.body.classList.contains("menu-open");
    document.body.classList.toggle("menu-open", open);
    $("#btn-menu").setAttribute("aria-expanded", String(open));
  });
  // после действия в меню оно закрывается; поля ввода и ползунок — не закрывают
  $("#toolbar-more").addEventListener("click", (e) => { if (e.target.closest("button")) closeMenu(); });
  $("#view-mode").addEventListener("change", closeMenu);
  map.on("click movestart", closeMenu);

  function renderPanel() {
    const box = $("#tab-object");
    box.replaceChildren();
    const doc = state.doc;
    if (!doc) {
      box.append(el("p", {}, "Откройте файл .osm кнопкой «Открыть» или перетащите его на карту."),
        el("p", { class: "muted" }, "Для пробы есть кнопка «Пример»: она открывает example.osm, если редактор запущен через сервер."));
      return;
    }
    const s = state.sel;
    if (s && s.type === "way" && doc.ways.has(s.id)) return renderWay(box, doc.ways.get(s.id));
    if (s && s.type === "node" && doc.nodes.has(s.id)) return renderNode(box, doc.nodes.get(s.id), s.way);
    renderOverview(box);
  }

  function renderOverview(box) {
    const st = state.doc.stats();
    const errors = state.issues.filter((i) => i.severity === "error").length;
    box.append(
      el("h2", {}, state.fileLabel),
      el("p", { class: "muted small" }, state.doc.dirty ? "Есть несохранённые правки" : "Правок нет"),
      el("div", { class: "stats" },
        "Дорог для машин", el("b", {}, st.drivable),
        "  — с числом полос", el("b", {}, st.lanes),
        "  — односторонних", el("b", {}, st.oneway),
        "Светофоров", el("b", {}, st.signals),
        "Всех линий", el("b", {}, st.ways),
        "Узлов", el("b", {}, st.nodes),
        "Отношений", el("b", {}, st.relations),
        "Ошибок графа", el("b", {}, errors)),
      el("div", { class: "hint" },
        el("b", {}, "Как править. "),
        "Кликните дорогу — справа появятся её атрибуты, на карте — узлы. Тащите узел, чтобы сдвинуть; бросьте на другой узел — получится перекрёсток. ",
        "Режим «Дорога» (N) рисует новую, «Светофор» (T) ставит светофор кликом."),
      el("h3", {}, "Автозаполнение пропусков"),
      autofillBlock(),
      el("h3", {}, "Пешеходы — массово"),
      el("div", { class: "actions" },
        el("button", { onclick: () => bulk("пешеходам нельзя на магистралях", (w) => isDrivable(w) && MAJOR.has(w.tags.highway) && !w.tags.foot, "foot", "no"),
          title: "foot=no на trunk/primary/secondary, где доступ пешеходов не указан" }, "Запретить на магистралях"),
        el("button", { onclick: () => bulk("пешеходы во дворах", (w) => (w.tags.highway === "service" || w.tags.highway === "living_street") && !w.tags.foot, "foot", "yes"),
          title: "foot=yes на дворовых проездах и в жилых зонах" }, "Разрешить во дворах")),
      el("p", { class: "muted small" }, "Обе кнопки — один шаг отмены. Отдельную дорогу можно поправить в её свойствах."),
      el("h3", {}, "Легенда — " + VIEWS[state.view].toLowerCase()),
      legend(),
    );
  }

  const MAJOR = new Set(["motorway", "trunk", "primary", "secondary", "motorway_link", "trunk_link", "primary_link", "secondary_link"]);

  function bulk(label, filter, key, value) {
    const n = run(label, () => state.doc.bulkSetTag(filter, key, value));
    toast(n ? `Изменено дорог: ${n}` : "Подходящих дорог нет — всё уже указано");
  }

  function legend() {
    const rows = {
      class: [["#5f3dc4", 6, "Магистральная (primary)"], ["#1971c2", 5, "Районная (secondary)"], ["#0c8599", 4, "Улица (tertiary)"],
        ["#2f9e44", 3.5, "Жилая (residential)"], ["#e67700", 3, "Жилая зона, двор"], ["#868e96", 2.5, "Проезд (service)"]],
      lanes: [["#a5d8ff", 4, "1 полоса"], ["#4dabf7", 5, "2 полосы"], ["#1c7ed6", 6, "3 полосы"], ["#1864ab", 8, "4 полосы"],
        ["#0b2e5c", 10, "5 и больше"], ["#e03131", 3, "Не указано — заполнить"]],
      speed: [["#2f9e44", 4, "до 20 км/ч"], ["#94d82d", 4, "до 40 км/ч"], ["#f59f00", 4, "до 60 км/ч"], ["#e8590c", 4, "больше 60"], ["#adb5bd", 3, "Не указано"]],
      foot: [["#e03131", 4, "Пешеходам нельзя"], ["#2f9e44", 4, "Можно / двор, жилая зона"], ["#1c7ed6", 4, "Есть тротуары"], ["#adb5bd", 3, "Не указано"]],
    }[state.view];
    const box = el("div", { class: "legend" });
    for (const [c, w, t] of rows) box.append(el("i", { style: `background:${c};height:${w}px` }), el("span", {}, t));
    if (state.view === "class") box.append(el("span", { class: "small muted", style: "grid-column:1/-1" }, "Толщина линии — число полос"));
    box.append(el("i", { style: "background:#ae3ec9;height:2px" }), el("span", {}, "Тротуары и тропы"));
    box.append(el("i", { style: "background:#c2255c;height:4px" }), el("span", {}, "Надземный / подземный переход"));
    box.append(el("i", { style: "background:#4dabf7;height:10px;opacity:.5;border:1px dashed #1864ab" }), el("span", {}, "Парковка"));
    box.append(el("i", { style: "background:#e03131;height:10px;width:10px;border-radius:50%" }), el("span", {}, "Светофор"));
    box.append(el("i", { style: "border:3px solid #c92a2a;height:14px;width:14px;border-radius:50%;background:none" }), el("span", {}, "Проблема графа"));
    return box;
  }

  function wayLength(w) {
    let m = 0;
    for (let i = 1; i < w.nodes.length; i++) m += distM(state.doc.nodes.get(w.nodes[i - 1]), state.doc.nodes.get(w.nodes[i]));
    return m;
  }

  function field(labelText, input) {
    const id = "f-" + Math.random().toString(36).slice(2, 8);
    input.id = id;
    return [el("label", { for: id }, labelText), input];
  }

  function textInput(value, onChange, opts) {
    const i = el("input", Object.assign({ type: "text", value: value || "" }, opts || {}));
    i.addEventListener("change", () => onChange(i.value.trim()));
    return i;
  }

  function selectInput(options, value, onChange) {
    const s = el("select", {});
    let found = false;
    for (const [v, t] of options) {
      const o = el("option", { value: v }, t);
      if (v === value) { o.selected = true; found = true; }
      s.append(o);
    }
    if (!found && value) s.prepend(el("option", { value, selected: true }, value));
    s.addEventListener("change", () => onChange(s.value));
    return s;
  }

  function check(labelText, checked, onChange) {
    const i = el("input", { type: "checkbox" });
    i.checked = !!checked;
    i.addEventListener("change", () => onChange(i.checked));
    return el("label", {}, i, labelText);
  }

  function renderWay(box, w) {
    const doc = state.doc;
    const t = w.tags;
    const tag = (k, v) => run(`${k} = ${v || "∅"}`, () => doc.setTag("way", w.id, k, v));
    box.append(
      el("h2", {}, label(w)),
      el("p", { class: "muted small" }, `Линия #${w.id} · ${w.nodes.length} ${plural(w.nodes.length, "узел", "узла", "узлов")} · ${Math.round(wayLength(w))} м`),
    );

    if (t.highway || category(w) === "roads") {
      const dir = onewayDir(w);
      const form = el("div", { class: "form" },
        field("Тип дороги", selectInput(HIGHWAY_TYPES, t.highway, (v) => tag("highway", v))),
        field("Название", textInput(t.name, (v) => tag("name", v))),
        field("Направление", selectInput([["no", "В обе стороны"], ["yes", "Одностороннее — по стрелке"], ["-1", "Одностороннее — против"]],
          t.oneway === "-1" ? "-1" : dir === 1 ? "yes" : "no", (v) => run("направление", () => {
            const tags = { ...w.tags };
            if (v === "no") { delete tags.oneway; } else { tags.oneway = v; delete tags["lanes:forward"]; delete tags["lanes:backward"]; }
            doc.setTags("way", w.id, tags);
          }))),
        );
      form.append(...field("Скорость, км/ч", textInput(t.maxspeed, (v) => tag("maxspeed", v), { list: "speeds", title: "Число в км/ч или RU:urban (60), RU:living_street (20)" })));
      form.append(...field("Ширина, м", textInput(t.width, (v) => tag("width", v), { type: "number", min: 2, max: 40, step: 0.5,
        title: "Ширина проезжей части. SUMO делит её на полосы, по ней Webots строит покрытие" })));
      form.append(...field("Уровень (layer)", textInput(t.layer, (v) => tag("layer", v), { type: "number", min: -5, max: 5, title: "Мосты +1 и выше, тоннели −1" })));
      box.append(form);
      box.append(el("h3", {}, "Полосы"), lanesEditor(w));
      box.append(el("div", { class: "checks" },
        check("Мост", t.bridge && t.bridge !== "no", (on) => run(on ? "мост" : "не мост", () => {
          const tags = { ...w.tags };
          if (on) { tags.bridge = "yes"; if (!tags.layer) tags.layer = "1"; } else { delete tags.bridge; if (tags.layer === "1") delete tags.layer; }
          doc.setTags("way", w.id, tags);
        })),
        check("Тоннель", t.tunnel && t.tunnel !== "no", (on) => run(on ? "тоннель" : "не тоннель", () => {
          const tags = { ...w.tags };
          if (on) { tags.tunnel = "yes"; if (!tags.layer) tags.layer = "-1"; } else { delete tags.tunnel; if (tags.layer === "-1") delete tags.layer; }
          doc.setTags("way", w.id, tags);
        })),
        check("Кольцо", t.junction === "roundabout", (on) => tag("junction", on ? "roundabout" : "")),
      ));
      box.append(el("h3", {}, "Пешеходы и парковка"), el("div", { class: "form" },
        field("По проезжей части", selectInput([
          ["", "Не указано"], ["no", "Нельзя (foot=no)"], ["yes", "Можно (foot=yes)"], ["designated", "Приоритет пешеходов"]],
          t.foot || "", (v) => tag("foot", v))),
        field("Тротуары", selectInput([
          ["", "Не указано"], ["both", "С обеих сторон"], ["right", "Справа"], ["left", "Слева"], ["no", "Нет"]],
          t.sidewalk || "", (v) => tag("sidewalk", v))),
        field("Парковка вдоль", selectInput([
          ["", "Нет / не указано"], ["both", "С обеих сторон"], ["right", "Справа"], ["left", "Слева"]],
          ["both", "right", "left"].find((side) => t["parking:" + side] === "lane") || "", (v) => run("парковка вдоль", () => {
            const tags = { ...w.tags };
            for (const side of ["both", "left", "right"]) { delete tags["parking:" + side]; delete tags["parking:" + side + ":orientation"]; }
            if (v) { tags["parking:" + v] = "lane"; tags["parking:" + v + ":orientation"] = "parallel"; }
            doc.setTags("way", w.id, tags);
          })))),
      );
    }
    if (category(w) === "parking") {
      box.append(el("div", { class: "form" },
        field("Мест", textInput(t.capacity, (v) => tag("capacity", v), { type: "number", min: 1 })),
        field("Тип", selectInput([["surface", "Наземная"], ["multi-storey", "Многоуровневая"], ["underground", "Подземная"], ["street_side", "У дороги"]],
          t.parking || "surface", (v) => tag("parking", v))),
        field("Доступ", selectInput([["", "Общая"], ["customers", "Для клиентов"], ["private", "Частная"]], t.access || "", (v) => tag("access", v))),
      ));
    }

    box.append(el("div", { class: "actions" },
      el("button", { onclick: () => run("развернуть", () => doc.reverseWay(w.id)), title: "R" }, "⇄ Развернуть"),
      el("button", { onclick: applyTemplateToSelection, title: "Применить шаблон из панели сверху" }, "Шаблон"),
      el("button", { onclick: () => open3d(focusPoint()), title: "Посмотреть уровни вокруг этой дороги (3)" }, "В 3D"),
      el("button", { class: "danger", onclick: () => { run("удалить линию", () => doc.deleteWay(w.id)); select(null); }, title: "Delete" }, "Удалить"),
    ));
    box.append(el("p", { class: "muted small" }, "Кликните узел на линии, чтобы поставить светофор или разрезать дорогу в этом месте."));
    box.append(el("h3", {}, "Все теги"), tagTable("way", w));
  }

  // Полосы по направлениям: кнопки ± и схема полос со стрелками
  function lanesEditor(w) {
    const doc = state.doc;
    const l = doc.lanesOf(w);
    const oneway = onewayDir(w) !== 0;
    const wrap = el("div", { class: "lanes" });
    const stepper = (title, value, onSet) => el("div", { class: "stepper" },
      el("span", {}, title),
      el("button", { title: "Меньше", onclick: () => onSet(Math.max(0, (value || 0) - 1)), disabled: !value }, "−"),
      el("b", {}, value == null ? "?" : value),
      el("button", { title: "Больше", onclick: () => onSet(Math.min(8, (value || 0) + 1)) }, "+"));
    if (oneway) {
      wrap.append(stepper("В одну сторону", l.total, (v) => run("полосы", () => doc.setLanes(w.id, v, 0))));
    } else {
      wrap.append(stepper("Туда →", l.forward, (v) => run("полосы туда", () => doc.setLanes(w.id, v, l.backward || 0))));
      wrap.append(stepper("← Обратно", l.backward, (v) => run("полосы обратно", () => doc.setLanes(w.id, l.forward || 0, v))));
    }
    // Схема: верхний ряд — обратное направление, нижний — по направлению рисования
    const diagram = el("div", { class: "lane-diagram", title: "Схема полос (по стрелке — направление рисования линии)" });
    const back = oneway ? 0 : l.backward || 0, fwd = oneway ? l.total || 0 : l.forward || 0;
    for (let i = 0; i < back; i++) diagram.append(el("div", { class: "lane back" }, "←"));
    if (back && fwd) diagram.append(el("div", { class: "lane-divider" }));
    for (let i = 0; i < fwd; i++) diagram.append(el("div", { class: "lane fwd" }, "→"));
    if (!back && !fwd) diagram.append(el("div", { class: "muted small" }, "Полосы не указаны — SUMO возьмёт число по умолчанию для класса дороги"));
    wrap.append(diagram);
    if (!oneway && l.total != null && (l.forward == null || l.backward == null) && l.total % 2) {
      wrap.append(el("p", { class: "muted small" }, `Указано lanes=${l.total} без разбивки по направлениям — уточните кнопками.`));
    }
    return wrap;
  }

  function renderNode(box, n, wayId) {
    const doc = state.doc;
    const ways = doc.waysOfNode(n.id);
    const w = wayId && doc.ways.get(wayId);
    const inner = w && w.nodes.indexOf(n.id) > 0 && w.nodes.indexOf(n.id) < w.nodes.length - 1;
    const kind = nodeKind(n);
    box.append(
      el("h2", {}, kind === "signal" ? "Светофор" : kind === "sign" ? "Дорожный знак" : kind === "crossing" ? "Пешеходный переход" : ways.length > 1 ? "Перекрёсток" : "Узел"),
      el("p", { class: "muted small" }, `Узел #${n.id} · ${n.lat.toFixed(6)}, ${n.lon.toFixed(6)} · ` +
        (ways.length ? `${ways.length} ${plural(ways.length, "линия", "линии", "линий")}: ` + ways.map(label).join(", ") : "не на дороге")),
      kind === "sign" ? el("p", {}, el("b", {}, (SIGNS.find((x) => x.tags.traffic_sign === n.tags.traffic_sign &&
        (!x.speed || x.speed === n.tags.maxspeed)) || { name: n.tags.traffic_sign || n.tags.highway }).name)) : null,
      kind === "sign" ? el("p", { class: "muted small" }, n.tags.maxspeed
        ? "Скорость дороги, на которой стоит знак, тоже выставлена — её SUMO и использует."
        : "Знак записан в OSM по правилам (traffic_sign). SUMO при импорте его не учитывает — приоритет на перекрёстке задаётся классом дорог.") : null,
      el("div", { class: "checks" },
        check("Светофор", kind === "signal", () => onSignalClick(L.latLng(n.lat, n.lon))),
      ),
      el("div", { class: "actions" },
        inner ? el("button", { onclick: () => {
          const nid = run("разрезать", () => doc.splitWay(w.id, n.id));
          if (nid) toast("Дорога разрезана: теперь у частей могут быть разные атрибуты");
        }, title: "X" }, "✂ Разрезать дорогу здесь") : null,
        w ? el("button", { onclick: () => select({ type: "way", id: w.id }) }, "← К дороге") : null,
        el("button", { onclick: () => open3d({ lat: n.lat, lon: n.lon }) }, "В 3D"),
        el("button", { class: "danger", onclick: () => { run("удалить узел", () => doc.deleteNode(n.id)); select(w && doc.ways.has(w.id) ? { type: "way", id: w.id } : null); }, title: "Delete" }, "Удалить узел"),
      ),
      el("p", { class: "muted small" }, "Чтобы соединить дороги, перетащите узел на узел другой дороги. Alt при перетаскивании — без прилипания."),
      el("h3", {}, "Все теги"), tagTable("node", n),
    );
  }

  function tagTable(type, obj) {
    const doc = state.doc;
    const table = el("table", { class: "tags" });
    const commitRow = (oldKey, k, v) => run("теги", () => {
      const tags = {};
      for (const [kk, vv] of Object.entries(obj.tags)) {
        if (kk === oldKey) { if (k) tags[k] = v; } else tags[kk] = vv;
      }
      if (!oldKey && k) tags[k] = v;
      doc.setTags(type, obj.id, tags);
    });
    for (const [k, v] of Object.entries(obj.tags)) {
      const ki = el("input", { value: k, spellcheck: "false" });
      const vi = el("input", { value: v, spellcheck: "false" });
      const save = () => commitRow(k, ki.value.trim(), vi.value.trim());
      ki.addEventListener("change", save); vi.addEventListener("change", save);
      table.append(el("tr", {}, el("td", {}, ki), el("td", {}, vi),
        el("td", {}, el("button", { title: "Удалить тег", onclick: () => commitRow(k, "", "") }, "✕"))));
    }
    const nk = el("input", { placeholder: "ключ", spellcheck: "false" });
    const nv = el("input", { placeholder: "значение", spellcheck: "false" });
    const add = () => { if (nk.value.trim() && nv.value.trim()) commitRow(null, nk.value.trim(), nv.value.trim()); };
    nv.addEventListener("change", add);
    table.append(el("tr", {}, el("td", {}, nk), el("td", {}, nv), el("td", {}, el("button", { title: "Добавить тег", onclick: add }, "+"))));
    return table;
  }

  // ----- проблемы -----

  const ISSUE_TITLES = {
    isolated: "Изолированные куски", deadend: "Односторонние тупики", gap: "Разорванные перекрёстки",
    crossing: "Пересечения без перекрёстка", bridge: "Мосты без уровня",
    trap: "Ловушки (нельзя выехать)", glued: "Склеенные перекрёстки", direction: "Неверные направления",
  };

  function renderIssues() {
    const box = $("#tab-issues");
    box.replaceChildren();
    if (!state.doc) { box.append(el("p", { class: "muted" }, "Файл не открыт.")); return; }
    const errors = state.issues.filter((i) => i.severity === "error").length;
    const warns = state.issues.length - errors;
    box.append(el("div", { class: "summary" },
      el("span", {}, "Ошибок: ", el("b", { class: errors ? "err" : "ok" }, errors)),
      el("span", {}, "Предупреждений: ", el("b", { class: warns ? "warn" : "ok" }, warns)),
      el("button", { onclick: () => { runValidation(); renderIssues(); } }, "Проверить заново")));
    box.append(el("p", { class: "muted small" },
      "Проверяются только дороги для машин — по ним MatSim строит маршруты, а SUMO пускает машины. Концы дорог у края фрагмента не считаются тупиками. Список обновляется после каждой правки."));
    if (!state.issues.length) { box.append(el("p", {}, "Граф связный, ошибок не найдено.")); return; }
    let lastType = null;
    for (const is of state.issues) {
      if (is.type !== lastType) { box.append(el("h3", {}, ISSUE_TITLES[is.type] || is.type)); lastType = is.type; }
      box.append(el("div", { class: "issue " + is.severity },
        el("p", {}, is.message),
        el("div", { class: "actions" },
          el("button", { onclick: () => focusIssue(is) }, "Показать"),
          el("button", { onclick: () => { focusIssue(is); open3d({ lat: is.lat, lon: is.lon }); } }, "В 3D"),
          is.fix ? el("button", { class: "primary", onclick: () => {
            run("исправить: " + (ISSUE_TITLES[is.type] || is.type), () => state.doc.applyFix(is.fix));
            runValidation(); renderIssues();
          } }, "Исправить") : null)));
    }
  }

  function focusIssue(is) {
    map.setView([is.lat, is.lon], Math.max(map.getZoom(), 18));
    if (is.ways && is.ways.length) select({ type: "way", id: is.ways[0] });
    else if (is.nodes && is.nodes.length) select({ type: "node", id: is.nodes[0], way: (state.doc.waysOfNode(is.nodes[0])[0] || {}).id });
    showTab("issues");
    const ring = L.circleMarker([is.lat, is.lon], { renderer, radius: 22, color: "#f2b705", weight: 4, fill: false, interactive: false }).addTo(g.sel);
    setTimeout(() => ring.remove(), 1500);
  }

  // ----- справка -----

  function renderHelp() {
    const box = $("#tab-help");
    if (box.childElementCount) return;
    const keys = [
      ["V", "Режим выбора и правки"], ["N", "Нарисовать дорогу (клики по карте, Enter или двойной клик — готово)"],
      ["T", "Светофор: клик по узлу или дороге"], ["S", "Дорожный знак"], ["P", "Пешеходный переход"], ["M", "Линейка"], ["3", "3D-просмотр видимой области"], ["R", "Развернуть выбранную дорогу"], ["X", "Разрезать дорогу в выбранном узле"],
      ["Delete", "Удалить выбранное"], ["Backspace", "При рисовании — убрать последнюю точку"], ["Esc", "Отмена / снять выбор"],
      ["Ctrl+Z / Ctrl+Y", "Отменить / повторить"], ["Ctrl+S", "Сохранить .osm"], ["Ctrl+O", "Открыть .osm"],
      ["F", "Скрыть/показать тротуары"], ["B", "Скрыть/показать здания"],
    ];
    const t = el("div", { class: "stats" });
    for (const [k, d] of keys) t.append(el("span", {}, d), el("b", {}, el("kbd", {}, k)));
    box.append(
      el("h2", {}, "Редактор графа УДС"),
      el("p", {}, "Открывает .osm, показывает дорожную сеть на карте, даёт править её мышью и сохраняет обратно в .osm — тот же формат, который на сервере проверки читают MatSim, SUMO и Webots."),
      el("h3", {}, "Горячие клавиши"), t,
      el("h3", {}, "Приёмы"),
      el("ul", {},
        el("li", {}, "Новая дорога, начатая или законченная на существующей дороге, сразу соединяется с ней (оранжевая точка)."),
        el("li", {}, "Узел, брошенный на другой узел, сливается с ним — так чинятся разорванные перекрёстки."),
        el("li", {}, "Полупрозрачные точки посередине отрезков — потяните, чтобы добавить изгиб."),
        el("li", {}, "Подложку можно сменить в правом верхнем углу карты (2ГИС, спутник, OSM), прозрачность — ползунком сверху."),
        el("li", {}, "Перед сохранением граф проверяется; ошибки видны на вкладке «Проблемы» и красными кругами на карте.")),
    );
  }

  // ---------------------------------------------------------------------------
  // Было — стало: список правок, подсветка, отчёт, обмен правками
  // ---------------------------------------------------------------------------

  function tagDiff(before, after) {
    const out = [];
    const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
    for (const k of [...keys].sort()) {
      const a = (before || {})[k], b = (after || {})[k];
      if (a !== b) out.push({ k, a, b });
    }
    return out;
  }

  function describeChange(c) {
    const t = (c.after || c.before).tags || {};
    const name = t.name || t.highway || t.amenity || t.building && "здание" || t.railway || (c.type === "node" ? "узел" : "линия");
    return `${name} #${c.id}`;
  }

  function changeGroups() {
    const diff = state.doc.diff();
    const groups = { roads: [], points: [], other: [] };
    for (const c of diff) {
      const e = c.after || c.before;
      if (c.type === "way") (e.tags.highway || e.tags.railway || e.tags.amenity === "parking" ? groups.roads : groups.other).push(c);
      else if (c.type === "node") {
        const td = tagDiff(c.before && c.before.tags, c.after && c.after.tags);
        if (td.length || c.kind !== "modified") {
          if (Object.keys(e.tags || {}).length || (c.before && Object.keys(c.before.tags || {}).length)) groups.points.push(c);
        }
      } else groups.other.push(c);
    }
    return { diff, groups };
  }

  function drawDiffLayer(diff) {
    g.diff.clearLayers();
    const doc = state.doc;
    for (const c of diff) {
      if (c.type !== "way") continue;
      const color = c.kind === "added" ? "#2f9e44" : c.kind === "deleted" ? "#e03131" : "#f08c00";
      let pts;
      if (c.kind === "deleted") {
        // удалённую линию рисуем по исходным координатам
        pts = c.before.nodes.map((id) => {
          const n = doc.nodes.get(id) || (doc.base.node.has(id) ? JSON.parse(doc.base.node.get(id)) : null);
          return n && [n.lat, n.lon];
        }).filter(Boolean);
      } else pts = c.after.nodes.map((id) => doc.nodes.get(id)).filter(Boolean).map(ll);
      if (pts.length < 2) continue;
      L.polyline(pts, { renderer, color, weight: 9, opacity: 0.45, dashArray: c.kind === "deleted" ? "6 6" : null, interactive: false }).addTo(g.diff);
    }
  }

  function renderChanges() {
    const box = $("#tab-changes");
    box.replaceChildren();
    if (!state.doc) { box.append(el("p", { class: "muted" }, "Файл не открыт.")); return; }
    const { diff, groups } = changeGroups();
    drawDiffLayer(diff);
    const count = (kind, type) => diff.filter((c) => c.kind === kind && (!type || c.type === type)).length;
    box.append(
      el("h2", {}, "Было — стало"),
      el("p", { class: "muted small" }, "Сравнение с файлом, как он был открыт. На карте: зелёным — новое, оранжевым — изменённое, красным пунктиром — удалённое."),
      el("div", { class: "stats" },
        "Новых линий", el("b", {}, count("added", "way")),
        "Изменённых линий", el("b", {}, count("modified", "way")),
        "Удалённых линий", el("b", {}, count("deleted", "way")),
        "Точечных объектов (светофоры, знаки, переходы)", el("b", {}, groups.points.length)),
      el("div", { class: "actions" },
        el("button", { onclick: downloadReport, title: "Список всех правок — для защиты и для жюри" }, "Отчёт .md"),
        el("button", { onclick: exportPatch, title: "Файл с вашими правками — чтобы товарищ влил их в свою копию" }, "Экспорт правок"),
        el("button", { onclick: () => $("#patch-input").click(), title: "Влить правки товарища, сделанные на том же исходном файле" }, "Влить правки…")),
    );
    const list = (title, items) => {
      if (!items.length) return;
      box.append(el("h3", {}, `${title} (${items.length})`));
      for (const c of items.slice(0, 150)) {
        const td = tagDiff(c.before && c.before.tags, c.after && c.after.tags);
        const geom = c.kind === "modified" && c.type === "way" && JSON.stringify(c.before.nodes) !== JSON.stringify(c.after.nodes);
        const moved = c.kind === "modified" && c.type === "node" && (c.before.lat !== c.after.lat || c.before.lon !== c.after.lon);
        const kindText = { added: "добавлено", modified: "изменено", deleted: "удалено" }[c.kind];
        box.append(el("div", { class: "issue change-" + c.kind },
          el("p", {}, el("b", {}, describeChange(c)), " — ", kindText,
            geom ? ", геометрия" : "", moved ? ", сдвинут" : ""),
          td.length && c.kind === "modified" ? el("p", { class: "small mono" }, td.map((d) => `${d.k}: ${d.a ?? "∅"} → ${d.b ?? "∅"}`).join("; ")) : null,
          c.kind !== "deleted" ? el("div", { class: "actions" }, el("button", { onclick: () => {
            if (c.type === "way") {
              const layer = wayLayers.get(c.id);
              if (layer) map.fitBounds(layer.getBounds().pad(0.5));
              select({ type: "way", id: c.id });
            } else {
              const n = state.doc.nodes.get(c.id);
              if (n) { map.setView(ll(n), Math.max(map.getZoom(), 18)); select({ type: "node", id: c.id, way: (state.doc.waysOfNode(c.id)[0] || {}).id }); }
            }
            showTab("changes");
          } }, "Показать")) : null));
      }
      if (items.length > 150) box.append(el("p", { class: "muted small" }, `…и ещё ${items.length - 150}`));
    };
    list("Дороги и пути", groups.roads);
    list("Светофоры, знаки, переходы", groups.points);
    list("Прочее", groups.other);
    if (!diff.length) box.append(el("p", {}, "Правок пока нет."));
    box.append(el("h3", {}, "Отправить на проверку"),
      el("p", { class: "muted small" }, "Файл уходит на сервер проверки (MatSim → SUMO → Webots), здесь видно место в очереди и результат."),
      serverBlock());
  }

  function download(name, text, type) {
    const blob = new Blob([text], { type: type || "text/plain" });
    const a = el("a", { href: URL.createObjectURL(blob), download: name });
    document.body.append(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  function downloadReport() {
    const { diff, groups } = changeGroups();
    const issuesBefore = OsmDoc.parse(state.baseText).validate();
    runValidation();
    const byType = (list) => {
      const m = {};
      for (const i of list) m[i.type] = (m[i.type] || 0) + 1;
      return m;
    };
    const ib = byType(issuesBefore), ia = byType(state.issues);
    const st0 = OsmDoc.parse(state.baseText).stats(), st1 = state.doc.stats();
    const lines = [
      `# Правки графа УДС — ${teamName() || "команда"}`, "",
      `Исходный файл: ${state.fileLabel}. Сформировано редактором ГрафУДС ${new Date().toLocaleString("ru-RU")}.`, "",
      "## Итог", "",
      "| Показатель | Было | Стало |", "|---|---|---|",
      `| Дорог для машин | ${st0.drivable} | ${st1.drivable} |`,
      `| — с числом полос | ${st0.lanes} | ${st1.lanes} |`,
      `| — односторонних | ${st0.oneway} | ${st1.oneway} |`,
      `| Светофоров | ${st0.signals} | ${st1.signals} |`,
      ...Object.keys(ISSUE_TITLES).filter((k) => ib[k] || ia[k]).map((k) => `| ${ISSUE_TITLES[k]} | ${ib[k] || 0} | ${ia[k] || 0} |`),
      "", "## Правки", "",
    ];
    const section = (title, items) => {
      if (!items.length) return;
      lines.push(`### ${title}`, "");
      for (const c of items) {
        const td = tagDiff(c.before && c.before.tags, c.after && c.after.tags);
        const kind = { added: "добавлено", modified: "изменено", deleted: "удалено" }[c.kind];
        lines.push(`- **${describeChange(c)}** — ${kind}` + (td.length && c.kind === "modified" ? ": " + td.map((d) => `\`${d.k}\` ${d.a ?? "∅"} → ${d.b ?? "∅"}`).join(", ") : ""));
      }
      lines.push("");
    };
    section("Дороги и пути", groups.roads);
    section("Светофоры, знаки, переходы", groups.points);
    section("Прочее", groups.other);
    download(`${teamName() || "team"}-правки.md`, lines.join("\n"), "text/markdown");
    toast(`Отчёт: ${diff.length} правок`);
  }

  function exportPatch() {
    const patch = state.doc.exportPatch({ file: state.fileLabel, team: teamName(), at: new Date().toISOString() });
    if (!patch.changes.length) return toast("Правок нет — экспортировать нечего");
    download(`${teamName() || "team"}-правки-${new Date().toTimeString().slice(0, 5).replace(":", "")}.json`, JSON.stringify(patch), "application/json");
    toast(`Экспортировано правок: ${patch.changes.length}`);
  }

  function importPatch(file) {
    if (!file || !state.doc) return;
    const reader = new FileReader();
    reader.onload = () => {
      let patch;
      try { patch = JSON.parse(reader.result); } catch (e) { return toast("Не удалось прочитать файл правок"); }
      const res = run("влить правки " + (patch.meta && patch.meta.team || ""), () => state.doc.applyPatch(patch));
      if (!res) return;
      drawAll();
      renderChanges();
      toast(`Влито правок: ${res.applied}` + (res.conflicts.length ? `, пропущено конфликтов: ${res.conflicts.length} (эти объекты вы тоже меняли)` : ""));
    };
    reader.readAsText(file, "utf-8");
  }

  // ---------------------------------------------------------------------------
  // Автозаполнение пропусков
  // ---------------------------------------------------------------------------

  const AUTOFILL_DEFAULTS = {
    primary: { lanes: 4, oneLanes: 2, maxspeed: 60 }, secondary: { lanes: 2, oneLanes: 2, maxspeed: 60 },
    tertiary: { lanes: 2, oneLanes: 1, maxspeed: 60 }, residential: { lanes: 2, oneLanes: 1, maxspeed: 40 },
    unclassified: { lanes: 2, oneLanes: 1, maxspeed: 40 }, living_street: { lanes: 1, oneLanes: 1, maxspeed: 20 },
    service: { lanes: 1, oneLanes: 1, maxspeed: 20 }, primary_link: { lanes: 1, oneLanes: 1, maxspeed: 40 },
    secondary_link: { lanes: 1, oneLanes: 1, maxspeed: 40 }, tertiary_link: { lanes: 1, oneLanes: 1, maxspeed: 40 },
  };

  function autofillBlock() {
    const wrap = el("div", {});
    const table = el("table", { class: "tags autofill" },
      el("tr", {}, el("th", {}, "Класс"), el("th", {}, "Полос 2-ст."), el("th", {}, "Полос 1-ст."), el("th", {}, "Скорость")));
    for (const [hw, d] of Object.entries(AUTOFILL_DEFAULTS)) {
      const inp = (key) => {
        const i = el("input", { type: "number", min: 1, max: key === "maxspeed" ? 130 : 8, value: d[key] });
        i.addEventListener("change", () => { d[key] = parseInt(i.value, 10) || d[key]; });
        return el("td", {}, i);
      };
      table.append(el("tr", {}, el("td", { class: "small" }, hw), inp("lanes"), inp("oneLanes"), inp("maxspeed")));
    }
    const result = el("p", { class: "small" });
    let plan = null;
    const preview = () => {
      plan = state.doc.autofillPlan(AUTOFILL_DEFAULTS);
      const lanes = plan.filter((p) => p.key === "lanes").length, speed = plan.filter((p) => p.key === "maxspeed").length;
      result.textContent = plan.length ? `Будет заполнено: полосы — у ${lanes} дорог, скорость — у ${speed}. Уже указанные значения не меняются.` : "Пропусков нет.";
      g.diff.clearLayers();
      const ids = new Set(plan.map((p) => p.way));
      for (const id of ids) {
        const layer = wayLayers.get(id);
        if (layer) L.polyline(layer.getLatLngs(), { renderer, color: "#f2b705", weight: 10, opacity: 0.5, interactive: false }).addTo(g.diff);
      }
      apply.disabled = !plan.length;
    };
    const apply = el("button", { class: "primary", disabled: true, onclick: () => {
      if (!plan || !plan.length) return;
      const n = run("автозаполнение", () => state.doc.applyAutofill(plan));
      g.diff.clearLayers();
      toast(`Заполнено значений: ${n}. Отменить — Ctrl+Z`);
      plan = null; apply.disabled = true;
    } }, "Применить");
    wrap.append(
      el("p", { class: "muted small" }, "Заполняет только пропуски — значения по умолчанию задают транспортники. Сначала «Показать», что изменится (подсветка на карте)."),
      el("details", {}, el("summary", {}, "Значения по умолчанию"), table),
      el("div", { class: "actions" }, el("button", { onclick: preview }, "Показать"), apply), result);
    return wrap;
  }

  // ---------------------------------------------------------------------------
  // Пешеходный поток (анализ по графу)
  // ---------------------------------------------------------------------------

  let pedAnim = null;
  function stopPedAnimation() {
    if (pedAnim) { cancelAnimationFrame(pedAnim.frame); pedAnim.layer.remove(); pedAnim = null; }
  }

  function drawPedFlow(res) {
    g.ped.clearLayers();
    const doc = state.doc;
    const counts = [...res.edges.values()].map((e) => e.count).sort((a, b) => a - b);
    const q = (p) => counts[Math.floor((counts.length - 1) * p)] || 1;
    const q50 = q(0.5), q80 = q(0.8), q95 = q(0.95);
    for (const e of res.edges.values()) {
      const a = doc.nodes.get(e.a), b = doc.nodes.get(e.b);
      if (!a || !b) continue;
      const [color, weight] = e.count >= q95 ? ["#c2255c", 8] : e.count >= q80 ? ["#f76707", 6] : e.count >= q50 ? ["#fab005", 4] : ["#ffe066", 2.5];
      L.polyline([ll(a), ll(b)], { renderer, color, weight, opacity: 0.85, interactive: false }).addTo(g.ped);
    }
    for (const c of res.crossings.slice(0, 30)) {
      L.circleMarker([c.lat, c.lon], { renderer, radius: 7 + Math.min(c.count, 20) / 2, color: "#c92a2a", weight: 3, fillColor: "#fff", fillOpacity: 0.8 })
        .bindTooltip(`Переходят без перехода: ${c.count} из ${res.stats.routed} маршрутов`).addTo(g.ped);
    }
  }

  function startPedAnimation(res) {
    stopPedAnimation();
    const doc = state.doc;
    const trips = res.trips.slice(0, 250).map((t) => {
      const pts = t.path.map((id) => doc.nodes.get(id)).filter(Boolean);
      const cum = [0];
      for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + distM(pts[i - 1], pts[i]));
      return { pts, cum, len: cum[cum.length - 1], offset: Math.random() };
    }).filter((t) => t.len > 0);
    const layer = L.layerGroup().addTo(map);
    const dots = trips.map(() => L.circleMarker([0, 0], { renderer, radius: 3, color: "#7048e8", weight: 1, fillColor: "#fff", fillOpacity: 1, interactive: false }).addTo(layer));
    const speed = 1.4 * 20; // м/с, ускорено в 20 раз
    const t0 = performance.now();
    pedAnim = { layer, frame: 0 };
    const tick = (now) => {
      const sec = (now - t0) / 1000;
      trips.forEach((t, i) => {
        const s = ((sec * speed) + t.offset * t.len) % t.len;
        let k = 1;
        while (k < t.cum.length - 1 && t.cum[k] < s) k++;
        const a = t.pts[k - 1], b = t.pts[k];
        const f = (s - t.cum[k - 1]) / ((t.cum[k] - t.cum[k - 1]) || 1);
        dots[i].setLatLng([a.lat + (b.lat - a.lat) * f, a.lon + (b.lon - a.lon) * f]);
      });
      pedAnim.frame = requestAnimationFrame(tick);
    };
    pedAnim.frame = requestAnimationFrame(tick);
  }

  function renderPed() {
    const box = $("#tab-ped");
    box.replaceChildren();
    if (!state.doc) { box.append(el("p", { class: "muted" }, "Файл не открыт.")); return; }
    const trips = el("input", { type: "number", min: 50, max: 3000, step: 50, value: (state.ped && state.ped.opts.trips) || 400 });
    box.append(
      el("h2", {}, "Пешеходный поток"),
      el("p", { class: "small" }, "Расчёт по графу: люди идут от зданий к остановкам и между домами по тротуарам, дорожкам и переходам, кратчайшим путём. ",
        "Переход магистрали вне разметки «стоит» как лишние 80 м — так находятся места, где переход нужен, но его нет на карте."),
      el("p", { class: "muted small" }, "Это анализ графа, а не симуляция: сервер проверки (SUMO) пешеходов не моделирует. Результат помогает расставить переходы и тротуары."),
      el("div", { class: "form" }, ...field("Маршрутов", trips)),
      el("div", { class: "actions" },
        el("button", { class: "primary", onclick: () => {
          const t0 = performance.now();
          const opts = { trips: parseInt(trips.value, 10) || 400, seed: 7 };
          const res = window.Pedestrians.analyze(state.doc, opts);
          state.ped = { res, opts, ms: Math.round(performance.now() - t0) };
          drawPedFlow(res);
          if (!map.hasLayer(g.ped)) map.addLayer(g.ped);
          renderPed();
        } }, state.ped ? "Пересчитать" : "Рассчитать"),
        state.ped ? el("button", { onclick: () => { if (pedAnim) stopPedAnimation(); else startPedAnimation(state.ped.res); renderPed(); } }, pedAnim ? "Остановить анимацию" : "Анимация") : null,
        state.ped ? el("button", { onclick: () => { stopPedAnimation(); g.ped.clearLayers(); state.ped = null; renderPed(); } }, "Убрать") : null),
    );
    if (!state.ped) return;
    const { res, ms } = state.ped;
    const st = res.stats;
    box.append(
      el("div", { class: "stats" },
        "Маршрутов построено", el("b", {}, `${st.routed} из ${st.trips}`),
        "Средняя длина", el("b", {}, st.routed ? Math.round(st.totalM / st.routed) + " м" : "—"),
        "Зданий / остановок", el("b", {}, `${st.buildings} / ${st.stops}`),
        "Оторванных кусков пешеходной сети", el("b", {}, st.smallParts),
        "Расчёт", el("b", {}, ms + " мс")),
      el("div", { class: "legend", style: "margin-top:8px" },
        el("i", { style: "background:#ffe066;height:3px" }), el("span", {}, "мало пешеходов"),
        el("i", { style: "background:#fab005;height:4px" }), el("span", {}, "средне"),
        el("i", { style: "background:#f76707;height:6px" }), el("span", {}, "много (20 % самых загруженных)"),
        el("i", { style: "background:#c2255c;height:8px" }), el("span", {}, "очень много (5 %)")),
      el("h3", {}, `Переходы вне разметки (${res.crossings.length})`),
    );
    if (!res.crossings.length) box.append(el("p", {}, "Маршруты пересекают магистрали только по переходам."));
    for (const c of res.crossings.slice(0, 40)) {
      const road = state.doc.ways.get(c.road);
      box.append(el("div", { class: "issue warning" },
        el("p", {}, `${c.count} ${plural(c.count, "маршрут пересекает", "маршрута пересекают", "маршрутов пересекают")} «${road ? label(road) : "магистраль"}» без перехода`),
        el("div", { class: "actions" },
          el("button", { onclick: () => { map.setView([c.lat, c.lon], 19); select({ type: "node", id: c.node, way: c.road }); showTab("ped"); } }, "Показать"),
          el("button", { class: "primary", onclick: () => {
            const n = state.doc.nodes.get(c.node);
            if (n.tags.highway && n.tags.highway !== "crossing") return toast("В узле уже " + n.tags.highway);
            run("зебра по пешеходному анализу", () => state.doc.setTags("node", c.node, Object.assign({ ...n.tags }, CROSSINGS[0].tags)));
            res.crossings = res.crossings.filter((x) => x !== c);
            drawPedFlow(res);
            renderPed();
          } }, "Поставить зебру"))));
    }
  }

  // ---------------------------------------------------------------------------
  // Линейка
  // ---------------------------------------------------------------------------

  const measure = { pts: [] };
  function onMeasureClick(latlng) {
    measure.pts.push(latlng);
    renderMeasure();
  }
  function renderMeasure(cursor) {
    g.measure.clearLayers();
    const pts = cursor ? [...measure.pts, cursor] : measure.pts;
    if (!pts.length) return;
    let total = 0;
    for (let i = 1; i < pts.length; i++) total += pts[i - 1].distanceTo(pts[i]);
    L.polyline(pts, { renderer, color: "#212529", weight: 2, dashArray: "4 4", interactive: false }).addTo(g.measure);
    for (const p of measure.pts) L.circleMarker(p, { renderer, radius: 3, color: "#212529", fillColor: "#fff", fillOpacity: 1, weight: 2, interactive: false }).addTo(g.measure);
    const last = pts[pts.length - 1];
    L.marker(last, { interactive: false, icon: L.divIcon({ className: "measure-label", html: `${total < 1000 ? total.toFixed(1) + " м" : (total / 1000).toFixed(2) + " км"}`, iconSize: null }) }).addTo(g.measure);
  }

  // ---------------------------------------------------------------------------
  // 3D
  // ---------------------------------------------------------------------------

  const view3d = window.View3D ? new window.View3D($("#view3d-canvas")) : null;
  const view3dState = { center: null };

  /** Точка, вокруг которой строить 3D: выбранная дорога, узел или центр карты. */
  function focusPoint() {
    const doc = state.doc, s = state.sel;
    if (s && s.type === "node" && doc.nodes.has(s.id)) { const n = doc.nodes.get(s.id); return { lat: n.lat, lon: n.lon }; }
    if (s && s.type === "way" && doc.ways.has(s.id)) {
      const w = doc.ways.get(s.id);
      const n = doc.nodes.get(w.nodes[Math.floor(w.nodes.length / 2)]);
      return { lat: n.lat, lon: n.lon };
    }
    const c = map.getCenter();
    return { lat: c.lat, lon: c.lng };
  }

  function open3d(center, keepCamera) {
    if (!state.doc) return toast("Сначала откройте файл .osm");
    if (!view3d || !window.THREE) return toast("3D недоступно: не загрузился three.js");
    $("#view3d").hidden = false;
    if (center) view3dState.center = center;
    else if (!keepCamera || !view3dState.center) view3dState.center = focusPoint();
    if (!state.issuesFresh) runValidation();
    try {
      const sel = state.sel && (state.sel.type === "way" ? state.sel.id : state.sel.way);
      const sum = view3d.open(state.doc, {
        center: view3dState.center, radius: parseInt($("#view3d-radius").value, 10) || 250,
        selectedWay: sel, issues: state.issues, buildings: $("#view3d-buildings").checked, keepCamera,
      });
      $("#view3d-info").textContent = `дорог ${sum.roads} · мостов ${sum.bridges} · тоннелей ${sum.tunnels}` +
        (sum.issues ? ` · проблем ${sum.issues}` : " · проблем нет");
    } catch (e) {
      $("#view3d").hidden = true;
      toast("Не удалось построить 3D: " + e.message);
    }
  }
  function close3d() { if (view3d) view3d.close(); $("#view3d").hidden = true; }
  function is3dOpen() { return !$("#view3d").hidden; }
  let rebuild3dTimer = null;
  function refresh3d() {
    if (!is3dOpen()) return;
    clearTimeout(rebuild3dTimer);
    rebuild3dTimer = setTimeout(() => open3d(null, true), 250);
  }
  if (view3d) view3d.onPick = (wayId) => { select({ type: "way", id: wayId }); refresh3d(); };
  $("#btn-3d").addEventListener("click", () => open3d());

  // QR-код ссылки на редактор с картой — показать на экране, чтобы открыли с телефона
  function shareUrl() {
    const base = location.origin + location.pathname;
    return state.sourceFile ? base + "?file=" + encodeURIComponent(state.sourceFile) : base;
  }
  function showQr() {
    if (!location.protocol.startsWith("http")) {
      return toast("QR-код работает, когда редактор открыт по адресу в интернете — например, на GitHub Pages");
    }
    if (!window.qrcode) return toast("Не загрузилась библиотека QR");
    const url = shareUrl();
    const qr = window.qrcode(0, "M");
    qr.addData(url);
    qr.make();
    $("#qr-image").innerHTML = qr.createSvgTag({ cellSize: 8, margin: 2, scalable: true });
    $("#qr-url").textContent = url;
    $("#qr-url").href = url;
    $("#qr-dialog").hidden = false;
  }
  $("#btn-qr").addEventListener("click", showQr);
  $("#qr-close").addEventListener("click", () => { $("#qr-dialog").hidden = true; });
  $("#qr-copy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(shareUrl()); toast("Ссылка скопирована"); } catch (e) { toast(shareUrl()); }
  });
  $("#view3d-close").addEventListener("click", close3d);
  $("#view3d-buildings").addEventListener("change", () => open3d(null, true));
  $("#view3d-radius").addEventListener("change", () => open3d(null, false));
  $("#view3d-top").addEventListener("click", () => view3d && view3d.resetView(true));
  $("#view3d-reset").addEventListener("click", () => view3d && view3d.resetView(false));
  $("#view3d-here").addEventListener("click", () => open3d(focusPoint(), false));

  // ---------------------------------------------------------------------------
  // Автосохранение в браузере (IndexedDB) — на случай закрытой вкладки
  // ---------------------------------------------------------------------------

  const idb = {
    open() {
      return new Promise((res, rej) => {
        if (!window.indexedDB) return rej(new Error("нет IndexedDB"));
        const r = indexedDB.open("uds-editor", 1);
        r.onupgradeneeded = () => r.result.createObjectStore("autosave");
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
    },
    async put(key, value) {
      const db = await this.open();
      return new Promise((res, rej) => { const tx = db.transaction("autosave", "readwrite"); tx.objectStore("autosave").put(value, key); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    },
    async get(key) {
      const db = await this.open();
      return new Promise((res, rej) => { const r = db.transaction("autosave").objectStore("autosave").get(key); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    },
    async del(key) {
      const db = await this.open();
      return new Promise((res) => { const tx = db.transaction("autosave", "readwrite"); tx.objectStore("autosave").delete(key); tx.oncomplete = res; tx.onerror = res; });
    },
  };

  let autosaveTimer = null;
  function scheduleAutosave() {
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(async () => {
      if (!state.doc || !state.doc.dirty) return;
      try {
        await idb.put("current", { label: state.fileLabel, text: state.doc.serialize(), base: state.baseText, at: Date.now() });
        $("#status-saved").textContent = "автосохранено " + new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
      } catch (e) { /* без автосохранения тоже работаем */ }
    }, 1500);
  }

  async function offerRestore() {
    try {
      const saved = await idb.get("current");
      if (!saved || !saved.text) return;
      const when = new Date(saved.at).toLocaleString("ru-RU");
      const box = document.querySelector(".empty-state div");
      if (!box) return;
      box.append(el("div", { class: "hint", style: "margin-top:10px" },
        el("p", {}, `Есть несохранённая работа: ${saved.label}, ${when}.`),
        el("div", { class: "actions", style: "justify-content:center" },
          el("button", { class: "primary", onclick: () => loadText(saved.text, saved.label, { baseText: saved.base }) }, "Восстановить"),
          el("button", { onclick: async (e) => { await idb.del("current"); e.target.closest(".hint").remove(); } }, "Удалить"))));
    } catch (e) { /* нет IndexedDB — нечего восстанавливать */ }
  }

  // ---------------------------------------------------------------------------
  // Отправка на сервер проверки прямо из редактора
  // ---------------------------------------------------------------------------

  const server = {
    url() {
      const saved = localStorage.getItem("checker-url");
      if (saved) return saved;
      // В Docker-образе редактора сервер проверки проксируется на /checker — без проблем с CORS
      return this.proxied ? location.origin + "/checker" : "http://innerlogistics.lovethosetrains.com:7078";
    },
    proxied: false,
    token() { return localStorage.getItem("checker-token") || ""; },
    async call(path, opts) {
      const r = await fetch(this.url().replace(/\/$/, "") + path, Object.assign({}, opts, {
        headers: Object.assign({ Authorization: "Bearer " + this.token() }, (opts || {}).headers || {}) }));
      return r;
    },
  };

  const submitStatus = el("div", { class: "small" });
  function serverBlock() {
    const url = el("input", { type: "text", value: server.url(), spellcheck: "false" });
    const token = el("input", { type: "password", value: server.token(), autocomplete: "off" });
    const status = submitStatus;
    url.addEventListener("change", () => localStorage.setItem("checker-url", url.value.trim()));
    token.addEventListener("change", () => localStorage.setItem("checker-token", token.value.trim()));
    return el("div", {},
      el("div", { class: "form" }, ...field("Сервер", url), ...field("Токен команды", token)),
      el("div", { class: "actions" }, el("button", { class: "primary", onclick: () => submitToServer(status) }, `Отправить ${teamName() || "team"}.osm`)),
      status);
  }

  async function submitToServer(status) {
    const team = teamName();
    if (!state.doc || !team) return toast("Нужен открытый файл и имя команды");
    if (!server.token()) return toast("Введите токен команды");
    runValidation();
    const errors = state.issues.filter((i) => i.severity === "error").length;
    if (errors && !confirm(`Есть ${errors} ${plural(errors, "ошибка", "ошибки", "ошибок")} графа — прогон на сервере может упасть. Всё равно отправить?`)) return;
    const form = new FormData();
    form.append("osm", new Blob([state.doc.serialize()], { type: "application/xml" }), team + ".osm");
    status.replaceChildren("Отправка…");
    let r;
    try {
      r = await server.call("/api/submit", { method: "POST", body: form });
    } catch (e) {
      status.replaceChildren(el("p", { class: "issue error" }, "Сервер не ответил или не разрешает запросы из браузера (CORS). ",
        "Запустите редактор через Docker с переменной CHECKER_URL (см. README) или загрузите сохранённый файл через сайт сервера."));
      return;
    }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      status.replaceChildren(el("p", { class: "issue error" }, data.error ||
        (r.status === 401 ? "Неверный токен команды" : `Сервер ответил ${r.status} — проверьте адрес сервера`)));
      return;
    }
    state.doc.dirty = false;
    updateStatus();
    pollRun(status, data.team, data.run_id);
  }

  async function pollRun(status, team, runId) {
    let data;
    try {
      const r = await server.call(`/api/runs/${team}/${runId}`);
      data = await r.json();
    } catch (e) { status.replaceChildren("Связь с сервером потеряна"); return; }
    const q = data.queue;
    const stages = Object.entries(data.stages || {}).map(([k, v]) => `${k}: ${{ pending: "ждёт", running: "идёт", done: "готово", failed: "сбой", skipped: "не запускался" }[v.status] || v.status}`).join(" · ");
    status.replaceChildren(...[
      el("p", {}, el("b", {}, `Прогон ${runId}: `), { queued: "в очереди", running: "идёт", done: "готово", failed: "сбой" }[data.status] || data.status,
        q && q.state === "queued" ? ` — место ${q.position}` + (q.starts_in_text ? `, начнётся ${q.starts_in_text}` : "") : ""),
      el("p", { class: "small muted" }, stages),
      data.error ? el("p", { class: "issue error" }, data.error) : null,
      el("p", { class: "small" }, el("a", { href: data.page_url, target: "_blank", rel: "noopener" }, "Открыть прогон на сервере")),
    ].filter(Boolean));
    if (data.status === "queued" || data.status === "running") { setTimeout(() => pollRun(status, team, runId), 5000); return; }
    for (const f of (data.files || []).filter((x) => x.name.endsWith(".mp4"))) {
      try {
        const r = await server.call(new URL(f.url).pathname.replace(/^\/checker/, ""));
        const blob = await r.blob();
        status.append(el("p", { class: "small" }, f.name), el("video", { src: URL.createObjectURL(blob), controls: true, style: "width:100%" }));
      } catch (e) { status.append(el("p", { class: "small" }, el("a", { href: f.url, target: "_blank" }, f.name))); }
    }
  }

  // ---------------------------------------------------------------------------
  // Шаблоны, поиск, статус
  // ---------------------------------------------------------------------------

  TEMPLATES.forEach((t, i) => $("#template").append(el("option", { value: i }, t.name)));
  SIGNS.forEach((t, i) => $("#sign-type").append(el("option", { value: i }, t.name)));
  CROSSINGS.forEach((t, i) => $("#crossing-type").append(el("option", { value: i }, t.name)));
  Object.entries(VIEWS).forEach(([k, v]) => $("#view-mode").append(el("option", { value: k }, v)));
  $("#crossing-type").addEventListener("change", () => {
    const t = CROSSINGS[$("#crossing-type").selectedIndex];
    if (t.template) startTemplateDraw(t.template);
  });
  $("#view-mode").addEventListener("change", (e) => {
    state.view = e.target.value;
    if (!state.doc) return;
    for (const w of state.doc.ways.values()) if (category(w) === "roads" || category(w) === "foot") drawWay(w.id);
    drawSelection();
    renderPanel();
  });

  function applyTemplateToSelection() {
    const s = state.sel;
    if (!s || s.type !== "way") return toast("Выберите дорогу");
    const tpl = TEMPLATES[$("#template").selectedIndex];
    if (tpl.area || tpl.noRoadSnap) return toast("Этот шаблон — для новых объектов: выберите его и рисуйте (N)");
    run(`шаблон «${tpl.name}»`, () => {
      const w = state.doc.ways.get(s.id);
      const tags = { ...w.tags };
      for (const k of TEMPLATE_KEYS) delete tags[k];
      state.doc.setTags("way", s.id, Object.assign(tags, tpl.tags));
    });
  }
  $("#btn-apply-tpl").addEventListener("click", applyTemplateToSelection);

  function fillStreetNames() {
    const names = new Set();
    for (const w of state.doc.ways.values()) if (w.tags.name && w.tags.highway) names.add(w.tags.name);
    $("#street-names").replaceChildren(...[...names].sort().map((n) => el("option", { value: n })));
  }

  $("#search").addEventListener("change", (e) => {
    const q = e.target.value.trim().toLowerCase();
    if (!q || !state.doc) return;
    const found = [...state.doc.ways.values()].filter((w) => w.tags.highway && (w.tags.name || "").toLowerCase().includes(q));
    if (!found.length) return toast("Улица не найдена");
    const layers = found.map((w) => wayLayers.get(w.id)).filter(Boolean);
    map.fitBounds(L.featureGroup(layers).getBounds().pad(0.2));
    select({ type: "way", id: found[0].id });
    toast(`Найдено линий: ${found.length}`);
  });

  function updateStatus() {
    const doc = state.doc;
    const modeText = {
      select: "Выбор: клик — выбрать, перетаскивание узла — сдвинуть или соединить",
      draw: state.draw && state.draw.points.length
        ? `Дорога: ${state.draw.points.length} ${plural(state.draw.points.length, "точка", "точки", "точек")} · Enter/двойной клик — готово · Backspace — назад · Esc — отмена`
        : "Дорога: кликайте по карте; клик по существующей дороге соединит с ней",
      signal: "Светофор: клик по узлу или дороге ставит/убирает светофор",
      sign: "Знак: выберите знак сверху и кликните по дороге; клик по знаку того же типа — убрать",
      crossing: "Переход: наземный — клик по дороге; надземный и подземный — рисуются линией поперёк дороги",
      measure: "Линейка: клики по карте — точки, Esc — заново",
    }[state.mode];
    $("#status-mode").textContent = modeText;
    $("#status-file").textContent = doc ? state.fileLabel + (doc.dirty ? " • не сохранено" : "") : "Файл не открыт";
    $("#status-stats").textContent = doc ? `дорог ${doc.stats().drivable}` : "";
    $("#btn-undo").disabled = !doc || !doc.undoStack.length;
    $("#btn-redo").disabled = !doc || !doc.redoStack.length;
    $("#btn-undo").title = doc && doc.undoStack.length ? "Отменить: " + doc.undoStack[doc.undoStack.length - 1].label + " (Ctrl+Z)" : "Отменить (Ctrl+Z)";
    $("#btn-redo").title = doc && doc.redoStack.length ? "Повторить: " + doc.redoStack[doc.redoStack.length - 1].label + " (Ctrl+Y)" : "Повторить (Ctrl+Y)";
  }

  let toastTimer = null;
  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 3500);
  }

  // ---------------------------------------------------------------------------
  // Кнопки, клавиши, перетаскивание файла
  // ---------------------------------------------------------------------------

  $("#btn-open").addEventListener("click", () => $("#file-input").click());
  $("#file-input").addEventListener("change", (e) => { openFile(e.target.files[0]); e.target.value = ""; });
  $("#btn-example").addEventListener("click", openExample);
  $("#btn-save").addEventListener("click", save);
  $("#btn-undo").addEventListener("click", () => state.doc && state.doc.undo());
  $("#btn-redo").addEventListener("click", () => state.doc && state.doc.redo());
  document.querySelectorAll(".modes button").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));

  function toggleLayer(grp, name) {
    if (map.hasLayer(grp)) { map.removeLayer(grp); toast(name + " скрыты"); } else { map.addLayer(grp); toast(name + " показаны"); }
  }

  document.addEventListener("keydown", (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (ctrl && (k === "s" || k === "ы")) { e.preventDefault(); save(); return; }
    if (ctrl && (k === "o" || k === "щ")) { e.preventDefault(); $("#file-input").click(); return; }
    if (typing) { if (e.key === "Escape") e.target.blur(); return; }
    if (ctrl && (k === "z" || k === "я")) { e.preventDefault(); if (state.doc) (e.shiftKey ? state.doc.redo() : state.doc.undo()); return; }
    if (ctrl && (k === "y" || k === "н")) { e.preventDefault(); if (state.doc) state.doc.redo(); return; }
    if (ctrl || e.altKey) return;
    const s = state.sel;
    switch (e.key === "Delete" || e.key === "Backspace" || e.key === "Escape" || e.key === "Enter" ? e.key : k) {
      case "v": case "м": setMode("select"); break;
      case "n": case "т": setMode("draw"); break;
      case "t": case "е": setMode("signal"); break;
      case "s": case "ы": setMode("sign"); break;
      case "p": case "з": setMode("crossing"); break;
      case "m": case "ь": setMode("measure"); break;
      case "3": open3d(); break;
      case "f": case "а": toggleLayer(g.foot, "Тротуары и тропы"); break;
      case "b": case "и": toggleLayer(g.buildings, "Здания"); break;
      case "r": case "к":
        if (s && s.type === "way") run("развернуть", () => state.doc.reverseWay(s.id));
        break;
      case "x": case "ч":
        if (s && s.type === "node" && s.way) run("разрезать", () => state.doc.splitWay(s.way, s.id));
        break;
      case "Enter": if (state.mode === "draw") finishDraw(); break;
      case "Escape":
        if (!$("#qr-dialog").hidden) { $("#qr-dialog").hidden = true; break; }
        if (!$("#view3d").hidden) { close3d(); break; }
        if (state.mode === "measure" && measure.pts.length) { measure.pts = []; g.measure.clearLayers(); break; }
        if (state.mode === "draw" && state.draw && state.draw.points.length) { cancelDraw(); updateStatus(); }
        else if (state.mode !== "select") setMode("select");
        else select(null);
        break;
      case "Backspace":
        if (state.mode === "draw" && state.draw && state.draw.points.length) { e.preventDefault(); state.draw.points.pop(); renderDraw(); updateStatus(); break; }
        // fallthrough — Backspace удаляет, как Delete
      case "Delete":
        if (!s || !state.doc) break;
        e.preventDefault();
        if (s.type === "way") { run("удалить линию", () => state.doc.deleteWay(s.id)); select(null); }
        else {
          const back = s.way;
          run("удалить узел", () => state.doc.deleteNode(s.id));
          select(back && state.doc.ways.has(back) ? { type: "way", id: back } : null);
        }
        break;
      default: return;
    }
  });

  let dragDepth = 0;
  window.addEventListener("dragenter", (e) => { e.preventDefault(); dragDepth++; $("#drop-hint").hidden = false; });
  window.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; $("#drop-hint").hidden = true; } });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => {
    e.preventDefault(); dragDepth = 0; $("#drop-hint").hidden = true;
    openFile(e.dataTransfer.files[0]);
  });
  window.addEventListener("beforeunload", (e) => {
    if (state.doc && state.doc.dirty) { e.preventDefault(); e.returnValue = ""; }
  });

  // Пустое состояние на карте
  map.getContainer().append(el("div", { class: "empty-state" }, el("div", {},
    el("p", {}, el("b", {}, "Откройте граф УДС в формате .osm")),
    el("p", { class: "muted" }, "Перетащите файл на карту или нажмите кнопку"),
    el("div", { class: "actions", style: "justify-content:center" },
      el("button", { class: "primary", onclick: () => $("#file-input").click() }, "Открыть .osm"),
      el("button", { onclick: openExample }, "Пример")))));

  $("#patch-input").addEventListener("change", (e) => { importPatch(e.target.files[0]); e.target.value = ""; });
  renderPanel();
  updateStatus();
  setMode("select");
  // Ссылка вида index.html?file=example.osm открывает карту сразу (для GitHub Pages и QR-кода)
  const fileParam = new URLSearchParams(location.search).get("file") || new URLSearchParams(location.search).get("osm");
  if (fileParam && location.protocol.startsWith("http")) {
    (async () => {
      // если на этом устройстве осталась несохранённая работа с этим же файлом — предложить продолжить
      let saved = null;
      try { saved = await idb.get("current"); } catch (e) { /* нет IndexedDB */ }
      const name = fileParam.split("/").pop();
      if (saved && saved.text && saved.label === name &&
          confirm(`Есть несохранённая работа с ${name} от ${new Date(saved.at).toLocaleString("ru-RU")}. Продолжить с неё?`)) {
        loadText(saved.text, saved.label, { baseText: saved.base });
        state.sourceFile = fileParam;
        return;
      }
      toast("Загрузка " + fileParam + "…");
      openUrl(fileParam).catch((e) => { toast("Не удалось открыть " + fileParam + ": " + e.message); offerRestore(); });
    })();
  } else offerRestore();
  if (location.protocol.startsWith("http")) {
    fetch("checker-proxy.json").then((r) => r.ok && r.json()).then((j) => { if (j && j.proxy) server.proxied = true; }).catch(() => {});
  }

  // Для автотестов и отладки из консоли
  window.editor = { state, map, loadText, save, select, setMode, finishDraw, onSignalClick, onSignClick, onCrossingClick, runValidation, open3d, close3d, showTab };
})();

/*
 * Пешеходный анализ графа — не симуляция, а расчёт по графу:
 *   1. строим сеть для пешеходов: тротуары, дорожки, переходы, дворы, улицы с тротуарами;
 *   2. генерируем маршруты от зданий к остановкам и между зданиями (фиксированное зерно — результат повторяем);
 *   3. каждый маршрут — кратчайший путь (Дейкстра); переход магистрали вне разметки «стоит» как лишние 80 м;
 *   4. считаем загрузку каждого отрезка и места, где маршруты пересекают магистраль без перехода.
 *
 * Сервер проверки (SUMO) пешеходов не моделирует, поэтому это инструмент правки графа:
 * показывает, где не хватает переходов и тротуаров.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./osm.js"));
  else root.Pedestrians = factory(root.OSM);
})(typeof self !== "undefined" ? self : this, function (OSM) {
  "use strict";
  const { isDrivable, distM, projector } = OSM;

  // Магистрали, которые нельзя переходить где попало
  const MAJOR = new Set(["motorway", "trunk", "primary", "secondary", "tertiary",
    "motorway_link", "trunk_link", "primary_link", "secondary_link", "tertiary_link"]);
  const PATHS = new Set(["footway", "path", "pedestrian", "steps", "crossing", "corridor", "cycleway", "track", "bridleway", "living_street", "service", "residential", "unclassified", "road"]);
  const NO_WALK = new Set(["motorway", "motorway_link", "trunk", "trunk_link"]);
  const CROSSING_PENALTY_M = 80;

  function hasSidewalk(t) {
    for (const k of ["sidewalk", "sidewalk:both", "sidewalk:left", "sidewalk:right"]) {
      if (t[k] && !["no", "none", "separate"].includes(t[k])) return true;
    }
    return false;
  }

  /** Можно ли идти вдоль линии. */
  function walkable(w) {
    const t = w.tags;
    if (!t.highway || t.foot === "no" || t.access === "no" && t.foot !== "yes") return false;
    if (t.area === "yes" && t.highway !== "pedestrian") return false;
    if (t.foot === "yes" || t.foot === "designated") return true;
    if (NO_WALK.has(t.highway)) return false;
    if (MAJOR.has(t.highway)) return hasSidewalk(t); // вдоль магистрали — только если у неё указан тротуар
    return PATHS.has(t.highway);
  }

  function isMarkedCrossing(n) {
    const t = n.tags;
    return t.highway === "crossing" || t.highway === "traffic_signals" || !!t.crossing || t.railway === "crossing";
  }

  // Детерминированный генератор случайных чисел (mulberry32)
  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  class Heap {
    constructor() { this.a = []; }
    push(item) {
      const a = this.a; a.push(item);
      let i = a.length - 1;
      while (i > 0) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; }
    }
    pop() {
      const a = this.a; const top = a[0]; const last = a.pop();
      if (a.length) {
        a[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1, r = l + 1; let m = i;
          if (l < a.length && a[l][0] < a[m][0]) m = l;
          if (r < a.length && a[r][0] < a[m][0]) m = r;
          if (m === i) break;
          [a[m], a[i]] = [a[i], a[m]]; i = m;
        }
      }
      return top;
    }
    get size() { return this.a.length; }
  }

  function buildGraph(doc) {
    const adj = new Map(); // узел -> [{to, len, way}]
    const add = (a, b, len, way) => {
      if (!adj.has(a)) adj.set(a, []);
      adj.get(a).push({ to: b, len, way });
    };
    for (const w of doc.ways.values()) {
      if (!walkable(w)) continue;
      for (let i = 1; i < w.nodes.length; i++) {
        const a = w.nodes[i - 1], b = w.nodes[i];
        const len = distM(doc.nodes.get(a), doc.nodes.get(b));
        add(a, b, len, w.id); add(b, a, len, w.id);
      }
    }
    // Узлы на магистралях без разметки перехода: пройти через них — значит перейти дорогу «где попало»
    const unmarked = new Map(); // узел -> id магистрали
    for (const id of adj.keys()) {
      const n = doc.nodes.get(id);
      if (isMarkedCrossing(n)) continue;
      const road = doc.waysOfNode(id).find((w) => isDrivable(w) && MAJOR.has(w.tags.highway) && !walkable(w));
      if (road) unmarked.set(id, road.id);
    }
    return { adj, unmarked };
  }

  function components(adj) {
    const comp = new Map();
    let c = 0;
    for (const s of adj.keys()) {
      if (comp.has(s)) continue;
      const q = [s]; comp.set(s, c);
      while (q.length) {
        const v = q.pop();
        for (const e of adj.get(v)) if (!comp.has(e.to)) { comp.set(e.to, c); q.push(e.to); }
      }
      c++;
    }
    return { comp, count: c };
  }

  /** Точки притяжения: центры зданий и остановки, привязанные к ближайшему узлу пешеходной сети. */
  function attractors(doc, adj, mainComp, comp) {
    const ids = [...adj.keys()].filter((id) => comp.get(id) === mainComp);
    if (!ids.length) return { buildings: [], stops: [] };
    const first = doc.nodes.get(ids[0]);
    const proj = projector(first.lat);
    const cell = 60;
    const grid = new Map();
    for (const id of ids) {
      const p = proj(doc.nodes.get(id));
      const k = Math.floor(p.x / cell) + ":" + Math.floor(p.y / cell);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push({ id, p });
    }
    const snap = (lat, lon, maxM) => {
      const p = proj({ lat, lon });
      const cx = Math.floor(p.x / cell), cy = Math.floor(p.y / cell);
      let best = null;
      for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) {
        for (const q of grid.get(cx + dx + ":" + (cy + dy)) || []) {
          const d = Math.hypot(p.x - q.p.x, p.y - q.p.y);
          if (d <= maxM && (!best || d < best.d)) best = { id: q.id, d };
        }
      }
      return best && best.id;
    };
    const buildings = [];
    for (const w of doc.ways.values()) {
      if (!w.tags.building || w.nodes.length < 3) continue;
      let lat = 0, lon = 0;
      const pts = w.nodes[0] === w.nodes[w.nodes.length - 1] ? w.nodes.slice(0, -1) : w.nodes;
      for (const id of pts) { const n = doc.nodes.get(id); lat += n.lat; lon += n.lon; }
      lat /= pts.length; lon /= pts.length;
      const node = snap(lat, lon, 120);
      if (node) buildings.push({ node, lat, lon, levels: parseInt(w.tags["building:levels"] || "2", 10) || 2 });
    }
    const stops = [];
    for (const n of doc.nodes.values()) {
      const t = n.tags;
      if (t.highway === "bus_stop" || t.railway === "tram_stop" || t.public_transport === "platform" || t.public_transport === "stop_position") {
        const node = adj.has(n.id) && comp.get(n.id) === mainComp ? n.id : snap(n.lat, n.lon, 80);
        if (node) stops.push({ node, lat: n.lat, lon: n.lon, name: t.name || "Остановка" });
      }
    }
    return { buildings, stops };
  }

  function dijkstra(adj, unmarked, from, to) {
    const dist = new Map([[from, 0]]);
    const prev = new Map();
    const heap = new Heap();
    heap.push([0, from]);
    while (heap.size) {
      const [d, v] = heap.pop();
      if (v === to) break;
      if (d > dist.get(v)) continue;
      for (const e of adj.get(v) || []) {
        const nd = d + e.len + (unmarked.has(e.to) && e.to !== to ? CROSSING_PENALTY_M : 0);
        if (nd < (dist.has(e.to) ? dist.get(e.to) : Infinity)) {
          dist.set(e.to, nd); prev.set(e.to, v); heap.push([nd, e.to]);
        }
      }
    }
    if (!dist.has(to)) return null;
    const path = [to];
    while (path[path.length - 1] !== from) path.push(prev.get(path[path.length - 1]));
    return path.reverse();
  }

  /**
   * Рассчитать пешеходный поток.
   * opts: { trips = 400, seed = 7, toStopsShare = 0.6 }
   */
  function analyze(doc, opts) {
    opts = Object.assign({ trips: 400, seed: 7, toStopsShare: 0.6 }, opts || {});
    const { adj, unmarked } = buildGraph(doc);
    const { comp, count } = components(adj);
    const sizes = new Map();
    for (const c of comp.values()) sizes.set(c, (sizes.get(c) || 0) + 1);
    let main = -1, best = -1;
    for (const [c, n] of sizes) if (n > best) { best = n; main = c; }
    const smallParts = [...sizes.entries()].filter(([c, n]) => c !== main && n >= 2).length;
    const { buildings, stops } = attractors(doc, adj, main, comp);
    const result = {
      stats: { trips: 0, routed: 0, failed: 0, totalM: 0, buildings: buildings.length, stops: stops.length, parts: count, smallParts },
      edges: new Map(), crossings: [], trips: [],
    };
    if (!buildings.length || (buildings.length < 2 && !stops.length)) return result;

    const rand = rng(opts.seed);
    const pick = (arr) => arr[Math.floor(rand() * arr.length)];
    // Здания с большим числом этажей порождают больше пешеходов
    const weighted = [];
    for (const b of buildings) for (let i = 0; i < Math.min(b.levels, 16); i++) weighted.push(b);
    const crossCount = new Map();

    for (let i = 0; i < opts.trips; i++) {
      const from = pick(weighted);
      let to = stops.length && rand() < opts.toStopsShare ? pick(stops) : pick(buildings);
      if (to.node === from.node) continue;
      if (rand() < 0.5) to = Object.assign({}, to); // направление: из дома и домой — одинаково по графу
      result.stats.trips++;
      const path = dijkstra(adj, unmarked, from.node, to.node);
      if (!path) { result.stats.failed++; continue; }
      result.stats.routed++;
      let len = 0;
      for (let k = 1; k < path.length; k++) {
        const a = path[k - 1], b = path[k];
        const key = a < b ? a + "|" + b : b + "|" + a;
        const e = result.edges.get(key) || { a, b, count: 0 };
        e.count++;
        result.edges.set(key, e);
        len += distM(doc.nodes.get(a), doc.nodes.get(b));
        if (unmarked.has(b) && k < path.length - 1) crossCount.set(b, (crossCount.get(b) || 0) + 1);
      }
      result.stats.totalM += len;
      result.trips.push({ path, length: len });
    }
    result.crossings = [...crossCount.entries()].map(([node, n]) => {
      const nd = doc.nodes.get(node);
      return { node, count: n, lat: nd.lat, lon: nd.lon, road: unmarked.get(node) };
    }).sort((a, b) => b.count - a.count);
    return result;
  }

  return { analyze, walkable, buildGraph, MAJOR, CROSSING_PENALTY_M };
});

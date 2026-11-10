/*
 * Ядро редактора графа УДС: модель OSM без привязки к интерфейсу.
 *
 *   OsmDoc.parse(text)      — прочитать .osm (XML OSM 0.6)
 *   doc.serialize()         — записать обратно в .osm; всё, что не правили, сохраняется как было
 *   doc.begin()/commit()    — правки группируются в шаги, у каждого есть отмена и повтор
 *   doc.validate()          — поиск типичных ошибок графа (связность, направления, перекрёстки)
 *
 * Работает и в браузере, и в Node (для тестов): DOMParser можно передать явно.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.OSM = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ---------- справочники ----------

  // Дороги, по которым ездят машины. Только они участвуют в проверке связности.
  const DRIVABLE = new Set([
    "motorway", "trunk", "primary", "secondary", "tertiary",
    "motorway_link", "trunk_link", "primary_link", "secondary_link", "tertiary_link",
    "unclassified", "residential", "living_street", "service", "road",
  ]);

  // Дворы и проезды: тупики и односторонние въезды здесь — обычное дело
  const YARD = new Set(["service", "living_street"]);
  const isYard = (w) => YARD.has(w.tags.highway);
  // OSM-тег noexit=yes на конце дороги — «тупик здесь настоящий», проверка его не трогает
  const isNoExit = (n) => !!n && n.tags.noexit === "yes";

  const KEY_ORDER_NODE = ["id", "visible", "version", "changeset", "timestamp", "user", "uid", "lat", "lon"];

  function isDrivable(way) {
    if (!way || !way.tags.highway || !DRIVABLE.has(way.tags.highway)) return false;
    const a = way.tags.access, mv = way.tags.motor_vehicle;
    if (a === "no" || mv === "no") return false;
    if (way.tags.area === "yes") return false;
    return true;
  }

  /** Направление движения: 1 — по порядку узлов, -1 — против, 0 — в обе стороны. */
  function onewayDir(way) {
    const o = way.tags.oneway;
    if (o === "yes" || o === "true" || o === "1") return 1;
    if (o === "-1" || o === "reverse") return -1;
    if (o === "no" || o === "false" || o === "0") return 0;
    if (way.tags.junction === "roundabout" || way.tags.junction === "circular") return 1;
    if (way.tags.highway === "motorway" || way.tags.highway === "motorway_link") return 1;
    return 0;
  }

  // ---------- геометрия ----------

  const R = 6371008.8;
  const rad = (d) => (d * Math.PI) / 180;

  function distM(a, b) {
    const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
    const x = dLon * Math.cos(rad((a.lat + b.lat) / 2));
    return Math.sqrt(x * x + dLat * dLat) * R;
  }

  /** Плоские координаты в метрах относительно точки отсчёта (для малых расстояний). */
  function projector(lat0) {
    const k = Math.cos(rad(lat0));
    return (p) => ({ x: rad(p.lon) * k * R, y: rad(p.lat) * R });
  }

  /** Азимут от a к b: 0 — север, 90 — восток. */
  function bearing(a, b) {
    const dy = b.lat - a.lat, dx = (b.lon - a.lon) * Math.cos(rad((a.lat + b.lat) / 2));
    return ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
  }
  function angleDiff(a, b) { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d); }

  /**
   * Плавное сужение/расширение проезжей части у стыка с продолжением.
   * own — свой профиль {left,right,axis}; startT/endT — профиль продолжения на концах (или null).
   * Возвращает профиль в точке на расстояниях dStart и dEnd от концов линии; длина перехода — taper метров.
   */
  function taperProfile(dStart, dEnd, own, startT, endT, taper) {
    const smooth = (t) => t * t * (3 - 2 * t);
    const mix = (a, b, t) => ({ left: a.left + (b.left - a.left) * t, right: a.right + (b.right - a.right) * t, axis: a.axis + (b.axis - a.axis) * t });
    let p = { left: own.left, right: own.right, axis: own.axis };
    // на стыке берём середину между своим профилем и профилем продолжения: обе линии сходятся в одной ширине
    const at = (t) => (t.exact ? t : mix(own, t, 0.5));
    if (endT && dEnd < taper) p = mix(at(endT), p, smooth(dEnd / taper));
    if (startT && dStart < taper) p = mix(at(startT), p, smooth(dStart / taper));
    return p;
  }

  /** Добавить точки на ломаной через каждые step метров в пределах taper от концов (для плавных переходов). */
  function densify(pts, taper, step, X, Y) {
    const d = [0];
    for (let i = 1; i < pts.length; i++) d.push(d[i - 1] + Math.hypot(pts[i][X] - pts[i - 1][X], pts[i][Y] - pts[i - 1][Y]));
    const total = d[d.length - 1];
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      out.push({ p: pts[i], s: d[i] });
      if (i === pts.length - 1) break;
      for (let s = d[i] + step; s < d[i + 1] - 0.5; s += step) {
        if (s > taper && s < total - taper) continue;
        const t = (s - d[i]) / (d[i + 1] - d[i]);
        const q = {};
        for (const k of Object.keys(pts[i])) q[k] = typeof pts[i][k] === "number" ? pts[i][k] + (pts[i + 1][k] - pts[i][k]) * t : pts[i][k];
        out.push({ p: q, s });
      }
    }
    return { pts: out.map((o) => o.p), dist: out.map((o) => o.s), total };
  }

  /** Значение стрелки OSM → тип манёвра. */
  function turnClass(v) {
    if (/left/.test(v)) return "left";
    if (/right/.test(v)) return "right";
    if (v === "reverse") return "reverse";
    if (v === "through" || /merge/.test(v)) return "through";
    return v;
  }

  /** Уровень обслуживания по средней задержке (как в HCM для регулируемых перекрёстков). */
  function los(delay, x) {
    if (x >= 1) return "F";
    if (delay == null) return null;
    return delay <= 10 ? "A" : delay <= 20 ? "B" : delay <= 35 ? "C" : delay <= 55 ? "D" : delay <= 80 ? "E" : "F";
  }

  function segIntersect(p1, p2, p3, p4) {
    const d = (p2.x - p1.x) * (p4.y - p3.y) - (p2.y - p1.y) * (p4.x - p3.x);
    if (Math.abs(d) < 1e-9) return null;
    const t = ((p3.x - p1.x) * (p4.y - p3.y) - (p3.y - p1.y) * (p4.x - p3.x)) / d;
    const u = ((p3.x - p1.x) * (p2.y - p1.y) - (p3.y - p1.y) * (p2.x - p1.x)) / d;
    const eps = 1e-6;
    if (t <= eps || t >= 1 - eps || u <= eps || u >= 1 - eps) return null;
    return { t, u };
  }

  // ---------- XML ----------

  function escapeAttr(v) {
    return String(v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/\n/g, "&#10;").replace(/\r/g, "&#13;").replace(/\t/g, "&#9;");
  }

  function attrsOf(el) {
    const out = {};
    for (let i = 0; i < el.attributes.length; i++) {
      const a = el.attributes[i];
      out[a.name] = a.value;
    }
    return out;
  }

  function tagsOf(el) {
    const tags = {};
    const kids = el.childNodes;
    for (let i = 0; i < kids.length; i++) {
      const c = kids[i];
      if (c.nodeType === 1 && c.nodeName === "tag") tags[c.getAttribute("k")] = c.getAttribute("v");
    }
    return tags;
  }

  function attrString(attrs, order) {
    const keys = Object.keys(attrs);
    if (order) keys.sort((a, b) => {
      const ia = order.indexOf(a), ib = order.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    return keys.map((k) => ` ${k}="${escapeAttr(attrs[k])}"`).join("");
  }

  function tagLines(tags, indent) {
    return Object.keys(tags).map((k) => `${indent}<tag k="${escapeAttr(k)}" v="${escapeAttr(tags[k])}"/>`);
  }

  const clone = (o) => (o == null ? o : JSON.parse(JSON.stringify(o)));

  // ---------- модель ----------

  class OsmDoc {
    constructor() {
      this.rootAttrs = { version: "0.6", generator: "UDS editor" };
      this.bounds = null;          // атрибуты <bounds>
      this.extraXml = [];           // прочие элементы верхнего уровня — сохраняем как есть
      this.nodes = new Map();       // id -> {id, lat, lon, attrs, tags}
      this.ways = new Map();        // id -> {id, nodes:[id], attrs, tags}
      this.relations = new Map();   // id -> {id, members:[{type,ref,role}], attrs, tags}
      this.nodeWays = new Map();    // id узла -> Set(id линий)
      this.nextId = 1;
      this.nextSeq = 0;             // порядок элементов в файле: отмена удаления возвращает элемент на место
      this._tx = null;
      this.undoStack = [];
      this.redoStack = [];
      this.dirty = false;
      this.listeners = [];
    }

    static parse(text, DOMParserImpl) {
      const P = DOMParserImpl || (typeof DOMParser !== "undefined" ? DOMParser : null);
      if (!P) throw new Error("Нет DOMParser");
      // Браузерный DOMParser аргументов не принимает, xmldom (тесты в Node) так сообщает об ошибках
      const fail = (m) => { throw new Error("Файл не является корректным XML: " + String(m).split("\n")[0]); };
      let xml;
      try {
        xml = new P({ errorHandler: { warning() {}, error: fail, fatalError: fail } }).parseFromString(text, "application/xml");
      } catch (e) {
        throw new Error(/XML/.test(e.message) ? e.message : "Файл не является корректным XML");
      }
      const err = xml.getElementsByTagName("parsererror");
      if (err.length) throw new Error("Файл не является корректным XML");
      const osm = xml.documentElement;
      if (!osm || osm.nodeName !== "osm") throw new Error("Корневой элемент должен быть <osm>");

      const doc = new OsmDoc();
      doc.rootAttrs = attrsOf(osm);
      let maxId = 0;
      const seen = (id) => {
        const n = Number(id);
        if (Number.isFinite(n) && Math.abs(n) > maxId) maxId = Math.abs(n);
      };

      const kids = osm.childNodes;
      for (let i = 0; i < kids.length; i++) {
        const el = kids[i];
        if (el.nodeType !== 1) continue;
        const name = el.nodeName;
        if (name === "node") {
          const a = attrsOf(el);
          if (a.action === "delete") continue;
          const id = a.id;
          const lat = parseFloat(a.lat), lon = parseFloat(a.lon);
          delete a.lat; delete a.lon;
          doc.nodes.set(id, { id, lat, lon, attrs: a, tags: tagsOf(el), seq: doc.nextSeq++ });
          seen(id);
        } else if (name === "way") {
          const a = attrsOf(el);
          if (a.action === "delete") continue;
          const nds = [];
          const c = el.childNodes;
          for (let j = 0; j < c.length; j++) {
            if (c[j].nodeType === 1 && c[j].nodeName === "nd") nds.push(c[j].getAttribute("ref"));
          }
          doc.ways.set(a.id, { id: a.id, nodes: nds, attrs: a, tags: tagsOf(el), seq: doc.nextSeq++ });
          seen(a.id);
        } else if (name === "relation") {
          const a = attrsOf(el);
          if (a.action === "delete") continue;
          const members = [];
          const c = el.childNodes;
          for (let j = 0; j < c.length; j++) {
            if (c[j].nodeType === 1 && c[j].nodeName === "member") {
              members.push({
                type: c[j].getAttribute("type"),
                ref: c[j].getAttribute("ref"),
                role: c[j].getAttribute("role") || "",
              });
            }
          }
          doc.relations.set(a.id, { id: a.id, members, attrs: a, tags: tagsOf(el), seq: doc.nextSeq++ });
          seen(a.id);
        } else if (name === "bounds") {
          doc.bounds = attrsOf(el);
        } else {
          doc.extraXml.push(typeof XMLSerializer !== "undefined"
            ? new XMLSerializer().serializeToString(el) : String(el));
        }
      }
      // Узлы, на которые ссылаются линии, но которых нет в файле (обрезка выгрузки), — убираем из линий
      doc.missingNodeRefs = 0;
      for (const w of doc.ways.values()) {
        const before = w.nodes.length;
        w.nodes = w.nodes.filter((id) => doc.nodes.has(id));
        doc.missingNodeRefs += before - w.nodes.length;
      }
      for (const [id, w] of doc.ways) if (w.nodes.length < 2) doc.ways.delete(id);
      // Новые объекты получают положительные id выше всех существующих:
      // MatSim, SUMO и импортёр Webots одинаково читают такие файлы.
      doc.nextId = maxId + 1;
      doc.rebuildIndex();
      return doc;
    }

    // ----- индекс узел -> линии -----

    rebuildIndex() {
      this.nodeWays = new Map();
      for (const w of this.ways.values()) this._indexWay(w);
    }

    _indexWay(w) {
      for (const n of w.nodes) {
        let s = this.nodeWays.get(n);
        if (!s) this.nodeWays.set(n, (s = new Set()));
        s.add(w.id);
      }
    }

    _unindexWay(w) {
      for (const n of w.nodes) {
        const s = this.nodeWays.get(n);
        if (s) { s.delete(w.id); if (!s.size) this.nodeWays.delete(n); }
      }
    }

    waysOfNode(id) {
      return [...(this.nodeWays.get(id) || [])].map((w) => this.ways.get(w)).filter(Boolean);
    }

    newId() { return String(this.nextId++); }

    on(fn) { this.listeners.push(fn); }
    _emit(change) { for (const fn of this.listeners) fn(change); }

    // ----- транзакции, отмена и повтор -----

    begin(label) {
      if (this._tx) return; // вложенные begin — часть внешней транзакции
      this._tx = { label: label || "правка", before: new Map(), after: null };
    }

    _touch(type, id) {
      if (!this._tx) throw new Error("Правка вне begin()/commit()");
      const key = type + ":" + id;
      if (!this._tx.before.has(key)) this._tx.before.set(key, clone(this._get(type, id)));
    }

    _get(type, id) {
      return type === "node" ? this.nodes.get(id) : type === "way" ? this.ways.get(id) : this.relations.get(id);
    }

    _set(type, id, value) {
      const store = type === "node" ? this.nodes : type === "way" ? this.ways : this.relations;
      if (type === "way") { const old = this.ways.get(id); if (old) this._unindexWay(old); }
      if (value == null) store.delete(id);
      else {
        store.set(id, value);
        if (type === "way") this._indexWay(value);
      }
    }

    commit() {
      const tx = this._tx;
      this._tx = null;
      if (!tx || !tx.before.size) return null;
      tx.after = new Map();
      for (const key of tx.before.keys()) {
        const [type, id] = key.split(/:(.+)/);
        tx.after.set(key, clone(this._get(type, id)));
      }
      // Отбрасываем ничего не изменившие ключи
      for (const key of [...tx.before.keys()]) {
        if (JSON.stringify(tx.before.get(key)) === JSON.stringify(tx.after.get(key))) {
          tx.before.delete(key); tx.after.delete(key);
        }
      }
      if (!tx.before.size) return null;
      this.undoStack.push(tx);
      if (this.undoStack.length > 300) this.undoStack.shift();
      this.redoStack = [];
      this.dirty = true;
      this._emit({ kind: "commit", keys: [...tx.before.keys()], label: tx.label });
      return tx;
    }

    rollback() {
      const tx = this._tx;
      this._tx = null;
      if (!tx) return;
      this._apply(tx.before);
    }

    _apply(states) {
      // сначала узлы, потом линии и отношения — индекс строится по линиям
      const order = { node: 0, way: 1, relation: 2 };
      const keys = [...states.keys()].sort((a, b) => order[a.split(":")[0]] - order[b.split(":")[0]]);
      for (const key of keys) {
        const [type, id] = key.split(/:(.+)/);
        this._set(type, id, clone(states.get(key)));
      }
      return keys;
    }

    undo() {
      const tx = this.undoStack.pop();
      if (!tx) return null;
      const keys = this._apply(tx.before);
      this.redoStack.push(tx);
      this.dirty = true;
      this._emit({ kind: "undo", keys, label: tx.label });
      return tx;
    }

    redo() {
      const tx = this.redoStack.pop();
      if (!tx) return null;
      const keys = this._apply(tx.after);
      this.undoStack.push(tx);
      this.dirty = true;
      this._emit({ kind: "redo", keys, label: tx.label });
      return tx;
    }

    /** Выполнить fn как один шаг отмены. */
    edit(label, fn) {
      const outer = !!this._tx;
      this.begin(label);
      try {
        const result = fn();
        if (!outer) this.commit();
        return result;
      } catch (e) {
        if (!outer) this.rollback();
        throw e;
      }
    }

    // ----- элементарные правки (вызываются внутри edit) -----

    addNode(lat, lon, tags) {
      const id = this.newId();
      this._touch("node", id);
      this._set("node", id, { id, lat, lon, attrs: { id, visible: "true", version: "1" }, tags: { ...(tags || {}) }, seq: this.nextSeq++ });
      return id;
    }

    moveNode(id, lat, lon) {
      this._touch("node", id);
      const n = this.nodes.get(id);
      n.lat = lat; n.lon = lon;
      // Узел сдвинут — линии через него тоже меняют геометрию (для перерисовки)
      for (const w of this.waysOfNode(id)) this._touch("way", w.id);
    }

    setTags(type, id, tags) {
      this._touch(type, id);
      const el = this._get(type, id);
      const clean = {};
      for (const [k, v] of Object.entries(tags)) {
        const kk = String(k).trim(), vv = v == null ? "" : String(v).trim();
        if (kk && vv !== "") clean[kk] = vv;
      }
      el.tags = clean;
    }

    setTag(type, id, key, value) {
      const el = this._get(type, id);
      const tags = { ...el.tags };
      if (value == null || value === "") delete tags[key]; else tags[key] = value;
      this.setTags(type, id, tags);
    }

    setWayNodes(id, nodes) {
      this._touch("way", id);
      const w = this.ways.get(id);
      this._unindexWay(w);
      w.nodes = nodes;
      this._indexWay(w);
    }

    addWay(nodeIds, tags) {
      const id = this.newId();
      this._touch("way", id);
      this._set("way", id, { id, nodes: [...nodeIds], attrs: { id, visible: "true", version: "1" }, tags: { ...(tags || {}) }, seq: this.nextSeq++ });
      return id;
    }

    deleteWay(id, keepOrphans) {
      const w = this.ways.get(id);
      if (!w) return;
      this._touch("way", id);
      this._set("way", id, null);
      this._removeFromRelations("way", id);
      if (!keepOrphans) {
        for (const n of new Set(w.nodes)) this._deleteNodeIfOrphan(n);
      }
    }

    _deleteNodeIfOrphan(id) {
      const n = this.nodes.get(id);
      if (!n) return;
      if (this.nodeWays.has(id)) return;
      if (Object.keys(n.tags).length) return;
      if (this._inRelations("node", id)) return;
      this._touch("node", id);
      this._set("node", id, null);
    }

    _inRelations(type, id) {
      for (const r of this.relations.values()) {
        if (r.members.some((m) => m.type === type && m.ref === id)) return true;
      }
      return false;
    }

    _removeFromRelations(type, id) {
      for (const r of this.relations.values()) {
        if (r.members.some((m) => m.type === type && m.ref === id)) {
          this._touch("relation", r.id);
          r.members = r.members.filter((m) => !(m.type === type && m.ref === id));
        }
      }
    }

    deleteNode(id) {
      if (!this.nodes.has(id)) return;
      for (const w of this.waysOfNode(id)) {
        const rest = w.nodes.filter((n) => n !== id);
        const dedup = rest.filter((n, i) => i === 0 || n !== rest[i - 1]);
        if (dedup.length < 2) this.deleteWay(w.id);
        else this.setWayNodes(w.id, dedup);
      }
      this._removeFromRelations("node", id);
      this._touch("node", id);
      this._set("node", id, null);
    }

    // ----- составные операции -----

    /** Развернуть линию: меняет направление односторонней дороги и связанные теги. */
    reverseWay(id) {
      const w = this.ways.get(id);
      this.setWayNodes(id, [...w.nodes].reverse());
      const tags = {};
      for (const [k, v] of Object.entries(w.tags)) {
        let nk = k;
        if (/:forward(:|$)/.test(k)) nk = k.replace(/:forward(:|$)/, ":backward$1");
        else if (/:backward(:|$)/.test(k)) nk = k.replace(/:backward(:|$)/, ":forward$1");
        let nv = v;
        if (k === "incline") nv = v === "up" ? "down" : v === "down" ? "up" : v.startsWith("-") ? v.slice(1) : /^\d/.test(v) ? "-" + v : v;
        if (k === "direction") nv = v === "forward" ? "backward" : v === "backward" ? "forward" : v;
        tags[nk] = nv;
      }
      this.setTags("way", id, tags);
    }

    /** Разрезать линию в промежуточном узле. Возвращает id новой линии. */
    splitWay(wayId, nodeId) {
      const w = this.ways.get(wayId);
      const idx = w.nodes.indexOf(nodeId);
      if (idx <= 0 || idx >= w.nodes.length - 1) throw new Error("Разрезать можно только в промежуточном узле линии");
      const first = w.nodes.slice(0, idx + 1);
      const second = w.nodes.slice(idx);
      const newId = this.addWay(second, w.tags);
      this.setWayNodes(wayId, first);
      // Новая часть входит в те же отношения (маршруты транспорта), сразу после исходной
      for (const r of this.relations.values()) {
        const i = r.members.findIndex((m) => m.type === "way" && m.ref === wayId);
        if (i >= 0) {
          this._touch("relation", r.id);
          r.members.splice(i + 1, 0, { type: "way", ref: newId, role: r.members[i].role });
        }
      }
      return newId;
    }

    /** Вставить узел в отрезок линии после позиции segIndex. */
    insertNode(wayId, segIndex, lat, lon, existingNodeId) {
      const w = this.ways.get(wayId);
      const id = existingNodeId || this.addNode(lat, lon);
      const nodes = [...w.nodes];
      nodes.splice(segIndex + 1, 0, id);
      this.setWayNodes(wayId, nodes);
      return id;
    }

    /** Слить узел removeId в keepId: все линии и отношения переходят на keepId. */
    mergeNodes(keepId, removeId) {
      if (keepId === removeId) return keepId;
      const keep = this.nodes.get(keepId), rem = this.nodes.get(removeId);
      if (!keep || !rem) throw new Error("Узел не найден");
      for (const w of this.waysOfNode(removeId)) {
        const replaced = w.nodes.map((n) => (n === removeId ? keepId : n));
        const dedup = replaced.filter((n, i) => i === 0 || n !== replaced[i - 1]);
        if (dedup.length < 2) this.deleteWay(w.id, true);
        else this.setWayNodes(w.id, dedup);
      }
      for (const r of this.relations.values()) {
        if (r.members.some((m) => m.type === "node" && m.ref === removeId)) {
          this._touch("relation", r.id);
          r.members = r.members.map((m) => (m.type === "node" && m.ref === removeId ? { ...m, ref: keepId } : m));
        }
      }
      if (Object.keys(rem.tags).length) this.setTags("node", keepId, { ...rem.tags, ...keep.tags });
      this._touch("node", removeId);
      this._set("node", removeId, null);
      return keepId;
    }

    /** Соединить две линии, пересекающиеся без общего узла: в точке пересечения появляется общий узел. */
    connectAt(wayA, segA, wayB, segB, lat, lon) {
      const id = this.insertNode(wayA, segA, lat, lon);
      this.insertNode(wayB, segB, lat, lon, id);
      return id;
    }

    /** Притянуть конец дороги на отрезок другой дороги и сделать общий узел. */
    snapNodeToWay(nodeId, wayId, segIndex, t) {
      const w = this.ways.get(wayId);
      const A = this.nodes.get(w.nodes[segIndex]), B = this.nodes.get(w.nodes[segIndex + 1]);
      this.moveNode(nodeId, A.lat + (B.lat - A.lat) * t, A.lon + (B.lon - A.lon) * t);
      this.insertNode(wayId, segIndex, 0, 0, nodeId);
      return nodeId;
    }

    /**
     * Полосы по направлениям. Для двусторонней дороги: forward — по направлению рисования,
     * backward — против; lanes = сумма. Для односторонней — просто lanes.
     * Именно так их читает SUMO: lanes:forward=2 + lanes:backward=1 → 2 полосы туда, 1 обратно.
     */
    setLanes(wayId, forward, backward) {
      const w = this.ways.get(wayId);
      const tags = { ...w.tags };
      let f = Math.max(0, Math.round(forward || 0)), b = Math.max(0, Math.round(backward || 0));
      if (onewayDir(w) !== 0) {
        if (f > 0) tags.lanes = String(f); else delete tags.lanes;
        delete tags["lanes:forward"]; delete tags["lanes:backward"];
      } else {
        // У двусторонней дороги 0 полос в одну сторону превратит её в SUMO в одностороннюю
        if (f + b > 0) { if (!f) f = 1; if (!b) b = 1; }
        if (f + b > 0) tags.lanes = String(f + b); else delete tags.lanes;
        if (f > 0) tags["lanes:forward"] = String(f); else delete tags["lanes:forward"];
        if (b > 0) tags["lanes:backward"] = String(b); else delete tags["lanes:backward"];
      }
      this.setTags("way", wayId, tags);
    }

    /** Текущие полосы {forward, backward, total, known}. Неизвестные части — null. */
    lanesOf(way) {
      const n = (v) => (v != null && /^\d+$/.test(v) ? parseInt(v, 10) : null);
      const total = n(way.tags.lanes), f = n(way.tags["lanes:forward"]), b = n(way.tags["lanes:backward"]);
      if (onewayDir(way) !== 0) return { forward: total, backward: 0, total, known: total != null };
      let ff = f, bb = b;
      if (total != null && ff == null && bb != null) ff = total - bb;
      if (total != null && bb == null && ff != null) bb = total - ff;
      if (total != null && ff == null && bb == null && total % 2 === 0) { ff = total / 2; bb = total / 2; }
      return { forward: ff, backward: bb, total, known: total != null || f != null || b != null };
    }

    /** Массовая правка: тег на все линии, подходящие под фильтр. Возвращает число изменённых. */
    bulkSetTag(filter, key, value) {
      let count = 0;
      for (const w of [...this.ways.values()]) {
        if (!filter(w) || w.tags[key] === value) continue;
        this.setTag("way", w.id, key, value);
        count++;
      }
      return count;
    }

    // ----- светофоры -----

    /** Подъезды к перекрёстку: направление (от узла к соседней точке), название, можно ли подъехать. */
    approaches(nodeId) {
      const n = this.nodes.get(nodeId);
      const list = [];
      for (const w of this.waysOfNode(nodeId)) {
        if (!isDrivable(w)) continue;
        const d = onewayDir(w);
        w.nodes.forEach((id, i) => {
          if (id !== nodeId) return;
          for (const [k, towardJunction] of [[i - 1, d >= 0], [i + 1, d <= 0]]) {
            if (k < 0 || k >= w.nodes.length) continue;
            const m = this.nodes.get(w.nodes[k]);
            const b = bearing(n, m);
            // side — с какой стороны линии едут к перекрёстку: forward — по направлению рисования
            list.push({ bearing: Math.round(b), name: w.tags.name || w.tags.highway, way: w.id, incoming: towardJunction,
              outgoing: k === i - 1 ? d <= 0 : d >= 0, side: k === i - 1 ? "forward" : "backward", lanes: this.lanesOf(w) });
          }
        });
      }
      // сливаем почти совпадающие направления (две линии одной улицы)
      list.sort((a, b) => a.bearing - b.bearing);
      const merged = [];
      for (const a of list) {
        const m = merged.find((x) => angleDiff(x.bearing, a.bearing) < 20);
        if (m) { m.incoming = m.incoming || a.incoming; m.outgoing = m.outgoing || a.outgoing; if (!m.name && a.name) m.name = a.name; }
        else merged.push({ ...a });
      }
      return merged;
    }

    // ----- запреты манёвров (отношения type=restriction) -----

    /** Запреты манёвров с узлом-перекрёстком via: {id, kind, only, from, to}. */
    restrictionsAt(nodeId) {
      if (!this._restrIndex || this._restrIndexVer !== this.undoStack.length + ":" + this.redoStack.length + ":" + this.relations.size) {
        const idx = new Map();
        for (const r of this.relations.values()) {
          if (r.tags.type !== "restriction") continue;
          const kind = r.tags.restriction || r.tags["restriction:motorcar"];
          if (!kind) continue;
          const from = r.members.find((m) => m.role === "from" && m.type === "way");
          const via = r.members.find((m) => m.role === "via" && m.type === "node");
          const to = r.members.find((m) => m.role === "to" && m.type === "way");
          if (!from || !via || !to) continue;
          if (!idx.has(via.ref)) idx.set(via.ref, []);
          idx.get(via.ref).push({ id: r.id, kind, only: kind.startsWith("only_"), from: from.ref, to: to.ref });
        }
        this._restrIndex = idx;
        this._restrIndexVer = this.undoStack.length + ":" + this.redoStack.length + ":" + this.relations.size;
      }
      return this._restrIndex.get(nodeId) || [];
    }

    /** Все запреты манёвров с координатами — для знаков на карте. */
    restrictions() {
      const out = [];
      for (const r of this.relations.values()) {
        if (r.tags.type !== "restriction") continue;
        const via = r.members.find((m) => m.role === "via" && m.type === "node");
        const from = r.members.find((m) => m.role === "from" && m.type === "way");
        if (!via || !from || !this.nodes.has(via.ref) || !this.ways.has(from.ref)) continue;
        const n = this.nodes.get(via.ref), w = this.ways.get(from.ref);
        // знак ставим на подъезде, в 15 м до перекрёстка
        const k = w.nodes.indexOf(via.ref);
        const nb = this.nodes.get(w.nodes[k > 0 ? k - 1 : k + 1]);
        if (!nb) continue;
        const d = distM(n, nb), t = Math.min(1, 15 / (d || 1));
        out.push({ id: r.id, kind: r.tags.restriction || r.tags["restriction:motorcar"], via: via.ref, from: from.ref,
          lat: n.lat + (nb.lat - n.lat) * t, lon: n.lon + (nb.lon - n.lon) * t });
      }
      return out;
    }

    // ----- общественный транспорт -----

    /** Маршруты ОТ из отношений route=bus/trolleybus/tram/…: линии и остановки, что есть в файле. */
    transitRoutes() {
      const TYPES = ["bus", "trolleybus", "tram", "minibus", "share_taxi"];
      const out = [];
      for (const r of this.relations.values()) {
        if (r.tags.type !== "route" || !TYPES.includes(r.tags.route)) continue;
        const ways = r.members.filter((m) => m.type === "way" && !/platform/.test(m.role) && this.ways.has(m.ref)).map((m) => m.ref);
        const stops = r.members.filter((m) => m.type === "node" && /stop|platform/.test(m.role) && this.nodes.has(m.ref)).map((m) => m.ref);
        if (!ways.length && !stops.length) continue;
        out.push({ id: r.id, mode: r.tags.route, ref: r.tags.ref || "", name: r.tags.name || r.tags.ref || r.id, colour: r.tags.colour, ways, stops });
      }
      return out.sort((a, b) => a.mode.localeCompare(b.mode) || (parseInt(a.ref, 10) || 0) - (parseInt(b.ref, 10) || 0) || a.ref.localeCompare(b.ref));
    }

    /** Остановки ОТ в файле. */
    transitStops() {
      const out = [];
      for (const n of this.nodes.values()) {
        const t = n.tags;
        if (t.highway === "bus_stop" || t.railway === "tram_stop" || t.public_transport === "platform" || t.public_transport === "stop_position" || t.amenity === "bus_station") {
          out.push({ id: n.id, lat: n.lat, lon: n.lon, name: t.name || "Остановка", kind: t.railway === "tram_stop" ? "tram" : t.trolleybus === "yes" ? "trolleybus" : "bus", user: t["uds:user"] === "yes" });
        }
      }
      return out;
    }

    /** Новая остановка (внутри edit): точка у дороги с тегами OSM по схеме public_transport. */
    addStop(lat, lon, name) {
      return this.addNode(lat, lon, { highway: "bus_stop", public_transport: "platform", bus: "yes", name: name || "Новая остановка", "uds:user": "yes" });
    }

    // ----- полосы и стрелки -----

    /** Ключ тега стрелок для направления: oneway → turn:lanes, иначе :forward / :backward. */
    turnKey(way, side) {
      return onewayDir(way) !== 0 ? "turn:lanes" : "turn:lanes:" + side;
    }

    /** Стрелки по полосам (слева направо по ходу движения). Пустая строка — не указано. */
    turnLanes(way, side) {
      const l = this.lanesOf(way);
      const n = onewayDir(way) !== 0 ? (l.total || 0) : side === "forward" ? (l.forward || 0) : (l.backward || 0);
      const raw = way.tags[this.turnKey(way, side)];
      const parts = raw ? raw.split("|") : [];
      return Array.from({ length: n }, (_, i) => (parts[i] || "").replace(/^none$/, ""));
    }

    /**
     * Стрелки по умолчанию для полос подъезда — по разрешённым манёврам на перекрёстке в конце:
     * 1 полоса — все манёвры; 2 — левая «налево+прямо», правая «прямо+направо»;
     * 3 и больше — крайняя левая «налево», крайняя правая «прямо+направо», средние «прямо».
     */
    defaultTurnLanes(way, side) {
      const n = this.turnLanes(way, side).length;
      if (!n) return [];
      const one = onewayDir(way) !== 0;
      const forwardTravel = one ? onewayDir(way) > 0 : side === "forward";
      const junction = forwardTravel ? way.nodes[way.nodes.length - 1] : way.nodes[0];
      const avail = new Set(this.movements(junction)
        .filter((m) => m.from.way === way.id && m.type !== "reverse" && (!m.restriction))
        .map((m) => m.type));
      if (!avail.size) return Array(n).fill("");
      const L = avail.has("left"), T = avail.has("through"), R = avail.has("right");
      const j = (...xs) => xs.filter(Boolean).join(";");
      if (n === 1) return [j(L && "left", T && "through", R && "right")];
      if (n === 2) return [j(L && "left", T && "through") || j(R && "right"), j(T && "through", R && "right") || j(L && "left")];
      return Array.from({ length: n }, (_, i) => i === 0 ? (L ? "left" : j(T && "through")) : i === n - 1 ? j(T && "through", R && "right") || "through" : (T ? "through" : (L ? "left" : "right")));
    }

    setTurnLanes(wayId, side, lanes) {
      const w = this.ways.get(wayId);
      const key = this.turnKey(w, side);
      const val = lanes.some((x) => x) ? lanes.map((x) => x || "none").join("|") : "";
      this.setTag("way", wayId, key, val);
    }

    /**
     * Манёвры на перекрёстке: каждый въезд × каждый выезд, тип поворота и разрешён ли он.
     * Разрешение — по стрелкам на полосах (turn:lanes), если они указаны; разворот — только по стрелке.
     */
    movements(nodeId) {
      const appr = this.approaches(nodeId);
      const out = [];
      for (const a of appr.filter((x) => x.incoming)) {
        const w = this.ways.get(a.way);
        const lanes = w ? this.turnLanes(w, onewayDir(w) !== 0 ? "forward" : a.side) : [];
        const allowedSet = new Set(lanes.flatMap((l) => l.split(";")).filter(Boolean).map(turnClass));
        const heading = (a.bearing + 180) % 360; // куда едут на подъезде
        const rest = this.restrictionsAt(nodeId).filter((r) => r.from === a.way);
        for (const b of appr.filter((x) => x.outgoing)) {
          let delta = ((b.bearing - heading + 540) % 360) - 180;
          const same = angleDiff(a.bearing, b.bearing) < 20;
          const type = same ? "reverse" : Math.abs(delta) < 30 ? "through" : delta > 0 ? "right" : "left";
          let allowed = allowedSet.size ? allowedSet.has(type) : type !== "reverse";
          // запреты манёвров из файла (отношения restriction) — их же читает SUMO
          let byRestriction = null;
          for (const r of rest) {
            if (r.only && r.to !== b.way) { allowed = false; byRestriction = r; }
            if (!r.only && r.to === b.way) { allowed = false; byRestriction = r; }
            if (r.only && r.to === b.way && type === "reverse") { allowed = true; }
          }
          out.push({ from: a, to: b, type, allowed, delta, restriction: byRestriction });
        }
      }
      return out;
    }

    // ----- геометрия проезжей части для отрисовки (2D-полосы и 3D) -----

    /** Полосы для отрисовки: если не указаны — умолчание по классу дороги. */
    renderLanes(w) {
      const DEF = { motorway: 4, trunk: 4, primary: 4, secondary: 2, tertiary: 2, unclassified: 2, residential: 2, living_street: 1, service: 1, road: 2 };
      const hw = w.tags.highway || "";
      const base = DEF[hw.replace("_link", "")] || 1;
      const l = this.lanesOf(w);
      if (onewayDir(w) !== 0) return { f: l.total || (hw.endsWith("_link") ? 1 : Math.max(1, Math.ceil(base / 2))), b: 0, known: !!l.total };
      let f = l.forward, b = l.backward;
      if (f == null || b == null) { const t = l.total || base; f = Math.max(1, Math.ceil(t / 2)); b = Math.max(t - f, t > 1 ? 1 : 0); }
      return { f, b, known: l.known };
    }

    /** Поперечный профиль: смещения левой и правой кромки и оси от линии (метры, влево — плюс). */
    crossSection(w) {
      const { f, b, known } = this.renderLanes(w);
      const tw = parseFloat(w.tags.width);
      const width = tw > 0 ? tw : (f + b) * 3.2;
      const laneW = width / Math.max(f + b, 1);
      const half = width / 2;
      return { f, b, known, laneW, width, left: half, right: -half, axis: half - b * laneW };
    }

    /**
     * Профиль на конце линии так, как его надо видеть с этой линии: если дорога продолжается
     * другой линией почти прямо (та же улица разбита на части), берём профиль продолжения —
     * тогда края и разметка сходятся, а лишняя полоса плавно сужается, а не обрывается ступенькой.
     */
    _continuation(w, atEnd) {
      const id = atEnd ? w.nodes[w.nodes.length - 1] : w.nodes[0];
      const prev = this.nodes.get(atEnd ? w.nodes[w.nodes.length - 2] : w.nodes[1]);
      const node = this.nodes.get(id);
      const heading = bearing(prev, node); // направление «наружу» через конец линии
      let best = null;
      const cands = [];
      const here = this.waysOfNode(id).filter(isDrivable);
      for (const o of here) {
        if (o.id === w.id || o.nodes.length < 2) continue;
        // продолжение — это та же дорога, разбитая на части: стык ровно двух линий или та же улица
        // того же класса. Съезд, вливающийся в магистраль, ширину магистрали не наследует.
        const sameStreet = w.tags.name && o.tags.name === w.tags.name && o.tags.highway === w.tags.highway;
        if (here.length > 2 && !sameStreet) continue;
        if (here.length === 2 && (o.tags.highway || "").endsWith("_link") !== (w.tags.highway || "").endsWith("_link")) continue;
        const k = o.nodes.indexOf(id);
        for (const step of [1, -1]) {
          const m = o.nodes[k + step];
          if (m === undefined) continue;
          const d = angleDiff(heading, bearing(node, this.nodes.get(m)));
          if (d < 35) {
            cands.push({ o, sameDir: (step === 1) === atEnd });
            if (!best || d < best.d) best = { o, d, sameDir: (step === 1) === atEnd };
          }
        }
      }
      // дорога расходится на две проезжие части (или две сходятся в одну) — это не продолжение
      if (best) best.all = cands;
      if (!best || new Set(cands.map((c) => c.o.id)).size > 1) return best ? Object.assign(best, { ambiguous: true }) : null;
      return best;
    }

    endProfile(w, atEnd) {
      const best = this._continuation(w, atEnd);
      if (!best) return null;
      const toFrame = (c) => {
        const p = this.crossSection(c.o);
        return c.sameDir ? { left: p.left, right: p.right, axis: p.axis } : { left: -p.right, right: -p.left, axis: -p.axis };
      };
      // Двусторонняя улица расходится на две односторонние проезжие части: каждая часть у стыка
      // занимает свою половину улицы и дальше плавно отходит — без ступеньки.
      if (onewayDir(w) !== 0) {
        const two = (best.all || []).find((c) => onewayDir(c.o) === 0 && c.o.tags.name && c.o.tags.name === w.tags.name);
        const id0 = atEnd ? w.nodes[w.nodes.length - 1] : w.nodes[0];
        const split = two && this._continuation(two.o, two.o.nodes[two.o.nodes.length - 1] === id0);
        if (two && split && split.ambiguous) {
          const t = toFrame(two);
          return onewayDir(w) > 0 ? { left: t.axis, right: t.right, axis: t.axis, exact: true }
                                  : { left: t.left, right: t.axis, axis: t.axis, exact: true };
        }
      }
      if (best.ambiguous) return null;
      // продолжение должно быть взаимным: иначе одна сторона сузится, а другая нет — опять ступенька
      const id = atEnd ? w.nodes[w.nodes.length - 1] : w.nodes[0];
      const back = this._continuation(best.o, best.o.nodes[best.o.nodes.length - 1] === id);
      if (!back || back.o.id !== w.id) return null;
      const p = this.crossSection(best.o);
      // у продолжения, нарисованного навстречу, лево и право меняются местами
      return best.sameDir ? { left: p.left, right: p.right, axis: p.axis }
                          : { left: -p.right, right: -p.left, axis: -p.axis };
    }

    // ----- знаки приоритета по данным -----

    /**
     * Где по данным графа нужны знаки приоритета на нерегулируемых перекрёстках:
     * второстепенные подъезды (ниже классом) — «Уступите дорогу» (2.4); с opts.main ещё и
     * главные — «Главная дорога» (2.1). Выезды из дворов (service, living_street) пропускаются.
     * Так же приоритет определяет SUMO: по классу дороги. Знаки ставятся в 12 м до перекрёстка.
     */
    suggestSigns(opts) {
      opts = opts || {};
      const RANK = { motorway: 7, trunk: 6, primary: 5, secondary: 4, tertiary: 3, unclassified: 2, residential: 2, road: 2, living_street: 1, service: 1 };
      const rank = (w) => { const h = w.tags.highway || ""; return (RANK[h.replace("_link", "")] || 0) - (h.endsWith("_link") ? 0.5 : 0); };
      const out = [];
      for (const [id] of this.nodeWays) {
        const n = this.nodes.get(id);
        if (n.tags.highway === "traffic_signals" || n.tags["uds:tls"]) continue;
        const appr = this.approaches(id).filter((a) => a.incoming);
        if (appr.length < 3) continue;
        const ranks = appr.map((a) => rank(this.ways.get(a.way)));
        const top = Math.max(...ranks);
        if (ranks.every((r) => r === top)) continue; // равнозначный перекрёсток — «правило правой руки»
        // выезды из дворов и с прилегающей территории знаков не требуют (ПДД 8.3)
        const minor = appr.filter((a, i) => ranks[i] < top && !isYard(this.ways.get(a.way)));
        if (!minor.length) continue;
        appr.forEach((a, i) => {
          const w = this.ways.get(a.way);
          const kind = ranks[i] === top ? "main" : "give_way";
          if (kind === "give_way" && isYard(w)) return;
          if (kind === "main" && !opts.main) return;
          // точка в 12 м от перекрёстка по подъезду
          const k = w.nodes.indexOf(id);
          const step = a.side === "forward" ? -1 : 1;
          let dist = 0, p = n, q = null;
          for (let j = k + step; j >= 0 && j < w.nodes.length; j += step) {
            q = this.nodes.get(w.nodes[j]);
            const seg = distM(p, q);
            if (dist + seg >= 12) { const t = (12 - dist) / seg; out.push({ junction: id, way: w.id, side: a.side, kind, name: a.name, seg: step < 0 ? j : j - 1, lat: p.lat + (q.lat - p.lat) * t, lon: p.lon + (q.lon - p.lon) * t }); return; }
            dist += seg; p = q;
          }
        });
      }
      // уже стоящие знаки не дублируем
      const existing = [...this.nodes.values()].filter((x) => x.tags.highway === "give_way" || x.tags.traffic_sign === "RU:2.4" || x.tags.traffic_sign === "RU:2.1");
      return out.filter((sg) => !existing.some((x) => distM(x, sg) < 20 && (x.tags.traffic_sign === "RU:2.1") === (sg.kind === "main")));
    }

    /** Записать предложенные знаки в граф: новые узлы на подъездах (внутри edit). */
    placeSigns(list) {
      let count = 0;
      for (const sg of list) {
        const w = this.ways.get(sg.way);
        if (!w) continue;
        // отрезок мог сдвинуться от вставок — ищем ближайший
        let best = 0, bd = Infinity;
        for (let i = 1; i < w.nodes.length; i++) {
          const a = this.nodes.get(w.nodes[i - 1]), b = this.nodes.get(w.nodes[i]);
          const d = distM(sg, { lat: (a.lat + b.lat) / 2, lon: (a.lon + b.lon) / 2 });
          if (d < bd) { bd = d; best = i - 1; }
        }
        const id = this.insertNode(sg.way, best, sg.lat, sg.lon);
        const tags = sg.kind === "main" ? { traffic_sign: "RU:2.1" } : { highway: "give_way", traffic_sign: "RU:2.4" };
        if (onewayDir(w) === 0) tags.direction = sg.side;
        this.setTags("node", id, tags);
        count++;
      }
      return count;
    }

    // ----- расчёт регулируемого перекрёстка (метод Вебстера) -----

    /**
     * Пропускная способность, задержка и очередь по подъездам при заданных интенсивностях.
     * prog.flows: { "<азимут подъезда>": авт/ч }. Поток насыщения — 1800 авт/ч на полосу.
     */
    tlsCapacity(nodeId, prog) {
      prog = prog || this.tlsProgram(nodeId);
      if (!prog) return null;
      const appr = this.approaches(nodeId).filter((a) => a.incoming);
      const flows = prog.flows || {};
      const flowOf = (a) => {
        const k = Object.keys(flows).find((b) => angleDiff(+b, a.bearing) <= 25);
        return k ? +flows[k] || 0 : 0;
      };
      const lanesIn = (a) => {
        const w = this.ways.get(a.way);
        if (!w) return 1;
        const l = this.lanesOf(w);
        const n = onewayDir(w) !== 0 ? l.total : a.side === "forward" ? l.forward : l.backward;
        return Math.max(1, n || (l.total ? Math.ceil(l.total / 2) : 1));
      };
      const phases = prog.phases;
      const cycle = phases.reduce((s, p) => s + (+p.dur || 0) + (+p.yellow || 0) + (+p.red || 0), 0);
      const lost = phases.reduce((s, p) => s + (+p.yellow || 0) + (+p.red || 0), 0);
      const inPhase = (p, a) => p.green.some((g) => angleDiff(g, a.bearing) <= 25);
      const rows = appr.map((a) => {
        const q = flowOf(a), n = lanesIn(a), s = 1800 * n;
        const g = phases.filter((p) => inPhase(p, a)).reduce((t, p) => t + (+p.dur || 0) + (+p.yellow || 0), 0);
        const lam = cycle ? g / cycle : 0;
        const cap = s * lam;
        const x = cap ? q / cap : (q ? Infinity : 0);
        const qs = q / 3600, ss = s / 3600, r = cycle - g;
        let delay = null, queue = null;
        if (q > 0 && x < 1 && lam > 0) {
          // Вебстер: равномерная составляющая + случайная, с поправочным коэффициентом 0,9
          delay = 0.9 * ((cycle * (1 - lam) ** 2) / (2 * (1 - lam * x)) + (x * x) / (2 * qs * (1 - x)));
          // очередь к началу зелёного: машины, пришедшие за красный, плюс доезжающие пока очередь рассасывается
          const veh = (qs * r) / (1 - qs / ss);
          queue = { veh: Math.ceil(veh), m: Math.round((veh / n) * 7) };
        }
        return { bearing: a.bearing, name: a.name, lanes: n, flow: q, sat: s, green: g, capacity: Math.round(cap), x, delay, queue, los: los(delay, x) };
      });
      // критические отношения фаз и оптимальный цикл Вебстера
      const ys = phases.map((p) => Math.max(0, ...rows.filter((r) => inPhase(p, r)).map((r) => (r.flow || 0) / r.sat)));
      const Y = ys.reduce((a, b) => a + b, 0);
      const C0 = Y < 0.95 && Y > 0 ? Math.min(150, Math.max(40, Math.round((1.5 * lost + 5) / (1 - Y)))) : null;
      const withFlow = rows.filter((r) => r.flow > 0 && r.delay != null);
      const avgDelay = withFlow.length ? withFlow.reduce((s, r) => s + r.delay * r.flow, 0) / withFlow.reduce((s, r) => s + r.flow, 0) : null;
      return { rows, cycle, lost, Y, C0, ys, avgDelay, los: los(avgDelay, Math.max(0, ...rows.map((r) => r.x).filter(Number.isFinite))) };
    }

    /**
     * Имитация работы регулируемого перекрёстка без визуализации (по секундам, модель очередей).
     * Машины приходят случайно (поток Пуассона с заданной интенсивностью), на зелёном уезжают
     * с интервалом насыщения 2 с на полосу после 2 с потерь на старт; на жёлтом — первые 2 с.
     * Возвращает показатели по подъездам и в целом за duration секунд, среднее по runs прогонам.
     */
    simulateJunction(nodeId, prog, opts) {
      opts = Object.assign({ duration: 3600, runs: 5, seed: 11, headway: 2, startLoss: 2, carLen: 7 }, opts || {});
      prog = prog || this.tlsProgram(nodeId);
      const cap = this.tlsCapacity(nodeId, prog);
      if (!cap) return null;
      const phases = prog.phases;
      // расписание сигнала по секундам цикла для каждого подъезда: 2 — зелёный, 1 — жёлтый, 0 — красный
      const cycle = cap.cycle;
      const inPhase = (p, b) => p.green.some((g) => angleDiff(g, b) <= 25);
      const rows = cap.rows.map((r) => {
        const sig = new Uint8Array(cycle);
        let t = 0;
        for (const p of phases) {
          const g = inPhase(p, r.bearing);
          for (let k = 0; k < (+p.dur || 0); k++, t++) sig[t] = g ? 2 : 0;
          for (let k = 0; k < (+p.yellow || 0); k++, t++) sig[t] = g ? 1 : 0;
          for (let k = 0; k < (+p.red || 0); k++, t++) sig[t] = 0;
        }
        // когда машины могут уезжать: зелёный после потерь на старт и первые 2 с жёлтого
        const go = new Uint8Array(cycle);
        for (let i = 0, g = 0, y = 0; i < 2 * cycle; i++) {
          const sg = sig[i % cycle];
          g = sg === 2 ? g + 1 : 0; y = sg === 1 ? y + 1 : 0;
          go[i % cycle] = (sg === 2 && g > opts.startLoss) || (sg === 1 && y <= 2) ? 1 : 0;
        }
        return { ...r, sig, go };
      });
      let seed = opts.seed;
      const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
      const res = rows.map((r) => ({ bearing: r.bearing, name: r.name, lanes: r.lanes, flow: r.flow, arrived: 0, departed: 0, delaySum: 0, stopped: 0, maxQueue: 0, queueSum: 0, overflowCycles: 0, cycles: 0 }));
      for (let run = 0; run < opts.runs; run++) {
        rows.forEach((r, i) => {
          const R = res[i];
          const lam = (r.flow || 0) / 3600;
          const queue = []; // время прихода машин в очереди
          let credit = 0, maxQ = 0;
          for (let t = 0; t < opts.duration; t++) {
            const c = (t + (+prog.offset || 0)) % cycle;
            // приход: число машин за секунду по Пуассону
            let L = Math.exp(-lam), k = 0, p = 1;
            do { k++; p *= rand(); } while (p > L);
            for (let a = 0; a < k - 1; a++) { queue.push(t); R.arrived++; }
            // отъезд
            const s = r.sig[c];
            if (r.go[c]) {
              credit += r.lanes / opts.headway;
              while (credit >= 1 && queue.length) {
                const arr = queue.shift();
                const delay = t - arr;
                R.departed++; R.delaySum += delay; if (delay > 1) R.stopped++;
                credit -= 1;
              }
              if (!queue.length) credit = Math.min(credit, 1);
            } else credit = 0;
            if (queue.length > maxQ) maxQ = queue.length;
            R.queueSum += queue.length;
            // конец зелёного с оставшейся очередью — «несработавший» цикл
            if (s === 2 && r.sig[(c + 1) % cycle] !== 2) { R.cycles++; if (queue.length) R.overflowCycles++; }
          }
          R.maxQueue = Math.max(R.maxQueue, maxQ);
          R.left = (R.left || 0) + queue.length;
        });
      }
      const N = opts.runs;
      const out = res.map((R) => ({
        bearing: R.bearing, name: R.name, lanes: R.lanes, flow: R.flow,
        arrived: Math.round(R.arrived / N), departed: Math.round(R.departed / N), leftInQueue: Math.round((R.left || 0) / N),
        avgDelay: R.departed ? R.delaySum / R.departed : null,
        stopShare: R.departed ? R.stopped / R.departed : null,
        avgQueue: R.queueSum / (opts.duration * N), maxQueue: R.maxQueue,
        maxQueueM: Math.round((R.maxQueue / Math.max(1, R.lanes)) * opts.carLen),
        failedCycles: R.cycles ? R.overflowCycles / R.cycles : 0,
      }));
      const dep = out.reduce((s, r) => s + r.departed, 0);
      const avgDelay = dep ? out.reduce((s, r) => s + (r.avgDelay || 0) * r.departed, 0) / dep : null;
      return { rows: out, cycle, duration: opts.duration, runs: N, totalArrived: out.reduce((s, r) => s + r.arrived, 0), totalDeparted: dep, avgDelay, los: los(avgDelay, 0) };
    }

    /** Распределить зелёный по Вебстеру: цикл C0, зелёный фазам пропорционально критическим отношениям. */
    websterProgram(nodeId, prog) {
      const cap = this.tlsCapacity(nodeId, prog);
      if (!cap || !cap.C0) return null;
      const G = cap.C0 - cap.lost;
      const sumY = cap.ys.reduce((a, b) => a + b, 0) || 1;
      const p = JSON.parse(JSON.stringify(prog));
      p.phases.forEach((ph, i) => { ph.dur = Math.max(10, Math.round((G * cap.ys[i]) / sumY) - (+ph.yellow || 0)); });
      return p;
    }

    tlsProgram(nodeId) {
      const n = this.nodes.get(nodeId);
      if (!n || !n.tags["uds:tls"]) return null;
      try { return JSON.parse(n.tags["uds:tls"]); } catch (e) { return null; }
    }

    /** Записать программу светофора на узел перекрёстка (внутри edit). null — убрать свою программу. */
    setTlsProgram(nodeId, prog) {
      const n = this.nodes.get(nodeId);
      const tags = { ...n.tags };
      if (prog) {
        tags["uds:tls"] = JSON.stringify(prog);
        if (tags.highway !== "traffic_signals") tags.highway = "traffic_signals";
      } else delete tags["uds:tls"];
      this.setTags("node", nodeId, tags);
    }

    /** Программа по умолчанию: две фазы — «ось 1» и «ось 2» (встречные подъезды вместе). */
    defaultTlsProgram(nodeId) {
      const appr = this.approaches(nodeId).filter((a) => a.incoming);
      if (!appr.length) return null;
      const axis = appr[0].bearing;
      const onAxis = (b) => angleDiff(b, axis) < 45 || angleDiff(b, axis) > 135;
      const g1 = appr.filter((a) => onAxis(a.bearing)), g2 = appr.filter((a) => !onAxis(a.bearing));
      const nameOf = (g) => [...new Set(g.map((a) => a.name))].join(" / ");
      const phases = [{ name: nameOf(g1), green: g1.map((a) => a.bearing), dur: 30, yellow: 3, red: 2 }];
      if (g2.length) phases.push({ name: nameOf(g2), green: g2.map((a) => a.bearing), dur: 25, yellow: 3, red: 2 });
      return { v: 1, offset: 0, approaches: this.approaches(nodeId).map((a) => ({ bearing: a.bearing, name: a.name, incoming: a.incoming })), phases };
    }

    /** Перенести светофоры с подходов на узел перекрёстка (внутри edit). */
    moveSignalsToJunction(junctionId, signalNodes) {
      for (const id of signalNodes) {
        const t = { ...this.nodes.get(id).tags };
        if (t.highway === "traffic_signals") delete t.highway;
        delete t["traffic_signals:direction"];
        this.setTags("node", id, t);
      }
      this.setTag("node", junctionId, "highway", "traffic_signals");
      return junctionId;
    }

    /** Применить автоисправление из validate(). */
    applyFix(fix) {
      if (fix.kind === "merge") return this.mergeNodes(fix.keep, fix.remove);
      if (fix.kind === "snap") return this.snapNodeToWay(fix.node, fix.way, fix.seg, fix.t);
      if (fix.kind === "connect") return this.connectAt(fix.wayA, fix.segA, fix.wayB, fix.segB, fix.lat, fix.lon);
      if (fix.kind === "tag") return this.setTag("way", fix.way, fix.key, fix.value);
      if (fix.kind === "unglue") return this.unglueNode(fix.node, fix.way);
      if (fix.kind === "noexit") return this.setTag("node", fix.node, "noexit", "yes");
      if (fix.kind === "move_signal") return this.moveSignalsToJunction(fix.junction, fix.signals);
      throw new Error("Неизвестное исправление: " + fix.kind);
    }

    // ----- запись -----

    serialize() {
      const bySeq = (m) => [...m.values()].sort((a, b) => a.seq - b.seq);
      const out = ['<?xml version="1.0" encoding="UTF-8"?>'];
      out.push(`<osm${attrString(this.rootAttrs)}>`);
      if (this.bounds) out.push(` <bounds${attrString(this.bounds)}/>`);
      for (const x of this.extraXml) out.push(" " + x);
      for (const n of bySeq(this.nodes)) {
        const attrs = { ...n.attrs, id: n.id, lat: n.lat.toFixed(7), lon: n.lon.toFixed(7) };
        const tags = tagLines(n.tags, "  ");
        if (tags.length) out.push(` <node${attrString(attrs, KEY_ORDER_NODE)}>`, ...tags, " </node>");
        else out.push(` <node${attrString(attrs, KEY_ORDER_NODE)}/>`);
      }
      for (const w of bySeq(this.ways)) {
        out.push(` <way${attrString({ ...w.attrs, id: w.id }, KEY_ORDER_NODE)}>`);
        for (const n of w.nodes) out.push(`  <nd ref="${escapeAttr(n)}"/>`);
        out.push(...tagLines(w.tags, "  "), " </way>");
      }
      for (const r of bySeq(this.relations)) {
        out.push(` <relation${attrString({ ...r.attrs, id: r.id }, KEY_ORDER_NODE)}>`);
        for (const m of r.members) out.push(`  <member type="${escapeAttr(m.type)}" ref="${escapeAttr(m.ref)}" role="${escapeAttr(m.role)}"/>`);
        out.push(...tagLines(r.tags, "  "), " </relation>");
      }
      out.push("</osm>", "");
      return out.join("\n");
    }

    // ----- проверка графа -----

    /**
     * Типичные ошибки OSM для дорог с машинным движением:
     *  - isolated     изолированный кусок сети (не связан с основной сетью)
     *  - deadend      односторонний тупик: въехать можно, выехать нельзя (или наоборот)
     *  - gap          разорванный перекрёсток: конец дороги в паре метров от другой, но не соединён
     *  - crossing     дороги пересекаются без общего узла и без моста/тоннеля
     *  - bridge       мост без уровня (layer) — в SUMO и Webots окажется на одной высоте с дорогой под ним
     *  - short        линия из одной точки / нулевой длины
     */
    validate(opts) {
      opts = Object.assign({ gapMeters: 4, boundaryMeters: 25 }, opts || {});
      const issues = [];
      const ways = [...this.ways.values()].filter(isDrivable);
      if (!ways.length) return issues;

      const nodeOf = (id) => this.nodes.get(id);
      const bbox = this._bbox(ways);
      const nearBoundary = (n) => {
        const b = bbox, m = opts.boundaryMeters;
        // дорога, выходящая за границу выгрузки, обрывается там естественно
        if (n.lat < b.minLat || n.lat > b.maxLat || n.lon < b.minLon || n.lon > b.maxLon) return true;
        return distM(n, { lat: b.minLat, lon: n.lon }) < m || distM(n, { lat: b.maxLat, lon: n.lon }) < m ||
               distM(n, { lat: n.lat, lon: b.minLon }) < m || distM(n, { lat: n.lat, lon: b.maxLon }) < m;
      };

      // Связность (по общим узлам, без учёта направления)
      const parent = new Map();
      const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
      const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
      for (const w of ways) for (const n of w.nodes) if (!parent.has(n)) parent.set(n, n);
      for (const w of ways) for (let i = 1; i < w.nodes.length; i++) union(w.nodes[0], w.nodes[i]);
      const comp = new Map();
      for (const w of ways) {
        const r = find(w.nodes[0]);
        if (!comp.has(r)) comp.set(r, { ways: [], length: 0 });
        const c = comp.get(r);
        c.ways.push(w.id);
        for (let i = 1; i < w.nodes.length; i++) c.length += distM(nodeOf(w.nodes[i - 1]), nodeOf(w.nodes[i]));
      }
      const comps = [...comp.values()].sort((a, b) => b.length - a.length);
      for (const c of comps.slice(1)) {
        const w = this.ways.get(c.ways[0]);
        const p = nodeOf(w.nodes[Math.floor(w.nodes.length / 2)]);
        const yard = c.ways.every((id) => isYard(this.ways.get(id)));
        if (c.ways.some((id) => this.ways.get(id).nodes.some((n) => isNoExit(nodeOf(n))))) continue;
        const end = this.ways.get(c.ways[0]).nodes[0];
        issues.push({
          type: "isolated", severity: yard ? "warning" : "error", ways: c.ways, lat: p.lat, lon: p.lon,
          fix: yard ? { kind: "noexit", node: end, label: "Это нормально" } : undefined,
          message: `${yard ? "Изолированный двор или проезд" : "Изолированный кусок сети"}: ${c.ways.length} ${plural(c.ways.length, "линия", "линии", "линий")}, ${Math.round(c.length)} м — ` +
            (yard ? "машины туда не попадут; если въезд есть в реальности — соедините, если нет — отметьте как норму"
                  : "MatSim и SUMO не смогут построить сюда маршруты"),
        });
      }

      // Направленный граф: входы и выходы узлов
      const inDeg = new Map(), outDeg = new Map();
      const inc = (m, k) => m.set(k, (m.get(k) || 0) + 1);
      for (const w of ways) {
        const d = onewayDir(w);
        for (let i = 1; i < w.nodes.length; i++) {
          const a = w.nodes[i - 1], b = w.nodes[i];
          if (d >= 0) { inc(outDeg, a); inc(inDeg, b); }
          if (d <= 0) { inc(outDeg, b); inc(inDeg, a); }
        }
      }
      for (const id of parent.keys()) {
        const n = nodeOf(id);
        const i = inDeg.get(id) || 0, o = outDeg.get(id) || 0;
        if ((i > 0 && o === 0) || (o > 0 && i === 0)) {
          if (nearBoundary(n)) continue; // край выгрузки — дорога уходит за границу фрагмента
          if (isNoExit(n)) continue;     // отмечено как настоящий тупик
          // Тупик двусторонней дороги — нормален (разворот), ошибка только для односторонних
          const touching = this.waysOfNode(id).filter(isDrivable);
          if (!touching.some((w) => onewayDir(w) !== 0)) continue;
          const yard = touching.every(isYard);
          issues.push({
            type: "deadend", severity: yard ? "warning" : "error", nodes: [id], ways: touching.map((w) => w.id), lat: n.lat, lon: n.lon,
            fix: { kind: "noexit", node: id, label: "Это нормально" },
            message: (o === 0 ? "Односторонний тупик: въехать можно, выехать нельзя" : "Односторонний тупик: выехать можно, въехать нельзя") +
              (yard ? ". Во дворе это бывает нормой (въезд с одной улицы, выезд на другую) — если так в реальности, отметьте" : ""),
          });
        }
      }

      // Отрезки дорог в плоских координатах + сетка для быстрого поиска
      const proj = projector((bbox.minLat + bbox.maxLat) / 2);
      const segs = [];
      for (const w of ways) {
        const layer = parseInt(w.tags.layer || "0", 10) || 0;
        const lifted = (w.tags.bridge && w.tags.bridge !== "no") || (w.tags.tunnel && w.tags.tunnel !== "no");
        for (let i = 1; i < w.nodes.length; i++) {
          segs.push({ w, i: i - 1, a: proj(nodeOf(w.nodes[i - 1])), b: proj(nodeOf(w.nodes[i])), na: w.nodes[i - 1], nb: w.nodes[i], layer, lifted });
        }
      }
      const sgrid = new Map();
      const scell = 50;
      segs.forEach((sg, idx) => {
        const x0 = Math.floor((Math.min(sg.a.x, sg.b.x) - opts.gapMeters) / scell), x1 = Math.floor((Math.max(sg.a.x, sg.b.x) + opts.gapMeters) / scell);
        const y0 = Math.floor((Math.min(sg.a.y, sg.b.y) - opts.gapMeters) / scell), y1 = Math.floor((Math.max(sg.a.y, sg.b.y) + opts.gapMeters) / scell);
        for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
          const k = x + ":" + y;
          if (!sgrid.has(k)) sgrid.set(k, []);
          sgrid.get(k).push(idx);
        }
      });

      // Разорванные перекрёстки: конец дороги в паре метров от другой дороги, но не соединён с ней
      const endpoints = new Set();
      for (const w of ways) {
        if (w.nodes[0] === w.nodes[w.nodes.length - 1]) continue; // кольцо
        for (const e of [w.nodes[0], w.nodes[w.nodes.length - 1]]) {
          const touching = [...(this.nodeWays.get(e) || [])].map((x) => this.ways.get(x)).filter(isDrivable);
          if (touching.length === 1) endpoints.add(e);
        }
      }
      const reportedGap = new Set();
      for (const id of endpoints) {
        const n = nodeOf(id);
        const p = proj(n);
        const own = this.nodeWays.get(id) || new Set();
        let best = null;
        for (const idx of sgrid.get(Math.floor(p.x / scell) + ":" + Math.floor(p.y / scell)) || []) {
          const sg = segs[idx];
          if (own.has(sg.w.id)) continue;
          const dx = sg.b.x - sg.a.x, dy = sg.b.y - sg.a.y;
          const len2 = dx * dx + dy * dy;
          let t = len2 ? ((p.x - sg.a.x) * dx + (p.y - sg.a.y) * dy) / len2 : 0;
          t = Math.max(0, Math.min(1, t));
          const qx = sg.a.x + dx * t, qy = sg.a.y + dy * t;
          const d = Math.hypot(p.x - qx, p.y - qy);
          if (d > opts.gapMeters || (best && d >= best.d)) continue;
          // ближе к концу отрезка, чем на метр — соединяем с существующим узлом
          const da = Math.hypot(p.x - sg.a.x, p.y - sg.a.y), db = Math.hypot(p.x - sg.b.x, p.y - sg.b.y);
          if (Math.min(da, db) <= Math.max(d + 1, 1.5)) best = { d, kind: "merge", keep: da <= db ? sg.na : sg.nb };
          else best = { d, kind: "snap", way: sg.w.id, seg: sg.i, t };
        }
        if (!best) continue;
        const pair = best.kind === "merge" ? [id, best.keep].sort().join("-") : id;
        if (reportedGap.has(pair)) continue;
        reportedGap.add(pair);
        const fix = best.kind === "merge"
          ? { kind: "merge", keep: best.keep, remove: id }
          : { kind: "snap", node: id, way: best.way, seg: best.seg, t: best.t };
        issues.push({
          type: "gap", severity: "error", nodes: [id], lat: n.lat, lon: n.lon, fix,
          message: `Разорванный перекрёсток: конец дороги в ${best.d.toFixed(1)} м от другой дороги, но не соединён`,
        });
      }

      // Пересечения без общего узла
      const checked = new Set();
      for (const list of sgrid.values()) {
        for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
          const s = segs[list[i]], t = segs[list[j]];
          if (s.w === t.w) continue;
          const pk = list[i] < list[j] ? list[i] + "-" + list[j] : list[j] + "-" + list[i];
          if (checked.has(pk)) continue;
          checked.add(pk);
          if (s.na === t.na || s.na === t.nb || s.nb === t.na || s.nb === t.nb) continue;
          if (s.layer !== t.layer || s.lifted || t.lifted) continue;
          const x = segIntersect(s.a, s.b, t.a, t.b);
          if (!x) continue;
          const A = nodeOf(s.na), B = nodeOf(s.nb);
          const lat = A.lat + (B.lat - A.lat) * x.t, lon = A.lon + (B.lon - A.lon) * x.t;
          issues.push({
            type: "crossing", severity: "warning", ways: [s.w.id, t.w.id], lat, lon,
            fix: { kind: "connect", wayA: s.w.id, segA: s.i, wayB: t.w.id, segB: t.i, lat, lon },
            message: `Дороги «${label(s.w)}» и «${label(t.w)}» пересекаются без перекрёстка (нет общего узла, не мост и не тоннель)`,
          });
        }
      }

      // Мосты без уровня
      for (const w of ways) {
        if (w.tags.bridge && w.tags.bridge !== "no" && !w.tags.layer) {
          const p = nodeOf(w.nodes[Math.floor(w.nodes.length / 2)]);
          issues.push({
            type: "bridge", severity: "warning", ways: [w.id], lat: p.lat, lon: p.lon, fix: { kind: "tag", way: w.id, key: "layer", value: "1" },
            message: `Мост «${label(w)}» без уровня (layer) — в 3D окажется на одной высоте с дорогой под ним`,
          });
        }
      }

      // Ловушки: участки, откуда нельзя выехать (или куда нельзя въехать) с учётом направлений.
      // randomTrips на сервере сам отбрасывает такие поездки, прогон не падает, но участок
      // выпадает из модели: машины в нём не ездят.
      const reportedDead = new Set(issues.filter((i) => i.type === "deadend").flatMap((i) => i.nodes));
      const isolatedWays = new Set(issues.filter((i) => i.type === "isolated").flatMap((i) => i.ways));
      for (const region of this._sccRegions(ways)) {
        if (region.nodes.some((id) => reportedDead.has(id))) continue;
        if (region.ways.every((id) => isolatedWays.has(id))) continue;
        if (region.nodes.some((id) => nearBoundary(nodeOf(id)))) continue;
        if (region.enter && region.exit) continue;
        if (region.nodes.some((id) => isNoExit(nodeOf(id)))) continue;
        const p = nodeOf(region.nodes[Math.floor(region.nodes.length / 2)]);
        const yard = region.ways.every((id) => isYard(this.ways.get(id)));
        const cnt = `${region.ways.length} ${plural(region.ways.length, "линия", "линии", "линий")}`;
        issues.push({
          type: "trap", severity: yard ? "warning" : "error", ways: region.ways, nodes: region.nodes, lat: p.lat, lon: p.lon,
          fix: { kind: "noexit", node: region.nodes[region.nodes.length - 1], label: "Это нормально" },
          message: (region.enter
            ? `Ловушка: на этот участок (${cnt}) можно въехать, но нельзя выехать`
            : `Ловушка: с этого участка (${cnt}) можно выехать, но въехать нельзя`) +
            (yard ? " — во дворе бывает нормой; отметьте, если так в реальности" : " — проверьте направления: участок выпадает из маршрутов"),
        });
      }

      // Склеенные перекрёстки: мост или тоннель имеет общий узел с дорогой другого уровня
      // не на своём конце — в Webots машины «спрыгивают» с моста на дорогу под ним.
      const level = (w) => {
        const l = parseInt(w.tags.layer || "0", 10) || 0;
        if (w.tags.bridge && w.tags.bridge !== "no") return Math.max(l, 1);
        if (w.tags.tunnel && w.tags.tunnel !== "no") return Math.min(l, -1);
        return l;
      };
      const allRoadish = [...this.ways.values()].filter((w) => w.tags.highway);
      const gluedSeen = new Set();
      for (const w of allRoadish) {
        const lw = level(w);
        if (!lw) continue;
        for (let i = 1; i < w.nodes.length - 1; i++) {
          const id = w.nodes[i];
          for (const o of this.waysOfNode(id)) {
            if (o === w || !o.tags.highway || level(o) === lw) continue;
            if (!isDrivable(w) && !isDrivable(o)) continue;
            const key = id;
            if (gluedSeen.has(key)) continue;
            gluedSeen.add(key);
            const n = nodeOf(id);
            issues.push({
              type: "glued", severity: "error", nodes: [id], ways: [w.id, o.id], lat: n.lat, lon: n.lon,
              fix: { kind: "unglue", node: id, way: o.id },
              message: `Склеенный перекрёсток: «${label(w)}» (уровень ${lw}) и «${label(o)}» (уровень ${level(o)}) имеют общий узел посередине моста или тоннеля`,
            });
          }
        }
      }

      // Встречные односторонние: две части одной улицы «смотрят» друг на друга
      const ends = new Map();
      for (const w of ways) {
        const d = onewayDir(w);
        if (!d || !w.tags.name) continue;
        const head = d > 0 ? w.nodes[w.nodes.length - 1] : w.nodes[0];
        const tail = d > 0 ? w.nodes[0] : w.nodes[w.nodes.length - 1];
        for (const [node, kind] of [[head, "in"], [tail, "out"]]) {
          const k = node + "|" + w.tags.name;
          if (!ends.has(k)) ends.set(k, { in: [], out: [] });
          ends.get(k)[kind].push(w.id);
        }
      }
      for (const [k, v] of ends) {
        const node = k.split("|")[0];
        if (reportedDead.has(node)) continue;
        const bad = v.in.length >= 2 && !v.out.length ? v.in : v.out.length >= 2 && !v.in.length ? v.out : null;
        if (!bad) continue;
        const touching = this.waysOfNode(node).filter((w) => isDrivable(w) && w.tags.name === k.split("|")[1]);
        if (touching.some((w) => onewayDir(w) === 0)) continue;
        const n = nodeOf(node);
        if (nearBoundary(n)) continue;
        issues.push({
          type: "direction", severity: "warning", nodes: [node], ways: bad, lat: n.lat, lon: n.lon,
          message: `Неверное направление: части улицы «${k.split("|")[1]}» односторонние навстречу друг другу`,
        });
      }

      // Светофоры на подходах: SUMO сделает отдельный светофор посреди дороги,
      // а сам перекрёсток останется нерегулируемым.
      const jDeg = (id) => this.waysOfNode(id).filter(isDrivable).length;
      const isJunction = (id) => {
        const ws = this.waysOfNode(id).filter(isDrivable);
        if (ws.length >= 2) return true;
        return ws.some((w) => { const i = w.nodes.indexOf(id); return i > 0 && i < w.nodes.length - 1 && w.nodes.indexOf(id, i + 1) > 0; });
      };
      const approachSignals = new Map(); // перекрёсток -> узлы-светофоры на подходах
      for (const n of this.nodes.values()) {
        if (n.tags.highway !== "traffic_signals" || n.tags.crossing) continue;
        if (isJunction(n.id) || jDeg(n.id) === 0) continue;
        // ближайший перекрёсток вдоль дороги в пределах 40 м
        let best = null;
        for (const w of this.waysOfNode(n.id).filter(isDrivable)) {
          const i = w.nodes.indexOf(n.id);
          for (const step of [-1, 1]) {
            let dist = 0;
            for (let k = i + step; k >= 0 && k < w.nodes.length; k += step) {
              dist += distM(nodeOf(w.nodes[k - step]), nodeOf(w.nodes[k]));
              if (dist > 40) break;
              if (isJunction(w.nodes[k])) { if (!best || dist < best.dist) best = { id: w.nodes[k], dist }; break; }
            }
          }
        }
        if (!best || nodeOf(best.id).tags.highway === "traffic_signals") continue;
        if (!approachSignals.has(best.id)) approachSignals.set(best.id, []);
        approachSignals.get(best.id).push(n.id);
      }
      for (const [jid, sigs] of approachSignals) {
        const j = nodeOf(jid);
        issues.push({
          type: "signal_approach", severity: "warning", nodes: [jid, ...sigs], lat: j.lat, lon: j.lon,
          fix: { kind: "move_signal", junction: jid, signals: sigs, label: "Перенести на перекрёсток" },
          message: `Светофор стоит на подходе к перекрёстку (${sigs.length} ${plural(sigs.length, "точка", "точки", "точек")}): SUMO сделает отдельный светофор посреди дороги, а перекрёсток останется нерегулируемым`,
        });
      }

      // Программы светофоров: каждый подъезд должен где-то получать зелёный
      for (const n of this.nodes.values()) {
        if (!n.tags["uds:tls"]) continue;
        const prog = this.tlsProgram(n.id);
        if (!prog) {
          issues.push({ type: "tls", severity: "error", nodes: [n.id], lat: n.lat, lon: n.lon, message: "Программа светофора повреждена — откройте узел и задайте заново" });
          continue;
        }
        const now = this.approaches(n.id).filter((a) => a.incoming);
        const greens = new Set(prog.phases.flatMap((p) => p.green));
        const lost = now.filter((a) => ![...greens].some((g) => angleDiff(g, a.bearing) <= 25));
        if (lost.length) {
          issues.push({
            type: "tls", severity: "error", nodes: [n.id], lat: n.lat, lon: n.lon,
            message: `Программа светофора: подъезд ${lost.map((a) => `«${a.name}» (${a.bearing}°)`).join(", ")} ни в одной фазе не получает зелёный — машины там встанут`,
          });
        }
        if (!isJunction(n.id)) {
          issues.push({ type: "tls", severity: "warning", nodes: [n.id], lat: n.lat, lon: n.lon, message: "Программа светофора задана не на перекрёстке" });
        }
      }

      const order = { error: 0, warning: 1 };
      issues.sort((a, b) => order[a.severity] - order[b.severity]);
      return issues;
    }

    /** Регионы вне главной сильно связной компоненты (по направлениям движения). */
    _sccRegions(ways) {
      const adj = new Map();
      const addEdge = (a, b) => { if (!adj.has(a)) adj.set(a, []); adj.get(a).push(b); if (!adj.has(b)) adj.set(b, []); };
      for (const w of ways) {
        const d = onewayDir(w);
        for (let i = 1; i < w.nodes.length; i++) {
          const a = w.nodes[i - 1], b = w.nodes[i];
          if (d >= 0) addEdge(a, b);
          if (d <= 0) addEdge(b, a);
        }
      }
      // Тарьян, итеративно
      let index = 0;
      const idx = new Map(), low = new Map(), onStack = new Set(), stack = [], comp = new Map();
      let compCount = 0;
      for (const start of adj.keys()) {
        if (idx.has(start)) continue;
        const work = [[start, 0]];
        idx.set(start, index); low.set(start, index); index++; stack.push(start); onStack.add(start);
        while (work.length) {
          const top = work[work.length - 1];
          const [v, i] = top;
          const nbrs = adj.get(v);
          if (i < nbrs.length) {
            top[1]++;
            const u = nbrs[i];
            if (!idx.has(u)) {
              idx.set(u, index); low.set(u, index); index++; stack.push(u); onStack.add(u);
              work.push([u, 0]);
            } else if (onStack.has(u)) low.set(v, Math.min(low.get(v), idx.get(u)));
          } else {
            work.pop();
            if (work.length) { const p = work[work.length - 1][0]; low.set(p, Math.min(low.get(p), low.get(v))); }
            if (low.get(v) === idx.get(v)) {
              let x;
              do { x = stack.pop(); onStack.delete(x); comp.set(x, compCount); } while (x !== v);
              compCount++;
            }
          }
        }
      }
      // Главная компонента — самая большая
      const sizes = new Map();
      for (const c of comp.values()) sizes.set(c, (sizes.get(c) || 0) + 1);
      let main = -1, best = 0;
      for (const [c, n] of sizes) if (n > best) { best = n; main = c; }
      // Узлы вне главной компоненты группируем по соседству (без учёта направлений)
      const outside = new Set([...comp.keys()].filter((v) => comp.get(v) !== main));
      const seen = new Set();
      const regions = [];
      const undirected = new Map();
      for (const [a, list] of adj) for (const b of list) {
        if (!undirected.has(a)) undirected.set(a, new Set());
        if (!undirected.has(b)) undirected.set(b, new Set());
        undirected.get(a).add(b); undirected.get(b).add(a);
      }
      for (const v of outside) {
        if (seen.has(v)) continue;
        const nodes = [], q = [v];
        seen.add(v);
        let enter = false, exit = false;
        while (q.length) {
          const x = q.pop();
          nodes.push(x);
          for (const u of adj.get(x) || []) if (comp.get(u) === main) exit = true;
          for (const u of undirected.get(x) || []) {
            if (outside.has(u) && !seen.has(u)) { seen.add(u); q.push(u); }
            if (comp.get(u) === main && (adj.get(u) || []).includes(x)) enter = true;
          }
        }
        const wayIds = new Set();
        for (const n of nodes) for (const w of this.waysOfNode(n)) if (isDrivable(w)) wayIds.add(w.id);
        regions.push({ nodes, ways: [...wayIds], enter, exit });
      }
      return regions;
    }

    /** Расклеить узел: линия way получает свой узел в той же точке (мост перестаёт касаться дороги). */
    unglueNode(nodeId, wayId) {
      const n = this.nodes.get(nodeId);
      const w = this.ways.get(wayId);
      const copy = this.addNode(n.lat, n.lon);
      this.setWayNodes(wayId, w.nodes.map((x) => (x === nodeId ? copy : x)));
      return copy;
    }

    /**
     * Автозаполнение пропусков. defaults: { highway: { lanes, oneLanes, maxspeed } }.
     * Возвращает список предлагаемых изменений [{way, key, value, label}] — ничего не меняет.
     */
    /**
     * Чего не хватает у дорог для машин: полосы, скорость, ширина, покрытие, название.
     * Возвращает {field: [wayId…]} и общее число дорог.
     */
    missingData() {
      const fields = { lanes: [], maxspeed: [], width: [], surface: [], name: [] };
      let total = 0;
      for (const w of this.ways.values()) {
        if (!isDrivable(w)) continue;
        total++;
        const t = w.tags;
        if (!t.lanes && !t["lanes:forward"] && !t["lanes:backward"]) fields.lanes.push(w.id);
        if (!t.maxspeed) fields.maxspeed.push(w.id);
        if (!t.width) fields.width.push(w.id);
        if (!t.surface) fields.surface.push(w.id);
        if (!t.name && !["service", "living_street"].includes(t.highway) && !(t.highway || "").endsWith("_link")) fields.name.push(w.id);
      }
      return { fields, total };
    }

    autofillPlan(defaults, keys) {
      keys = keys || ["lanes", "maxspeed"];
      const plan = [];
      for (const w of this.ways.values()) {
        if (!isDrivable(w)) continue;
        const d = defaults[w.tags.highway];
        if (!d) continue;
        const one = onewayDir(w) !== 0;
        if (keys.includes("lanes") && !w.tags.lanes && !w.tags["lanes:forward"] && !w.tags["lanes:backward"]) {
          const n = one ? d.oneLanes : d.lanes;
          if (n) plan.push({ way: w.id, key: "lanes", value: String(n), label: label(w) });
        }
        if (keys.includes("maxspeed") && !w.tags.maxspeed && d.maxspeed) {
          plan.push({ way: w.id, key: "maxspeed", value: String(d.maxspeed), label: label(w) });
        }
        // ширина проезжей части = число полос × ширина полосы по нормам
        if (keys.includes("width") && !w.tags.width && d.laneWidth) {
          const l = this.lanesOf(w);
          const n = l.total || (one ? d.oneLanes : d.lanes) || 1;
          plan.push({ way: w.id, key: "width", value: String(Math.round(n * d.laneWidth * 10) / 10), label: label(w) });
        }
        if (keys.includes("surface") && !w.tags.surface && d.surface) {
          plan.push({ way: w.id, key: "surface", value: d.surface, label: label(w) });
        }
        if (keys.includes("turns")) {
          for (const side of one ? ["forward"] : ["forward", "backward"]) {
            const cur = this.turnLanes(w, side);
            if (!cur.length || cur.some(Boolean)) continue;
            const end = (one ? onewayDir(w) > 0 : side === "forward") ? w.nodes[w.nodes.length - 1] : w.nodes[0];
            if (this.waysOfNode(end).filter(isDrivable).length < 2) continue;
            const def = this.defaultTurnLanes(w, side);
            if (def.some(Boolean)) plan.push({ way: w.id, key: "turns", side, value: def, label: label(w) });
          }
        }
      }
      return plan;
    }

    applyAutofill(plan) {
      // сначала полосы — от них зависят ширина и стрелки
      plan = [...plan].sort((a, b) => (a.key === "lanes" ? 0 : a.key === "turns" ? 2 : 1) - (b.key === "lanes" ? 0 : b.key === "turns" ? 2 : 1));
      for (const p of plan) {
        if (p.key === "turns") {
          const w = this.ways.get(p.way);
          const def = this.defaultTurnLanes(w, p.side);
          if (def.some(Boolean)) this.setTurnLanes(p.way, p.side, def);
          continue;
        }
        if (p.key === "lanes") {
          const w = this.ways.get(p.way);
          const n = parseInt(p.value, 10);
          if (onewayDir(w) !== 0) this.setLanes(p.way, n, 0);
          else if (n >= 2) this.setLanes(p.way, Math.ceil(n / 2), Math.floor(n / 2));
          else this.setTag("way", p.way, "lanes", String(n)); // одна полоса на обе стороны — без разбивки
        } else this.setTag("way", p.way, p.key, p.value);
      }
      return plan.length;
    }

    // ----- исходное состояние, разница и обмен правками -----

    /** Запомнить текущее состояние как «исходное» (после открытия файла). */
    snapshotBase(from) {
      const src = from || this;
      const pack = (m) => new Map([...m].map(([id, e]) => [id, JSON.stringify(stripSeq(e))]));
      this.base = { node: pack(src.nodes), way: pack(src.ways), relation: pack(src.relations) };
    }

    /** Что изменилось относительно исходного: [{type, id, kind: added|modified|deleted, before, after}]. */
    diff() {
      if (!this.base) return [];
      const out = [];
      for (const type of ["node", "way", "relation"]) {
        const cur = type === "node" ? this.nodes : type === "way" ? this.ways : this.relations;
        const base = this.base[type];
        for (const [id, e] of cur) {
          const now = JSON.stringify(stripSeq(e));
          const was = base.get(id);
          if (was === undefined) out.push({ type, id, kind: "added", before: null, after: JSON.parse(now) });
          else if (was !== now) out.push({ type, id, kind: "modified", before: JSON.parse(was), after: JSON.parse(now) });
        }
        for (const [id, was] of base) if (!cur.has(id)) out.push({ type, id, kind: "deleted", before: JSON.parse(was), after: null });
      }
      return out;
    }

    /** Правки в виде патча, который можно применить к другой копии того же исходного файла. */
    exportPatch(meta) {
      return { format: "uds-editor-patch", version: 1, meta: meta || {}, changes: this.diff() };
    }

    /**
     * Применить патч товарища (внутри edit). Новые объекты получают свои id, чтобы не пересечься с нашими.
     * Конфликт — объект изменён и у нас, и в патче по-разному; такие правки пропускаются.
     */
    applyPatch(patch) {
      if (!patch || patch.format !== "uds-editor-patch") throw new Error("Это не файл правок редактора");
      // Новые объекты из патча: если такой id у нас уже занят (наш собственный новый объект) — даём свой
      const remap = new Map();
      for (const c of patch.changes) {
        if (c.kind !== "added") continue;
        const taken = !!this._get(c.type, c.id) || (this.base && this.base[c.type].has(c.id));
        const id = taken ? this.newId() : c.id;
        remap.set(c.type + ":" + c.id, id);
        const num = Math.abs(Number(id));
        if (Number.isFinite(num) && num >= this.nextId) this.nextId = num + 1;
      }
      const mapId = (type, id) => remap.get(type + ":" + id) || id;
      const fixRefs = (type, e) => {
        e = clone(e);
        if (type === "way") e.nodes = e.nodes.map((n) => mapId("node", n));
        if (type === "relation") e.members = e.members.map((m) => ({ ...m, ref: mapId(m.type, m.ref) }));
        return e;
      };
      const result = { applied: 0, conflicts: [] };
      const order = { node: 0, way: 1, relation: 2 };
      const sorted = [...patch.changes].sort((a, b) =>
        (a.kind === "deleted") - (b.kind === "deleted") || order[a.type] - order[b.type]);
      for (const c of sorted) {
        const id = mapId(c.type, c.id);
        const cur = this._get(c.type, id);
        const curJson = cur ? JSON.stringify(stripSeq(cur)) : null;
        if (c.kind === "added") {
          const e = fixRefs(c.type, c.after);
          e.id = id; e.attrs = { ...e.attrs, id };
          this._touch(c.type, id);
          this._set(c.type, id, Object.assign(e, { seq: this.nextSeq++ }));
          result.applied++;
          continue;
        }
        const baseJson = this.base && this.base[c.type].get(c.id);
        if (curJson !== baseJson && curJson !== JSON.stringify(c.after)) {
          // у нас тоже правили этот объект — не затираем
          if (!(c.kind === "deleted" && cur == null)) { result.conflicts.push(c); continue; }
        }
        this._touch(c.type, id);
        if (c.kind === "deleted") this._set(c.type, id, null);
        else this._set(c.type, id, Object.assign(fixRefs(c.type, c.after), { seq: cur ? cur.seq : this.nextSeq++ }));
        result.applied++;
      }
      return result;
    }

    _bbox(ways) {
      if (this.bounds && this.bounds.minlat) {
        return { minLat: +this.bounds.minlat, maxLat: +this.bounds.maxlat, minLon: +this.bounds.minlon, maxLon: +this.bounds.maxlon };
      }
      const b = { minLat: 90, maxLat: -90, minLon: 180, maxLon: -180 };
      for (const w of ways) for (const id of w.nodes) {
        const n = this.nodes.get(id);
        b.minLat = Math.min(b.minLat, n.lat); b.maxLat = Math.max(b.maxLat, n.lat);
        b.minLon = Math.min(b.minLon, n.lon); b.maxLon = Math.max(b.maxLon, n.lon);
      }
      return b;
    }

    stats() {
      let drivable = 0, signals = 0, lanes = 0, oneway = 0;
      for (const w of this.ways.values()) {
        if (isDrivable(w)) {
          drivable++;
          if (w.tags.lanes) lanes++;
          if (onewayDir(w) !== 0) oneway++;
        }
      }
      for (const n of this.nodes.values()) if (n.tags.highway === "traffic_signals" || n.tags.crossing === "traffic_signals") signals++;
      return { nodes: this.nodes.size, ways: this.ways.size, relations: this.relations.size, drivable, signals, lanes, oneway };
    }
  }

  function stripSeq(e) {
    const { seq, ...rest } = e;
    return rest;
  }

  function label(w) {
    return w.tags.name || w.tags.ref || (w.tags.highway ? w.tags.highway + " #" + w.id : "линия #" + w.id);
  }

  function plural(n, one, few, many) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
    return many;
  }

  return { OsmDoc, DRIVABLE, isDrivable, onewayDir, distM, projector, label, plural, bearing, angleDiff, isYard, turnClass, taperProfile, densify };
});

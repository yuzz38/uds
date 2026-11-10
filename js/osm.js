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

    /** Применить автоисправление из validate(). */
    applyFix(fix) {
      if (fix.kind === "merge") return this.mergeNodes(fix.keep, fix.remove);
      if (fix.kind === "snap") return this.snapNodeToWay(fix.node, fix.way, fix.seg, fix.t);
      if (fix.kind === "connect") return this.connectAt(fix.wayA, fix.segA, fix.wayB, fix.segB, fix.lat, fix.lon);
      if (fix.kind === "tag") return this.setTag("way", fix.way, fix.key, fix.value);
      if (fix.kind === "unglue") return this.unglueNode(fix.node, fix.way);
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
        issues.push({
          type: "isolated", severity: "error", ways: c.ways, lat: p.lat, lon: p.lon,
          message: `Изолированный кусок сети: ${c.ways.length} ${plural(c.ways.length, "линия", "линии", "линий")}, ${Math.round(c.length)} м — машины сюда не попадут`,
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
          // Тупик двусторонней дороги — нормален (разворот), ошибка только для односторонних
          const touching = this.waysOfNode(id).filter(isDrivable);
          if (!touching.some((w) => onewayDir(w) !== 0)) continue;
          issues.push({
            type: "deadend", severity: "error", nodes: [id], ways: touching.map((w) => w.id), lat: n.lat, lon: n.lon,
            message: o === 0 ? "Односторонний тупик: въехать можно, выехать нельзя" : "Односторонний тупик: выехать можно, въехать нельзя",
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
      // На сервере SUMO пускает 100 машин и требует, чтобы доехали все — ловушка роняет прогон.
      const reportedDead = new Set(issues.filter((i) => i.type === "deadend").flatMap((i) => i.nodes));
      const isolatedWays = new Set(issues.filter((i) => i.type === "isolated").flatMap((i) => i.ways));
      for (const region of this._sccRegions(ways)) {
        if (region.nodes.some((id) => reportedDead.has(id))) continue;
        if (region.ways.every((id) => isolatedWays.has(id))) continue;
        if (region.nodes.some((id) => nearBoundary(nodeOf(id)))) continue;
        if (region.enter && region.exit) continue;
        const p = nodeOf(region.nodes[Math.floor(region.nodes.length / 2)]);
        issues.push({
          type: "trap", severity: "error", ways: region.ways, nodes: region.nodes, lat: p.lat, lon: p.lon,
          message: region.enter
            ? `Ловушка: на этот участок (${region.ways.length} ${plural(region.ways.length, "линия", "линии", "линий")}) можно въехать, но нельзя выехать — машины в SUMO не доедут`
            : `Ловушка: с этого участка (${region.ways.length} ${plural(region.ways.length, "линия", "линии", "линий")}) можно выехать, но въехать нельзя`,
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
      }
      return plan;
    }

    applyAutofill(plan) {
      for (const p of plan) {
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

  return { OsmDoc, DRIVABLE, isDrivable, onewayDir, distM, projector, label, plural };
});

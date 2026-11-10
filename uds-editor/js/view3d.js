/*
 * 3D — проверка уровней.
 *
 * Зачем: на плоской карте мост, дорога под ним и подземный переход лежат друг на друге.
 * Здесь видно, поднят ли мост, не склеен ли он с дорогой внизу, плавно ли дорога въезжает
 * на путепровод. Именно это потом проверяет Webots на сервере.
 *
 * Высоты считаются так же, как в контейнере Webots (webots/road_elevation.py):
 * уровень layer = 5 м, мост или тоннель держит уровень по всей длине, примыкающие дороги
 * плавно выходят на него на протяжении 100 м.
 *
 * Строится не весь город, а место вокруг выбранной дороги или проблемы (радиус 150–400 м).
 */
(function (root) {
  "use strict";
  const { isDrivable, onewayDir, projector, distM } = root.OSM;

  const CLEARANCE_M = 5;
  const RAMP_M = 100;
  const LANE_M = 3.2;
  const DEFAULT_LANES = { motorway: 4, trunk: 4, primary: 4, secondary: 2, tertiary: 2, unclassified: 2, residential: 2, living_street: 1, service: 1, road: 2 };

  const COLORS = {
    asphalt: 0x3b4046, asphaltUnder: 0x2b2f34, asphaltBridge: 0x454b52,
    deck: 0x9aa1a8, pillar: 0x8d939a, railing: 0xd0d4d8,
    white: 0xf1f3f5, yellow: 0xfcc419,
    foot: 0xd9cdb3, footBridge: 0xe64980, footTunnel: 0x9c36b5,
    rail: 0x5c4b3b, railBed: 0x868e96,
    ground: 0x8fa47a, building: 0xe9ecef,
    selected: 0xf2b705, issue: 0xe03131, warn: 0xf76707,
  };

  function level(w) {
    const l = parseInt(w.tags.layer || "0", 10) || 0;
    if (w.tags.bridge && w.tags.bridge !== "no") return Math.max(l, 1);
    if (w.tags.tunnel && w.tags.tunnel !== "no" && w.tags.tunnel !== "building_passage") return Math.min(l, -1);
    return l;
  }

  function lanesSplit(doc, w) {
    const l = doc.lanesOf(w);
    const hw = w.tags.highway || "";
    const base = DEFAULT_LANES[hw.replace("_link", "")] || 1;
    if (onewayDir(w) !== 0) return { f: l.total || (hw.endsWith("_link") ? 1 : Math.max(1, Math.ceil(base / 2))), b: 0 };
    let f = l.forward, b = l.backward;
    if (f == null || b == null) {
      const total = l.total || base;
      f = Math.max(1, Math.ceil(total / 2));
      b = Math.max(total - f, total > 1 ? 1 : 0);
    }
    return { f, b };
  }

  function roadWidth(doc, w) {
    const width = parseFloat(w.tags.width);
    const { f, b } = lanesSplit(doc, w);
    return Number.isFinite(width) && width > 0 ? width : Math.max(f + b, 1) * LANE_M;
  }

  /** Высоты узлов: уровни мостов/тоннелей и пандусы по примыкающим дорогам. */
  function computeHeights(doc, ways) {
    const h = new Map();
    const adj = new Map();
    const link = (a, b, len) => { if (!adj.has(a)) adj.set(a, []); adj.get(a).push([b, len]); };
    for (const w of ways) {
      const lv = level(w);
      for (let i = 0; i < w.nodes.length; i++) {
        const id = w.nodes[i];
        if (lv) {
          const target = lv * CLEARANCE_M, cur = h.get(id);
          if (cur === undefined || Math.abs(target) > Math.abs(cur)) h.set(id, target);
        }
        if (i && !lv) {
          const a = w.nodes[i - 1];
          const len = distM(doc.nodes.get(a), doc.nodes.get(id));
          link(a, id, len); link(id, a, len);
        }
      }
    }
    const slope = CLEARANCE_M / RAMP_M;
    const queue = [...h.entries()].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
    while (queue.length) {
      const [id, height] = queue.shift();
      if (h.get(id) !== height) continue;
      for (const [to, len] of adj.get(id) || []) {
        const cand = Math.sign(height) * Math.max(0, Math.abs(height) - len * slope);
        const cur = h.get(to) || 0;
        if (Math.abs(cand) > Math.abs(cur) + 0.01) {
          h.set(to, cand);
          let k = queue.findIndex((q) => Math.abs(q[1]) < Math.abs(cand));
          if (k < 0) k = queue.length;
          queue.splice(k, 0, [to, cand]);
        }
      }
    }
    return h;
  }

  // ---------- геометрия ----------

  /** Нормали со скосом в вершинах ломаной — чтобы лента не рвалась на поворотах. */
  function miters(pts) {
    const norm = (q, p) => {
      const dx = q.x - p.x, dz = q.z - p.z, l = Math.hypot(dx, dz) || 1;
      return { x: -dz / l, z: dx / l };
    };
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const n1 = i > 0 ? norm(pts[i], pts[i - 1]) : norm(pts[1], pts[0]);
      const n2 = i < pts.length - 1 ? norm(pts[i + 1], pts[i]) : n1;
      let mx = n1.x + n2.x, mz = n1.z + n2.z;
      const ml = Math.hypot(mx, mz) || 1;
      mx /= ml; mz /= ml;
      const k = Math.min(1 / Math.max(mx * n1.x + mz * n1.z, 0.35), 1.6);
      out.push({ x: mx * k, z: mz * k });
    }
    return out;
  }

  const lerp = (p, q, t) => ({ x: p.x + (q.x - p.x) * t, z: p.z + (q.z - p.z) * t, y: p.y + (q.y - p.y) * t });
  const lerpM = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
  const at = (p, m, off, lift) => [p.x + m.x * off, p.y + lift, p.z + m.z * off];
  const ov = (off, i) => (Array.isArray(off) ? off[i] : off);
  const lerpOff = (off, i, j, t) => ov(off, i) + (ov(off, j) - ov(off, i)) * t;

  class Builder {
    constructor() { this.pos = []; this.col = []; this.owner = []; }
    tri(a, b, c, color, owner) {
      this.pos.push(...a, ...b, ...c);
      for (let i = 0; i < 3; i++) this.col.push(color.r, color.g, color.b);
      this.owner.push(owner || null);
    }
    quad(a, b, c, d, color, owner) { this.tri(a, b, c, color, owner); this.tri(a, c, d, color, owner); }
    box(x, y, z, sx, sy, sz, color) {
      if (sy <= 0) return;
      const X = [x - sx / 2, x + sx / 2], Y = [y, y + sy], Z = [z - sz / 2, z + sz / 2];
      const v = (i, j, k) => [X[i], Y[j], Z[k]];
      this.quad(v(0, 0, 0), v(1, 0, 0), v(1, 1, 0), v(0, 1, 0), color);
      this.quad(v(1, 0, 1), v(0, 0, 1), v(0, 1, 1), v(1, 1, 1), color);
      this.quad(v(0, 0, 1), v(0, 0, 0), v(0, 1, 0), v(0, 1, 1), color);
      this.quad(v(1, 0, 0), v(1, 0, 1), v(1, 1, 1), v(1, 1, 0), color);
      this.quad(v(0, 1, 0), v(1, 1, 0), v(1, 1, 1), v(0, 1, 1), color);
    }
    /** Лента между смещениями off1 и off2 (метры влево от оси), на высоте узла + lift. */
    band(pts, mit, off1, off2, lift, color, owner, dash) {
      let acc = 0;
      for (let i = 1; i < pts.length; i++) {
        const p = pts[i - 1], q = pts[i], m1 = mit[i - 1], m2 = mit[i];
        const len = Math.hypot(q.x - p.x, q.z - p.z);
        if (!dash) {
          this.quad(at(p, m1, ov(off1, i - 1), lift), at(p, m1, ov(off2, i - 1), lift), at(q, m2, ov(off2, i), lift), at(q, m2, ov(off1, i), lift), color, owner);
          continue;
        }
        // прерывистая: штрих 3 м, промежуток 6 м
        let s = 0;
        while (s < len) {
          const phase = (acc + s) % 9;
          const segEnd = Math.min(len, s + (phase < 3 ? 3 - phase : 9 - phase));
          if (phase < 3) {
            const t1 = s / len, t2 = segEnd / len;
            const P = lerp(p, q, t1), Q = lerp(p, q, t2), M1 = lerpM(m1, m2, t1), M2 = lerpM(m1, m2, t2);
            this.quad(at(P, M1, lerpOff(off1, i - 1, i, t1), lift), at(P, M1, lerpOff(off2, i - 1, i, t1), lift),
              at(Q, M2, lerpOff(off2, i - 1, i, t2), lift), at(Q, M2, lerpOff(off1, i - 1, i, t2), lift), color, owner);
          }
          s = segEnd + 1e-6;
        }
        acc += len;
      }
    }
    /** Вертикальная стенка вдоль смещения off, от y+lift-depth до y+lift — только где поднято выше minHeight. */
    wall(pts, mit, off, lift, depth, color, minHeight) {
      for (let i = 1; i < pts.length; i++) {
        const p = pts[i - 1], q = pts[i];
        if (minHeight != null && Math.max(p.y, q.y) < minHeight) continue;
        const a = at(p, mit[i - 1], ov(off, i - 1), lift), b = at(q, mit[i], ov(off, i), lift);
        this.quad(a, b, [b[0], b[1] - depth, b[2]], [a[0], a[1] - depth, a[2]], color);
      }
    }
    mesh(THREE, opts) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
      g.setAttribute("color", new THREE.Float32BufferAttribute(this.col, 3));
      g.computeVertexNormals();
      const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial(Object.assign({ vertexColors: true, side: THREE.DoubleSide }, opts || {})));
      m.userData.owner = this.owner;
      return m;
    }
  }

  function textSprite(THREE, text, color) {
    const c = document.createElement("canvas");
    const ctx = c.getContext("2d");
    const font = "600 28px Segoe UI, system-ui, sans-serif";
    ctx.font = font;
    const w = Math.ceil(ctx.measureText(text).width) + 24;
    c.width = w; c.height = 44;
    ctx.font = font;
    ctx.fillStyle = color || "rgba(33,37,41,.88)";
    ctx.fillRect(0, 0, w, 44);
    ctx.fillStyle = "#fff";
    ctx.textBaseline = "middle";
    ctx.fillText(text, 12, 23);
    const tex = new THREE.CanvasTexture(c);
    tex.minFilter = THREE.LinearFilter;
    // постоянный размер на экране, независимо от расстояния до камеры
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true, sizeAttenuation: false }));
    const k = 0.026;
    s.scale.set((k * w) / 44, k, 1);
    s.renderOrder = 10;
    return s;
  }

  // ---------- сцена ----------

  function build(THREE, doc, opts) {
    const { center, radius, selectedWay, issues } = opts;
    const proj = projector(center.lat);
    const c0 = proj(center);
    const P = (n, y) => { const p = proj(n); return { x: p.x - c0.x, z: -(p.y - c0.y), y: y || 0 }; };
    const near = (n) => distM(n, center) <= radius;
    const ways = [...doc.ways.values()].filter((w) => w.nodes.some((id) => { const n = doc.nodes.get(id); return n && near(n); }));
    const heights = computeHeights(doc, [...doc.ways.values()].filter((w) => w.tags.highway &&
      w.nodes.some((id) => { const n = doc.nodes.get(id); return n && distM(n, center) <= radius + RAMP_M * 2; })));
    const H = (id) => heights.get(id) || 0;
    const C = (hex) => new THREE.Color(hex);

    const group = new THREE.Group();
    const pickables = [];
    const summary = { roads: 0, bridges: 0, tunnels: 0, buildings: 0, issues: 0 };

    // Земля полупрозрачная — тоннели и выемки видны сквозь неё
    const ground = new THREE.Mesh(new THREE.CircleGeometry(radius * 1.15, 64),
      new THREE.MeshLambertMaterial({ color: COLORS.ground, transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide }));
    ground.rotation.x = -Math.PI / 2;
    group.add(ground);
    const grid = new THREE.PolarGridHelper(radius * 1.15, 8, 6, 64, 0x6b7d5a, 0x6b7d5a);
    grid.material.transparent = true; grid.material.opacity = 0.2;
    group.add(grid);

    const roads = new Builder(), marks = new Builder(), struct = new Builder(), foot = new Builder(), rails = new Builder();
    const labels = [];
    const white = C(COLORS.white), yellow = C(COLORS.yellow);

    // ---- дороги для машин ----
    for (const w of ways.filter(isDrivable)) {
      const raw = w.nodes.map((id) => P(doc.nodes.get(id), H(id)));
      if (raw.length < 2) continue;
      const lv = level(w);
      const cs = doc.crossSection(w);
      const { f, b, laneW } = cs;
      const width = cs.width, half = width / 2;
      // плавное сужение к продолжению дороги — как в 2D
      const dn = root.OSM.densify(raw, 25, 4, "x", "z");
      const pts = dn.pts;
      const taper = Math.min(25, dn.total * 0.45);
      const prof = dn.dist.map((s) => root.OSM.taperProfile(s, dn.total - s, cs, doc.endProfile(w, false), doc.endProfile(w, true), taper));
      const L_ = prof.map((p) => p.left), R_ = prof.map((p) => p.right), A_ = prof.map((p) => p.axis);
      const mit = miters(pts);
      const add = (arr, d) => arr.map((v) => v + d);
      roads.band(pts, mit, L_, R_, 0.03, C(lv > 0 ? COLORS.asphaltBridge : lv < 0 ? COLORS.asphaltUnder : COLORS.asphalt), w.id);
      summary.roads++;
      if (lv > 0) summary.bridges++;
      if (lv < 0) summary.tunnels++;

      // разметка: кромки, двойная осевая у двусторонних, прерывистые между полосами
      marks.band(pts, mit, add(L_, -0.25), add(L_, -0.4), 0.07, white);
      marks.band(pts, mit, add(R_, 0.4), add(R_, 0.25), 0.07, white);
      if (b > 0) {
        marks.band(pts, mit, add(A_, 0.22), add(A_, 0.08), 0.07, yellow);
        marks.band(pts, mit, add(A_, -0.08), add(A_, -0.22), 0.07, yellow);
        for (let k = 1; k < b; k++) { const o = A_.map((a, i) => Math.min(a + k * laneW, L_[i] - 0.3)); marks.band(pts, mit, add(o, 0.07), add(o, -0.07), 0.07, white, null, true); }
        for (let k = 1; k < f; k++) { const o = A_.map((a, i) => Math.max(a - k * laneW, R_[i] + 0.3)); marks.band(pts, mit, add(o, 0.07), add(o, -0.07), 0.07, white, null, true); }
      } else {
        for (let k = 1; k < f; k++) { const o = L_.map((l, i) => Math.max(l - k * laneW, R_[i] + 0.3)); marks.band(pts, mit, add(o, 0.07), add(o, -0.07), 0.07, white, null, true); }
        // стрелки направления на односторонних
        const dir = onewayDir(w) < 0 ? -1 : 1;
        for (let i = 1; i < pts.length; i++) {
          const p = pts[i - 1], q = pts[i];
          const len = Math.hypot(q.x - p.x, q.z - p.z);
          for (let s = 10; s < len - 4; s += 30) {
            const m = lerp(p, q, s / len);
            const ux = ((q.x - p.x) / len) * dir, uz = ((q.z - p.z) / len) * dir;
            const nx = -uz, nz = ux, y = m.y + 0.08;
            marks.tri([m.x + ux * 2.2, y, m.z + uz * 2.2], [m.x - ux * 1.2 + nx * 1.1, y, m.z - uz * 1.2 + nz * 1.1], [m.x - ux * 1.2 - nx * 1.1, y, m.z - uz * 1.2 - nz * 1.1], white);
          }
        }
      }

      // мост: плита, борта, ограждение, опоры — там, где дорога поднята
      if (pts.some((p) => p.y > 0.5)) {
        const deck = C(COLORS.deck), rail = C(COLORS.railing), pil = C(COLORS.pillar);
        struct.wall(pts, mit, add(L_, 0.4), 0.03, 1.1, deck, 0.5);
        struct.wall(pts, mit, add(R_, -0.4), 0.03, 1.1, deck, 0.5);
        struct.band(pts.map((p) => ({ ...p, y: p.y - 1.07 })), mit, add(L_, 0.4), add(R_, -0.4), 0, deck);
        struct.wall(pts, mit, add(L_, 0.4), 1.1, 1.07, rail, 0.5);
        struct.wall(pts, mit, add(R_, -0.4), 1.1, 1.07, rail, 0.5);
        for (let i = 1; i < pts.length; i++) {
          const p = pts[i - 1], q = pts[i], len = Math.hypot(q.x - p.x, q.z - p.z);
          for (let s = 0; s < len; s += 24) {
            const m = lerp(p, q, s / len);
            if (m.y > 2) struct.box(m.x, 0, m.z, Math.min(width * 0.5, 6), m.y - 1.1, 1.4, pil);
          }
        }
      }
      // выемка тоннеля: стенки до уровня земли
      if (pts.some((p) => p.y < -0.5)) {
        const wallC = C(0x7b8087);
        for (const off of [half + 0.5, -half - 0.5]) {
          for (let i = 1; i < pts.length; i++) {
            const p = pts[i - 1], q = pts[i];
            if (p.y > -0.5 && q.y > -0.5) continue;
            const a = at(p, mit[i - 1], off, 0), bq = at(q, mit[i], off, 0);
            struct.quad([a[0], 0, a[2]], [bq[0], 0, bq[2]], bq, a, wallC);
          }
        }
      }
      if (lv) {
        labels.push({ p: pts[Math.floor(pts.length / 2)], key: (w.tags.name || w.tags.highway) + lv,
          text: `${w.tags.name || w.tags.highway} · ${lv > 0 ? "мост" : "тоннель"} ${lv > 0 ? "+" : "−"}${Math.abs(lv) * CLEARANCE_M} м`,
          color: lv > 0 ? "rgba(95,61,196,.92)" : "rgba(52,58,64,.92)" });
      }
    }

    // ---- пешеходные пути ----
    for (const w of ways.filter((x) => x.tags.highway && !isDrivable(x) && x.tags.area !== "yes")) {
      const pts = w.nodes.map((id) => P(doc.nodes.get(id), H(id)));
      if (pts.length < 2) continue;
      const mit = miters(pts);
      const lv = level(w);
      const wd = lv ? 3 : (w.tags.highway === "steps" ? 2.5 : 2);
      foot.band(pts, mit, wd / 2, -wd / 2, lv ? 0.04 : 0.05, C(lv > 0 ? COLORS.footBridge : lv < 0 ? COLORS.footTunnel : COLORS.foot), w.id);
      if (pts.some((p) => p.y > 0.5)) {
        struct.wall(pts, mit, wd / 2, 1.1, 1.1, C(COLORS.railing), 0.5);
        struct.wall(pts, mit, -wd / 2, 1.1, 1.1, C(COLORS.railing), 0.5);
        for (const p of pts) if (p.y > 2) struct.box(p.x, 0, p.z, 0.7, p.y - 0.2, 0.7, C(COLORS.pillar));
      }
      if (lv > 0 && w.tags.highway !== "steps") labels.push({ p: pts[Math.floor(pts.length / 2)], key: "fb", text: `пешеходный мост +${lv * CLEARANCE_M} м`, color: "rgba(230,73,128,.92)" });
      if (lv < 0 && w.tags.highway !== "steps") labels.push({ p: pts[Math.floor(pts.length / 2)], key: "ft", text: `подземный переход −${-lv * CLEARANCE_M} м`, color: "rgba(156,54,181,.92)" });
    }

    // ---- рельсы ----
    for (const w of ways.filter((x) => ["rail", "tram", "light_rail", "subway"].includes(x.tags.railway))) {
      const pts = w.nodes.map((id) => P(doc.nodes.get(id), H(id)));
      if (pts.length < 2) continue;
      const mit = miters(pts);
      rails.band(pts, mit, 1.6, -1.6, 0.02, C(COLORS.railBed), w.id);
      rails.band(pts, mit, 0.8, 0.68, 0.12, C(COLORS.rail));
      rails.band(pts, mit, -0.68, -0.8, 0.12, C(COLORS.rail));
    }

    for (const b of [roads, marks, struct, foot, rails]) {
      if (!b.pos.length) continue;
      const m = b.mesh(THREE, b === marks ? { polygonOffset: true, polygonOffsetFactor: -2 } : {});
      group.add(m);
      if (b === roads || b === foot || b === rails) pickables.push(m);
    }

    // ---- выбранная дорога: жёлтая рамка ----
    const sel = selectedWay && doc.ways.get(selectedWay);
    if (sel) {
      const pts = sel.nodes.map((id) => P(doc.nodes.get(id), H(id)));
      const mit = miters(pts);
      const hb = new Builder();
      const half = isDrivable(sel) ? roadWidth(doc, sel) / 2 + 0.6 : 2;
      hb.band(pts, mit, half, half - 0.6, 0.15, C(COLORS.selected));
      hb.band(pts, mit, -half + 0.6, -half, 0.15, C(COLORS.selected));
      group.add(hb.mesh(THREE));
    }

    // ---- здания (полупрозрачные, чтобы не заслоняли дороги) ----
    if (opts.buildings) {
      const bb = new Builder();
      for (const w of ways) {
        if (!w.tags.building || w.nodes.length < 4 || w.nodes[0] !== w.nodes[w.nodes.length - 1]) continue;
        const ring = w.nodes.slice(0, -1).map((id) => P(doc.nodes.get(id)));
        let height = parseFloat(w.tags.height);
        if (!Number.isFinite(height)) height = (parseInt(w.tags["building:levels"], 10) || 3) * 3;
        const col = C(COLORS.building);
        for (let i = 0; i < ring.length; i++) {
          const a = ring[i], b = ring[(i + 1) % ring.length];
          bb.quad([a.x, 0, a.z], [b.x, 0, b.z], [b.x, height, b.z], [a.x, height, a.z], col);
        }
        for (const [i, j, k] of THREE.ShapeUtils.triangulateShape(ring.map((p) => new THREE.Vector2(p.x, p.z)), [])) {
          bb.tri([ring[i].x, height, ring[i].z], [ring[j].x, height, ring[j].z], [ring[k].x, height, ring[k].z], col);
        }
        summary.buildings++;
      }
      if (bb.pos.length) group.add(bb.mesh(THREE, { transparent: true, opacity: 0.35, depthWrite: false }));
    }

    // ---- светофоры ----
    const tl = new Builder();
    for (const n of doc.nodes.values()) {
      if ((n.tags.highway !== "traffic_signals" && n.tags.crossing !== "traffic_signals") || !near(n)) continue;
      const p = P(n, H(n.id));
      tl.box(p.x + 2, p.y, p.z + 2, 0.2, 4.5, 0.2, C(0x343a40));
      tl.box(p.x + 2, p.y + 4.5, p.z + 2, 0.5, 1.4, 0.5, C(0x212529));
      tl.box(p.x + 2, p.y + 5.45, p.z + 2.26, 0.3, 0.3, 0.05, C(0xff3b30));
      tl.box(p.x + 2, p.y + 4.95, p.z + 2.26, 0.3, 0.3, 0.05, C(0xffd43b));
      tl.box(p.x + 2, p.y + 4.5, p.z + 2.26, 0.3, 0.3, 0.05, C(0x51cf66));
    }
    if (tl.pos.length) group.add(tl.mesh(THREE));

    // ---- проблемы: штырь через все затронутые уровни + кольцо + подпись ----
    const titles = { glued: "склейка уровней", bridge: "мост без уровня", gap: "разрыв", deadend: "тупик", trap: "ловушка",
      crossing: "пересечение без узла", isolated: "изолированный кусок", direction: "направление" };
    for (const is of issues || []) {
      if (distM(is, center) > radius) continue;
      summary.issues++;
      const p = P(is, 0);
      const lvls = (is.ways || []).map((id) => { const w = doc.ways.get(id); return w ? level(w) * CLEARANCE_M : 0; });
      const hs = (is.nodes || []).map(H);
      const y = hs.length ? Math.max(...hs) : 0;
      const lo = Math.min(0, y, ...lvls), hi = Math.max(0, y, ...lvls) + 4;
      const color = is.severity === "error" ? COLORS.issue : COLORS.warn;
      const pin = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, hi - lo, 10), new THREE.MeshBasicMaterial({ color }));
      pin.position.set(p.x, (hi + lo) / 2, p.z);
      group.add(pin);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(3, 0.3, 8, 32), new THREE.MeshBasicMaterial({ color }));
      ring.rotation.x = Math.PI / 2;
      ring.position.set(p.x, y + 0.3, p.z);
      group.add(ring);
      labels.push({ p: { x: p.x, y: hi - 4, z: p.z }, force: true, key: "i" + summary.issues,
        text: "⚠ " + (titles[is.type] || is.type), color: is.severity === "error" ? "rgba(201,42,42,.95)" : "rgba(230,119,0,.95)" });
    }

    // ---- подписи: проблемы всегда, остальные — по одной на улицу, не больше 12 ----
    const seen = new Set();
    let shown = 0;
    for (const l of labels.sort((a, b) => (b.force ? 1 : 0) - (a.force ? 1 : 0))) {
      if (!l.force && (seen.has(l.key) || shown >= 12)) continue;
      seen.add(l.key);
      if (!l.force) shown++;
      const s = textSprite(THREE, l.text, l.color);
      s.position.set(l.p.x, l.p.y + (l.force ? 12 : 5), l.p.z);
      group.add(s);
    }
    const north = textSprite(THREE, "С ↑", "rgba(33,37,41,.75)");
    north.position.set(0, 2, -radius * 1.08);
    group.add(north);

    return { group, pickables, summary };
  }

  // ---------- окно ----------

  class View3D {
    constructor(host) { this.host = host; this.renderer = null; }

    get isOpen() { return !!this.renderer; }

    /** opts: {center:{lat,lon}, radius, selectedWay, issues, buildings, keepCamera} */
    open(doc, opts) {
      const THREE = root.THREE;
      if (!THREE) throw new Error("three.js не загружен");
      const keep = !!(this.renderer && opts.keepCamera);
      if (!keep) this.close();
      if (!this.renderer) this._init(THREE);
      if (this.content) {
        this.scene.remove(this.content);
        this._dispose(this.content);
      }
      const built = build(THREE, doc, opts);
      this.content = built.group;
      this.pickables = built.pickables;
      this.scene.add(built.group);
      this.radius = opts.radius;
      if (!keep) this.resetView();
      return built.summary;
    }

    _init(THREE) {
      const w = this.host.clientWidth || 800, h = this.host.clientHeight || 600;
      const renderer = new THREE.WebGLRenderer({ antialias: true });
      renderer.setPixelRatio(Math.min(root.devicePixelRatio || 1, 2));
      renderer.setSize(w, h);
      this.host.append(renderer.domElement);
      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0xd8e4ee);
      scene.add(new THREE.HemisphereLight(0xffffff, 0x6f7f60, 0.9));
      const sun = new THREE.DirectionalLight(0xffffff, 0.55);
      sun.position.set(-200, 400, 150);
      scene.add(sun);
      const camera = new THREE.PerspectiveCamera(45, w / h, 0.5, 6000);
      const controls = new THREE.OrbitControls(camera, renderer.domElement);
      controls.maxPolarAngle = Math.PI / 2 + 0.3; // можно заглянуть под землю — к тоннелям
      controls.enableDamping = true;
      Object.assign(this, { renderer, scene, camera, controls });
      const loop = () => { this.frame = requestAnimationFrame(loop); controls.update(); renderer.render(scene, camera); };
      loop();
      this.onResize = () => {
        const W = this.host.clientWidth, Hh = this.host.clientHeight;
        if (!W || !Hh) return;
        camera.aspect = W / Hh; camera.updateProjectionMatrix(); renderer.setSize(W, Hh);
      };
      root.addEventListener("resize", this.onResize);
      // клик (без перетаскивания) по дороге — выбрать её на карте
      const ray = new THREE.Raycaster();
      let down = null;
      renderer.domElement.addEventListener("pointerdown", (e) => { down = [e.clientX, e.clientY]; });
      renderer.domElement.addEventListener("pointerup", (e) => {
        if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4 || !this.onPick) return;
        const r = renderer.domElement.getBoundingClientRect();
        ray.setFromCamera({ x: ((e.clientX - r.left) / r.width) * 2 - 1, y: -((e.clientY - r.top) / r.height) * 2 + 1 }, camera);
        const hit = ray.intersectObjects(this.pickables || [], false)[0];
        if (hit) { const id = hit.object.userData.owner[hit.faceIndex]; if (id) this.onPick(id); }
      });
    }

    resetView(top) {
      const r = this.radius || 250;
      if (top) this.camera.position.set(0, r * 2.1, 0.01);
      else this.camera.position.set(-r * 0.5, r * 0.55, r * 0.8);
      this.controls.target.set(0, 0, 0);
      this.controls.update();
    }

    _dispose(obj) {
      obj.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); }
      });
    }

    close() {
      if (!this.renderer) return;
      cancelAnimationFrame(this.frame);
      root.removeEventListener("resize", this.onResize);
      this._dispose(this.scene);
      this.renderer.dispose();
      this.renderer.domElement.remove();
      this.renderer = null;
      this.content = null;
    }
  }

  root.View3D = View3D;
  root.View3DInternals = { computeHeights, roadWidth, level, CLEARANCE_M, RAMP_M };
})(typeof self !== "undefined" ? self : this);

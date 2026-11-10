#!/usr/bin/env python3
"""
Программы светофоров из редактора ГрафУДС → программа SUMO (tlLogic).

Редактор хранит программу на узле перекрёстка в теге uds:tls (JSON):
    {"v": 1, "offset": 0,
     "approaches": [{"bearing": 12, "name": "ул. Лермонтова"}, ...],
     "phases": [{"name": "Лермонтова", "green": [12, 192], "dur": 30, "yellow": 3, "red": 2}, ...]}
bearing — направление ОТ перекрёстка К подъезду (откуда едут машины), градусы от севера по часовой.

SUMO нумерует сигналы светофора по «связям» (connection linkIndex) после netconvert, поэтому
перевод делается по готовой сети: каждая связь относится к подъезду по направлению её входящего
ребра, и в каждой фазе получает зелёный, если подъезд в списке green.

Использование:
    python osm_tls_to_sumo.py map.osm network.net.xml -o uds.tll.xml
    netconvert -s network.net.xml --tllogic-files uds.tll.xml -o network.net.xml

Для сервера проверки это две строки в sumo/pipeline.py после fix_access.py (см. docs).
"""
import argparse
import json
import math
import sys
import xml.etree.ElementTree as ET

MATCH_DEG = 40


def _bearing(dx, dy):
    return (math.degrees(math.atan2(dx, dy)) + 360) % 360


def _diff(a, b):
    d = abs(a - b) % 360
    return min(d, 360 - d)


def _point_back(shape, dist):
    """Точка на ломаной в dist метрах от её конца (назад от стоп-линии)."""
    pts = [tuple(map(float, p.split(","))) for p in shape.split()]
    left = dist
    for i in range(len(pts) - 1, 0, -1):
        (x1, y1), (x2, y2) = pts[i - 1], pts[i]
        seg = math.hypot(x2 - x1, y2 - y1)
        if seg >= left and seg > 0:
            t = left / seg
            return x2 + (x1 - x2) * t, y2 + (y1 - y2) * t
        left -= seg
    return pts[0]


def read_programs(osm_path):
    progs = {}
    for node in ET.parse(osm_path).getroot().findall("node"):
        for tag in node.findall("tag"):
            if tag.get("k") == "uds:tls":
                try:
                    progs[node.get("id")] = json.loads(tag.get("v"))
                except json.JSONDecodeError:
                    print(f"узел {node.get('id')}: тег uds:tls не читается", file=sys.stderr)
    return progs


def build_tll(osm_path, net_path):
    """Возвращает (xml-текст или None, список строк отчёта)."""
    progs = read_programs(osm_path)
    report = []
    if not progs:
        return None, ["программ светофоров в файле нет — SUMO построит их сам"]
    net = ET.parse(net_path).getroot()
    junctions = {j.get("id"): j for j in net.findall("junction")}
    lanes = {}
    for e in net.findall("edge"):
        if e.get("function") == "internal":
            continue
        for ln in e.findall("lane"):
            lanes[e.get("id")] = ln.get("shape")
            break
    tl_of_junction = {}
    for j in junctions.values():
        if j.get("type") in ("traffic_light", "traffic_light_right_on_red", "traffic_light_unregulated"):
            tl_of_junction[j.get("id")] = j.get("id")
    # light-узлы могут быть объединены в кластер: id вида cluster_A_B или joinedS_...
    def find_tl(node_id):
        if node_id in tl_of_junction:
            return node_id
        for jid in tl_of_junction:
            parts = jid.replace("cluster_", "").replace("joinedS_", "").replace("GS_", "").split("_")
            if node_id in parts:
                return jid
        return None

    conns = {}
    for c in net.findall("connection"):
        if c.get("tl"):
            conns.setdefault(c.get("tl"), []).append(c)
    existing = {t.get("id"): t for t in net.findall("tlLogic")}

    out = ['<?xml version="1.0" encoding="UTF-8"?>', "<tlLogics>"]
    applied = 0
    for node_id, prog in progs.items():
        tl = find_tl(node_id)
        if not tl or tl not in existing:
            report.append(f"узел {node_id}: в сети SUMO нет светофора на этом перекрёстке — программа пропущена "
                          f"(поставьте светофор на узел перекрёстка)")
            continue
        j = junctions[tl]
        jx, jy = float(j.get("x")), float(j.get("y"))
        links = sorted(conns.get(tl, []), key=lambda c: int(c.get("linkIndex")))
        n = max((int(c.get("linkIndex")) for c in links), default=-1) + 1
        approaches = [a["bearing"] for a in prog.get("approaches", [])]
        link_appr = [None] * n
        for c in links:
            shape = lanes.get(c.get("from"))
            if not shape:
                continue
            px, py = _point_back(shape, 15)
            b = _bearing(px - jx, py - jy)
            best = min(approaches, key=lambda a: _diff(a, b)) if approaches else None
            if best is not None and _diff(best, b) > MATCH_DEG:
                report.append(f"узел {node_id}: подъезд с направления {round(b)}° не найден в программе, "
                              f"взят ближайший {best}°")
            link_appr[int(c.get("linkIndex"))] = (best, c.get("dir"))
        phases = [p for p in prog.get("phases", []) if p.get("dur", 0) > 0]
        if not phases:
            report.append(f"узел {node_id}: в программе нет фаз — пропущено")
            continue

        def green_state(ph):
            g = set(ph.get("green", []))
            st = []
            for la in link_appr:
                if not la or la[0] not in g:
                    st.append("r")
                    continue
                appr, d = la
                # левый поворот и разворот при одновременном зелёном встречному — уступая (g)
                opposing = any(_diff(appr, other) > 135 for other in g if other != appr)
                st.append("g" if d in ("l", "L", "t") and opposing else "G")
            return "".join(st)

        states = [green_state(p) for p in phases]
        lines = [f'    <tlLogic id="{tl}" type="static" programID="0" offset="{int(prog.get("offset", 0))}">']
        for k, p in enumerate(phases):
            cur, nxt = states[k], states[(k + 1) % len(states)]
            name = (p.get("name") or f"фаза {k + 1}").replace('"', "'")
            lines.append(f'        <phase duration="{int(p["dur"])}" state="{cur}" name="{name}"/>')
            yel = "".join("y" if c in "Gg" and nx not in "Gg" else c for c, nx in zip(cur, nxt))
            if int(p.get("yellow", 0)) > 0 and yel != cur:
                lines.append(f'        <phase duration="{int(p["yellow"])}" state="{yel}"/>')
            red = "".join("r" if c in "Gg" and nx not in "Gg" else c for c, nx in zip(cur, nxt))
            if int(p.get("red", 0)) > 0 and red != cur:
                lines.append(f'        <phase duration="{int(p["red"])}" state="{red}"/>')
        lines.append("    </tlLogic>")
        out.extend(lines)
        never = sorted({la[0] for la in link_appr if la and not any(la[0] in p.get("green", []) for p in phases)})
        if never:
            report.append(f"узел {node_id}: подъезды {never} ни в одной фазе не получают зелёный — машины там встанут")
        cycle = sum(int(p["dur"]) + int(p.get("yellow", 0)) + int(p.get("red", 0)) for p in phases)
        report.append(f"узел {node_id} → светофор SUMO «{tl}»: {len(phases)} фаз, цикл {cycle} с, сигналов {n}")
        applied += 1
    out.append("</tlLogics>")
    return ("\n".join(out) + "\n") if applied else None, report


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("osm")
    ap.add_argument("net")
    ap.add_argument("-o", "--output", default="uds.tll.xml")
    a = ap.parse_args()
    xml, report = build_tll(a.osm, a.net)
    for line in report:
        print(line)
    if xml:
        open(a.output, "w", encoding="utf-8").write(xml)
        print("записано:", a.output)


if __name__ == "__main__":
    main()

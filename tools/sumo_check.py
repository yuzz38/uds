#!/usr/bin/env python3
"""
Локальная проверка .osm так же, как контейнер SUMO на сервере проверки (traffic-simulators/sumo),
только без видео — за десятки секунд вместо очереди на сервере.

    pip install eclipse-sumo
    python tools/sumo_check.py team1.osm

Шаги повторяют sumo/pipeline.py: netconvert с теми же типами дорог, запреты motor_vehicle/motorcar,
randomTrips (100 машин, те же параметры и зерно), моделирование 1 час, проверка «доехали все 100».
Если в .osm есть программы светофоров из редактора (теги uds:tls), они применяются так же,
как это делает tools/osm_tls_to_sumo.py — чтобы проверить их до сервера.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

# Тот же файл типов, что service-passenger.typ.xml в контейнере SUMO
SERVICE_TYPES = """<types>
    <type
        id="highway.service"
        allow="passenger delivery pedestrian bicycle"
    />
</types>
"""


def sumo_home():
    if os.environ.get("SUMO_HOME"):
        return Path(os.environ["SUMO_HOME"])
    try:
        import sumo  # pip install eclipse-sumo
        return Path(sumo.SUMO_HOME)
    except ImportError:
        sys.exit("Нет SUMO: установите `pip install eclipse-sumo` или задайте SUMO_HOME")


def run(cmd, label, quiet=True):
    r = subprocess.run([str(c) for c in cmd], capture_output=True, text=True)
    if r.returncode != 0:
        print(r.stdout[-3000:], r.stderr[-3000:])
        raise SystemExit(f"Ошибка на шаге «{label}»")
    return r


def restricted_ways(osm_path):
    out = set()
    for way in ET.parse(osm_path).getroot().findall("way"):
        tags = {t.get("k"): t.get("v") for t in way.findall("tag")}
        if tags.get("motor_vehicle") == "no" or tags.get("motorcar") == "no":
            out.add(way.get("id"))
    return out


def _allows_passenger(lane):
    allow = lane.get("allow")
    disallow = set(lane.get("disallow", "").split())
    if allow is not None:
        allowed = set(allow.split())
        return "passenger" in allowed or "all" in allowed
    return "passenger" not in disallow and "all" not in disallow


def _forbid_passenger(lane):
    allow = lane.get("allow")
    if allow is not None:
        modes = allow.split()
        if "all" in modes:
            lane.attrib.pop("allow")
            lane.set("disallow", "passenger")
        else:
            modes = [m for m in modes if m != "passenger"]
            if modes:
                lane.set("allow", " ".join(modes))
            else:
                lane.attrib.pop("allow")
                lane.set("disallow", "all")
    else:
        modes = lane.get("disallow", "").split()
        if "passenger" not in modes and "all" not in modes:
            modes.append("passenger")
        lane.set("disallow", " ".join(modes))


def apply_access(raw, out, restricted):
    """Копия логики sumo/fix_access.py сервера."""
    tree = ET.parse(raw)
    for edge in tree.getroot().findall("edge"):
        if edge.get("function"):
            continue
        if edge.get("id", "").lstrip("-").split("#")[0] not in restricted:
            continue
        for lane in edge.findall("lane"):
            if _allows_passenger(lane):
                _forbid_passenger(lane)
    tree.write(out, encoding="utf-8", xml_declaration=True)


def main():
    ap = argparse.ArgumentParser(description="Проверка .osm как в контейнере SUMO сервера")
    ap.add_argument("osm")
    ap.add_argument("--keep", help="сохранить рабочие файлы в эту папку")
    args = ap.parse_args()
    home = sumo_home()
    bin_ = lambda name: shutil.which(name) or str(home / "bin" / name)
    work = Path(args.keep or tempfile.mkdtemp(prefix="sumo_check_"))
    work.mkdir(parents=True, exist_ok=True)
    osm = work / "map.osm"
    shutil.copyfile(args.osm, osm)
    (work / "service-passenger.typ.xml").write_text(SERVICE_TYPES, encoding="utf-8")
    types = f"{home / 'data/typemap/osmNetconvert.typ.xml'},{work / 'service-passenger.typ.xml'}"

    print("1. netconvert…")
    run([bin_("netconvert"), "--osm-files", osm, "--type-files", types, "--output-file", work / "raw.net.xml"], "netconvert")
    apply_access(work / "raw.net.xml", work / "network.net.xml", restricted_ways(osm))

    # программы светофоров из редактора
    from osm_tls_to_sumo import build_tll
    tll, report = build_tll(osm, work / "network.net.xml")
    for line in report:
        print("   " + line)
    if tll is not None:
        (work / "uds.tll.xml").write_text(tll, encoding="utf-8")
        run([bin_("netconvert"), "-s", work / "network.net.xml", "--tllogic-files", work / "uds.tll.xml",
             "-o", work / "network.net.xml"], "применение программ светофоров")

    print("2. randomTrips (100 машин, как на сервере)…")
    run([sys.executable, home / "tools/randomTrips.py", "-n", work / "network.net.xml", "-o", work / "trips.xml",
         "--route-file", work / "routes.rou.xml", "-b", "28800", "-e", "29100", "-p", "3",
         "--vehicle-class", "passenger", "--edge-permission", "passenger", "--fringe-factor", "5",
         "--min-distance", "500", "--seed", "42"], "randomTrips")
    vehicles = ET.parse(work / "routes.rou.xml").getroot().findall("vehicle")
    print(f"   маршрутов: {len(vehicles)} из 100")

    print("3. sumo (1 час модельного времени)…")
    r = run([bin_("sumo"), "-n", work / "network.net.xml", "-r", work / "routes.rou.xml", "-b", "28800", "-e", "32400",
             "--tripinfo-output", work / "tripinfo.xml", "--queue-output", work / "queue.xml",
             "--duration-log.statistics", "true", "--no-step-log", "true"], "sumo")
    trips = ET.parse(work / "tripinfo.xml").getroot().findall("tripinfo")
    teleports = 0
    for line in (r.stdout + r.stderr).splitlines():
        if "Teleports:" in line:
            try: teleports = int(line.split("Teleports:")[1].split()[0])
            except ValueError: pass
    dur = [float(t.get("duration")) for t in trips]
    loss = [float(t.get("timeLoss")) for t in trips]
    wait = [float(t.get("waitingTime")) for t in trips]
    stops = [int(t.get("waitingCount")) for t in trips]
    speed = [float(t.get("routeLength")) / float(t.get("duration")) * 3.6 for t in trips if float(t.get("duration")) > 0]
    # самые длинные очереди: максимум по полосе за час
    names = {}
    for way in ET.parse(osm).getroot().findall("way"):
        tags = {tg.get("k"): tg.get("v") for tg in way.findall("tag")}
        names[way.get("id")] = f"{tags.get('name') or tags.get('highway', 'дорога')} (линия {way.get('id')})"
    qmax = {}
    for step in ET.iterparse(work / "queue.xml", events=("end",)):
        el = step[1]
        if el.tag == "lane":
            lid, ql = el.get("id"), float(el.get("queueing_length") or 0)
            if not lid.startswith(":") and ql > qmax.get(lid, 0):
                qmax[lid] = ql
        if el.tag == "data":
            el.clear()
    top = sorted(qmax.items(), key=lambda kv: -kv[1])[:5]
    queues = [f"{names.get(lid.lstrip('-').split('#')[0].rsplit('_', 1)[0], 'полоса ' + lid)}: {round(q)} м" for lid, q in top if q > 0]
    ok = len(vehicles) == 100 and len(trips) == 100
    print()
    print(json.dumps({
        "маршрутов": len(vehicles), "доехало": len(trips), "телепортаций": teleports,
        "среднее_время_в_пути_с": round(sum(dur) / len(dur), 1) if dur else None,
        "средние_потери_времени_с": round(sum(loss) / len(loss), 1) if loss else None,
        "среднее_время_стоянки_с": round(sum(wait) / len(wait), 1) if wait else None,
        "средне_остановок_на_машину": round(sum(stops) / len(stops), 2) if stops else None,
        "средняя_скорость_кмч": round(sum(speed) / len(speed), 1) if speed else None,
        "самые_длинные_очереди": queues,
        "итог": "OK — прогон на сервере пройдёт этот шаг" if ok else "СБОЙ — сервер упадёт на SUMO",
    }, ensure_ascii=False, indent=2))
    print("рабочие файлы:", work)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()

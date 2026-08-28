#!/usr/bin/env python3
"""
Lädt Graslandfeuerindex (GLFI) und Waldbrandgefahrenindex (WBI) für alle
DWD-Stationen vom offiziellen DWD OpenData-Server und schreibt sie als JSON
nach data/.

Quelle (offizielle DWD-Daten, CC BY 4.0):
  https://opendata.dwd.de/climate_environment/CDC/derived_germany/fire_danger_index/grassland/forecast/recent/
  https://opendata.dwd.de/climate_environment/CDC/derived_germany/fire_danger_index/woodland/forecast/recent/

Format pro Station (laut DWD-Datensatzbeschreibung):
  Station_ID;Date;<param>_0;<param>_1;...;<param>_6
  (glfi_0..glfi_6 bzw. wbi_0..wbi_6 = heutiger Wert + 6 Folgetage)

Die Dateinamen enthalten eine Versionsnummer, die sich ändern kann
(z.B. "v2-0--0"). Das Skript ermittelt die tatsächlich vorhandenen Dateien
daher immer live aus dem Verzeichnis-Listing, statt Versionen fest zu
kodieren.
"""
from __future__ import annotations

import concurrent.futures
import csv
import gzip
import io
import json
import logging
import re
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone, date, timedelta
from pathlib import Path

import requests

BASE = "https://opendata.dwd.de/climate_environment/CDC/derived_germany/fire_danger_index"
INDEX_TYPES = {
    "grassland": "glfi",
    "woodland": "wbi",
}
DATA_DIR = Path(__file__).resolve().parent.parent / "data"
MAX_WORKERS = 12
REQUEST_TIMEOUT = 20
USER_AGENT = "dwd-feuerindex-widget/1.0 (+https://github.com/; nicht-kommerzielles Widget-Projekt)"

log = logging.getLogger("update_indices")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

HREF_RE = re.compile(r'href="([^"]+)"')
STATION_LIST_RE = re.compile(r"_stations_list\.txt$")
STATION_CSV_RE = re.compile(r"_recent_(\d+)_v[\d.\-]+\.csv\.gz$")


@dataclass
class StationMeta:
    id: int
    height_m: int | None
    lat: float
    lon: float
    name: str
    bundesland: str


@dataclass
class IndexRun:
    param: str  # "glfi" or "wbi"
    dir_name: str  # "grassland" or "woodland"
    stations_meta: dict[int, StationMeta] = field(default_factory=dict)
    values: dict[int, dict[str, int]] = field(default_factory=dict)  # id -> {iso_date: value}


def make_session() -> requests.Session:
    s = requests.Session()
    s.headers.update({"User-Agent": USER_AGENT})
    adapter = requests.adapters.HTTPAdapter(
        max_retries=requests.packages.urllib3.util.retry.Retry(
            total=4, backoff_factor=0.5, status_forcelist=[429, 500, 502, 503, 504]
        ),
        pool_maxsize=MAX_WORKERS * 2,
    )
    s.mount("https://", adapter)
    return s


def list_dir(session: requests.Session, url: str) -> list[str]:
    r = session.get(url, timeout=REQUEST_TIMEOUT)
    r.raise_for_status()
    return HREF_RE.findall(r.text)


def parse_stations_list(raw: bytes) -> dict[int, StationMeta]:
    # Die Datei ist Latin-1-kodiert (Umlaute in Stationsnamen).
    text = raw.decode("latin-1")
    out: dict[int, StationMeta] = {}
    for line in text.splitlines():
        if not line.strip() or line.strip().startswith("Stationsindex"):
            continue
        parts = [p.strip() for p in line.split(";")]
        if len(parts) < 6:
            continue
        try:
            sid = int(parts[0])
            height = int(parts[1]) if parts[1] not in ("", "-") else None
            lat = float(parts[2])
            lon = float(parts[3])
            name = parts[4]
            bundesland = parts[5]
        except ValueError:
            continue
        out[sid] = StationMeta(id=sid, height_m=height, lat=lat, lon=lon, name=name, bundesland=bundesland)
    return out


# Das DWD-PDF beschreibt die Date-Spalte als "YYYY-MM-DD", tatsächlich
# liefern die Dateien aber z.B. "20260828 04:17" (kompakt, mit Uhrzeit).
# Wir akzeptieren daher mehrere Formate und fallen notfalls auf eine
# Regex-Extraktion der ersten 8 Ziffern (JJJJMMTT) zurück.
DATE_FORMATS = (
    "%Y-%m-%d",
    "%Y-%m-%d %H:%M",
    "%Y%m%d %H:%M",
    "%Y%m%d%H%M",
    "%Y%m%d",
)
DATE_DIGITS_RE = re.compile(r"(\d{4})(\d{2})(\d{2})")


def parse_row_date(raw: str) -> date:
    raw = raw.strip()
    for fmt in DATE_FORMATS:
        try:
            return datetime.strptime(raw, fmt).date()
        except ValueError:
            continue
    m = DATE_DIGITS_RE.search(raw)
    if m:
        return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    raise ValueError(f"Unbekanntes Datumsformat: {raw!r}")


def parse_station_csv(raw_gz: bytes, param: str) -> dict[str, int]:
    """Liest eine einzelne gzip-komprimierte Stationsdatei und gibt
    {iso_date: value} für den 7-Tage-Forecast zurück."""
    with gzip.GzipFile(fileobj=io.BytesIO(raw_gz)) as f:
        text = f.read().decode("utf-8", errors="replace")
    reader = csv.reader(io.StringIO(text), delimiter=";")
    rows = [row for row in reader if row and not row[0].strip().lower().startswith("station")]
    if not rows:
        return {}
    # Falls mehrere Zeilen enthalten sind (z.B. History), die mit dem
    # spätesten Datum verwenden.
    rows.sort(key=lambda row: parse_row_date(row[1]))
    row = rows[-1]
    base_date = parse_row_date(row[1])
    values: dict[str, int] = {}
    for offset, raw_val in enumerate(row[2:9]):
        raw_val = raw_val.strip()
        if raw_val in ("", "-999", "-99"):
            continue
        try:
            values[(base_date + timedelta(days=offset)).isoformat()] = int(round(float(raw_val)))
        except ValueError:
            continue
    return values


def fetch_index(session: requests.Session, dir_name: str, param: str) -> IndexRun:
    run = IndexRun(param=param, dir_name=dir_name)
    recent_url = f"{BASE}/{dir_name}/forecast/recent/"
    log.info("Verzeichnis laden: %s", recent_url)
    hrefs = list_dir(session, recent_url)

    stations_list_href = next((h for h in hrefs if STATION_LIST_RE.search(h)), None)
    if not stations_list_href:
        raise RuntimeError(f"Keine stations_list.txt gefunden unter {recent_url}")
    stations_list_url = recent_url + stations_list_href.split("/")[-1]
    log.info("Stationsliste laden: %s", stations_list_url)
    r = session.get(stations_list_url, timeout=REQUEST_TIMEOUT)
    r.raise_for_status()
    run.stations_meta = parse_stations_list(r.content)
    log.info("%d Stationen in der Liste (%s)", len(run.stations_meta), dir_name)

    csv_targets: list[tuple[int, str]] = []
    for h in hrefs:
        m = STATION_CSV_RE.search(h)
        if m:
            csv_targets.append((int(m.group(1)), recent_url + h.split("/")[-1]))
    log.info("%d Stations-Dateien gefunden (%s)", len(csv_targets), dir_name)

    def worker(item: tuple[int, str]) -> tuple[int, dict[str, int]] | None:
        sid, url = item
        try:
            resp = session.get(url, timeout=REQUEST_TIMEOUT)
            resp.raise_for_status()
            return sid, parse_station_csv(resp.content, param)
        except Exception as exc:  # noqa: BLE001
            log.warning("Fehler bei Station %s (%s): %s", sid, dir_name, exc)
            return None

    failures = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        for result in pool.map(worker, csv_targets):
            if result is None:
                failures += 1
                continue
            sid, values = result
            if values:
                run.values[sid] = values

    log.info(
        "%s: %d/%d Stationen erfolgreich, %d Fehler",
        dir_name, len(run.values), len(csv_targets), failures,
    )
    if csv_targets and failures / len(csv_targets) > 0.25:
        raise RuntimeError(
            f"Zu viele Fehler beim Laden von {dir_name} ({failures}/{len(csv_targets)}) - Abbruch."
        )
    return run


def build_combined(runs: dict[str, IndexRun]) -> dict:
    all_ids: set[int] = set()
    for run in runs.values():
        all_ids |= set(run.stations_meta.keys())

    stations_out = []
    for sid in sorted(all_ids):
        meta = None
        for run in runs.values():
            if sid in run.stations_meta:
                meta = run.stations_meta[sid]
                break
        if meta is None:
            continue
        entry = {
            "id": sid,
            "name": meta.name,
            "bundesland": meta.bundesland,
            "lat": meta.lat,
            "lon": meta.lon,
            "height_m": meta.height_m,
            "indices": {},
        }
        for param, run in runs.items():
            if sid in run.values:
                entry["indices"][param] = run.values[sid]
        if entry["indices"]:
            stations_out.append(entry)

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": {
            "provider": "Deutscher Wetterdienst (DWD)",
            "dataset": "Grassland/Woodland Fire Danger Index Forecast",
            "url": f"{BASE}/",
            "license": "CC BY 4.0",
            "license_url": "https://creativecommons.org/licenses/by/4.0/",
        },
        "legend": {
            "1": "sehr geringe Gefahr",
            "2": "geringe Gefahr",
            "3": "mittlere Gefahr",
            "4": "hohe Gefahr",
            "5": "sehr hohe Gefahr",
        },
        "station_count": len(stations_out),
        "stations": stations_out,
    }


def main() -> int:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    session = make_session()

    runs: dict[str, IndexRun] = {}
    for dir_name, param in INDEX_TYPES.items():
        runs[param] = fetch_index(session, dir_name, param)

    combined = build_combined(runs)

    out_path = DATA_DIR / "combined.json"
    tmp_path = out_path.with_suffix(".json.tmp")
    tmp_path.write_text(json.dumps(combined, ensure_ascii=False, indent=None, separators=(",", ":")), encoding="utf-8")
    tmp_path.replace(out_path)
    log.info("Geschrieben: %s (%d Stationen)", out_path, combined["station_count"])

    # Kompakte Variante nur mit heutigem Wert, fürs schnelle Kartenrendering.
    today_only = {
        "generated_at": combined["generated_at"],
        "source": combined["source"],
        "legend": combined["legend"],
        "stations": [
            {
                "id": s["id"],
                "name": s["name"],
                "bundesland": s["bundesland"],
                "lat": s["lat"],
                "lon": s["lon"],
                "today": {
                    param: (list(values.values())[0] if values else None)
                    for param, values in s["indices"].items()
                },
            }
            for s in combined["stations"]
        ],
    }
    latest_path = DATA_DIR / "latest.json"
    tmp_latest = latest_path.with_suffix(".json.tmp")
    tmp_latest.write_text(json.dumps(today_only, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    tmp_latest.replace(latest_path)
    log.info("Geschrieben: %s", latest_path)

    if combined["station_count"] == 0:
        log.error("Keine Stationen mit Daten - vermutlich ist etwas schiefgelaufen.")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""
HTTP data server: Serves data with the same API structure as mode 2 from Nsight SQLite (abhinav_data) or OTF2 (abhinav_data2).
Mode 3: --format nsight, reads Nsight SQLite, events are raw columns only.
Mode 4: --format otf2, reads OTF2 directory (e.g. abhinav_data2), preserves original fields (Event Type, Name, Process, Thread, Attributes, etc.).
Port 8080.
"""

import argparse
import json
import re
import sys
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import parse_qs, urlparse

try:
    import pipit  # type: ignore
except ImportError:
    pipit = None

try:
    import pandas as pd  # type: ignore
except Exception:
    pd = None


# ---------- Infer column names from Nsight table structure (aligned with convert_nsight_sqlite_to_eseman) ----------
def normalize_col(name: str) -> str:
    name = name.strip().lower()
    name = re.sub(r"[^a-z0-9]+", "_", name)
    return name.strip("_")


def pick_column(columns: List[str], candidates: List[str]) -> Optional[str]:
    direct = {c: c for c in columns}
    normalized = {normalize_col(c): c for c in columns}
    for cand in candidates:
        if cand in direct:
            return cand
        norm = normalize_col(cand)
        if norm in normalized:
            return normalized[norm]
    return None


def infer_columns(columns: List[str]) -> Dict[str, Optional[str]]:
    return {
        "start": pick_column(
            columns,
            [
                "start", "start_time", "ts", "timestamp", "timestamp_ns",
                "timestamp_us", "timestamp_ms", "time_start", "timestamp (ns)",
            ],
        ),
        "end": pick_column(
            columns,
            [
                "end", "end_time", "time_end", "timestamp_end",
                "matching_timestamp", "_matching_timestamp",
                "timestamp_end_ns", "timestamp_end_us",
            ],
        ),
        "dur": pick_column(
            columns, ["dur", "duration", "duration_ns", "duration_us", "duration_ms"]
        ),
        "name": pick_column(columns, ["name", "event_name", "op", "operation"]),
        "track": pick_column(
            columns,
            [
                "tid", "thread_id", "thread", "lane", "track",
                "stream_id", "streamid", "gpuid", "gpu_id", "pid",
            ],
        ),
        "id": pick_column(columns, ["id", "event_id", "corr_id"]),
    }


def is_missing(value: Any) -> bool:
    if value is None:
        return True
    if pd is not None:
        try:
            if pd.isna(value):
                return True
        except Exception:
            pass
    return False


def normalize_value(value: Any) -> Any:
    if is_missing(value):
        return None
    if hasattr(value, "isoformat"):
        return value.isoformat()
    if hasattr(value, "item"):
        try:
            return value.item()
        except Exception:
            pass
    if isinstance(value, dict):
        return {k: normalize_value(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [normalize_value(v) for v in value]
    return value


def normalize_number(value: Any) -> Optional[float]:
    if value is None:
        return None
    v = normalize_value(value)
    if isinstance(value, bool):
        return float(int(value))
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        try:
            return float(int(v))
        except ValueError:
            try:
                return float(v)
            except ValueError:
                return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


# ---------- Get start/end/track/name from raw events (for filtering and binning) ----------
def _raw_start_end(ev: Dict[str, Any], col_map: Dict[str, Optional[str]]) -> Tuple[Optional[float], Optional[float]]:
    start_col = col_map.get("start")
    end_col = col_map.get("end")
    dur_col = col_map.get("dur")
    if not start_col:
        return None, None
    s = normalize_number(ev.get(start_col))
    if s is None:
        return None, None
    e = normalize_number(ev.get(end_col)) if end_col else None
    if e is None and dur_col:
        e = s + (normalize_number(ev.get(dur_col)) or 0)
    return s, e


def _raw_track(ev: Dict[str, Any], col_map: Dict[str, Optional[str]]) -> str:
    c = col_map.get("track")
    if not c:
        return ""
    v = ev.get(c)
    return "" if v is None else str(normalize_value(v))


def _raw_name(ev: Dict[str, Any], col_map: Dict[str, Optional[str]]) -> str:
    c = col_map.get("name")
    if not c:
        return ""
    v = ev.get(c)
    return "" if v is None else str(normalize_value(v))


def _raw_id(ev: Dict[str, Any], col_map: Dict[str, Optional[str]]) -> Optional[str]:
    c = col_map.get("id")
    if not c:
        return None
    v = ev.get(c)
    return str(normalize_value(v)) if v is not None else None


# ---------- Load: raw columns only, no enter/leave etc. ----------
def load_raw_events(
    sqlite_path: Path,
) -> Tuple[List[Dict[str, Any]], Dict[str, Optional[str]], float]:
    """Return (raw events list, column map, min_start). Events contain raw columns only."""
    if pipit is None:
        raise RuntimeError("pipit is required: pip install 'git+https://github.com/hpcgroup/pipit.git'")
    path = sqlite_path.expanduser().resolve()
    if not path.exists():
        raise FileNotFoundError(f"File not found: {path}")
    trace = pipit.Trace.from_nsight_sqlite(str(path))
    events = trace.events
    is_df = hasattr(events, "columns") and hasattr(events, "itertuples")
    if is_df:
        columns = list(events.columns)
        rows = [dict(zip(columns, (normalize_value(v) for v in row))) for row in events.itertuples(index=False, name=None)]
    elif isinstance(events, list) and events and isinstance(events[0], dict):
        columns = list(events[0].keys())
        rows = [{k: normalize_value(row.get(k)) for k in columns} for row in events]
    else:
        raise ValueError("Unsupported events type")

    col_map = infer_columns(columns)
    if not col_map.get("start"):
        raise ValueError(f"Cannot infer start time column. Available columns: {columns}")

    min_start: Optional[float] = None
    out: List[Dict[str, Any]] = []
    for row in rows:
        s, e = _raw_start_end(row, col_map)
        if s is None or e is None:
            continue
        if min_start is None or s < min_start:
            min_start = s
        out.append(row)
    if min_start is None:
        raise ValueError("No valid start time found")
    return out, col_map, float(min_start)


# ---------- Mode 4: Load from OTF2 directory (abhinav_data2), preserve original fields ----------
def load_raw_events_otf2(
    trace_dir: Path,
) -> Tuple[List[Dict[str, Any]], Dict[str, Optional[str]], float]:
    """Load events from OTF2 trace directory, keeping pipit raw columns (Timestamp (ns), Event Type, Name, Process, Thread, Attributes, etc.).
    Uses pipit.Trace.from_otf2(trace_dir), matches Enter/Leave then uses Enter rows as intervals; returns (events list, column map, min_start)."""
    if pipit is None:
        raise RuntimeError("pipit is required: pip install 'git+https://github.com/hpcgroup/pipit.git'")
    path = trace_dir.expanduser().resolve()
    if not path.is_dir():
        raise FileNotFoundError(f"OTF2 requires a directory: {path}")
    trace = pipit.Trace.from_otf2(str(path))
    trace._match_events()  # Add _matching_timestamp for start/end inference
    events = trace.events
    # Keep only Enter rows that have a matched Leave, as intervals (one row per interval), preserve original fields
    enter_mask = (events["Event Type"] == "Enter") & events["_matching_event"].notnull()
    events = events.loc[enter_mask].copy()
    columns = list(events.columns)
    rows = [
        dict(zip(columns, (normalize_value(v) for v in row)))
        for row in events.itertuples(index=False, name=None)
    ]
    col_map = infer_columns(columns)
    if not col_map.get("start"):
        raise ValueError(f"Cannot infer start time column. Available columns: {columns}")
    min_start: Optional[float] = None
    out: List[Dict[str, Any]] = []
    for row in rows:
        s, e = _raw_start_end(row, col_map)
        if s is None or e is None:
            continue
        if min_start is None or s < min_start:
            min_start = s
        out.append(row)
    if min_start is None:
        raise ValueError("No valid start time found")
    return out, col_map, float(min_start)


def _filter_raw_events(
    events: List[Dict[str, Any]],
    col_map: Dict[str, Optional[str]],
    min_start: float,
    time_begin: Optional[int],
    time_end: Optional[int],
    track_filter: Optional[set],
) -> List[Dict[str, Any]]:
    """Filter raw events by normalized time range and track."""
    if time_begin is None and time_end is None and not track_filter:
        return list(events)
    matched = []
    for ev in events:
        s_raw, e_raw = _raw_start_end(ev, col_map)
        if s_raw is None or e_raw is None:
            continue
        s_norm = s_raw - min_start
        e_norm = e_raw - min_start
        if time_begin is not None and e_norm < time_begin:
            continue
        if time_end is not None and s_norm > time_end:
            continue
        if track_filter is not None and _raw_track(ev, col_map) not in track_filter:
            continue
        matched.append(ev)
    return matched


def _binned_utilization_raw(
    events: List[Dict[str, Any]],
    col_map: Dict[str, Optional[str]],
    min_start: float,
    time_begin: int,
    time_end: int,
    track_ids: List[str],
    bins: int,
    primitive_filter: Optional[str],
) -> Tuple[List[Dict[str, Any]], int, int]:
    """Same as mode 2: return data [{ track, utils }], begin, end (normalized time)."""
    if time_begin < 0 or time_end < 0 or bins <= 0:
        return [], time_begin, time_end
    span = max(1, time_end - time_begin)
    bin_size = span / bins
    track_set = set(track_ids) if track_ids else None
    by_track: Dict[str, List[Tuple[float, float]]] = {}
    for ev in events:
        s_raw, e_raw = _raw_start_end(ev, col_map)
        if s_raw is None or e_raw is None:
            continue
        s_norm = s_raw - min_start
        e_norm = e_raw - min_start
        loc = _raw_track(ev, col_map)
        if track_set is not None and loc not in track_set:
            continue
        if primitive_filter and _raw_name(ev, col_map) != primitive_filter:
            continue
        if e_norm < time_begin or s_norm > time_end:
            continue
        by_track.setdefault(loc, []).append((s_norm, e_norm))

    def _track_sort_key(loc: str):
        try:
            return (0, int(loc))
        except ValueError:
            return (1, loc)

    if not track_ids:
        track_ids = sorted(by_track.keys(), key=_track_sort_key)

    data = []
    for loc in track_ids:
        utils = [0.0] * bins
        for s_norm, e_norm in by_track.get(loc, []):
            for b in range(bins):
                bin_start = time_begin + b * bin_size
                bin_end = bin_start + bin_size
                overlap = max(0, min(e_norm, bin_end) - max(s_norm, bin_start))
                if overlap > 0:
                    utils[b] += overlap / bin_size
        data.append({"track": loc, "utils": [str(min(1.0, u)) for u in utils]})
    return data, time_begin, time_end


def _find_event_id_at_raw(
    events: List[Dict[str, Any]],
    col_map: Dict[str, Optional[str]],
    min_start: float,
    current_time_norm: int,
    current_track: int,
) -> Optional[str]:
    """Return the id of the raw event containing (current_time_norm, current_track) (same as event_id in mode 2)."""
    loc_str = str(current_track)
    for ev in events:
        if _raw_track(ev, col_map) != loc_str:
            continue
        s_raw, e_raw = _raw_start_end(ev, col_map)
        if s_raw is None or e_raw is None:
            continue
        s_norm = s_raw - min_start
        e_norm = e_raw - min_start
        if s_norm <= current_time_norm <= e_norm:
            return _raw_id(ev, col_map)
    return None


# ---------- HTTP server ----------
def make_error(message: str) -> str:
    return json.dumps({"error": message}, ensure_ascii=False)


class NsightRawHandler(BaseHTTPRequestHandler):
    events: List[Dict[str, Any]] = []
    col_map: Dict[str, Optional[str]] = {}
    min_start: float = 0.0

    def _cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")

    def _send_json(self, status: int, body: str):
        data = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self._cors_headers()
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors_headers()
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        path = (parsed.path or "/").rstrip("/") or "/"
        qs = parse_qs(parsed.query)

        def q(key: str, default: Optional[str] = None) -> Optional[str]:
            v = qs.get(key, [])
            return v[0] if v else default

        if path == "/health":
            self._send_json(200, json.dumps({"status": "healthy", "timestamp": __import__("time").time()}, ensure_ascii=False))
            return

        if path == "/get-events":
            try:
                begin_s, end_s = q("begin"), q("end")
                time_begin, time_end = None, None
                if begin_s is not None or end_s is not None:
                    if not begin_s or not end_s:
                        self._send_json(400, make_error("get-events: both begin and end are required when specifying time range"))
                        return
                    try:
                        time_begin = int(begin_s)
                        time_end = int(end_s)
                    except ValueError:
                        self._send_json(400, make_error("begin/end must be integers"))
                        return
                tracks_s = q("tracks")
                # Empty string means not provided: same as mode 2, no track filter
                track_filter = set(t.strip() for t in tracks_s.split(",")) if (tracks_s and tracks_s.strip()) else None
                matched = _filter_raw_events(
                    self.events, self.col_map, self.min_start,
                    time_begin, time_end, track_filter
                )
                body = json.dumps(
                    {
                        "events": matched,
                        "metadata": {
                            "count": len(matched),
                            "begin": time_begin,
                            "end": time_end,
                        },
                    },
                    ensure_ascii=False,
                    default=str,
                )
                self._send_json(200, body)
            except (BrokenPipeError, ConnectionResetError):
                pass  # Client disconnected (e.g. timeout), ignore
            except Exception as e:
                try:
                    self._send_json(500, make_error(f"get-events error: {e!r}"))
                except (BrokenPipeError, ConnectionResetError):
                    pass
            return

        if path.startswith("/get-data-in-range"):
            begin_s, end_s = q("begin"), q("end")
            time_begin = int(begin_s) if begin_s else None
            time_end = int(end_s) if end_s else None
            if (time_begin is None or time_end is None) and self.events:
                t_min, t_max = None, None
                for ev in self.events:
                    s, e = _raw_start_end(ev, self.col_map)
                    if s is not None and e is not None:
                        sn = s - self.min_start
                        en = e - self.min_start
                        if t_min is None or sn < t_min:
                            t_min = sn
                        if t_max is None or en > t_max:
                            t_max = en
                if time_begin is None and t_min is not None:
                    time_begin = int(t_min)
                if time_end is None and t_max is not None:
                    time_end = int(t_max)
            if time_begin is None:
                time_begin = 0
            if time_end is None:
                time_end = time_begin + 1
            bins = int(q("bins") or "100")
            tracks_s = q("tracks")
            track_list = [t.strip() for t in tracks_s.split(",")] if tracks_s else []
            primitive = q("primitive") or ""
            data, actual_begin, actual_end = _binned_utilization_raw(
                self.events, self.col_map, self.min_start,
                time_begin, time_end, track_list, bins, primitive or None
            )
            payload = {
                "data": data,
                "metadata": {"begin": actual_begin, "end": actual_end, "bins": bins},
            }
            self._send_json(200, json.dumps(payload, ensure_ascii=False, default=str))
            return

        if path.startswith("/get-event-attribute"):
            ct, cl = q("current-time"), q("current-track")
            if not ct or not cl:
                self._send_json(400, make_error("get-event-attribute requires current-time and current-track"))
                return
            try:
                c_time = int(ct)
                c_track = int(cl)
            except ValueError:
                self._send_json(400, make_error("current-time/current-track must be integers"))
                return
            interval_id = _find_event_id_at_raw(
                self.events, self.col_map, self.min_start, c_time, c_track
            )
            payload = {} if interval_id is None else {"event_id": interval_id}
            self._send_json(200, json.dumps(payload, ensure_ascii=False, default=str))
            return

        self._send_json(404, make_error("Endpoint not found"))

    def log_message(self, format: str, *args: Any) -> None:
        sys.stderr.write(f"[NsightRaw] {format % args}\n")


def main() -> None:
    parser = argparse.ArgumentParser(description="Mode 3 Nsight SQLite / Mode 4 OTF2 raw data server, port 8080")
    parser.add_argument(
        "--format",
        choices=["nsight", "otf2"],
        default="nsight",
        help="Mode 3=nsight (abhinav_data), Mode 4=otf2 (abhinav_data2)",
    )
    parser.add_argument(
        "--input",
        type=Path,
        default=None,
        help="Mode 3: Nsight SQLite file path; Mode 4: OTF2 trace directory (must contain traces.otf2)",
    )
    parser.add_argument("--port", type=int, default=8080, help="Listen port")
    parser.add_argument("--host", type=str, default="127.0.0.1", help="Listen address")
    args = parser.parse_args()

    if args.input is None:
        if args.format == "otf2":
            base = Path(__file__).parent / "abhinav_data2"
            # Use subdir if present after extract, else abhinav_data2 (must contain traces.otf2)
            candidate = base / "lulesh-otf2-b3-64"
            args.input = candidate if candidate.is_dir() else base
        else:
            args.input = Path(__file__).parent / "abhinav_data" / "yalistrace_44408148_0 (1).sqlite"

    if args.format == "otf2":
        print("Loading OTF2 (mode 4, preserve original fields)...", args.input, file=sys.stderr)
        NsightRawHandler.events, NsightRawHandler.col_map, NsightRawHandler.min_start = load_raw_events_otf2(
            args.input
        )
    else:
        print("Loading Nsight SQLite (mode 3, raw columns only)...", args.input, file=sys.stderr)
        NsightRawHandler.events, NsightRawHandler.col_map, NsightRawHandler.min_start = load_raw_events(
            args.input
        )
    print(f"Loaded {len(NsightRawHandler.events)} events", file=sys.stderr)

    server = HTTPServer((args.host, args.port), NsightRawHandler)
    print(f"Nsight raw data server: http://{args.host}:{args.port}", file=sys.stderr)
    print("  GET /get-events?begin=&end=&tracks=", file=sys.stderr)
    print("  GET /get-data-in-range?begin=&end=&tracks=&bins=&primitive=", file=sys.stderr)
    print("  GET /get-event-attribute?current-time=&current-track=", file=sys.stderr)
    print("  GET /health", file=sys.stderr)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped", file=sys.stderr)
        server.shutdown()


if __name__ == "__main__":
    main()

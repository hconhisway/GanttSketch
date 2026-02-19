#!/usr/bin/env python3
"""
HTTP data server: Serves data with the same API structure as mode 2 from Nsight SQLite (abhinav_data) or OTF2 (abhinav_data2).

- Mode 3: --format nsight, reads Nsight SQLite, events are raw columns only.
- Mode 4: --format otf2, reads OTF2 directory, preserves original fields (Event Type, Name, Process, Thread, Attributes, etc.).

New: manual upload workflow

- By default, the server starts with NO trace loaded.
- Frontend should call GET /health to detect server state, then POST a file to /api/upload-trace.
- After upload, the existing GET endpoints (/get-events, /get-data-in-range, /get-event-attribute) serve the uploaded trace.
"""

import argparse
import cgi
import json
import os
import re
import shutil
import sys
import tempfile
import time
from dataclasses import dataclass
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import parse_qs, urlparse
import tarfile
import zipfile

try:
    import pipit  # type: ignore
except ImportError:
    pipit = None

try:
    import pandas as pd  # type: ignore
except Exception:
    pd = None


MAX_UPLOAD_BYTES = int(os.environ.get("NSIGHT_RAW_UPLOAD_MAX_BYTES", str(1024 * 1024 * 1024)))  # 1GiB
MAX_ZIP_TOTAL_BYTES = int(os.environ.get("NSIGHT_RAW_UPLOAD_MAX_ZIP_BYTES", str(2 * 1024 * 1024 * 1024)))  # 2GiB
MAX_SESSIONS = int(os.environ.get("NSIGHT_RAW_MAX_SESSIONS", "8"))
TRACE_TTL_SECONDS = int(os.environ.get("NSIGHT_RAW_TRACE_TTL_SECONDS", str(6 * 3600)))  # 6 hours

SESSION_ID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-"
    r"[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{12}$"
)
DEFAULT_SESSION_ID = "default"


@dataclass
class TraceState:
    events: List[Dict[str, Any]]
    col_map: Dict[str, Optional[str]]
    min_start: float
    trace_name: str
    trace_format: str  # nsight | otf2 | pfw
    loaded_at: float
    last_access: float


def json_dumps(payload: Any) -> str:
    return json.dumps(payload, ensure_ascii=False, default=str)


def sanitize_filename(name: str) -> str:
    value = (name or "").strip().replace("\x00", "")
    value = value.replace("\\", "/").split("/")[-1]
    if not value:
        return "upload"
    # Keep it simple: remove path separators and control chars.
    value = re.sub(r"[^a-zA-Z0-9._ -]+", "_", value).strip(" .")
    return value or "upload"


def safe_extract_zip(zip_path: Path, dest_dir: Path) -> None:
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest_root = dest_dir.resolve()
    total = 0
    with zipfile.ZipFile(str(zip_path), "r") as zf:
        for info in zf.infolist():
            name = info.filename
            if not name or name.endswith("/"):
                continue
            total += int(info.file_size or 0)
            if total > MAX_ZIP_TOTAL_BYTES:
                raise ValueError(f"Zip too large (>{MAX_ZIP_TOTAL_BYTES} bytes)")
            out_path = (dest_dir / name).resolve()
            if not str(out_path).startswith(str(dest_root) + os.sep) and out_path != dest_root:
                raise ValueError(f"Unsafe zip path: {name!r}")
            out_path.parent.mkdir(parents=True, exist_ok=True)
            with zf.open(info, "r") as src, open(out_path, "wb") as dst:
                shutil.copyfileobj(src, dst)


def safe_extract_tar(tar_path: Path, dest_dir: Path) -> None:
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest_root = dest_dir.resolve()
    total = 0

    # r:* auto-detects compression (gz, bz2, xz, ...)
    with tarfile.open(str(tar_path), mode="r:*") as tf:
        for m in tf.getmembers():
            name = m.name or ""
            if not name:
                continue
            if name.startswith("/") or name.startswith("\\"):
                raise ValueError(f"Unsafe tar path: {name!r}")

            out_path = (dest_dir / name).resolve()
            if not str(out_path).startswith(str(dest_root) + os.sep) and out_path != dest_root:
                raise ValueError(f"Unsafe tar path: {name!r}")

            # Disallow links to avoid escaping the extraction root.
            if m.islnk() or m.issym():
                raise ValueError(f"Tar contains link entry (not allowed): {name!r}")

            if m.isdir():
                out_path.mkdir(parents=True, exist_ok=True)
                continue

            if not m.isreg():
                # Ignore other entry types (devices, fifos, etc.)
                continue

            total += int(getattr(m, "size", 0) or 0)
            if total > MAX_ZIP_TOTAL_BYTES:
                raise ValueError(f"Tar too large (>{MAX_ZIP_TOTAL_BYTES} bytes)")

            out_path.parent.mkdir(parents=True, exist_ok=True)
            src = tf.extractfile(m)
            if src is None:
                continue
            with src, open(out_path, "wb") as dst:
                shutil.copyfileobj(src, dst)


def find_otf2_dir(extracted_root: Path) -> Path:
    # OTF2 expects a directory containing traces.otf2
    for p in extracted_root.rglob("traces.otf2"):
        try:
            if p.is_file():
                return p.parent
        except OSError:
            continue
    raise FileNotFoundError("OTF2 upload requires a zip that contains traces.otf2")


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


def load_raw_events_pfw(
    trace_path: Path,
) -> Tuple[List[Dict[str, Any]], Dict[str, Optional[str]], float]:
    """Load a .pfw/.json/.txt trace (JSON array or one-JSON-object-per-line, optionally wrapped in [ ])."""
    path = trace_path.expanduser().resolve()
    if not path.exists():
        raise FileNotFoundError(f"File not found: {path}")

    # First pass: line-based parsing (handles .pfw format used in this repo)
    parsed_events: List[Dict[str, Any]] = []
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            raw = line.strip()
            if not raw or raw == "[" or raw == "]":
                continue
            if raw.endswith(","):
                raw = raw[:-1]
            try:
                obj = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if isinstance(obj, dict):
                parsed_events.append(obj)
            elif isinstance(obj, list):
                for item in obj:
                    if isinstance(item, dict):
                        parsed_events.append(item)

    # Fallback: full-file JSON parsing (for true JSON arrays)
    if not parsed_events:
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
            obj = json.loads(text)
            if isinstance(obj, list):
                parsed_events = [e for e in obj if isinstance(e, dict)]
        except Exception:
            pass

    if not parsed_events:
        raise ValueError("No events found in uploaded trace (expected JSON array or JSON lines).")

    # Infer columns from a small sample (keys can vary)
    sample_keys: set = set()
    for ev in parsed_events[:200]:
        if isinstance(ev, dict):
            sample_keys.update(ev.keys())
    columns = list(sample_keys) if sample_keys else list(parsed_events[0].keys())
    col_map = infer_columns(columns)
    if not col_map.get("start"):
        raise ValueError(f"Cannot infer start time column. Available columns: {sorted(columns)}")

    min_start: Optional[float] = None
    out: List[Dict[str, Any]] = []
    for ev in parsed_events:
        if not isinstance(ev, dict):
            continue
        s, e = _raw_start_end(ev, col_map)
        if s is None or e is None:
            continue
        if min_start is None or s < min_start:
            min_start = s
        out.append(ev)
    if min_start is None or not out:
        raise ValueError("No valid timed events found (missing start/end/dur fields).")
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
def make_error(message: str, *, needs_upload: bool = False, **extra: Any) -> str:
    payload: Dict[str, Any] = {"error": message}
    if needs_upload:
        payload["needsUpload"] = True
    for k, v in extra.items():
        payload[k] = v
    return json_dumps(payload)


class NsightRawHandler(BaseHTTPRequestHandler):
    # Per-session traces (kept in memory). Frontend sends ?session=<uuid>.
    traces_by_session: Dict[str, TraceState] = {}

    @classmethod
    def normalize_session_id(cls, raw: Optional[str]) -> str:
        value = (raw or "").strip()
        if not value:
            return DEFAULT_SESSION_ID
        if SESSION_ID_RE.match(value):
            return value
        # Keep backward compatibility, but avoid unbounded cardinality.
        return DEFAULT_SESSION_ID

    @classmethod
    def cleanup_traces(cls, now: Optional[float] = None) -> None:
        if now is None:
            now = time.time()

        # TTL eviction
        if TRACE_TTL_SECONDS > 0:
            expired = [
                sid
                for sid, st in cls.traces_by_session.items()
                if (now - float(st.last_access)) > TRACE_TTL_SECONDS
            ]
            for sid in expired:
                cls.traces_by_session.pop(sid, None)

        # LRU eviction to bound memory usage
        if MAX_SESSIONS > 0 and len(cls.traces_by_session) > MAX_SESSIONS:
            items = sorted(cls.traces_by_session.items(), key=lambda kv: float(kv[1].last_access))
            to_evict = len(items) - MAX_SESSIONS
            for sid, _ in items[:to_evict]:
                cls.traces_by_session.pop(sid, None)

    @classmethod
    def get_trace(cls, session_id: str) -> Optional[TraceState]:
        cls.cleanup_traces()
        st = cls.traces_by_session.get(session_id)
        if st is None:
            return None
        st.last_access = time.time()
        return st

    @classmethod
    def set_trace(cls, session_id: str, st: TraceState) -> None:
        cls.traces_by_session[session_id] = st
        cls.cleanup_traces(now=st.last_access)

    @classmethod
    def clear_trace(cls, session_id: Optional[str] = None) -> None:
        if session_id:
            cls.traces_by_session.pop(session_id, None)
        else:
            cls.traces_by_session = {}

    def _get_session_id_from_query(self, qs: Dict[str, List[str]]) -> str:
        v = qs.get("session", [])
        raw = v[0] if v else None
        return NsightRawHandler.normalize_session_id(raw)

    def _cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

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

    def do_POST(self):
        parsed = urlparse(self.path)
        path = (parsed.path or "/").rstrip("/") or "/"
        qs = parse_qs(parsed.query)
        session_id = self._get_session_id_from_query(qs)
        has_session_param = bool((qs.get("session", [""])[0] or "").strip())

        if path == "/api/clear-trace":
            if has_session_param:
                NsightRawHandler.clear_trace(session_id)
            else:
                NsightRawHandler.clear_trace(None)
            self._send_json(
                200,
                json_dumps(
                    {
                        "ok": True,
                        "cleared": {"all": not has_session_param, "session": session_id if has_session_param else None},
                    }
                ),
            )
            return

        if path != "/api/upload-trace":
            self._send_json(404, make_error("Endpoint not found"))
            return

        content_length = self.headers.get("Content-Length")
        try:
            length = int(content_length) if content_length is not None else None
        except ValueError:
            length = None

        if length is not None and length > MAX_UPLOAD_BYTES:
            self._send_json(413, make_error(f"Upload too large (>{MAX_UPLOAD_BYTES} bytes)"))
            return

        ctype = (self.headers.get("Content-Type") or "").strip()
        if not ctype.lower().startswith("multipart/form-data"):
            self._send_json(400, make_error("upload-trace requires multipart/form-data with field 'file'"))
            return

        sys.stderr.write(
            f"[NsightRaw] upload start session={session_id} content_length={length} content_type={ctype!r}\n"
        )
        tmp_dir = Path(tempfile.mkdtemp(prefix="nsight_raw_upload_"))
        try:
            env = {"REQUEST_METHOD": "POST", "CONTENT_TYPE": ctype}
            if length is not None:
                env["CONTENT_LENGTH"] = str(length)
            form = cgi.FieldStorage(fp=self.rfile, headers=self.headers, environ=env)  # type: ignore

            if "file" not in form:
                self._send_json(400, make_error("Missing form field: file"))
                return
            file_item = form["file"]
            if isinstance(file_item, list):
                file_item = file_item[0]

            filename = sanitize_filename(getattr(file_item, "filename", "") or "upload")
            upload_path = tmp_dir / filename

            file_obj = getattr(file_item, "file", None)
            if file_obj is None:
                self._send_json(400, make_error("Invalid upload: missing file content"))
                return

            written = 0
            with open(upload_path, "wb") as out_f:
                while True:
                    chunk = file_obj.read(1024 * 1024)
                    if not chunk:
                        break
                    written += len(chunk)
                    if written > MAX_UPLOAD_BYTES:
                        self._send_json(413, make_error(f"Upload too large (>{MAX_UPLOAD_BYTES} bytes)"))
                        return
                    out_f.write(chunk)

            sys.stderr.write(
                f"[NsightRaw] upload saved session={session_id} name={filename!r} bytes={written} tmp={str(upload_path)!r}\n"
            )
            format_hint = None
            try:
                format_hint = form.getfirst("format")  # type: ignore
            except Exception:
                format_hint = None
            hint = (str(format_hint or "auto").strip().lower() or "auto")

            # Infer loader
            suffix = upload_path.suffix.lower()
            lower_name = upload_path.name.lower()
            is_zip = lower_name.endswith(".zip")
            is_tar = lower_name.endswith(".tar")
            is_targz = lower_name.endswith(".tar.gz") or lower_name.endswith(".tgz")
            trace_format: str
            if hint in ("nsight", "otf2", "pfw"):
                trace_format = hint
            elif suffix in (".sqlite", ".db"):
                trace_format = "nsight"
            elif is_zip or is_tar or is_targz:
                trace_format = "otf2"
            else:
                trace_format = "pfw"

            t0 = time.time()
            if trace_format == "otf2":
                extracted = tmp_dir / "otf2_extracted"
                if is_zip:
                    safe_extract_zip(upload_path, extracted)
                elif is_tar or is_targz:
                    safe_extract_tar(upload_path, extracted)
                else:
                    self._send_json(
                        400,
                        make_error(
                            "OTF2 upload expects a .zip/.tar.gz/.tgz/.tar containing traces.otf2"
                        ),
                    )
                    return
                otf2_dir = find_otf2_dir(extracted)
                events, col_map, min_start = load_raw_events_otf2(otf2_dir)
            elif trace_format == "nsight":
                events, col_map, min_start = load_raw_events(upload_path)
            else:
                events, col_map, min_start = load_raw_events_pfw(upload_path)
            sys.stderr.write(
                f"[NsightRaw] upload loaded session={session_id} format={trace_format} events={len(events)} elapsed_s={time.time() - t0:.3f}\n"
            )
            now = time.time()
            NsightRawHandler.set_trace(
                session_id,
                TraceState(
                    events=events,
                    col_map=col_map,
                    min_start=float(min_start),
                    trace_name=filename,
                    trace_format=trace_format,
                    loaded_at=now,
                    last_access=now,
                ),
            )

            self._send_json(
                200,
                json_dumps(
                    {
                        "ok": True,
                        "session": session_id,
                        "trace": {
                            "name": filename,
                            "format": trace_format,
                            "event_count": len(events),
                        },
                    }
                ),
            )
        except Exception as e:
            self._send_json(500, make_error(f"upload-trace error: {e!r}"))
        finally:
            try:
                shutil.rmtree(tmp_dir, ignore_errors=True)
            except Exception:
                pass

    def do_GET(self):
        parsed = urlparse(self.path)
        path = (parsed.path or "/").rstrip("/") or "/"
        qs = parse_qs(parsed.query)
        session_id = self._get_session_id_from_query(qs)

        def q(key: str, default: Optional[str] = None) -> Optional[str]:
            v = qs.get(key, [])
            return v[0] if v else default

        if path == "/health":
            st = NsightRawHandler.get_trace(session_id)
            self._send_json(
                200,
                json_dumps(
                    {
                        "status": "healthy",
                        "timestamp": time.time(),
                        "session": session_id,
                        "sessions_loaded": len(NsightRawHandler.traces_by_session),
                        "trace": {
                            "loaded": st is not None,
                            "name": st.trace_name if st else "",
                            "format": st.trace_format if st else "",
                            "loaded_at": st.loaded_at if st else 0.0,
                            "last_access": st.last_access if st else 0.0,
                            "event_count": len(st.events) if st else 0,
                            "col_map": st.col_map if st else {},
                        },
                    }
                ),
            )
            return

        if path == "/get-events":
            st = NsightRawHandler.get_trace(session_id)
            if st is None:
                self._send_json(
                    409,
                    make_error(
                        "No trace loaded for this session. Upload via POST /api/upload-trace?session=<id> (multipart field 'file').",
                        needs_upload=True,
                        session=session_id,
                    ),
                )
                return
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
                    st.events, st.col_map, st.min_start,
                    time_begin, time_end, track_filter
                )
                body = json.dumps(
                    {
                        "events": matched,
                        "metadata": {
                            "count": len(matched),
                            "begin": time_begin,
                            "end": time_end,
                            "session": session_id,
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
            st = NsightRawHandler.get_trace(session_id)
            if st is None:
                self._send_json(
                    409,
                    make_error(
                        "No trace loaded for this session. Upload via POST /api/upload-trace?session=<id> (multipart field 'file').",
                        needs_upload=True,
                        session=session_id,
                    ),
                )
                return
            begin_s, end_s = q("begin"), q("end")
            time_begin = int(begin_s) if begin_s else None
            time_end = int(end_s) if end_s else None
            if (time_begin is None or time_end is None) and st.events:
                t_min, t_max = None, None
                for ev in st.events:
                    s, e = _raw_start_end(ev, st.col_map)
                    if s is not None and e is not None:
                        sn = s - st.min_start
                        en = e - st.min_start
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
                st.events, st.col_map, st.min_start,
                time_begin, time_end, track_list, bins, primitive or None
            )
            payload = {
                "data": data,
                "metadata": {"begin": actual_begin, "end": actual_end, "bins": bins, "session": session_id},
            }
            self._send_json(200, json.dumps(payload, ensure_ascii=False, default=str))
            return

        if path.startswith("/get-event-attribute"):
            st = NsightRawHandler.get_trace(session_id)
            if st is None:
                self._send_json(
                    409,
                    make_error(
                        "No trace loaded for this session. Upload via POST /api/upload-trace?session=<id> (multipart field 'file').",
                        needs_upload=True,
                        session=session_id,
                    ),
                )
                return
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
                st.events, st.col_map, st.min_start, c_time, c_track
            )
            payload = {} if interval_id is None else {"event_id": interval_id}
            self._send_json(200, json.dumps(payload, ensure_ascii=False, default=str))
            return

        self._send_json(404, make_error("Endpoint not found"))

    def log_message(self, format: str, *args: Any) -> None:
        sys.stderr.write(f"[NsightRaw] {format % args}\n")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Nsight SQLite / OTF2 raw data server (port 8080). Defaults to manual upload (no auto-load)."
    )
    parser.add_argument(
        "--format",
        choices=["nsight", "otf2", "pfw"],
        default="nsight",
        help="Startup load format (only used with --input or --autoload-sample)",
    )
    parser.add_argument(
        "--input",
        type=Path,
        default=None,
        help="Optional startup trace path. nsight: SQLite file; otf2: directory containing traces.otf2; pfw: .pfw/.json/.txt file",
    )
    parser.add_argument(
        "--autoload-sample",
        action="store_true",
        help="If --input is not provided, load the bundled sample trace (old behavior).",
    )
    parser.add_argument("--port", type=int, default=8080, help="Listen port")
    parser.add_argument("--host", type=str, default="127.0.0.1", help="Listen address")
    args = parser.parse_args()

    if args.input is None and args.autoload_sample:
        if args.format == "otf2":
            base = Path(__file__).parent / "abhinav_data2"
            candidate = base / "lulesh-otf2-b3-64"
            args.input = candidate if candidate.is_dir() else base
        elif args.format == "pfw":
            args.input = Path(__file__).resolve().parents[1] / "public" / "unet3d_a100--verify-1.pfw"
        else:
            args.input = Path(__file__).parent / "abhinav_data" / "yalistrace_44408148_0 (1).sqlite"

    if args.input is not None:
        if args.format == "otf2":
            print("Loading OTF2 (startup)...", args.input, file=sys.stderr)
            events, col_map, min_start = load_raw_events_otf2(args.input)
            trace_format = "otf2"
        elif args.format == "pfw":
            print("Loading PFW/JSON (startup)...", args.input, file=sys.stderr)
            events, col_map, min_start = load_raw_events_pfw(args.input)
            trace_format = "pfw"
        else:
            print("Loading Nsight SQLite (startup)...", args.input, file=sys.stderr)
            events, col_map, min_start = load_raw_events(args.input)
            trace_format = "nsight"
        now = time.time()
        NsightRawHandler.set_trace(
            DEFAULT_SESSION_ID,
            TraceState(
                events=events,
                col_map=col_map,
                min_start=float(min_start),
                trace_name=str(args.input),
                trace_format=trace_format,
                loaded_at=now,
                last_access=now,
            ),
        )
        print(f"Loaded {len(events)} events into session {DEFAULT_SESSION_ID}", file=sys.stderr)
    else:
        NsightRawHandler.clear_trace(None)
        print("No trace loaded. Waiting for upload via POST /api/upload-trace?session=... ...", file=sys.stderr)

    server = HTTPServer((args.host, args.port), NsightRawHandler)
    print(f"Nsight raw data server: http://{args.host}:{args.port}", file=sys.stderr)
    print("  GET /get-events?session=&begin=&end=&tracks=", file=sys.stderr)
    print("  GET /get-data-in-range?session=&begin=&end=&tracks=&bins=&primitive=", file=sys.stderr)
    print("  GET /get-event-attribute?session=&current-time=&current-track=", file=sys.stderr)
    print("  GET /health?session=", file=sys.stderr)
    print(
        "  POST /api/upload-trace?session=  (multipart/form-data: file=...; optional format=auto|nsight|otf2|pfw)",
        file=sys.stderr,
    )
    print("  POST /api/clear-trace?session=  (omit session to clear all)", file=sys.stderr)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped", file=sys.stderr)
        server.shutdown()


if __name__ == "__main__":
    main()

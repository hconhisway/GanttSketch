import argparse
import json
from pathlib import Path


def _event_time(event):
    ts = event.get("ts")
    dur = event.get("dur")
    if ts is None or dur is None:
        return None
    try:
        start = int(ts)
        end = start + int(dur)
    except (TypeError, ValueError):
        return None
    return start, end


def _event_level(event):
    args = event.get("args") if isinstance(event, dict) else None
    level_raw = None
    if isinstance(args, dict):
        level_raw = args.get("level")
    if level_raw is None:
        level_raw = event.get("level")

    if level_raw is None:
        return 0
    try:
        level = float(level_raw)
    except (TypeError, ValueError):
        return 0
    if level != level or level in (float("inf"), float("-inf")):
        return 0
    return int(level) if level.is_integer() else level


def _collect_events_by_thread_level(events):
    per_thread_level = {}
    for index, event in enumerate(events):
        time_range = _event_time(event)
        if time_range is None:
            continue
        pid = event.get("pid")
        tid = event.get("tid")
        if pid is None or tid is None:
            continue
        level = _event_level(event)
        per_thread_level.setdefault((pid, tid, level), []).append(
            {
                "start": time_range[0],
                "end": time_range[1],
                "index": index,
                "event": event,
            }
        )
    return per_thread_level


def _group_overlaps(items):
    items.sort(key=lambda item: (item["start"], item["end"], item["index"]))
    groups = []
    current_group = []
    current_end = None

    for item in items:
        if not current_group:
            current_group = [item]
            current_end = item["end"]
            continue
        if item["start"] <= current_end:
            current_group.append(item)
            if item["end"] > current_end:
                current_end = item["end"]
        else:
            groups.append(current_group)
            current_group = [item]
            current_end = item["end"]

    if current_group:
        groups.append(current_group)
    return [group for group in groups if len(group) >= 2]


def build_overlap_groups(events):
    per_thread_level = _collect_events_by_thread_level(events)
    thread_map = {}

    for (pid, tid, level), items in per_thread_level.items():
        thread_map.setdefault((pid, tid), {})[level] = items

    threads_output = []
    for (pid, tid) in sorted(thread_map.keys()):
        level_output = []
        levels = sorted(thread_map[(pid, tid)].keys())
        for level in levels:
            groups = _group_overlaps(thread_map[(pid, tid)][level])
            if not groups:
                continue
            level_output.append(
                {
                    "level": level,
                    "groups": [
                        [item["event"] for item in group] for group in groups
                    ],
                }
            )
        if level_output:
            threads_output.append(
                {
                    "pid": pid,
                    "tid": tid,
                    "levels": level_output,
                }
            )

    return {"threads": threads_output}


def load_events(input_path: Path):
    try:
        with input_path.open("r", encoding="utf-8") as handle:
            events = json.load(handle)
        if not isinstance(events, list):
            raise ValueError("Input file must be a JSON array of events.")
        return events
    except json.JSONDecodeError:
        events = []
        with input_path.open("r", encoding="utf-8") as handle:
            for line in handle:
                stripped = line.strip()
                if not stripped or stripped in ("[", "]"):
                    continue
                if stripped.endswith(","):
                    stripped = stripped[:-1].rstrip()
                if not stripped:
                    continue
                events.append(json.loads(stripped))
        return events


def main():
    parser = argparse.ArgumentParser(
        description=(
            "Group overlapping events per (pid, tid) from a .pfw trace file."
        )
    )
    parser.add_argument(
        "--input",
        default="unet3d_a100--verify-1.pfw",
        help="Path to the input .pfw file (JSON array).",
    )
    parser.add_argument(
        "--output",
        default="overlap_groups.json",
        help="Path to write grouped overlap results as JSON.",
    )
    args = parser.parse_args()

    input_path = Path(args.input)
    output_path = Path(args.output)

    events = load_events(input_path)

    result = build_overlap_groups(events)

    with output_path.open("w", encoding="utf-8") as handle:
        json.dump(result, handle, ensure_ascii=True, indent=2)


if __name__ == "__main__":
    main()


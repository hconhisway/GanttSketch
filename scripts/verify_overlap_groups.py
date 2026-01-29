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


def _group_is_continuous_overlap(group_events):
    items = []
    for idx, event in enumerate(group_events):
        time_range = _event_time(event)
        if time_range is None:
            return False, f"event[{idx}] missing ts/dur"
        items.append((time_range[0], time_range[1], idx))

    items.sort(key=lambda item: (item[0], item[1], item[2]))
    current_end = None
    for start, end, idx in items:
        if current_end is None:
            current_end = end
            continue
        if start > current_end:
            return False, f"event[{idx}] breaks overlap chain"
        if end > current_end:
            current_end = end
    return True, ""


def verify_overlap_groups(data):
    issues = []
    threads = data.get("threads", [])
    for t_idx, thread in enumerate(threads):
        pid = thread.get("pid")
        tid = thread.get("tid")
        levels = thread.get("levels", [])
        for l_idx, level_entry in enumerate(levels):
            level = level_entry.get("level")
            groups = level_entry.get("groups", [])
            for g_idx, group in enumerate(groups):
                if not isinstance(group, list) or len(group) < 2:
                    issues.append(
                        f"thread[{t_idx}] pid={pid} tid={tid} "
                        f"level[{l_idx}]={level} group[{g_idx}] size<2"
                    )
                    continue
                ok, reason = _group_is_continuous_overlap(group)
                if not ok:
                    issues.append(
                        f"thread[{t_idx}] pid={pid} tid={tid} "
                        f"level[{l_idx}]={level} group[{g_idx}] {reason}"
                    )
    return issues


def main():
    parser = argparse.ArgumentParser(
        description="Verify overlap_groups.json for true overlap groups."
    )
    parser.add_argument(
        "--input",
        default="overlap_groups.json",
        help="Path to overlap_groups.json.",
    )
    args = parser.parse_args()

    input_path = Path(args.input)
    with input_path.open("r", encoding="utf-8") as handle:
        data = json.load(handle)

    issues = verify_overlap_groups(data)
    if issues:
        print(f"Found {len(issues)} issue(s):")
        for issue in issues:
            print(f"- {issue}")
    else:
        print("All groups are continuous overlaps.")


if __name__ == "__main__":
    main()


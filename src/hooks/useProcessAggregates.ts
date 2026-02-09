import { useEffect, useMemo } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { getValueAtPath } from '../utils/expression';
import {
  resolveThreadLaneMode,
  getThreadLaneFieldPath
} from '../utils/processOrder';

type ThreadLevelMap = Map<string | number, any[]>;
type ThreadMap = Map<string, ThreadLevelMap>;
type ThreadsByPid = Map<string, ThreadMap>;

const LANE_KEY_NONE = '__none__';

/** Try path first; if missing, try common alternates so one attribute name works across datasets */
function getLaneKeyValue(ev: any, path: string): unknown {
  const normalizedPath = path.startsWith('event.') ? path.slice(6) : path;
  let v = getValueAtPath(ev, normalizedPath);
  if (v !== undefined && v !== null) return v;
  if (normalizedPath === 'level' || normalizedPath === 'depth' || normalizedPath === 'lane') {
    const alternates = ['level', 'depth', 'lane', 'args.level', 'args.depth', 'args.lane'];
    for (const alt of alternates) {
      if (alt === normalizedPath) continue;
      v = getValueAtPath(ev, alt);
      if (v !== undefined && v !== null) return v;
    }
  }
  return undefined;
}

interface UseProcessAggregatesArgs {
  data: any[];
  obd: any;
  startTime: number;
  endTime: number;
  mergeGapRatio: number;
  hierarchy2LaneRule?: any;
  setThreadsByPid: (next: ThreadsByPid) => void;
  setProcessAggregates: (next: Map<string, any[]>) => void;
  setExpandedPids: Dispatch<SetStateAction<string[]>>;
  threadsByPid: ThreadsByPid;
  processAggregates: Map<string, any[]>;
}

export function useProcessAggregates({
  data,
  obd,
  startTime,
  endTime,
  mergeGapRatio,
  hierarchy2LaneRule,
  setThreadsByPid,
  setProcessAggregates,
  setExpandedPids,
  threadsByPid,
  processAggregates
}: UseProcessAggregatesArgs) {
  const aggregates = useMemo(() => {
    if (!data || data.length === 0 || !obd) {
      return { threadMap: new Map(), processMap: new Map() };
    }

    const mode = resolveThreadLaneMode(hierarchy2LaneRule);
    const laneFieldPath = getThreadLaneFieldPath(hierarchy2LaneRule);
    const useFieldLanes = mode === 'level' && laneFieldPath.length > 0;

    const windowUs = Math.max(0, Number(endTime) - Number(startTime));
    const mergeGapUs = windowUs * mergeGapRatio;
    const threadMap: ThreadsByPid = new Map();

    data.forEach((ev) => {
      const pid = String(ev.pid ?? 'unknown');
      const tid = String(ev.tid ?? pid);
      const start = Number(ev.start);
      const end = Number(ev.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;

      let laneKey: string | number;
      if (useFieldLanes) {
        const raw = getLaneKeyValue(ev, laneFieldPath);
        if (raw !== undefined && raw !== null) {
          laneKey =
            typeof raw === 'number' && Number.isFinite(raw) ? raw : String(raw);
        } else {
          laneKey = LANE_KEY_NONE;
        }
      } else {
        laneKey = 0;
      }

      let tidMap = threadMap.get(pid);
      if (!tidMap) {
        tidMap = new Map();
        threadMap.set(pid, tidMap);
      }

      let levelMap = tidMap.get(tid);
      if (!levelMap) {
        levelMap = new Map();
        tidMap.set(tid, levelMap);
      }

      let bucket = levelMap.get(laneKey);
      if (!bucket) {
        bucket = [];
        levelMap.set(laneKey, bucket);
      }

      const levelForEvent = typeof laneKey === 'number' ? laneKey : (ev.level ?? 0);
      bucket.push({
        ...ev,
        pid,
        tid,
        level: levelForEvent,
        start,
        end,
        count: ev.count ?? 1
      });
    });

    // Sort events within each level
    threadMap.forEach((tidMap: ThreadMap) => {
      tidMap.forEach((levelMap: ThreadLevelMap) => {
        levelMap.forEach((arr: any[]) => {
          arr.sort((a: any, b: any) => a.start - b.start);
        });
      });
    });

    // Build process aggregates by merging close/overlapping events across all threads
    const processMap: Map<string, any[]> = new Map();
    threadMap.forEach((tidMap: ThreadMap, pid: string) => {
      const all: any[] = [];
      tidMap.forEach((levelMap: ThreadLevelMap) => {
        levelMap.forEach((arr: any[]) => {
          if (!Array.isArray(arr) || arr.length === 0) return;
          for (const item of arr) {
            all.push(item);
          }
        });
      });
      all.sort((a, b) => a.start - b.start);

      const merged: any[] = [];
      all.forEach((ev) => {
        if (merged.length === 0) {
          merged.push({ ...ev, count: ev.count ?? 1 });
          return;
        }
        const last = merged[merged.length - 1];
        const gap = ev.start - last.end;
        if (gap <= mergeGapUs) {
          last.end = Math.max(last.end, ev.end);
          last.count = (last.count || 1) + (ev.count || 1);
        } else {
          merged.push({ ...ev, count: ev.count ?? 1 });
        }
      });
      processMap.set(pid, merged);
    });

    return { threadMap, processMap };
  }, [data, obd, startTime, endTime, mergeGapRatio, hierarchy2LaneRule]);

  useEffect(() => {
    setThreadsByPid(aggregates.threadMap);
    setProcessAggregates(aggregates.processMap);
  }, [aggregates, setProcessAggregates, setThreadsByPid]);

  // Drop expanded pids that no longer exist
  useEffect(() => {
    setExpandedPids((prev) =>
      prev.filter((pid) => threadsByPid.has(pid) || processAggregates.has(pid))
    );
  }, [threadsByPid, processAggregates, setExpandedPids]);
}

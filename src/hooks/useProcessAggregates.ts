import { useEffect, useMemo } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { getValueAtPath } from '../utils/expression';
import {
  resolveThreadLaneMode,
  getThreadLaneFieldPath
} from '../utils/processOrder';
import {
  getHierarchyKeysFromHierarchyValues,
  getHierarchyValuesFromEvent
} from '../utils/hierarchy';

type ThreadLevelMap = Map<string | number, any[]>;
type ThreadMap = Map<string, ThreadLevelMap>;
type ThreadsByHierarchy1 = Map<string, ThreadMap>;

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
  mergeUtilGap: number;
  hierarchy2LaneRule?: any;
  setThreadsByHierarchy1: (next: ThreadsByHierarchy1) => void;
  setProcessAggregates: (next: Map<string, any[]>) => void;
  setExpandedHierarchy1Ids: Dispatch<SetStateAction<string[]>>;
  threadsByHierarchy1: ThreadsByHierarchy1;
  processAggregates: Map<string, any[]>;
}

export function useProcessAggregates({
  data,
  obd,
  startTime,
  endTime,
  mergeUtilGap,
  hierarchy2LaneRule,
  setThreadsByHierarchy1,
  setProcessAggregates,
  setExpandedHierarchy1Ids,
  threadsByHierarchy1,
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
    const mergeGapUs = windowUs * mergeUtilGap;
    const threadMap: ThreadsByHierarchy1 = new Map();

    data.forEach((ev) => {
      const hierarchyAliases = getHierarchyKeysFromHierarchyValues(getHierarchyValuesFromEvent(ev));
      const hierarchyValues = hierarchyAliases.hierarchyValues;
      const hierarchy1 = String(hierarchyAliases.hierarchy1 ?? 'unknown');
      const hierarchy2Path =
        hierarchyValues.length > 1
          ? hierarchyValues.slice(1).map((v: any) => String(v ?? '<N/A>')).join('|')
          : String(hierarchyAliases.hierarchy2 ?? hierarchy1);
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
          laneKey = '<N/A>';
        }
      } else {
        laneKey = 0;
      }

      let hierarchy2Map = threadMap.get(hierarchy1);
      if (!hierarchy2Map) {
        hierarchy2Map = new Map();
        threadMap.set(hierarchy1, hierarchy2Map);
      }

      let levelMap = hierarchy2Map.get(hierarchy2Path);
      if (!levelMap) {
        levelMap = new Map();
        hierarchy2Map.set(hierarchy2Path, levelMap);
      }

      let bucket = levelMap.get(laneKey);
      if (!bucket) {
        bucket = [];
        levelMap.set(laneKey, bucket);
      }

      const levelForEvent = typeof laneKey === 'number' ? laneKey : (ev.level ?? 0);
      bucket.push({
        ...ev,
        ...hierarchyAliases,
        hierarchy1,
        hierarchy2: hierarchy2Path,
        hierarchyValues,
        level: levelForEvent,
        start,
        end,
        count: ev.count ?? 1
      });
    });

    // Sort events within each level
    threadMap.forEach((hierarchy2Map: ThreadMap) => {
      hierarchy2Map.forEach((levelMap: ThreadLevelMap) => {
        levelMap.forEach((arr: any[]) => {
          arr.sort((a: any, b: any) => a.start - b.start);
        });
      });
    });

    // Build process aggregates by merging close/overlapping events across all threads
    const processMap: Map<string, any[]> = new Map();
    threadMap.forEach((hierarchy2Map: ThreadMap, hierarchy1: string) => {
      const all: any[] = [];
      hierarchy2Map.forEach((levelMap: ThreadLevelMap) => {
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
      processMap.set(hierarchy1, merged);
    });

    return { threadMap, processMap };
  }, [data, obd, startTime, endTime, mergeUtilGap, hierarchy2LaneRule]);

  useEffect(() => {
    setThreadsByHierarchy1(aggregates.threadMap);
    setProcessAggregates(aggregates.processMap);
  }, [aggregates, setProcessAggregates, setThreadsByHierarchy1]);

  // Drop expanded hierarchy1 ids that no longer exist
  useEffect(() => {
    setExpandedHierarchy1Ids((prev) => {
      const topLevel = new Set<string>();
      threadsByHierarchy1.forEach((_value, key) => topLevel.add(String(key)));
      processAggregates.forEach((_value, key) => topLevel.add(String(key)));
      return prev.filter((expandKey) => {
        const root = String(expandKey).split('|')[0];
        return topLevel.has(root);
      });
    });
  }, [threadsByHierarchy1, processAggregates, setExpandedHierarchy1Ids]);
}

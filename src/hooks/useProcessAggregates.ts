import { useEffect, useMemo, useRef } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { getValueAtPath } from '../utils/expression';
import {
  resolveThreadLaneMode,
  getThreadLaneFieldPath
} from '../utils/processOrder';
import {
  getHierarchyKeysFromHierarchyValues,
  getHierarchyValuesFromEvent,
  resolveHierarchyAggregationRule
} from '../utils/hierarchy';
import type { HierarchyAggregateNode, HierarchyAggregateSegment, HierarchyLevelMap } from '../types/hierarchyAggregation';

type ThreadLevelMap = Map<string | number, any[]>;
type ThreadMap = Map<string, ThreadLevelMap>;
type ThreadsByHierarchy1 = Map<string, ThreadMap>;

type MutableHierarchyNode = {
  key: string;
  segment: string;
  depth: number;
  hierarchy1: string;
  hierarchyPath: string[];
  hierarchyValues: string[];
  sourceEvents: any[];
  children: Map<string, MutableHierarchyNode>;
  levelMap?: HierarchyLevelMap;
};

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
  yAxisConfig?: any;
  setThreadsByHierarchy1: (next: ThreadsByHierarchy1) => void;
  setProcessAggregates: (next: Map<string, any[]>) => void;
  setHierarchyTrees: (next: Map<string, HierarchyAggregateNode>) => void;
  setExpandedHierarchy1Ids: Dispatch<SetStateAction<string[]>>;
  hierarchyTrees: Map<string, HierarchyAggregateNode>;
}

function sortEventsByStart(events: any[]) {
  events.sort((a: any, b: any) => {
    const byStart = Number(a?.start ?? 0) - Number(b?.start ?? 0);
    if (byStart !== 0) return byStart;
    return Number(a?.end ?? 0) - Number(b?.end ?? 0);
  });
}

function resolveLeafLaneRule(yAxisConfig: any, level: number) {
  for (let current = Math.max(2, Math.floor(level)); current >= 2; current -= 1) {
    const direct = yAxisConfig?.[`hierarchy${current}LaneRule`];
    if (direct != null) return direct;
  }
  return yAxisConfig?.hierarchy2LaneRule;
}

function getLeafLaneKey(ev: any, yAxisConfig: any, level: number): string | number {
  const laneRule = resolveLeafLaneRule(yAxisConfig, level);
  const mode = resolveThreadLaneMode(laneRule);
  const laneFieldPath = getThreadLaneFieldPath(laneRule);
  const useFieldLanes = mode === 'level' && laneFieldPath.length > 0;
  if (!useFieldLanes) {
    return 0;
  }
  const raw = getLaneKeyValue(ev, laneFieldPath);
  if (raw !== undefined && raw !== null) {
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : String(raw);
  }
  return '<N/A>';
}

function createMutableHierarchyNode(
  hierarchy1: string,
  hierarchyValues: string[],
  depth: number,
  segment: string,
  hierarchyPath: string[]
): MutableHierarchyNode {
  return {
    key: hierarchyValues.join('|'),
    segment,
    depth,
    hierarchy1,
    hierarchyPath,
    hierarchyValues,
    sourceEvents: [],
    children: new Map<string, MutableHierarchyNode>()
  };
}

function buildAggregateSegments(
  node: MutableHierarchyNode,
  yAxisConfig: any,
  windowUs: number,
  fallbackMergeUtilGap: number
): HierarchyAggregateSegment[] {
  const rule = resolveHierarchyAggregationRule(yAxisConfig, node.depth, fallbackMergeUtilGap);
  const mergeGapRatio = Number(rule?.mergeGapRatio ?? fallbackMergeUtilGap);
  const minGapUs = Math.max(0, Number(rule?.minGapUs ?? 0));
  const mergeGapUs = Math.max(minGapUs, windowUs * Math.max(0, mergeGapRatio));
  const merged: HierarchyAggregateSegment[] = [];

  for (let index = 0; index < node.sourceEvents.length; index += 1) {
    const ev = node.sourceEvents[index];
    if (merged.length === 0) {
      merged.push({
        kind: 'aggregateSegment',
        id: `${node.key}|agg|0`,
        start: Number(ev.start),
        end: Number(ev.end),
        count: Number(ev.count ?? 1),
        depth: node.depth,
        hierarchy1: node.hierarchy1,
        hierarchyPath: [...node.hierarchyPath],
        hierarchyValues: [...node.hierarchyValues],
        sourceEvents: [ev],
        representativeEvent: ev
      });
      continue;
    }

    const last = merged[merged.length - 1];
    const gap = Number(ev.start) - Number(last.end);
    if (gap <= mergeGapUs) {
      last.end = Math.max(Number(last.end), Number(ev.end));
      last.count += Number(ev.count ?? 1);
      last.sourceEvents.push(ev);
    } else {
      merged.push({
        kind: 'aggregateSegment',
        id: `${node.key}|agg|${merged.length}`,
        start: Number(ev.start),
        end: Number(ev.end),
        count: Number(ev.count ?? 1),
        depth: node.depth,
        hierarchy1: node.hierarchy1,
        hierarchyPath: [...node.hierarchyPath],
        hierarchyValues: [...node.hierarchyValues],
        sourceEvents: [ev],
        representativeEvent: ev
      });
    }
  }

  return merged;
}

function finalizeHierarchyNode(
  node: MutableHierarchyNode,
  yAxisConfig: any,
  windowUs: number,
  fallbackMergeUtilGap: number
): HierarchyAggregateNode {
  sortEventsByStart(node.sourceEvents);
  if (node.levelMap) {
    node.levelMap.forEach((events) => sortEventsByStart(events));
  }

  const children = Array.from(node.children.values())
    .sort((a, b) => String(a.segment).localeCompare(String(b.segment), undefined, { numeric: true }))
    .map((child) => finalizeHierarchyNode(child, yAxisConfig, windowUs, fallbackMergeUtilGap));

  const aggregateSegments = buildAggregateSegments(node, yAxisConfig, windowUs, fallbackMergeUtilGap);

  return {
    key: node.key,
    segment: node.segment,
    depth: node.depth,
    hierarchy1: node.hierarchy1,
    hierarchyPath: [...node.hierarchyPath],
    hierarchyValues: [...node.hierarchyValues],
    sourceEvents: node.sourceEvents,
    aggregateSegments,
    children,
    levelMap: node.levelMap,
    representativeEvent: node.sourceEvents[0] ?? aggregateSegments[0]?.representativeEvent ?? null
  };
}

export function useProcessAggregates({
  data,
  obd,
  startTime,
  endTime,
  mergeUtilGap,
  yAxisConfig,
  setThreadsByHierarchy1,
  setProcessAggregates,
  setHierarchyTrees,
  setExpandedHierarchy1Ids,
  hierarchyTrees
}: UseProcessAggregatesArgs) {
  const aggregates = useMemo(() => {
    if (!data || data.length === 0 || !obd) {
      return { threadMap: new Map(), processMap: new Map(), hierarchyTreeMap: new Map() };
    }

    const windowUs = Math.max(0, Number(endTime) - Number(startTime));
    const threadMap: ThreadsByHierarchy1 = new Map();
    const hierarchyTreeMap = new Map<string, MutableHierarchyNode>();

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

      const laneKey = getLeafLaneKey(ev, yAxisConfig, hierarchyValues.length);
      const levelForEvent = typeof laneKey === 'number' ? laneKey : (ev.level ?? 0);
      const normalized = {
        ...ev,
        ...hierarchyAliases,
        hierarchy1,
        hierarchy2: hierarchy2Path,
        hierarchyValues,
        level: levelForEvent,
        start,
        end,
        count: ev.count ?? 1
      };

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

      bucket.push(normalized);

      let rootNode = hierarchyTreeMap.get(hierarchy1);
      if (!rootNode) {
        rootNode = createMutableHierarchyNode(hierarchy1, [hierarchy1], 1, hierarchy1, []);
        hierarchyTreeMap.set(hierarchy1, rootNode);
      }

      let currentNode = rootNode;
      currentNode.sourceEvents.push(normalized);
      for (let index = 1; index < hierarchyValues.length; index += 1) {
        const segment = String(hierarchyValues[index] ?? '<N/A>');
        let child = currentNode.children.get(segment);
        if (!child) {
          const nextValues = hierarchyValues.slice(0, index + 1).map((value) => String(value ?? '<N/A>'));
          child = createMutableHierarchyNode(
            hierarchy1,
            nextValues,
            index + 1,
            segment,
            nextValues.slice(1)
          );
          currentNode.children.set(segment, child);
        }
        child.sourceEvents.push(normalized);
        currentNode = child;
      }

      if (!currentNode.levelMap) currentNode.levelMap = new Map();
      const leafBucket = currentNode.levelMap.get(laneKey);
      if (leafBucket) {
        leafBucket.push(normalized);
      } else {
        currentNode.levelMap.set(laneKey, [normalized]);
      }
    });

    // Sort events within each level
    threadMap.forEach((hierarchy2Map: ThreadMap) => {
      hierarchy2Map.forEach((levelMap: ThreadLevelMap) => {
        levelMap.forEach((arr: any[]) => sortEventsByStart(arr));
      });
    });

    const processMap: Map<string, any[]> = new Map();
    const finalizedHierarchyTrees = new Map<string, HierarchyAggregateNode>();
    hierarchyTreeMap.forEach((node, hierarchy1) => {
      const finalized = finalizeHierarchyNode(node, yAxisConfig, windowUs, mergeUtilGap);
      finalizedHierarchyTrees.set(hierarchy1, finalized);
      processMap.set(hierarchy1, finalized.aggregateSegments);
    });

    return { threadMap, processMap, hierarchyTreeMap: finalizedHierarchyTrees };
  }, [data, obd, startTime, endTime, mergeUtilGap, yAxisConfig]);

  useEffect(() => {
    setThreadsByHierarchy1(aggregates.threadMap);
    setProcessAggregates(aggregates.processMap);
    setHierarchyTrees(aggregates.hierarchyTreeMap);
  }, [aggregates, setHierarchyTrees, setProcessAggregates, setThreadsByHierarchy1]);

  const prevTopRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    const top = new Set<string>();
    hierarchyTrees.forEach((_, key) => top.add(String(key)));
    const prev = prevTopRef.current;
    let shrink = false;
    if (prev != null) {
      if (top.size < prev.size) shrink = true;
      else for (const k of prev) { if (!top.has(k)) { shrink = true; break; } }
    }
    prevTopRef.current = top;
    if (!shrink && prev != null) return;
    setExpandedHierarchy1Ids((p) => p.filter((key) => top.has(String(key).split('|')[0])));
  }, [hierarchyTrees, setExpandedHierarchy1Ids]);
}

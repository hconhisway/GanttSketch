import type { GanttDataMapping } from '../types/ganttConfig';
import type { NormalizedEvent, RenderPrimitive } from '../types/data';
import type { SpanSoAChunkBundle } from '../utils/soaBuffers';
import { buildSoAChunksFromPrimitives } from '../utils/soaBuffers';
import { aggregateLaneEvents } from '../utils/lodAggregation';
import { resolveColorKey } from '../utils/color';
import { getValueAtPath } from '../utils/expression';
import { buildHierarchyLaneKey, getHierarchyFieldsFromMapping } from '../utils/hierarchy';
import {
  dataMappingToFlatFieldMapping,
  getTimeMultiplier,
  processEventsMinimal
} from '../agents/dataAnalysisAgent';

// Keep all lanes by default; viewport lane restriction can hide valid events.
const ENABLE_VIEWPORT_LANE_FILTER = false;
// Keep all events by default; viewport time clipping can hide valid lanes.
const ENABLE_VIEWPORT_TIME_FILTER = true;

type WorkerRequest = {
  id: number;
  rawEvents: any[];
  dataMapping: GanttDataMapping;
  colorConfig?: any;
  legacyColorConfig?: any;
  threadOrderMode?: string;
  laneFieldPath?: string;
  view: {
    timeDomain: [number, number];
    viewportPxWidth: number;
    pixelWindow: number;
    visibleLaneIds: string[];
  };
};

type WorkerResponse = {
  id: number;
  events: NormalizedEvent[];
  soaBundle: SpanSoAChunkBundle;
};

const ctx = globalThis as any;

const getLaneKeyValue = (ev: any, path: string) => {
  if (!path) return undefined;
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
};

const buildAutoLanes = (events: NormalizedEvent[]) => {
  if (!Array.isArray(events) || events.length === 0) return [];
  const sorted = [...events].sort((a, b) => {
    const byStart = (a.start ?? 0) - (b.start ?? 0);
    if (byStart !== 0) return byStart;
    return (a.end ?? 0) - (b.end ?? 0);
  });
  const lanes: NormalizedEvent[][] = [];
  const laneEnds: number[] = [];
  sorted.forEach((ev) => {
    let placedIndex = -1;
    for (let i = 0; i < laneEnds.length; i += 1) {
      if ((ev.start ?? 0) >= laneEnds[i]) {
        placedIndex = i;
        break;
      }
    }
    if (placedIndex === -1) {
      laneEnds.push(ev.end ?? 0);
      lanes.push([ev]);
    } else {
      laneEnds[placedIndex] = Math.max(laneEnds[placedIndex], ev.end ?? 0);
      lanes[placedIndex].push(ev);
    }
  });
  return lanes;
};

const filterByViewport = (
  events: NormalizedEvent[],
  timeDomain: [number, number],
  visibleLaneIds: string[]
) => {
  if (!Array.isArray(events) || events.length === 0) return [];
  const [t0, t1] = timeDomain;
  const laneSet = new Set((visibleLaneIds || []).map((lane) => String(lane)));
  const hasLaneFilter = ENABLE_VIEWPORT_LANE_FILTER && laneSet.size > 0;
  return events.filter((ev) => {
    if (hasLaneFilter) {
      const hierarchyValues = Array.isArray((ev as any)?.hierarchyValues)
        ? (ev as any).hierarchyValues.map((value: any) => String(value ?? ''))
        : [];
      const hierarchy1 = hierarchyValues[0] ?? '';
      const hierarchyPath = hierarchyValues.slice(1).join('|');
      const track = String((ev as any)?.track ?? '');
      if (
        !laneSet.has(hierarchy1) &&
        !laneSet.has(hierarchyPath) &&
        (track ? !laneSet.has(track) : true)
      ) {
        return false;
      }
    }
    const start = Number(ev?.start ?? 0);
    const end = Number(ev?.end ?? 0);
    if (!ENABLE_VIEWPORT_TIME_FILTER) return true;
    return end >= t0 && start <= t1;
  });
};

ctx.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const {
    id,
    rawEvents,
    dataMapping,
    view,
    colorConfig,
    legacyColorConfig,
    threadOrderMode,
    laneFieldPath
  } = event.data;
  const flatMapping = dataMappingToFlatFieldMapping(dataMapping);
  const hierarchyFields = getHierarchyFieldsFromMapping(dataMapping);
  const timeMultiplier = getTimeMultiplier(dataMapping.xAxis.timeUnit);
  const normalized = processEventsMinimal(rawEvents, flatMapping, timeMultiplier, hierarchyFields);
  const filtered = filterByViewport(normalized, view.timeDomain, view.visibleLaneIds || []);

  const laneBuckets = new Map<string, NormalizedEvent[]>();
  if (threadOrderMode === 'auto') {
    const byHierarchyPath = new Map<string, Map<string, NormalizedEvent[]>>();
    filtered.forEach((ev) => {
      const hierarchyValues = Array.isArray((ev as any)?.hierarchyValues)
        ? (ev as any).hierarchyValues
        : ['unknown', '<N/A>'];
      const hierarchy1 = String(hierarchyValues[0] ?? 'unknown');
      const hierarchyPath = String(
        hierarchyValues.length > 1
          ? hierarchyValues.slice(1).map((v: any) => String(v ?? '<N/A>')).join('|')
          : '<N/A>'
      );
      const hierarchyMap = byHierarchyPath.get(hierarchy1) || new Map<string, NormalizedEvent[]>();
      const bucket = hierarchyMap.get(hierarchyPath) || [];
      bucket.push(ev);
      hierarchyMap.set(hierarchyPath, bucket);
      byHierarchyPath.set(hierarchy1, hierarchyMap);
    });
    byHierarchyPath.forEach((pathMap, hierarchy1) => {
      pathMap.forEach((events, hierarchyPath) => {
        const lanes = buildAutoLanes(events);
        lanes.forEach((laneEvents, idx) => {
          const pathValues = [hierarchy1, ...String(hierarchyPath).split('|').filter(Boolean)];
          const laneKey = buildHierarchyLaneKey(pathValues, idx);
          const withLaneKey = laneEvents.map((ev) => ({ ...ev, laneKey }));
          laneBuckets.set(laneKey, withLaneKey);
        });
      });
    });
  } else {
    filtered.forEach((ev) => {
      const hierarchyValues = Array.isArray((ev as any)?.hierarchyValues)
        ? (ev as any).hierarchyValues
        : ['unknown', '<N/A>'];
      let laneValue: unknown;
      if (laneFieldPath && threadOrderMode === 'level') {
        const raw = getLaneKeyValue(ev, laneFieldPath);
        laneValue = raw !== undefined && raw !== null ? raw : '<N/A>';
      } else {
        laneValue = ev?.level ?? 0;
      }
      const laneKey = buildHierarchyLaneKey(hierarchyValues, laneValue ?? 0);
      const bucket = laneBuckets.get(laneKey) || [];
      bucket.push({ ...ev, laneKey });
      laneBuckets.set(laneKey, bucket);
    });
  }

  const primitives: RenderPrimitive[] = [];
  laneBuckets.forEach((events, laneKey) => {
    events.sort((a, b) => a.start - b.start);
    const lanePrimitives = aggregateLaneEvents(events, {
      laneId: laneKey,
      timeDomain: view.timeDomain,
      viewportPxWidth: view.viewportPxWidth,
      pixelWindow: view.pixelWindow,
      colorKeyForEvent: (ev) => {
        const hierarchyValues = Array.isArray((ev as any)?.hierarchyValues)
          ? (ev as any).hierarchyValues
          : ['unknown', '<N/A>'];
        const trackKey = String(
          hierarchyValues.length > 1
            ? hierarchyValues.slice(1).map((v: any) => String(v ?? '<N/A>')).join('|')
            : laneKey
        );
        const trackMeta = {
          type: 'lane',
          hierarchy1: hierarchyValues[0],
          hierarchyPath: hierarchyValues.slice(1),
          level: ev?.level
        };
        return resolveColorKey(ev, trackKey, trackMeta, colorConfig, legacyColorConfig);
      }
    });
    primitives.push(...lanePrimitives);
  });

  const soaBundle = buildSoAChunksFromPrimitives(primitives);

  const response: WorkerResponse = {
    id,
    events: filtered,
    soaBundle
  };

  const transfer: Transferable[] = [];
  soaBundle.chunks.forEach((chunk) => {
    transfer.push(
      chunk.bundle.soa.starts.buffer,
      chunk.bundle.soa.ends.buffer,
      chunk.bundle.soa.laneIds.buffer,
      chunk.bundle.soa.colorIds.buffer,
      chunk.bundle.soa.flags.buffer,
      chunk.bundle.soa.counts.buffer,
      chunk.bundle.meta.laneOffsets.buffer
    );
  });

  ctx.postMessage(response, transfer);
};

export {};

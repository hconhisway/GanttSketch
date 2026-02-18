import type { NormalizedEvent, RenderPrimitive, SummarySpan } from '../types/data';
import {
  getHierarchyKeysFromHierarchyValues,
  getHierarchyValuesFromEvent
} from './hierarchy';

interface LODOptions {
  laneId: string;
  timeDomain: [number, number];
  viewportPxWidth: number;
  pixelWindow: number;
  colorKeyForEvent?: (event: NormalizedEvent) => string;
  /**
   * When true, `events` are assumed sorted ascending by `start`.
   * Enables safe early-exit when `start > t1`.
   */
  eventsSortedByStart?: boolean;
}

const defaultColorKeyForEvent = (event: NormalizedEvent, laneId: string): string =>
  String(
    event?.cat ??
      event?.name ??
      getHierarchyValuesFromEvent(event).join('|') ??
      event?.level ??
      event?.id ??
      laneId
  );

export function aggregateLaneEvents(
  events: NormalizedEvent[],
  {
    laneId,
    timeDomain,
    viewportPxWidth,
    pixelWindow,
    colorKeyForEvent,
    eventsSortedByStart
  }: LODOptions
): RenderPrimitive[] {
  if (!Array.isArray(events) || events.length === 0) return [];
  const [t0, t1] = timeDomain;
  const widthPx = Math.max(1, viewportPxWidth);
  const span = Math.max(1, t1 - t0);
  const windowPx = Math.max(1, pixelWindow);
  const windowTime = (span / widthPx) * windowPx;

  if (!Number.isFinite(windowTime) || windowTime <= 0) {
    return events.map((ev) => ({ ...ev, kind: 'raw' }));
  }

  const buckets = new Map<number, { items: NormalizedEvent[]; minStart: number; maxEnd: number }>();
  for (let i = 0; i < events.length; i += 1) {
    const ev = events[i];
    const start = Number(ev.start ?? 0);
    if (eventsSortedByStart && start > t1) break;
    const end = Number(ev.end ?? 0);
    if (end < t0 || start > t1) continue;
    const idx = Math.floor((start - t0) / windowTime);
    const bucket = buckets.get(idx) || {
      items: [],
      minStart: Number.POSITIVE_INFINITY,
      maxEnd: Number.NEGATIVE_INFINITY
    };
    bucket.items.push(ev);
    bucket.minStart = Math.min(bucket.minStart, start);
    bucket.maxEnd = Math.max(bucket.maxEnd, end);
    buckets.set(idx, bucket);
  }

  const primitives: RenderPrimitive[] = [];
  const orderedKeys = Array.from(buckets.keys()).sort((a, b) => a - b);
  orderedKeys.forEach((idx) => {
    const bucket = buckets.get(idx);
    if (!bucket || bucket.items.length === 0) return;
    if (bucket.items.length === 1) {
      primitives.push({ ...bucket.items[0], kind: 'raw' });
      return;
    }

    const categories: Record<string, number> = {};
    const colorKeyStats = new Map<string, { count: number; sample: NormalizedEvent }>();
    const colorKeyFn =
      typeof colorKeyForEvent === 'function'
        ? colorKeyForEvent
        : (event: NormalizedEvent) => defaultColorKeyForEvent(event, laneId);
    let totalDuration = 0;
    bucket.items.forEach((ev) => {
      const cat = String(ev.cat ?? ev.name ?? 'unknown');
      categories[cat] = (categories[cat] || 0) + 1;
      const colorKey = colorKeyFn(ev);
      const existing = colorKeyStats.get(colorKey);
      if (existing) {
        existing.count += 1;
      } else {
        colorKeyStats.set(colorKey, { count: 1, sample: ev });
      }
      totalDuration += Math.max(0, Number(ev.end ?? 0) - Number(ev.start ?? 0));
    });
    const topCategories = Object.entries(categories)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([key]) => key);

    let dominantColorKey: string | undefined;
    let dominantSample: NormalizedEvent | undefined;
    let dominantCount = -1;
    colorKeyStats.forEach((stats, key) => {
      if (stats.count > dominantCount) {
        dominantCount = stats.count;
        dominantColorKey = key;
        dominantSample = stats.sample;
      }
    });

    const summaryHierarchyAliases = getHierarchyKeysFromHierarchyValues(
      getHierarchyValuesFromEvent(dominantSample)
    );
    const summary: SummarySpan = {
      kind: 'summary',
      lane: laneId,
      start: Number.isFinite(bucket.minStart) ? bucket.minStart : t0,
      end: Number.isFinite(bucket.maxEnd) ? bucket.maxEnd : t0,
      count: bucket.items.length,
      colorKey: dominantColorKey || laneId,
      cat: dominantSample?.cat,
      name: dominantSample?.name,
      ...summaryHierarchyAliases,
      hierarchyValues: summaryHierarchyAliases.hierarchyValues,
      level: dominantSample?.level,
      id: dominantSample?.id,
      args: dominantSample?.args,
      attrSummary: {
        topCategories,
        avgDuration: bucket.items.length > 0 ? totalDuration / bucket.items.length : 0
      }
    };
    primitives.push(summary);
  });

  return primitives;
}

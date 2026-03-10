/**
 * Compute binned time series for the auxiliary overview chart.
 * Overlap-accurate: union intervals per entity to avoid double-counting.
 */

import { evalExpr } from '../utils/expression';
import { getHierarchyValuesFromEvent } from '../utils/hierarchy';
import type { AuxOverviewConfig, BinnedSeries, OverviewModel } from './types';

export interface Interval {
  start: number;
  end: number;
}

/** Get entity key from event. entityLevel 1 = hierarchy1, 2 = hierarchy1|hierarchy2, etc. */
export function getEntityKey(ev: any, entityLevel: number): string {
  const values = getHierarchyValuesFromEvent(ev);
  const n = Math.max(1, Math.min(entityLevel, values.length));
  return values.slice(0, n).join('|');
}

/** Merge overlapping intervals. Input must be sorted by start. */
export function mergeIntervals(intervals: Interval[]): Interval[] {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const out: Interval[] = [{ start: sorted[0].start, end: sorted[0].end }];
  for (let i = 1; i < sorted.length; i++) {
    const last = out[out.length - 1];
    if (sorted[i].start <= last.end) {
      last.end = Math.max(last.end, sorted[i].end);
    } else {
      out.push({ start: sorted[i].start, end: sorted[i].end });
    }
  }
  return out;
}

/** Build map: entityKey -> merged intervals. Events assumed to have start/end in same unit (e.g. us). */
export function buildUnionIntervalsByEntity(
  events: any[],
  entityLevel: number
): Map<string, Interval[]> {
  const byEntity = new Map<string, Interval[]>();
  for (const ev of events) {
    const start = Number(ev.start ?? ev.timeStart ?? 0);
    const end = Number(ev.end ?? ev.timeEnd ?? 0);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const key = getEntityKey(ev, entityLevel);
    let list = byEntity.get(key);
    if (!list) {
      list = [];
      byEntity.set(key, list);
    }
    list.push({ start, end });
  }
  const result = new Map<string, Interval[]>();
  byEntity.forEach((list, key) => {
    result.set(key, mergeIntervals(list));
  });
  return result;
}

/** Overlap length of interval [s,e] with bin [binStart, binEnd]. */
function overlapUs(s: number, e: number, binStart: number, binEnd: number): number {
  const low = Math.max(s, binStart);
  const high = Math.min(e, binEnd);
  return Math.max(0, high - low);
}

/** Compute % utilization per bin: sum(overlap per entity) / (binWidth * entityCount). */
export function computeUtilizationArea(
  binCount: number,
  t0: number,
  t1: number,
  intervalsByEntity: Map<string, Interval[]>
): number[] {
  const span = Math.max(1, t1 - t0);
  const binWidthUs = span / binCount;
  const entityCount = intervalsByEntity.size || 1;
  const values = new Array<number>(binCount).fill(0);

  intervalsByEntity.forEach((intervals) => {
    for (let i = 0; i < binCount; i++) {
      const binStart = t0 + i * binWidthUs;
      const binEnd = t0 + (i + 1) * binWidthUs;
      let total = 0;
      for (const iv of intervals) {
        total += overlapUs(iv.start, iv.end, binStart, binEnd);
      }
      values[i] += total / binWidthUs; // fraction of bin occupied by this entity (0..1)
    }
  });

  for (let i = 0; i < binCount; i++) {
    values[i] = values[i] / entityCount; // average across entities -> 0..1
  }
  return values;
}

/** Compute active entity count per bin (each entity contributes 0 or 1). */
export function computeUtilizationCount(
  binCount: number,
  t0: number,
  t1: number,
  intervalsByEntity: Map<string, Interval[]>
): number[] {
  const span = Math.max(1, t1 - t0);
  const binWidthUs = span / binCount;
  const values = new Array<number>(binCount).fill(0);

  intervalsByEntity.forEach((intervals) => {
    for (let i = 0; i < binCount; i++) {
      const binStart = t0 + i * binWidthUs;
      const binEnd = t0 + (i + 1) * binWidthUs;
      let hasOverlap = false;
      for (const iv of intervals) {
        if (overlapUs(iv.start, iv.end, binStart, binEnd) > 0) {
          hasOverlap = true;
          break;
        }
      }
      if (hasOverlap) values[i] += 1;
    }
  });

  return values;
}

/** Get group key for an event using groupBy expr. */
function getGroupKey(ev: any, groupByExpr: any): string {
  const ctx = {
    event: ev,
    hierarchy1: ev?.hierarchy1 ?? (Array.isArray(ev?.hierarchyValues) ? ev.hierarchyValues[0] : ''),
    hierarchy2: ev?.hierarchy2 ?? (Array.isArray(ev?.hierarchyValues) ? ev.hierarchyValues[1] : '')
  };
  const v = evalExpr(groupByExpr, ctx);
  if (v === undefined || v === null) return '<null>';
  return String(v).trim() || '<empty>';
}

/** Compute stacked series: one series per group key (from groupBy or explicit series). */
export function computeStacked(
  events: any[],
  binCount: number,
  t0: number,
  t1: number,
  config: AuxOverviewConfig,
  entityLevel: number
): BinnedSeries[] {
  const stacked = config.stacked;

  if (stacked?.mode === 'series' && Array.isArray(stacked.series) && stacked.series.length > 0) {
    const evalPredicate = (when: any, ev: any): boolean => {
      const ctx = { event: ev, hierarchy1: ev?.hierarchy1, hierarchy2: ev?.hierarchy2 };
      return Boolean(evalExpr(when, ctx));
    };
    const result: BinnedSeries[] = [];
    for (const s of stacked.series) {
      const filtered = events.filter((ev) => evalPredicate(s.when, ev));
      const byEntity = buildUnionIntervalsByEntity(filtered, entityLevel);
      const values = computeUtilizationArea(binCount, t0, t1, byEntity);
      result.push({
        id: s.id,
        label: s.label ?? s.id,
        values,
        color: s.color
      });
    }
    return result;
  }

  const groupByExpr = stacked?.groupBy;
  if (!groupByExpr) {
    const byEntity = buildUnionIntervalsByEntity(events, entityLevel);
    const values = computeUtilizationArea(binCount, t0, t1, byEntity);
    return [{ id: 'default', label: 'Utilization', values }];
  }

  const byKey = new Map<string, any[]>();
  for (const ev of events) {
    const key = getGroupKey(ev, groupByExpr);
    let list = byKey.get(key);
    if (!list) {
      list = [];
      byKey.set(key, list);
    }
    list.push(ev);
  }

  const totalDurByKey = new Map<string, number>();
  byKey.forEach((evs, key) => {
    let total = 0;
    for (const ev of evs) {
      const s = Number(ev.start ?? 0);
      const e = Number(ev.end ?? 0);
      if (Number.isFinite(s) && Number.isFinite(e)) total += e - s;
    }
    totalDurByKey.set(key, total);
  });

  const topK = Math.max(1, stacked?.topK ?? 8);
  const sortedKeys = [...byKey.keys()].sort(
    (a, b) => (totalDurByKey.get(b) ?? 0) - (totalDurByKey.get(a) ?? 0)
  );
  const includeOther = stacked?.includeOther !== false;
  const keysToUse = sortedKeys.slice(0, topK);
  if (includeOther && sortedKeys.length > topK) keysToUse.push('__other__');

  const palette = [
    '#4C78A8', '#9ECAE9', '#F58518', '#FFBF79', '#54A24B', '#88D27A', '#B79A20', '#F2CF5B',
    '#439894', '#83BCB6'
  ];

  const result: BinnedSeries[] = [];
  keysToUse.forEach((key, idx) => {
    let evs: any[];
    if (key === '__other__') {
      evs = sortedKeys.slice(topK).flatMap((k) => byKey.get(k) ?? []);
    } else {
      evs = byKey.get(key) ?? [];
    }
    const byEntity = buildUnionIntervalsByEntity(evs, entityLevel);
    const values = computeUtilizationArea(binCount, t0, t1, byEntity);
    result.push({
      id: key,
      label: key === '__other__' ? 'Other' : key,
      values,
      color: palette[idx % palette.length]
    });
  });
  return result;
}

/** Resolve bin count from config and container width. */
export function resolveBinCount(
  config: AuxOverviewConfig | undefined,
  innerWidth: number
): number {
  const bins = config?.bins;
  const fixed = bins?.mode === 'fixed' ? bins.fixed : undefined;
  if (typeof fixed === 'number' && Number.isFinite(fixed)) {
    return Math.max(1, Math.floor(fixed));
  }
  const min = Math.max(1, bins?.min ?? 300);
  const max = Math.max(min, bins?.max ?? 900);
  return Math.min(max, Math.max(min, Math.floor(innerWidth)));
}

/** Main entry: compute overview model from events and config. */
export function computeOverviewModel(
  events: any[],
  t0: number,
  t1: number,
  config: AuxOverviewConfig,
  binCount: number
): OverviewModel {
  const entityLevel = Math.max(1, config.entityLevel ?? 1);
  const span = Math.max(1, t1 - t0);
  const binWidthUs = span / binCount;

  const kind = config.kind ?? 'utilizationArea';

  if (kind === 'utilizationArea') {
    const byEntity = buildUnionIntervalsByEntity(events, entityLevel);
    const values = computeUtilizationArea(binCount, t0, t1, byEntity);
    return {
      kind: 'utilizationArea',
      binCount,
      t0,
      t1,
      binWidthUs,
      series: [{ id: 'util', label: 'Utilization %', values }],
      entityCount: byEntity.size
    };
  }

  if (kind === 'utilizationCount') {
    const byEntity = buildUnionIntervalsByEntity(events, entityLevel);
    const values = computeUtilizationCount(binCount, t0, t1, byEntity);
    const binSize = Math.max(1, config.count?.binSize ?? 1);
    const quantized = binSize === 1 ? values : values.map((v) => Math.floor(v / binSize) * binSize);
    return {
      kind: 'utilizationCount',
      binCount,
      t0,
      t1,
      binWidthUs,
      series: [{ id: 'count', label: 'Active count', values: quantized }],
      entityCount: byEntity.size
    };
  }

  const series = computeStacked(events, binCount, t0, t1, config, entityLevel);
  return {
    kind: 'stackedArea',
    binCount,
    t0,
    t1,
    binWidthUs,
    series
  };
}

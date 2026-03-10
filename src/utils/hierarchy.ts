import type { GanttDataMapping, HierarchyAggregationRule, YAxisConfig } from '../types/ganttConfig';

type MaybeString = string | null | undefined;
export type HierarchyAliasMap = {
  hierarchy1: string;
  hierarchy2: string;
  hierarchyValues: string[];
} & Record<string, string | string[]>;

function cleanField(value: MaybeString): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function getPathValue(source: any, path: string | null | undefined): any {
  const clean = cleanField(path);
  if (!clean || source == null || typeof source !== 'object') return undefined;
  return clean.split('.').reduce((acc: any, key: string) => {
    if (acc == null) return undefined;
    return acc[key];
  }, source);
}

export function getHierarchyVarName(level: number): string {
  return `hierarchy${Math.max(1, Math.floor(level))}`;
}

export function getHierarchyFieldsFromMapping(mapping: Partial<GanttDataMapping> | null | undefined): string[] {
  const yAxisFields = Array.isArray(mapping?.yAxis?.hierarchyFields)
    ? mapping!.yAxis!.hierarchyFields
        .map((value) => cleanField(value))
        .filter((value): value is string => Boolean(value))
    : [];
  if (yAxisFields.length > 0) return yAxisFields;

  const featureFields = Array.isArray(mapping?.features?.hierarchyFields)
    ? mapping!.features!.hierarchyFields
        .map((value) => cleanField(value))
        .filter((value): value is string => Boolean(value))
    : [];
  if (featureFields.length > 0) return featureFields;

  const inferredLevels = Number(mapping?.features?.hierarchyLevels ?? 0);
  if (Number.isFinite(inferredLevels) && inferredLevels > 0) {
    return Array.from({ length: Math.max(1, Math.floor(inferredLevels)) }, (_, idx) =>
      getHierarchyVarName(idx + 1)
    );
  }

  return [getHierarchyVarName(1), getHierarchyVarName(2)];
}

export function normalizeHierarchyFeatures(mapping: GanttDataMapping): GanttDataMapping {
  const hierarchyFields = getHierarchyFieldsFromMapping(mapping);
  const hierarchyLevels = Math.max(1, hierarchyFields.length);

  return {
    ...mapping,
    yAxis: {
      ...mapping.yAxis,
      hierarchyFields
    },
    features: {
      ...mapping.features,
      hierarchyLevels,
      hierarchyFields
    }
  };
}

export function buildHierarchyValues(
  event: any,
  raw: any,
  hierarchyFields: string[],
  fallbackLevel1 = 'unknown',
  fallbackLevel2 = '<N/A>'
): string[] {
  if (!Array.isArray(hierarchyFields) || hierarchyFields.length === 0) {
    return [fallbackLevel1];
  }
  return hierarchyFields.map((field, index) => {
    const value = getPathValue(raw, field) ?? getPathValue(event, field);
    if (value === undefined || value === null || String(value).trim() === '') {
      return index === 0 ? fallbackLevel1 : fallbackLevel2;
    }
    return String(value);
  });
}

export function getHierarchyFieldVarName(level: number): string {
  return `hierarchy${Math.max(1, Math.floor(level))}Field`;
}

export function getHierarchyAggregationRuleKey(level: number): string {
  return `hierarchy${Math.max(1, Math.floor(level))}AggregationRule`;
}

export function resolveHierarchyAggregationRule(
  yAxis: Partial<YAxisConfig> | null | undefined,
  level: number,
  fallbackMergeGapRatio = 0.002
): HierarchyAggregationRule {
  const lvl = Math.max(1, Math.floor(level));
  for (let current = lvl; current >= 1; current -= 1) {
    const candidate = yAxis?.[getHierarchyAggregationRuleKey(current) as keyof YAxisConfig];
    if (candidate && typeof candidate === 'object') {
      return candidate as HierarchyAggregationRule;
    }
  }
  return {
    type: 'mergeGap',
    mergeGapRatio: fallbackMergeGapRatio
  };
}

export function getHierarchyLodKey(level: number): string {
  return `hierarchy${Math.max(1, Math.floor(level))}LOD`;
}

export function resolveHierarchyLod(performance: any, level: number): any {
  const lvl = Math.max(1, Math.floor(level));
  for (let current = lvl; current >= 1; current -= 1) {
    const direct = performance?.[getHierarchyLodKey(current)];
    if (direct && typeof direct === 'object') return direct;
  }
  return undefined;
}

export function buildHierarchyLaneKey(
  hierarchyValues: Array<string | number | null | undefined>,
  laneValue: any
): string {
  const parts = (Array.isArray(hierarchyValues) ? hierarchyValues : []).map((value, index) => {
    if (value === undefined || value === null || String(value).trim() === '') {
      return index === 0 ? 'unknown' : '<N/A>';
    }
    return String(value);
  });
  parts.push(String(laneValue ?? 0));
  return parts.join('|');
}

export function getHierarchyValuesFromEvent(event: any): string[] {
  if (Array.isArray(event?.hierarchyValues) && event.hierarchyValues.length > 0) {
    return event.hierarchyValues.map((value: any, index: number) => {
      if (value === undefined || value === null || String(value).trim() === '') {
        return index === 0 ? 'unknown' : '<N/A>';
      }
      return String(value);
    });
  }

  const numberedValues: Array<[number, string]> = [];
  if (event && typeof event === 'object') {
    Object.keys(event).forEach((key) => {
      const match = key.match(/^hierarchy(\d+)$/);
      if (!match) return;
      const level = Number(match[1]);
      if (!Number.isFinite(level) || level <= 0) return;
      const rawValue = event[key];
      if (rawValue === undefined || rawValue === null || String(rawValue).trim() === '') return;
      numberedValues.push([level, String(rawValue)]);
    });
  }
  if (numberedValues.length > 0) {
    numberedValues.sort((a, b) => a[0] - b[0]);
    return numberedValues.map(([, value]) => value);
  }

  return ['unknown'];
}

export function getHierarchyKeysFromHierarchyValues(
  hierarchyValues: Array<string | number | null | undefined>
): HierarchyAliasMap {
  const normalizedValues = (Array.isArray(hierarchyValues) ? hierarchyValues : []).map((value, index) => {
    if (value === undefined || value === null || String(value).trim() === '') {
      return index === 0 ? 'unknown' : '<N/A>';
    }
    return String(value);
  });
  if (normalizedValues.length === 0) normalizedValues.push('unknown');

  const aliases: Record<string, string> = {};
  normalizedValues.forEach((value, index) => {
    aliases[getHierarchyVarName(index + 1)] = value;
  });

  return {
    ...aliases,
    hierarchy1: aliases.hierarchy1 ?? normalizedValues[0] ?? 'unknown',
    hierarchy2: aliases.hierarchy2 ?? aliases.hierarchy1 ?? normalizedValues[0] ?? 'unknown',
    hierarchyValues: normalizedValues
  };
}

export function pruneHierarchyConfig(config: any, levelCount: number): any {
  if (!config || typeof config !== 'object') return config;
  const maxLevel = Math.max(1, Math.floor(levelCount));
  const next = JSON.parse(JSON.stringify(config));

  const yAxis = next?.yAxis;
  if (yAxis && typeof yAxis === 'object') {
    for (const key of Object.keys(yAxis)) {
      const match = key.match(/^hierarchy(\d+)(Field|OrderRule|LaneRule|LabelRule|AggregationRule)$/);
      if (!match) continue;
      const level = Number(match[1]);
      if (!Number.isFinite(level) || level <= maxLevel) continue;
      delete yAxis[key];
    }
  }

  const performance = next?.performance;
  if (performance && typeof performance === 'object') {
    for (const key of Object.keys(performance)) {
      const match = key.match(/^hierarchy(\d+)LOD$/);
      if (!match) continue;
      const level = Number(match[1]);
      if (!Number.isFinite(level) || level <= maxLevel) continue;
      delete performance[key];
    }
  }

  return next;
}


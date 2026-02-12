import { getHierarchyValuesFromEvent } from './hierarchy';

export interface SpanSoA {
  count: number;
  starts: Float64Array;
  ends: Float64Array;
  laneIds: Uint32Array;
  colorIds: Uint16Array;
  flags: Uint8Array;
  counts: Uint32Array;
}

export interface SpanSoAMeta {
  laneKeys: string[];
  laneOffsets: Uint32Array;
}

export interface SpanSoABundle {
  soa: SpanSoA;
  meta: SpanSoAMeta;
}

export type SpanSoAChunk = {
  hierarchy1: string;
  bundle: SpanSoABundle;
};

export interface SpanSoAChunkBundle {
  chunks: SpanSoAChunk[];
}

const laneKeyForPrimitive = (ev: any) => {
  if (ev?.kind === 'summary') {
    return String(ev.lane ?? ev.laneKey ?? 'lane');
  }
  if (ev?.laneKey) return String(ev.laneKey);
  const hierarchyValues = Array.isArray(ev?.hierarchyValues) ? ev.hierarchyValues : [];
  if (hierarchyValues.length > 0) {
    const path = hierarchyValues.map((value: any) => String(value ?? '<N/A>')).join('|');
    return `${path}|${String(ev?.level ?? 0)}`;
  }
  const fallbackPath = getHierarchyValuesFromEvent(ev).join('|');
  return `${fallbackPath}|${String(ev?.level ?? 0)}`;
};

const hierarchy1ForPrimitive = (ev: any) => {
  if (Array.isArray(ev?.hierarchyValues) && ev.hierarchyValues.length > 0) {
    return String(ev.hierarchyValues[0] ?? 'unknown');
  }
  if (ev?.kind === 'summary') {
    const laneKey = String(ev?.lane ?? ev?.laneKey ?? '');
    const parts = laneKey.split('|');
    if (parts.length > 0 && parts[0]) return parts[0];
  }
  return String(ev?.hierarchy1 ?? getHierarchyValuesFromEvent(ev)[0] ?? 'unknown');
};

const hashStringToInt = (input: string) => {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash << 5) - hash + input.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
};

export const buildSoAFromPrimitives = (primitives: any[]): SpanSoABundle => {
  const laneMap = new Map<string, any[]>();
  primitives.forEach((ev) => {
    const laneKey = laneKeyForPrimitive(ev);
    const bucket = laneMap.get(laneKey) || [];
    bucket.push(ev);
    laneMap.set(laneKey, bucket);
  });

  const laneKeys = Array.from(laneMap.keys()).sort();
  const laneOffsets = new Uint32Array(laneKeys.length + 1);
  const totalCount = laneKeys.reduce((sum, key) => sum + (laneMap.get(key)?.length ?? 0), 0);

  const starts = new Float64Array(totalCount);
  const ends = new Float64Array(totalCount);
  const laneIds = new Uint32Array(totalCount);
  const colorIds = new Uint16Array(totalCount);
  const flags = new Uint8Array(totalCount);
  const counts = new Uint32Array(totalCount);

  let cursor = 0;
  laneKeys.forEach((laneKey, laneIndex) => {
    laneOffsets[laneIndex] = cursor;
    const items = laneMap.get(laneKey) || [];
    items.sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
    items.forEach((ev) => {
      const isSummary = ev?.kind === 'summary';
      const colorKey = isSummary
        ? String(ev?.colorKey ?? ev?.cat ?? laneKey)
        : String(ev?.colorKey ?? ev?.cat ?? ev?.hierarchy1 ?? ev?.hierarchy2 ?? laneKey);
      starts[cursor] = Number(ev?.start ?? 0);
      ends[cursor] = Number(ev?.end ?? 0);
      laneIds[cursor] = laneIndex;
      colorIds[cursor] = hashStringToInt(colorKey) & 0xffff;
      flags[cursor] = isSummary ? 1 : 0;
      counts[cursor] = isSummary ? Number(ev?.count ?? 1) : 1;
      cursor += 1;
    });
  });
  laneOffsets[laneKeys.length] = cursor;

  return {
    soa: { count: cursor, starts, ends, laneIds, colorIds, flags, counts },
    meta: { laneKeys, laneOffsets }
  };
};

export const buildSoAChunksFromPrimitives = (primitives: any[]): SpanSoAChunkBundle => {
  const byHierarchy1 = new Map<string, any[]>();
  primitives.forEach((ev) => {
    const key = hierarchy1ForPrimitive(ev);
    const bucket = byHierarchy1.get(key) || [];
    bucket.push(ev);
    byHierarchy1.set(key, bucket);
  });

  const chunks: SpanSoAChunk[] = [];
  byHierarchy1.forEach((items, hierarchy1) => {
    chunks.push({ hierarchy1, bundle: buildSoAFromPrimitives(items) });
  });

  return { chunks };
};

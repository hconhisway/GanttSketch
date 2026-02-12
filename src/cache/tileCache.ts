type TileKey = string;

type TileCacheEntry = {
  events: any[];
  lastUsed: number;
};

type GetRangeArgs = {
  traceId: string;
  laneIds: string[];
  t0: number;
  t1: number;
  pixelWindow: number;
  filtersHash: string;
  tileSizeUs: number;
};

type SetRangeArgs = GetRangeArgs & {
  events: any[];
};

const buildKey = (
  traceId: string,
  laneId: string,
  tileId: number,
  tileSizeUs: number,
  pixelWindow: number,
  filtersHash: string
): TileKey => `${traceId}|${laneId}|${tileId}|${tileSizeUs}|${pixelWindow}|${filtersHash}`;

const tileIdsForRange = (t0: number, t1: number, tileSizeUs: number) => {
  const start = Math.floor(t0 / tileSizeUs);
  const end = Math.floor(t1 / tileSizeUs);
  const ids: number[] = [];
  for (let i = start; i <= end; i += 1) ids.push(i);
  return ids;
};

const extractHierarchyValues = (ev: any): string[] => {
  if (Array.isArray(ev?.hierarchyValues) && ev.hierarchyValues.length > 0) {
    return ev.hierarchyValues
      .map((value: any) => String(value ?? '').trim())
      .filter((value: string) => value.length > 0);
  }

  const numberedValues: Array<[number, string]> = [];
  if (ev && typeof ev === 'object') {
    Object.keys(ev).forEach((key) => {
      const match = key.match(/^hierarchy(\d+)$/);
      if (!match) return;
      const level = Number(match[1]);
      if (!Number.isFinite(level) || level <= 0) return;
      const raw = ev[key];
      if (raw === undefined || raw === null || String(raw).trim() === '') return;
      numberedValues.push([level, String(raw)]);
    });
  }
  if (numberedValues.length > 0) {
    numberedValues.sort((a, b) => a[0] - b[0]);
    return numberedValues.map(([, value]) => value);
  }

  return [ev?.hierarchy1, ev?.hierarchy2]
    .map((value) => String(value ?? '').trim())
    .filter((value) => value.length > 0);
};

const eventKey = (ev: any) =>
  String(
    ev?.id ??
      `${
        extractHierarchyValues(ev).join('|') || `${ev?.hierarchy1 ?? 'p'}|${ev?.hierarchy2 ?? 't'}`
      }|${ev?.start ?? 0}|${ev?.end ?? 0}|${ev?.name ?? ''}`
  );

export class TileCache {
  private entries = new Map<TileKey, TileCacheEntry>();
  private maxEntries: number;

  constructor(maxEntries = 4000) {
    this.maxEntries = maxEntries;
  }

  getRange({ traceId, laneIds, t0, t1, pixelWindow, filtersHash, tileSizeUs }: GetRangeArgs) {
    if (!traceId || !Array.isArray(laneIds) || laneIds.length === 0) {
      return { hit: false, events: [] as any[] };
    }
    const ids = tileIdsForRange(t0, t1, tileSizeUs);
    const now = Date.now();
    const events: any[] = [];
    const seen = new Set<string>();
    for (const laneId of laneIds) {
      for (const tileId of ids) {
        const key = buildKey(traceId, laneId, tileId, tileSizeUs, pixelWindow, filtersHash);
        const entry = this.entries.get(key);
        if (!entry) {
          return { hit: false, events: [] as any[] };
        }
        entry.lastUsed = now;
        for (const ev of entry.events) {
          const k = eventKey(ev);
          if (seen.has(k)) continue;
          seen.add(k);
          events.push(ev);
        }
      }
    }
    return { hit: true, events };
  }

  setRange({
    traceId,
    laneIds,
    t0,
    t1,
    pixelWindow,
    filtersHash,
    tileSizeUs,
    events
  }: SetRangeArgs) {
    if (!traceId || !Array.isArray(events) || events.length === 0) return;
    const now = Date.now();
    const laneSet = new Set((laneIds || []).map((lane) => String(lane)));
    const useLaneFilter = laneSet.size > 0;
    const ids = tileIdsForRange(t0, t1, tileSizeUs);

    events.forEach((ev) => {
      const start = Number(ev?.start ?? 0);
      const tileId = Math.floor(start / tileSizeUs);
      if (!ids.includes(tileId)) return;
      const hierarchyValues = extractHierarchyValues(ev);
      const track = String(ev?.track ?? '');
      const laneKeys = [...hierarchyValues, track].filter(Boolean);
      laneKeys.forEach((laneId) => {
        if (useLaneFilter && !laneSet.has(laneId)) return;
        const key = buildKey(traceId, laneId, tileId, tileSizeUs, pixelWindow, filtersHash);
        const entry = this.entries.get(key);
        if (entry) {
          entry.events.push(ev);
          entry.lastUsed = now;
        } else {
          this.entries.set(key, { events: [ev], lastUsed: now });
        }
      });
    });

    this.evictIfNeeded();
  }

  private evictIfNeeded() {
    if (this.entries.size <= this.maxEntries) return;
    const entriesArray = Array.from(this.entries.entries());
    entriesArray.sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    const removeCount = this.entries.size - this.maxEntries;
    for (let i = 0; i < removeCount; i += 1) {
      const key = entriesArray[i]?.[0];
      if (key) this.entries.delete(key);
    }
  }

  clear() {
    this.entries.clear();
  }
}

export const tileCache = new TileCache();

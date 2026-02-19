import { getHierarchyKeysFromHierarchyValues, getHierarchyValuesFromEvent } from './hierarchy';

export function extractEventFieldPaths(events: any[], maxFields = 60): string[] {
  if (!Array.isArray(events) || events.length === 0) return [];
  const sample = events.slice(0, 50);
  const fields = new Set<string>();

  const walk = (obj: any, prefix = '', depth = 0) => {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
    if (depth > 2) return;
    Object.keys(obj).forEach((key) => {
      const next = prefix ? `${prefix}.${key}` : key;
      fields.add(next);
      walk(obj[key], next, depth + 1);
    });
  };

  sample.forEach((event) => walk(event));

  return Array.from(fields).slice(0, maxFields);
}

export function buildProcessStats(events: any[]): Map<string, any> {
  const stats = new Map<string, any>();
  if (!Array.isArray(events)) return stats;
  events.forEach((ev) => {
    const hierarchy1 =
      ev?.hierarchy1 ??
      (Array.isArray(ev?.hierarchyValues) && ev.hierarchyValues.length > 0
        ? ev.hierarchyValues[0]
        : undefined);
    if (hierarchy1 === undefined || hierarchy1 === null) return;
    const key = String(hierarchy1);
    const start = Number(ev.start ?? ev.timeStart ?? 0);
    const end = Number(ev.end ?? ev.timeEnd ?? 0);
    const duration = Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0;
    const entry = stats.get(key) || {
      hierarchy1: key,
      count: 0,
      totalDurUs: 0,
      maxDurUs: 0,
      minStart: Number.POSITIVE_INFINITY,
      maxEnd: 0
    };
    entry.count += 1;
    entry.totalDurUs += duration;
    entry.maxDurUs = Math.max(entry.maxDurUs, duration);
    entry.minStart = Math.min(entry.minStart, start);
    entry.maxEnd = Math.max(entry.maxEnd, end);
    stats.set(key, entry);
  });
  stats.forEach((entry) => {
    entry.avgDurUs = entry.count > 0 ? entry.totalDurUs / entry.count : 0;
    if (!Number.isFinite(entry.minStart)) entry.minStart = 0;
  });
  return stats;
}

export interface FetchViewportOptions {
  signal?: AbortSignal;
  sessionId?: string;
  lanes?: string[];
  viewportPxWidth?: number;
  pixelWindow?: number;
  summary?: number;
  filters?: any[];
}

export async function fetchData(
  begin: number,
  end: number,
  bins: number,
  apiUrl: string,
  options: FetchViewportOptions = {}
): Promise<any> {
  try {
    const params = new URLSearchParams();
    params.set('begin', String(begin));
    params.set('end', String(end));
    if (options.sessionId) params.set('session', String(options.sessionId));
    if (Number.isFinite(Number(bins))) params.set('bins', String(bins));
    if (Number.isFinite(Number(options.viewportPxWidth))) {
      params.set('viewportPxWidth', String(options.viewportPxWidth));
    }
    if (Number.isFinite(Number(options.pixelWindow))) {
      params.set('pixelWindow', String(options.pixelWindow));
    }
    if (Number.isFinite(Number(options.summary))) {
      params.set('summary', String(options.summary));
    }
    if (Array.isArray(options.lanes) && options.lanes.length > 0) {
      params.set('lanes', options.lanes.join(','));
    }
    if (Array.isArray(options.filters) && options.filters.length > 0) {
      params.set('filters', JSON.stringify(options.filters));
    }
    const response = await fetch(`${apiUrl}?${params.toString()}`, {
      signal: options.signal
    });

    if (!response.ok) {
      let payload: any = null;
      let bodyText = '';
      try {
        const ct = response.headers.get('content-type') || '';
        if (ct.includes('application/json')) {
          payload = await response.json();
        } else {
          bodyText = await response.text();
        }
      } catch {
        // ignore body parse errors
      }

      const message =
        payload?.error ||
        payload?.message ||
        bodyText ||
        `HTTP error! status: ${response.status}`;

      const err: any = new Error(String(message));
      err.status = response.status;
      err.payload = payload;
      if (payload?.needsUpload || payload?.needs_upload) {
        err.needsUpload = true;
      }
      throw err;
    }

    const rawData = await response.json();
    return rawData;
  } catch (error) {
    console.error('Error fetching data:', error);
    throw error;
  }
}

const getEventTimeBounds = (event: any): [number, number] => {
  const startCandidate =
    event?.start ??
    event?.timeStart ??
    event?.enter?.Timestamp ??
    event?.Timestamp ??
    event?.ts;
  const durCandidate = event?.dur ?? event?.duration ?? event?.timeDur ?? 0;
  const endCandidate =
    event?.end ??
    event?.timeEnd ??
    event?.leave?.Timestamp ??
    (startCandidate !== undefined ? Number(startCandidate) + Number(durCandidate) : undefined);

  const start = Number(startCandidate);
  let end = Number(endCandidate);
  if (!Number.isFinite(start)) return [0, 0];
  if (!Number.isFinite(end) || end <= start) {
    end = start + Math.max(1, Number(durCandidate) || 1);
  }
  return [start, end];
};

export function simulateStreamingFetch(
  fullData: any[],
  request: { timeWindow: [number, number]; laneIds: string[]; summaryLevel: number }
): { events: any[]; metadata: any } {
  const [t0, t1] = request.timeWindow;
  const laneSet = new Set((request.laneIds || []).map((lane) => String(lane)));
  const useLaneFilter = laneSet.size > 0;

  const events = (Array.isArray(fullData) ? fullData : []).filter((event) => {
    const [start, end] = getEventTimeBounds(event);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
    if (end < t0 || start > t1) return false;
    if (!useLaneFilter) return true;

    const hierarchyValues = getHierarchyValuesFromEvent(event);
    const hierarchy1 = hierarchyValues[0] ?? '';
    const hierarchyPath = hierarchyValues.slice(1).join('|');
    const track = String(event?.track ?? '');
    return laneSet.has(hierarchy1) || (hierarchyPath && laneSet.has(hierarchyPath)) || (track && laneSet.has(track));
  });

  return {
    events,
    metadata: {
      begin: t0,
      end: t1,
      count: events.length,
      summary: request.summaryLevel
    }
  };
}

export function parseFrontendTraceText(text: string): any[] {
  const trimmed = String(text || '').trim();
  if (!trimmed) return [];

  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // Fall through to line-based parsing.
    }
  }

  const events: any[] = [];
  const lines = trimmed.split(/\r?\n/);
  lines.forEach((line) => {
    const raw = line.trim();
    if (!raw || raw === '[' || raw === ']') return;
    const normalized = raw.endsWith(',') ? raw.slice(0, -1) : raw;
    try {
      events.push(JSON.parse(normalized));
    } catch (e) {
      // Skip malformed lines but keep parsing others.
    }
  });
  return events;
}

export function buildFrontendPayloadFromText(text: string): {
  events: any[];
  metadata: { count: number; source: string };
} {
  const events = parseFrontendTraceText(text);
  if (!Array.isArray(events) || events.length === 0) {
    throw new Error('Trace file is empty or invalid.');
  }
  return { events, metadata: { count: events.length, source: 'frontend' } };
}

export async function fetchFrontendData(
  traceUrl: string,
  options: FetchViewportOptions = {}
): Promise<any> {
  const response = await fetch(traceUrl, { cache: 'no-store', signal: options.signal });
  if (!response.ok) {
    throw new Error(`Frontend trace not found (${response.status}) at ${traceUrl}`);
  }
  const text = await response.text();
  try {
    return buildFrontendPayloadFromText(text);
  } catch (e: any) {
    const msg = e?.message || 'invalid trace format';
    throw new Error(`Frontend trace file is invalid: ${msg}`);
  }
}

export async function fetchDataWithFallback(
  begin: number,
  end: number,
  bins: number,
  apiUrl: string,
  traceUrl: string,
  localTraceText: string,
  options: FetchViewportOptions = {}
): Promise<any> {
  try {
    return await fetchData(begin, end, bins, apiUrl, options);
  } catch (backendError: any) {
    const backendNeedsUpload = Boolean(
      backendError?.needsUpload || backendError?.needs_upload || backendError?.status === 409
    );
    if (backendNeedsUpload) {
      backendError.needsUpload = true;
      throw backendError;
    }

    if (localTraceText) {
      try {
        return buildFrontendPayloadFromText(localTraceText);
      } catch (e) {
        console.warn('[data] local upload invalid, ignoring:', e);
        // Fall through to frontend trace fallback.
      }
    }

    console.warn('[data] backend unavailable, falling back to frontend trace:', backendError);
    try {
      return await fetchFrontendData(traceUrl, options);
    } catch (fallbackError: any) {
      const backendMsg = backendError?.message || 'unknown backend error';
      const fallbackMsg = fallbackError?.message || 'unknown frontend error';
      const err: any = new Error(
        `Backend unavailable (${backendMsg}); frontend fallback failed (${fallbackMsg}).`
      );
      err.needsUpload = true;
      throw err;
    }
  }
}

export function extractForkFieldsFromRawEvent(ev: any): {
  hierarchy1: string;
  ppid: string | null;
  name: string;
  args: any;
  raw: any;
} {
  const raw =
    ev?.Raw ??
    ev?.raw ??
    ev?.enter?.Raw ??
    ev?.enter?.raw ??
    ev?.leave?.Raw ??
    ev?.leave?.raw ??
    ev;

  const args = raw?.args ?? ev?.args ?? ev?.enter?.args ?? ev?.leave?.args ?? {};

  const nameValue =
    raw?.name ??
    ev?.name ??
    raw?.Name ??
    ev?.Name ??
    args?.name ??
    ev?.Primitive ??
    raw?.Primitive ??
    '';

  const hierarchy1Value =
    raw?.pid ??
    ev?.pid ??
    ev?.hierarchy1 ??
    raw?.PID ??
    ev?.PID ??
    args?.pid ??
    args?.PID ??
    args?.processId ??
    args?.process_id ??
    ev?.Location ??
    'unknown';

  const ppidValue =
    raw?.ppid ??
    ev?.ppid ??
    raw?.PPID ??
    ev?.PPID ??
    args?.ppid ??
    args?.PPID ??
    args?.parentPid ??
    args?.parent_pid ??
    args?.parentProcessId ??
    args?.parent_process_id ??
    null;

  const hierarchy1 = hierarchy1Value === undefined || hierarchy1Value === null ? '' : String(hierarchy1Value);
  const ppid = ppidValue === undefined || ppidValue === null ? null : String(ppidValue);
  const name = String(nameValue ?? '');

  return { hierarchy1, ppid, name, args, raw };
}

export function buildProcessForkRelationsFromRawEvents(rawEvents: any[]): {
  parentByHierarchy1: Map<string, string>;
  childrenByHierarchy1: Map<string, string[]>;
  edges: { parentHierarchy1: string; hierarchy1: string }[];
  conflicts: { hierarchy1: string; parentHierarchy1Existing: string; parentHierarchy1New: string }[];
  startEventCount: number;
  missingPpidCount: number;
  missingHierarchy1Count: number;
  debug: {
    startContainsCount: number;
    startNameExamples: string[];
    ppidSourceHits: Record<string, number>;
  };
} {
  const parentByHierarchy1 = new Map<string, string>(); // hierarchy1 -> parentHierarchy1
  const childrenByHierarchy1 = new Map<string, string[]>(); // parentHierarchy1 -> [hierarchy1...]
  const edges: { parentHierarchy1: string; hierarchy1: string }[] = [];
  const conflicts: { hierarchy1: string; parentHierarchy1Existing: string; parentHierarchy1New: string }[] = [];
  let startEventCount = 0;
  let missingPpidCount = 0;
  let missingHierarchy1Count = 0;
  let startContainsCount = 0;
  const startNameExamples: string[] = [];
  const ppidSourceHits: Record<string, number> = {
    raw_ppid: 0,
    ev_ppid: 0,
    args_ppid: 0,
    args_PPID: 0,
    args_parentPid: 0,
    args_parent_pid: 0
  };

  if (!Array.isArray(rawEvents)) {
    return {
      parentByHierarchy1,
      childrenByHierarchy1,
      edges,
      conflicts,
      startEventCount,
      missingPpidCount,
      missingHierarchy1Count,
      debug: { startContainsCount, startNameExamples, ppidSourceHits }
    };
  }

  for (const ev of rawEvents) {
    const { hierarchy1, ppid, name, args, raw } = extractForkFieldsFromRawEvent(ev);
    const nameLower = String(name || '').toLowerCase();

    if (nameLower.includes('start') && nameLower !== 'start') {
      startContainsCount += 1;
      if (startNameExamples.length < 10 && !startNameExamples.includes(name)) {
        startNameExamples.push(name);
      }
    }

    if (nameLower !== 'start') continue;
    startEventCount += 1;

    if (!hierarchy1) {
      missingHierarchy1Count += 1;
      continue;
    }

    // Extra source diagnostics (for "why ppid is missing")
    if (raw && raw.ppid !== undefined && raw.ppid !== null) ppidSourceHits.raw_ppid += 1;
    if (ev && ev.ppid !== undefined && ev.ppid !== null) ppidSourceHits.ev_ppid += 1;
    if (args && args.ppid !== undefined && args.ppid !== null) ppidSourceHits.args_ppid += 1;
    if (args && args.PPID !== undefined && args.PPID !== null) ppidSourceHits.args_PPID += 1;
    if (args && args.parentPid !== undefined && args.parentPid !== null)
      ppidSourceHits.args_parentPid += 1;
    if (args && args.parent_pid !== undefined && args.parent_pid !== null)
      ppidSourceHits.args_parent_pid += 1;

    if (ppid === undefined || ppid === null || ppid === '') {
      missingPpidCount += 1;
      continue;
    }
    if (hierarchy1 === ppid) continue;

    if (parentByHierarchy1.has(hierarchy1)) {
      const existing = parentByHierarchy1.get(hierarchy1) ?? '';
      if (existing !== ppid) {
        conflicts.push({ hierarchy1, parentHierarchy1Existing: existing, parentHierarchy1New: ppid });
      }
      continue;
    }

    parentByHierarchy1.set(hierarchy1, ppid);
    edges.push({ parentHierarchy1: ppid, hierarchy1 });

    if (!childrenByHierarchy1.has(ppid)) childrenByHierarchy1.set(ppid, []);
    childrenByHierarchy1.get(ppid)!.push(hierarchy1);
  }

  return {
    parentByHierarchy1,
    childrenByHierarchy1,
    edges,
    conflicts,
    startEventCount,
    missingPpidCount,
    missingHierarchy1Count,
    debug: { startContainsCount, startNameExamples, ppidSourceHits }
  };
}

export function buildProcessForkRelations(events: any[]): {
  parentByHierarchy1: Map<string, string>;
  childrenByHierarchy1: Map<string, string[]>;
  edges: { parentHierarchy1: string; hierarchy1: string }[];
  conflicts: { hierarchy1: string; parentHierarchy1Existing: string; parentHierarchy1New: string }[];
  startEventCount: number;
  missingPpidCount: number;
} {
  const parentByHierarchy1 = new Map<string, string>();
  const childrenByHierarchy1 = new Map<string, string[]>();
  const edges: { parentHierarchy1: string; hierarchy1: string }[] = [];
  const conflicts: { hierarchy1: string; parentHierarchy1Existing: string; parentHierarchy1New: string }[] = [];
  let startEventCount = 0;
  let missingPpidCount = 0;

  if (!Array.isArray(events)) {
    return { parentByHierarchy1, childrenByHierarchy1, edges, conflicts, startEventCount, missingPpidCount };
  }

  for (const ev of events) {
    const nameLower = String(ev?.name ?? '').toLowerCase();
    if (!ev || nameLower !== 'start') continue;
    startEventCount += 1;

    const hierarchy1 = ev.hierarchy1 === undefined || ev.hierarchy1 === null ? '' : String(ev.hierarchy1);
    if (!hierarchy1) continue;

    const ppidValue = ev.ppid ?? ev.args?.ppid ?? ev.args?.PPID;
    if (ppidValue === undefined || ppidValue === null) {
      missingPpidCount += 1;
      continue;
    }
    const parentHierarchy1 = String(ppidValue);
    if (!parentHierarchy1 || hierarchy1 === parentHierarchy1) continue;

    if (parentByHierarchy1.has(hierarchy1)) {
      const existing = parentByHierarchy1.get(hierarchy1) ?? '';
      if (existing !== parentHierarchy1) {
        conflicts.push({ hierarchy1, parentHierarchy1Existing: existing, parentHierarchy1New: parentHierarchy1 });
      }
      continue;
    }

    parentByHierarchy1.set(hierarchy1, parentHierarchy1);
    edges.push({ parentHierarchy1, hierarchy1 });

    if (!childrenByHierarchy1.has(parentHierarchy1)) childrenByHierarchy1.set(parentHierarchy1, []);
    childrenByHierarchy1.get(parentHierarchy1)!.push(hierarchy1);
  }

  return { parentByHierarchy1, childrenByHierarchy1, edges, conflicts, startEventCount, missingPpidCount };
}

export function transformData(rawData: any): any[] {
  if (!rawData) return [];

  // New event API: { events: [...], metadata: { begin, end, count } }
  if (Array.isArray(rawData.events)) {
    const events = rawData.events
      .map((ev: any) => {
        const raw = ev.Raw ?? ev.raw ?? ev;
        const args = raw.args ?? ev.args ?? {};
        const h1 = raw.pid ?? ev.pid ?? ev.hierarchy1 ?? ev.Location ?? 'unknown';
        const h2 = raw.tid ?? ev.tid ?? ev.hierarchy2 ?? h1;
        const hierarchyValues = getHierarchyValuesFromEvent({
          ...raw,
          ...ev,
          hierarchy1: h1,
          hierarchy2: h2
        });
        const hierarchyAliases = getHierarchyKeysFromHierarchyValues(hierarchyValues);
        const ppidValue = raw.ppid ?? ev.ppid ?? args.ppid ?? args.PPID;
        const ppid = ppidValue === undefined || ppidValue === null ? null : String(ppidValue);
        const levelRaw = args.level ?? raw.level ?? ev.level ?? 0;
        const level = Number.isFinite(Number(levelRaw)) ? Number(levelRaw) : 0;

        // Prefer relative microsecond timestamps if present
        const startCandidate = ev.enter?.Timestamp ?? ev.Timestamp ?? raw.ts ?? ev.ts;
        const durCandidate = raw.dur ?? ev.dur ?? 0;
        let endCandidate =
          ev.leave?.Timestamp ??
          (startCandidate !== undefined
            ? Number(startCandidate) + Number(durCandidate)
            : undefined);
        // Backend may send leave.Timestamp 0; treat as invalid and use start + duration
        if (endCandidate !== undefined && Number(endCandidate) <= Number(startCandidate || 0)) {
          endCandidate =
            startCandidate !== undefined
              ? Number(startCandidate) + Math.max(1, Number(durCandidate) || 1)
              : undefined;
        }

        const start = Number(startCandidate);
        const end = Number(endCandidate);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;

        // Preserve ALL original fields, then add/override with internal fields
        return {
          ...raw, // Preserve all original fields (ts, dur, etc.)
          ...ev, // Preserve wrapper fields if any
          // Internal fields for chart rendering (these override if they exist in original)
          kind: 'raw',
          ...hierarchyAliases,
          hierarchyValues: hierarchyAliases.hierarchyValues,
          ppid,
          level,
          start, // microseconds
          end, // microseconds
          id: raw.id ?? ev.id ?? ev.GUID ?? ev.intervalId ?? null,
          name: raw.name ?? ev.name ?? ev.Primitive ?? '',
          cat: raw.cat ?? ev.cat ?? '',
          args
        };
      })
      .filter(Boolean);

    // Ensure timeline starts at 0 if backend returns absolute timestamps
    // Heuristic: epoch-microseconds are ~1e15; relative traces are typically < 1e11.
    const minStart = events.length > 0 ? Math.min(...events.map((e: any) => e.start)) : 0;
    if (minStart > 1e12) {
      events.forEach((e: any) => {
        e.start -= minStart;
        e.end -= minStart;
        // Also adjust original time fields if they exist (to maintain consistency)
        if (typeof e.ts === 'number') e.ts -= minStart;
        if (typeof e.timestamp === 'number') e.timestamp -= minStart;
      });
    }

    // Sort for later binary search / merging
    events.sort((a: any, b: any) => a.start - b.start);
    return events;
  }

  // Legacy util API fallback: { metadata:{begin,end,bins}, data:[{track,utils}] }
  if (Array.isArray(rawData.data) && rawData.metadata) {
    const metaBegin = rawData.metadata.begin ?? 0;
    const metaEnd = rawData.metadata.end ?? 0;
    const metaBins = rawData.metadata.bins || 1;
    const binDuration = metaBins > 0 ? (metaEnd - metaBegin) / metaBins : 0;

    const events: any[] = [];
    rawData.data.forEach((item: any) => {
      const hierarchy1 = item.hierarchy1 ?? item.pid ?? item.process ?? item.track ?? 'unknown';
      const hierarchy2 = item.hierarchy2 ?? item.tid ?? item.thread ?? item.track ?? hierarchy1;
      const hierarchyAliases = getHierarchyKeysFromHierarchyValues(
        getHierarchyValuesFromEvent({
          ...item,
          hierarchy1,
          hierarchy2
        })
      );
      const level = Number.isFinite(Number(item.level)) ? Number(item.level) : 0;
      const utils = item.utils || [];

      utils.forEach((utilValue: any, binIndex: number) => {
        const utilFloat = parseFloat(utilValue);
        if (!isFinite(utilFloat) || utilFloat <= 0) return;
        const start = metaBegin + binIndex * binDuration;
        const end = start + binDuration;
        events.push({
          kind: 'raw',
          ...hierarchyAliases,
          hierarchyValues: hierarchyAliases.hierarchyValues,
          level,
          start,
          end,
          id: `${hierarchy1}-${binIndex}`,
          name: 'util',
          cat: 'util',
          args: { util: utilFloat }
        });
      });
    });
    events.sort((a, b) => a.start - b.start);
    return events;
  }

  return [];
}

export function processTracksConfig(
  data: any[],
  config: any = {}
): {
  processedData: any[];
  trackOrder: string[];
  trackGroups: Array<{ name: string; tracks: string[] }> | null;
} {
  const {
    sortMode = 'asc',
    customSort = null,
    groups = null,
    filter = null,
    trackList = null
  } = config;

  const getTrackKey = (item: any) => {
    const hierarchyPath =
      Array.isArray(item?.hierarchyValues) && item.hierarchyValues.length > 0
        ? item.hierarchyValues.map((value: any) => String(value ?? '')).filter(Boolean).join('|')
        : '';
    const fallbackHierarchyTrack =
      hierarchyPath ||
      item?.hierarchy1 ||
      item?.hierarchy2 ||
      item?.pid ||
      item?.tid ||
      'unknown';
    return String(item?.track ?? fallbackHierarchyTrack);
  };

  // Get unique tracks from data
  let uniqueTracks = [...new Set(data.map(getTrackKey))];

  // Apply filtering
  let filteredTracks = uniqueTracks;
  if (trackList && trackList.length > 0) {
    // Use explicit track list
    filteredTracks = trackList.filter((track: string) => uniqueTracks.includes(track));
  } else if (filter) {
    // Use filter function
    filteredTracks = uniqueTracks.filter((track) => filter(track));
  }

  // Filter data to only include selected tracks
  const filteredData = data.filter((d) => filteredTracks.includes(getTrackKey(d)));

  // Apply sorting or grouping
  let trackOrder: string[] = [];
  let trackGroups: Array<{ name: string; tracks: string[] }> | null = null;

  if (sortMode === 'grouped' && groups && groups.length > 0) {
    // Group mode
    trackGroups = [];
    const assignedTracks = new Set<string>();

    // Sort groups by order
    const sortedGroups = [...groups].sort((a, b) => (a.order || 0) - (b.order || 0));

    sortedGroups.forEach((group, groupIndex) => {
      const groupTracks = group.tracks.filter(
        (track: string) => filteredTracks.includes(track) && !assignedTracks.has(track)
      );

      if (groupTracks.length > 0) {
        trackGroups!.push({
          name: group.name,
          tracks: groupTracks
        });
        groupTracks.forEach((track: string) => assignedTracks.add(track));
        trackOrder.push(...groupTracks);

        // Add spacer between groups (except after the last group)
        if (groupIndex < sortedGroups.length - 1) {
          trackOrder.push(`__spacer_${groupIndex}__`);
        }
      }
    });

    // Add ungrouped tracks at the end
    const ungroupedTracks = filteredTracks.filter((track) => !assignedTracks.has(track));
    if (ungroupedTracks.length > 0) {
      // Sort ungrouped tracks
      ungroupedTracks.sort((a, b) => {
        if (typeof a === 'string' && typeof b === 'string') {
          const numA = parseFloat(a);
          const numB = parseFloat(b);
          if (!isNaN(numA) && !isNaN(numB)) {
            return numA - numB;
          }
          return a.localeCompare(b);
        }
        return 0;
      });

      // Add spacer before ungrouped tracks if there are any grouped tracks
      if (trackGroups.length > 0) {
        trackOrder.push(`__spacer_ungrouped__`);
      }

      trackGroups.push({
        name: 'Other',
        tracks: ungroupedTracks
      });
      trackOrder.push(...ungroupedTracks);
    }
  } else if (sortMode === 'custom' && customSort) {
    // Custom sorting function
    trackOrder = [...filteredTracks].sort(customSort);
  } else if (sortMode === 'desc') {
    // Descending order
    trackOrder = [...filteredTracks].sort((a, b) => {
      if (typeof a === 'string' && typeof b === 'string') {
        const numA = parseFloat(a);
        const numB = parseFloat(b);
        if (!isNaN(numA) && !isNaN(numB)) {
          return numB - numA;
        }
        return b.localeCompare(a);
      }
      return 0;
    });
  } else {
    // Default: ascending order
    trackOrder = [...filteredTracks].sort((a, b) => {
      if (typeof a === 'string' && typeof b === 'string') {
        const numA = parseFloat(a);
        const numB = parseFloat(b);
        if (!isNaN(numA) && !isNaN(numB)) {
          return numA - numB;
        }
        return a.localeCompare(b);
      }
      return 0;
    });
  }

  return {
    processedData: filteredData,
    trackOrder,
    trackGroups
  };
}

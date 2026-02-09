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
    const pid = ev?.pid;
    if (pid === undefined || pid === null) return;
    const key = String(pid);
    const start = Number(ev.start ?? ev.timeStart ?? 0);
    const end = Number(ev.end ?? ev.timeEnd ?? 0);
    const duration = Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0;
    const entry = stats.get(key) || {
      pid: key,
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

export async function fetchData(
  begin: number,
  end: number,
  bins: number,
  apiUrl: string
): Promise<any> {
  try {
    const response = await fetch(`${apiUrl}?begin=${begin}&end=${end}`);

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const rawData = await response.json();
    return rawData;
  } catch (error) {
    console.error('Error fetching data:', error);
    throw error;
  }
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

export async function fetchFrontendData(traceUrl: string): Promise<any> {
  const response = await fetch(traceUrl, { cache: 'no-store' });
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
  localTraceText: string
): Promise<any> {
  if (localTraceText) {
    try {
      return buildFrontendPayloadFromText(localTraceText);
    } catch (e) {
      console.warn('[data] local upload invalid, ignoring:', e);
      // Fall through to backend/frontend attempts.
    }
  }

  try {
    return await fetchData(begin, end, bins, apiUrl);
  } catch (backendError: any) {
    console.warn('[data] backend unavailable, falling back to frontend trace:', backendError);
    try {
      return await fetchFrontendData(traceUrl);
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
  pid: string;
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

  const pidValue =
    raw?.pid ??
    ev?.pid ??
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

  const pid = pidValue === undefined || pidValue === null ? '' : String(pidValue);
  const ppid = ppidValue === undefined || ppidValue === null ? null : String(ppidValue);
  const name = String(nameValue ?? '');

  return { pid, ppid, name, args, raw };
}

export function buildProcessForkRelationsFromRawEvents(rawEvents: any[]): {
  parentByPid: Map<string, string>;
  childrenByPid: Map<string, string[]>;
  edges: { ppid: string; pid: string }[];
  conflicts: { pid: string; ppidExisting: string; ppidNew: string }[];
  startEventCount: number;
  missingPpidCount: number;
  missingPidCount: number;
  debug: {
    startContainsCount: number;
    startNameExamples: string[];
    ppidSourceHits: Record<string, number>;
  };
} {
  const parentByPid = new Map<string, string>(); // pid -> ppid
  const childrenByPid = new Map<string, string[]>(); // ppid -> [pid...]
  const edges: { ppid: string; pid: string }[] = []; // [{ ppid, pid }]
  const conflicts: { pid: string; ppidExisting: string; ppidNew: string }[] = [];
  let startEventCount = 0;
  let missingPpidCount = 0;
  let missingPidCount = 0;
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
      parentByPid,
      childrenByPid,
      edges,
      conflicts,
      startEventCount,
      missingPpidCount,
      missingPidCount,
      debug: { startContainsCount, startNameExamples, ppidSourceHits }
    };
  }

  for (const ev of rawEvents) {
    const { pid, ppid, name, args, raw } = extractForkFieldsFromRawEvent(ev);
    const nameLower = String(name || '').toLowerCase();

    if (nameLower.includes('start') && nameLower !== 'start') {
      startContainsCount += 1;
      if (startNameExamples.length < 10 && !startNameExamples.includes(name)) {
        startNameExamples.push(name);
      }
    }

    if (nameLower !== 'start') continue;
    startEventCount += 1;

    if (!pid) {
      missingPidCount += 1;
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
    if (pid === ppid) continue;

    if (parentByPid.has(pid)) {
      const existing = parentByPid.get(pid) ?? '';
      if (existing !== ppid) {
        conflicts.push({ pid, ppidExisting: existing, ppidNew: ppid });
      }
      continue;
    }

    parentByPid.set(pid, ppid);
    edges.push({ ppid, pid });

    if (!childrenByPid.has(ppid)) childrenByPid.set(ppid, []);
    childrenByPid.get(ppid)!.push(pid);
  }

  return {
    parentByPid,
    childrenByPid,
    edges,
    conflicts,
    startEventCount,
    missingPpidCount,
    missingPidCount,
    debug: { startContainsCount, startNameExamples, ppidSourceHits }
  };
}

export function buildProcessForkRelations(events: any[]): {
  parentByPid: Map<string, string>;
  childrenByPid: Map<string, string[]>;
  edges: { ppid: string; pid: string }[];
  conflicts: { pid: string; ppidExisting: string; ppidNew: string }[];
  startEventCount: number;
  missingPpidCount: number;
} {
  const parentByPid = new Map<string, string>(); // pid -> ppid
  const childrenByPid = new Map<string, string[]>(); // ppid -> [pid...]
  const edges: { ppid: string; pid: string }[] = []; // [{ ppid, pid }]
  const conflicts: { pid: string; ppidExisting: string; ppidNew: string }[] = [];
  let startEventCount = 0;
  let missingPpidCount = 0;

  if (!Array.isArray(events)) {
    return { parentByPid, childrenByPid, edges, conflicts, startEventCount, missingPpidCount };
  }

  for (const ev of events) {
    const nameLower = String(ev?.name ?? '').toLowerCase();
    if (!ev || nameLower !== 'start') continue;
    startEventCount += 1;

    const pid = ev.pid === undefined || ev.pid === null ? '' : String(ev.pid);
    if (!pid) continue;

    const ppidValue = ev.ppid ?? ev.args?.ppid ?? ev.args?.PPID;
    if (ppidValue === undefined || ppidValue === null) {
      missingPpidCount += 1;
      continue;
    }
    const ppid = String(ppidValue);
    if (!ppid || pid === ppid) continue;

    if (parentByPid.has(pid)) {
      const existing = parentByPid.get(pid) ?? '';
      if (existing !== ppid) {
        conflicts.push({ pid, ppidExisting: existing, ppidNew: ppid });
      }
      continue;
    }

    parentByPid.set(pid, ppid);
    edges.push({ ppid, pid });

    if (!childrenByPid.has(ppid)) childrenByPid.set(ppid, []);
    childrenByPid.get(ppid)!.push(pid);
  }

  return { parentByPid, childrenByPid, edges, conflicts, startEventCount, missingPpidCount };
}

export function transformData(rawData: any): any[] {
  if (!rawData) return [];

  // New event API: { events: [...], metadata: { begin, end, count } }
  if (Array.isArray(rawData.events)) {
    const events = rawData.events
      .map((ev: any) => {
        const raw = ev.Raw ?? ev.raw ?? ev;
        const args = raw.args ?? ev.args ?? {};
        const pid = raw.pid ?? ev.pid ?? ev.Location ?? 'unknown';
        const tid = raw.tid ?? ev.tid ?? pid;
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
          pid: String(pid),
          tid: String(tid),
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
      const pid = item.pid ?? item.process ?? item.track ?? 'unknown';
      const tid = item.tid ?? item.thread ?? item.track ?? pid;
      const level = Number.isFinite(Number(item.level)) ? Number(item.level) : 0;
      const utils = item.utils || [];

      utils.forEach((utilValue: any, binIndex: number) => {
        const utilFloat = parseFloat(utilValue);
        if (!isFinite(utilFloat) || utilFloat <= 0) return;
        const start = metaBegin + binIndex * binDuration;
        const end = start + binDuration;
        events.push({
          pid: String(pid),
          tid: String(tid),
          level,
          start,
          end,
          id: `${pid}-${binIndex}`,
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

  const getTrackKey = (item: any) => String(item?.track ?? item?.pid ?? item?.tid ?? 'unknown');

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

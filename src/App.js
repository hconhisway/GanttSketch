import React, { useEffect, useRef, useState } from 'react';
import * as d3 from 'd3';
import './App.css';
import { streamLLMResponse } from './llmConfig';
import { GANTT_CONFIG, cloneGanttConfig, applyGanttConfigPatch } from './ganttConfig';
import { cloneWidgetConfig, applyWidgetConfigPatch } from './widgetConfig';
import { GanttDrawingOverlay, DrawingControls } from './GanttDrawingOverlay';
import { 
  getEnhancedSystemPrompt, 
  parseTrackConfigFromResponse, 
  convertLLMConfigToTracksConfig 
} from './tracksConfigPrompt';
import { getWidgetSystemPrompt } from './widgetAgentPrompt';

// API configuration
const API_URL = "http://127.0.0.1:8080/get-events";
const FRONTEND_TRACE_URL = `${process.env.PUBLIC_URL || ''}/unet3d_a100--verify-1.pfw`;
const FRONTEND_TRACE_LABEL = 'unet3d_a100--verify-1.pfw';
const DEFAULT_END_US = 100_000_000; // 100s, microseconds
const MERGE_GAP_RATIO = 0.01; // merge gap as fraction of total time window

function formatTimeUs(us) {
  const safe = Number(us);
  if (!Number.isFinite(safe)) return '';
  const totalMs = Math.max(0, Math.round(safe / 1000));
  const minutes = Math.floor(totalMs / 60000);
  const seconds = Math.floor((totalMs % 60000) / 1000);
  const millis = totalMs % 1000;
  return `${minutes}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

function formatTimeUsFull(us) {
  const safe = Number(us);
  if (!Number.isFinite(safe)) return '';
  const totalUs = Math.max(0, Math.floor(safe));
  const totalSec = Math.floor(totalUs / 1_000_000);
  const usRemainder = totalUs % 1_000_000;
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  const nanos = usRemainder * 1000; // keep 9 digits after decimal
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(nanos).padStart(9, '0')}`;
}

function formatDurationUs(us) {
  const safe = Number(us);
  if (!Number.isFinite(safe)) return '';
  let remaining = Math.max(0, Math.floor(safe));
  const minutes = Math.floor(remaining / 60_000_000);
  remaining %= 60_000_000;
  const seconds = Math.floor(remaining / 1_000_000);
  remaining %= 1_000_000;
  const ms = Math.floor(remaining / 1000);
  const micros = remaining % 1000;

  const parts = [];
  if (minutes) parts.push(`${minutes}m`);
  if (seconds) parts.push(`${seconds}s`);
  if (ms) parts.push(`${ms}ms`);
  if (micros || parts.length === 0) parts.push(`${micros}µs`);
  return parts.join(' ');
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatArgValue(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function clampNumber(value, min, max) {
  const v = Number(value);
  const lo = Number(min);
  const hi = Number(max);
  if (!Number.isFinite(v) || !Number.isFinite(lo) || !Number.isFinite(hi)) return lo;
  return Math.min(hi, Math.max(lo, v));
}

function pickTextColor(hexColor) {
  // Accept #rgb/#rrggbb; fall back to white for unknown formats
  if (typeof hexColor !== 'string') return '#fff';
  const hex = hexColor.trim().replace('#', '');
  const full = hex.length === 3
    ? hex.split('').map(ch => ch + ch).join('')
    : hex;
  if (full.length !== 6) return '#fff';
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  if (![r, g, b].every(Number.isFinite)) return '#fff';
  // Relative luminance
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return luminance > 0.6 ? '#111' : '#fff';
}

function stripScriptTags(html) {
  if (!html || typeof html !== 'string') return '';
  return html.replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '');
}

function toCssSize(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'number') return `${value}px`;
  return String(value);
}

function normalizeWidget(rawWidget) {
  const base = rawWidget && typeof rawWidget === 'object' ? rawWidget : {};
  const fallbackId = `widget-${Date.now()}`;
  const id = String(base.id || fallbackId);
  const name = String(base.name || base.title || id);
  const html = stripScriptTags(String(base.html || ''));
  const rawListeners = Array.isArray(base.listeners) ? base.listeners : [];
  const listeners = rawListeners
    .map(listener => ({
      selector: typeof listener.selector === 'string' ? listener.selector : '',
      event: typeof listener.event === 'string' ? listener.event : 'change',
      handler: typeof listener.handler === 'string' ? listener.handler : ''
    }))
    .filter(listener => listener.handler);
  return {
    id,
    name,
    html,
    listeners,
    description: base.description ? String(base.description) : ''
  };
}

function buildWidgetHandler(source) {
  if (!source || typeof source !== 'string') return null;
  const trimmed = source.trim();
  try {
    if (trimmed.startsWith('function') || trimmed.startsWith('(')) {
      const factory = new Function(`return (${source});`);
      return factory();
    }
    return new Function('payload', 'api', 'widget', source);
  } catch (error) {
    console.warn('Failed to compile widget handler:', error);
    return null;
  }
}

function hashStringToInt(s) {
  const str = String(s ?? '');
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h * 31 + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function getValueAtPath(obj, path) {
  if (!obj || !path) return undefined;
  const parts = String(path).split('.');
  let cursor = obj;
  for (const part of parts) {
    if (cursor && typeof cursor === 'object' && part in cursor) {
      cursor = cursor[part];
    } else {
      return undefined;
    }
  }
  return cursor;
}

function pickFirstFieldValue(item, fields) {
  if (!Array.isArray(fields)) return undefined;
  for (const field of fields) {
    const value = getValueAtPath(item, field);
    if (value !== undefined && value !== null && value !== '') {
      return value;
    }
  }
  return undefined;
}

function resolveColorKey(item, trackKey, trackMeta, colorConfig) {
  const mode = colorConfig?.mode || 'byField';
  let keyValue;

  if (mode === 'byTrack') {
    keyValue = trackKey;
  } else if (mode === 'byField') {
    keyValue = pickFirstFieldValue(item, [colorConfig?.field]);
  } else if (mode === 'byFields') {
    keyValue = pickFirstFieldValue(item, colorConfig?.fields);
  }

  if (keyValue === undefined || keyValue === null || keyValue === '') {
    keyValue = pickFirstFieldValue(item, colorConfig?.fallbackFields);
  }

  if (keyValue === undefined || keyValue === null || keyValue === '') {
    const fallbackKey = trackMeta?.type === 'process'
      ? (item?.pid ?? trackMeta?.pid ?? trackKey ?? '')
      : `${item?.tid ?? trackMeta?.tid ?? trackKey}-${item?.level ?? trackMeta?.level ?? 0}`;
    keyValue = fallbackKey;
  }

  return String(keyValue ?? '');
}

function resolveColor(item, trackKey, trackMeta, colorConfig, defaultPalette) {
  if (colorConfig?.mode === 'fixed' && colorConfig?.fixedColor) {
    return colorConfig.fixedColor;
  }
  const palette = Array.isArray(colorConfig?.palette) && colorConfig.palette.length > 0
    ? colorConfig.palette
    : defaultPalette;
  const key = resolveColorKey(item, trackKey, trackMeta, colorConfig);
  const hash = hashStringToInt(key);
  return palette[hash % palette.length];
}

// Fetch data from API
async function fetchData(begin, end, bins, apiUrl) {
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

function parseFrontendTraceText(text) {
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

  const events = [];
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

function buildFrontendPayloadFromText(text) {
  const events = parseFrontendTraceText(text);
  if (!Array.isArray(events) || events.length === 0) {
    throw new Error('Trace file is empty or invalid.');
  }
  return { events, metadata: { count: events.length, source: 'frontend' } };
}

async function fetchFrontendData(traceUrl) {
  const response = await fetch(traceUrl, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Frontend trace not found (${response.status}) at ${traceUrl}`);
  }
  const text = await response.text();
  try {
    return buildFrontendPayloadFromText(text);
  } catch (e) {
    const msg = e?.message || 'invalid trace format';
    throw new Error(`Frontend trace file is invalid: ${msg}`);
  }
}

async function fetchDataWithFallback(begin, end, bins, apiUrl, traceUrl, localTraceText) {
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
  } catch (backendError) {
    console.warn('[data] backend unavailable, falling back to frontend trace:', backendError);
    try {
      return await fetchFrontendData(traceUrl);
    } catch (fallbackError) {
      const backendMsg = backendError?.message || 'unknown backend error';
      const fallbackMsg = fallbackError?.message || 'unknown frontend error';
      const err = new Error(`Backend unavailable (${backendMsg}); frontend fallback failed (${fallbackMsg}).`);
      err.needsUpload = true;
      throw err;
    }
  }
}

function extractForkFieldsFromRawEvent(ev) {
  const raw =
    ev?.Raw ??
    ev?.raw ??
    ev?.enter?.Raw ??
    ev?.enter?.raw ??
    ev?.leave?.Raw ??
    ev?.leave?.raw ??
    ev;

  const args =
    raw?.args ??
    ev?.args ??
    ev?.enter?.args ??
    ev?.leave?.args ??
    {};

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

  const pid = (pidValue === undefined || pidValue === null) ? '' : String(pidValue);
  const ppid = (ppidValue === undefined || ppidValue === null) ? null : String(ppidValue);
  const name = String(nameValue ?? '');

  return { pid, ppid, name, args, raw };
}

// Build pid fork relationships from *raw* events (unfiltered).
// Rule: for each event where name === 'start', the event's pid is a child of its ppid.
function buildProcessForkRelationsFromRawEvents(rawEvents) {
  const parentByPid = new Map();   // pid -> ppid
  const childrenByPid = new Map(); // ppid -> [pid...]
  const edges = [];               // [{ ppid, pid }]
  const conflicts = [];
  let startEventCount = 0;
  let missingPpidCount = 0;
  let missingPidCount = 0;
  let startContainsCount = 0;
  const startNameExamples = [];
  const ppidSourceHits = {
    raw_ppid: 0,
    ev_ppid: 0,
    args_ppid: 0,
    args_PPID: 0,
    args_parentPid: 0,
    args_parent_pid: 0
  };

  if (!Array.isArray(rawEvents)) {
    return {
      parentByPid, childrenByPid, edges, conflicts,
      startEventCount, missingPpidCount, missingPidCount,
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
    if (args && args.parentPid !== undefined && args.parentPid !== null) ppidSourceHits.args_parentPid += 1;
    if (args && args.parent_pid !== undefined && args.parent_pid !== null) ppidSourceHits.args_parent_pid += 1;

    if (ppid === undefined || ppid === null || ppid === '') {
      missingPpidCount += 1;
      continue;
    }
    if (pid === ppid) continue;

    if (parentByPid.has(pid)) {
      const existing = parentByPid.get(pid);
      if (existing !== ppid) {
        conflicts.push({ pid, ppidExisting: existing, ppidNew: ppid });
      }
      continue;
    }

    parentByPid.set(pid, ppid);
    edges.push({ ppid, pid });

    if (!childrenByPid.has(ppid)) childrenByPid.set(ppid, []);
    childrenByPid.get(ppid).push(pid);
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

// Build pid fork relationships from the *normalized* (duration-filtered) event stream.
// Kept as a fallback when raw events are not available.
function buildProcessForkRelations(events) {
  const parentByPid = new Map();   // pid -> ppid
  const childrenByPid = new Map(); // ppid -> [pid...]
  const edges = [];               // [{ ppid, pid }]
  const conflicts = [];
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
      const existing = parentByPid.get(pid);
      if (existing !== ppid) {
        conflicts.push({ pid, ppidExisting: existing, ppidNew: ppid });
      }
      continue;
    }

    parentByPid.set(pid, ppid);
    edges.push({ ppid, pid });

    if (!childrenByPid.has(ppid)) childrenByPid.set(ppid, []);
    childrenByPid.get(ppid).push(pid);
  }

  return { parentByPid, childrenByPid, edges, conflicts, startEventCount, missingPpidCount };
}

// Transform raw data to normalized event list (microseconds, relative time starting at 0)
function transformData(rawData) {
  if (!rawData) return [];

  // New event API: { events: [...], metadata: { begin, end, count } }
  if (Array.isArray(rawData.events)) {
    const events = rawData.events
      .map((ev) => {
        const raw = ev.Raw ?? ev.raw ?? ev;
        const args = raw.args ?? ev.args ?? {};
        const pid = raw.pid ?? ev.pid ?? ev.Location ?? 'unknown';
        const tid = raw.tid ?? ev.tid ?? pid;
        const ppidValue = raw.ppid ?? ev.ppid ?? args.ppid ?? args.PPID;
        const ppid = (ppidValue === undefined || ppidValue === null) ? null : String(ppidValue);
        const levelRaw = args.level ?? raw.level ?? ev.level ?? 0;
        const level = Number.isFinite(Number(levelRaw)) ? Number(levelRaw) : 0;

        // Prefer relative microsecond timestamps if present
        const startCandidate = ev.enter?.Timestamp ?? ev.Timestamp ?? raw.ts ?? ev.ts;
        const durCandidate = raw.dur ?? ev.dur ?? 0;
        const endCandidate = ev.leave?.Timestamp ?? (startCandidate !== undefined ? Number(startCandidate) + Number(durCandidate) : undefined);

        const start = Number(startCandidate);
        const end = Number(endCandidate);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;

        return {
          pid: String(pid),
          tid: String(tid),
          ppid,
          level,
          start, // microseconds
          end,   // microseconds
          id: raw.id ?? ev.id ?? ev.GUID ?? ev.intervalId ?? null,
          name: raw.name ?? ev.name ?? ev.Primitive ?? '',
          cat: raw.cat ?? ev.cat ?? '',
          args
        };
      })
      .filter(Boolean);

    // Ensure timeline starts at 0 if backend returns absolute timestamps
    // Heuristic: epoch-microseconds are ~1e15; relative traces are typically < 1e11.
    const minStart = events.length > 0 ? Math.min(...events.map(e => e.start)) : 0;
    if (minStart > 1e12) {
      events.forEach((e) => {
        e.start -= minStart;
        e.end -= minStart;
      });
    }

    // Sort for later binary search / merging
    events.sort((a, b) => a.start - b.start);
    return events;
  }

  // Legacy util API fallback: { metadata:{begin,end,bins}, data:[{track,utils}] }
  if (Array.isArray(rawData.data) && rawData.metadata) {
    const metaBegin = rawData.metadata.begin ?? 0;
    const metaEnd = rawData.metadata.end ?? 0;
    const metaBins = rawData.metadata.bins || 1;
    const binDuration = metaBins > 0 ? (metaEnd - metaBegin) / metaBins : 0;

    const events = [];
    rawData.data.forEach((item) => {
      const pid = item.pid ?? item.process ?? item.track ?? 'unknown';
      const tid = item.tid ?? item.thread ?? item.track ?? pid;
      const level = Number.isFinite(Number(item.level)) ? Number(item.level) : 0;
      const utils = item.utils || [];

      utils.forEach((utilValue, binIndex) => {
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

/**
 * Process tracks with sorting, grouping, and filtering
 * @param {Array} data - The chart data
 * @param {Object} config - Configuration object
 * @param {string} config.sortMode - 'asc', 'desc', 'custom', or 'grouped'
 * @param {Function} config.customSort - Custom sorting function (track1, track2) => number
 * @param {Array} config.groups - Array of group objects: [{ name: string, tracks: string[], order: number }]
 * @param {Function} config.filter - Filter function (track) => boolean
 * @param {Array} config.trackList - Explicit list of tracks to show
 * @returns {Object} - { processedData, trackOrder, trackGroups }
 */
function processTracksConfig(data, config = {}) {
  const {
    sortMode = 'asc',
    customSort = null,
    groups = null,
    filter = null,
    trackList = null
  } = config;
  
  // Get unique tracks from data
  let uniqueTracks = [...new Set(data.map(d => d.track))];
  
  // Apply filtering
  let filteredTracks = uniqueTracks;
  if (trackList && trackList.length > 0) {
    // Use explicit track list
    filteredTracks = trackList.filter(track => uniqueTracks.includes(track));
  } else if (filter) {
    // Use filter function
    filteredTracks = uniqueTracks.filter(filter);
  }
  
  // Filter data to only include selected tracks
  const filteredData = data.filter(d => filteredTracks.includes(d.track));
  
  // Apply sorting or grouping
  let trackOrder = [];
  let trackGroups = null;
  
  if (sortMode === 'grouped' && groups && groups.length > 0) {
    // Group mode
    trackGroups = [];
    const assignedTracks = new Set();
    
    // Sort groups by order
    const sortedGroups = [...groups].sort((a, b) => (a.order || 0) - (b.order || 0));
    
    sortedGroups.forEach((group, groupIndex) => {
      const groupTracks = group.tracks.filter(track => 
        filteredTracks.includes(track) && !assignedTracks.has(track)
      );
      
      if (groupTracks.length > 0) {
        trackGroups.push({
          name: group.name,
          tracks: groupTracks
        });
        groupTracks.forEach(track => assignedTracks.add(track));
        trackOrder.push(...groupTracks);
        
        // Add spacer between groups (except after the last group)
        if (groupIndex < sortedGroups.length - 1) {
          trackOrder.push(`__spacer_${groupIndex}__`);
        }
      }
    });
    
    // Add ungrouped tracks at the end
    const ungroupedTracks = filteredTracks.filter(track => !assignedTracks.has(track));
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

function App() {
  const chartRef = useRef();
  const minimapRef = useRef();
  const xAxisRef = useRef();
  const yAxisRef = useRef();
  const chatEndRef = useRef();
  const drawingOverlayRef = useRef();
  const widgetAreaRef = useRef(null);
  const widgetHandlersRef = useRef([]);
  const ganttConfigRef = useRef(null);
  const tracksConfigRef = useRef(null);
  const widgetApiRef = useRef(null);
  const redrawRef = useRef(null);
  const viewRangeRef = useRef({ start: 0, end: DEFAULT_END_US });
  const fetchRangeRef = useRef({ start: 0, end: DEFAULT_END_US });
  const forkRelationsRef = useRef({ parentByPid: new Map(), childrenByPid: new Map(), edges: [] });
  const forkLoggedRef = useRef(false);
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [isFetching, setIsFetching] = useState(false);
  const [error, setError] = useState(null);
  const [obd, setObd] = useState([0, DEFAULT_END_US, 1]); // [begin, end, bins]
  const [startTime, setStartTime] = useState(0);
  const [endTime, setEndTime] = useState(DEFAULT_END_US);
  const [bins, setBins] = useState(1000);
  const [viewRange, setViewRange] = useState({ start: 0, end: DEFAULT_END_US });
  const [processAggregates, setProcessAggregates] = useState(new Map());
  const [threadsByPid, setThreadsByPid] = useState(new Map());
  const [expandedPids, setExpandedPids] = useState([]);
  const [yAxisWidth, setYAxisWidth] = useState(180);
  
  // Chat state
  const [messages, setMessages] = useState([]);
  const [inputMessage, setInputMessage] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [currentStreamingMessage, setCurrentStreamingMessage] = useState('');
  
  // Drawing state
  const [isDrawingMode, setIsDrawingMode] = useState(false);
  const [brushSize, setBrushSize] = useState(3);
  const [brushColor, setBrushColor] = useState('#ff0000');
  const [ganttConfig, setGanttConfig] = useState(() => cloneGanttConfig());
  const [processSortMode, setProcessSortMode] = useState(
    GANTT_CONFIG.yAxis?.orderMode === 'fork' ? 'fork' : 'default'
  ); // 'fork' | 'default'
  const [localTraceText, setLocalTraceText] = useState('');
  const [localTraceName, setLocalTraceName] = useState('');
  const [showUploadPrompt, setShowUploadPrompt] = useState(false);
  
  // Image storage for LLM
  const [savedImages, setSavedImages] = useState([]);
  const [selectedImageId, setSelectedImageId] = useState(null);
  
  // Tracks configuration
  const [tracksConfig, setTracksConfig] = useState({
    sortMode: 'asc', // 'asc', 'desc', 'custom', 'grouped'
    customSort: null,
    groups: null,
    filter: null,
    trackList: null
  });

  // Widget configuration and instances
  const [widgetConfig, setWidgetConfig] = useState(() => cloneWidgetConfig());
  const [widgets, setWidgets] = useState([]);

  useEffect(() => {
    ganttConfigRef.current = ganttConfig;
  }, [ganttConfig]);

  useEffect(() => {
    tracksConfigRef.current = tracksConfig;
  }, [tracksConfig]);

  useEffect(() => {
    widgetApiRef.current = {
      getGanttConfig: () => ganttConfigRef.current,
      setGanttConfig,
      applyGanttConfigPatch,
      setProcessSortMode,
      getTracksConfig: () => tracksConfigRef.current,
      setTracksConfig,
      setViewRange,
      setYAxisWidth,
      setIsDrawingMode,
      setBrushSize,
      setBrushColor
    };
  }, [
    setGanttConfig,
    setProcessSortMode,
    setTracksConfig,
    setViewRange,
    setYAxisWidth,
    setIsDrawingMode,
    setBrushSize,
    setBrushColor
  ]);

  useEffect(() => {
    const host = widgetAreaRef.current;
    if (!host) return;

    widgetHandlersRef.current.forEach(binding => {
      binding.element.removeEventListener(binding.event, binding.handler);
    });
    widgetHandlersRef.current = [];

    widgets.forEach(widget => {
      const widgetRoot = host.querySelector(`[data-widget-id="${widget.id}"]`);
      if (!widgetRoot) return;
      const listeners = Array.isArray(widget.listeners) ? widget.listeners : [];
      listeners.forEach(listener => {
        const handlerFn = buildWidgetHandler(listener.handler);
        if (!handlerFn) return;
        const elements = listener.selector
          ? widgetRoot.querySelectorAll(listener.selector)
          : [widgetRoot];
        elements.forEach(element => {
          const eventName = listener.event || 'change';
          const wrapped = (event) => {
            const payload = {
              event,
              target: event.target,
              value: event.target?.value,
              widgetRoot
            };
            const api = widgetApiRef.current;
            if (!api) return;
            handlerFn(payload, api, widget);
          };
          element.addEventListener(eventName, wrapped);
          widgetHandlersRef.current.push({ element, event: eventName, handler: wrapped });
        });
      });
    });
  }, [widgets]);

  // Fetch and transform data when parameters change
  useEffect(() => {
    if (!obd) return;

    const loadData = async () => {
      try {
        setIsFetching(true);
        const rawData = await fetchDataWithFallback(
          startTime,
          endTime,
          bins,
          API_URL,
          FRONTEND_TRACE_URL,
          localTraceText
        );
        const transformed = transformData(rawData);

        // Build pid fork relations from raw events first (start events may be instantaneous and
        // get filtered out by transformData, so using transformed alone can miss forks).
        const forkFromRaw = Array.isArray(rawData?.events)
          ? buildProcessForkRelationsFromRawEvents(rawData.events)
          : null;
        const forkFromTransformed = buildProcessForkRelations(transformed);
        const forkRelations = (forkFromRaw && forkFromRaw.edges.length > 0)
          ? forkFromRaw
          : forkFromTransformed;

        // Don't wipe previously computed relations when a later fetch window lacks start events.
        if (forkRelations && forkRelations.parentByPid instanceof Map) {
          const prev = forkRelationsRef.current;
          const prevEdgeCount = Array.isArray(prev?.edges) ? prev.edges.length : 0;
          const nextEdgeCount = Array.isArray(forkRelations.edges) ? forkRelations.edges.length : 0;
          if (prev && prev.parentByPid instanceof Map && prevEdgeCount > 0 && nextEdgeCount === 0) {
            // keep prev
          } else if (prev && prev.parentByPid instanceof Map && prevEdgeCount > 0 && nextEdgeCount > 0) {
            // merge: pid -> ppid (keep first, warn on conflicts)
            const mergedParent = new Map(prev.parentByPid);
            const mergedConflicts = [...(prev.conflicts || []), ...(forkRelations.conflicts || [])];
            for (const [pid, ppid] of forkRelations.parentByPid.entries()) {
              if (!mergedParent.has(pid)) {
                mergedParent.set(pid, ppid);
              } else if (mergedParent.get(pid) !== ppid) {
                mergedConflicts.push({ pid, ppidExisting: mergedParent.get(pid), ppidNew: ppid });
              }
            }
            const mergedChildren = new Map();
            const mergedEdges = [];
            for (const [pid, ppid] of mergedParent.entries()) {
              mergedEdges.push({ ppid, pid });
              if (!mergedChildren.has(ppid)) mergedChildren.set(ppid, []);
              mergedChildren.get(ppid).push(pid);
            }
            forkRelationsRef.current = {
              ...forkRelations,
              parentByPid: mergedParent,
              childrenByPid: mergedChildren,
              edges: mergedEdges,
              conflicts: mergedConflicts
            };
          } else {
            forkRelationsRef.current = forkRelations;
          }
        }

        if (!forkLoggedRef.current && Array.isArray(transformed) && transformed.length > 0) {
          forkLoggedRef.current = true;
          try {
            const MAX_VERBOSE = 500;
            const MAX_EDGE_LOG = 200;
            const rel = forkRelationsRef.current || forkRelations;
            const edgeSample = rel.edges.length > MAX_EDGE_LOG
              ? rel.edges.slice(0, MAX_EDGE_LOG)
              : rel.edges;

            console.groupCollapsed(
              `[fork] edges=${rel.edges.length}, startEvents=${rel.startEventCount}, missingPid=${rel.missingPidCount ?? 0}, missingPpid=${rel.missingPpidCount}`
            );
            console.log('edges sample (ppid -> pid):', edgeSample);
            if (rel.edges.length > MAX_EDGE_LOG) {
              console.log(`... +${rel.edges.length - MAX_EDGE_LOG} more edges`);
            }

            if (rel.parentByPid.size <= MAX_VERBOSE) {
              console.log('parentByPid:', Object.fromEntries(rel.parentByPid.entries()));
            } else {
              console.log('parentByPid (Map):', rel.parentByPid);
            }

            if (rel.childrenByPid.size <= MAX_VERBOSE) {
              console.log(
                'childrenByPid:',
                Object.fromEntries([...rel.childrenByPid.entries()].map(([ppid, children]) => [ppid, [...children]]))
              );
            } else {
              console.log('childrenByPid (Map):', rel.childrenByPid);
            }

            if (rel.conflicts && rel.conflicts.length > 0) {
              console.warn('conflicts:', rel.conflicts);
            }

            // If still no edges, print a small diagnostic snapshot to match against input schema.
            if (rel.edges.length === 0) {
              console.warn('[fork] no edges detected. Debug snapshot:', {
                rawStartContainsCount: forkFromRaw?.debug?.startContainsCount ?? 0,
                rawStartNameExamples: forkFromRaw?.debug?.startNameExamples ?? [],
                rawPpidSourceHits: forkFromRaw?.debug?.ppidSourceHits ?? null,
                rawStartEventCount: forkFromRaw?.startEventCount ?? null,
                rawMissingPid: forkFromRaw?.missingPidCount ?? null,
                rawMissingPpid: forkFromRaw?.missingPpidCount ?? null
              });
            }
            console.groupEnd();
          } catch (e) {
            // Never break data load due to debug logging.
            console.warn('[fork] failed to log fork relations:', e);
          }
        }

        setData(transformed);
        
        // Auto-fit time range (slider max) to real data end (max event end), when we are viewing the full current range.
        if (transformed && transformed.length > 0) {
          const dataMaxEnd = transformed.reduce((max, e) => Math.max(max, Number(e.end) || 0), 0);
          if (Number.isFinite(dataMaxEnd) && dataMaxEnd > 0) {
            const prevMax = Array.isArray(obd) ? Number(obd[1]) : DEFAULT_END_US;
            const atCurrentMax = Number(endTime) >= prevMax;
            if (atCurrentMax && Math.abs(dataMaxEnd - prevMax) > 1) {
              setObd([0, Math.ceil(dataMaxEnd), 1]);
              if (Number(endTime) > dataMaxEnd) setEndTime(Math.ceil(dataMaxEnd));
            } else if (dataMaxEnd > prevMax) {
              // Never block exploration if we discover data extends beyond current max
              setObd([0, Math.ceil(dataMaxEnd), 1]);
            }
          }
        }

        setError(null);
        setShowUploadPrompt(false);
        setLoading(false);
        setIsFetching(false);
      } catch (err) {
        console.error('Error loading data:', err);
        setError(err.message);
        setShowUploadPrompt(Boolean(err && err.needsUpload));
        setLoading(false);
        setIsFetching(false);
      }
    };

    loadData();
  }, [startTime, endTime, bins, obd, localTraceText]);

  // Keep viewRange within fetched range; if user isn't zoomed (viewRange == previous fetch range),
  // automatically track the full fetched window.
  useEffect(() => {
    const newFetch = { start: Number(startTime), end: Number(endTime) };
    const prevFetch = fetchRangeRef.current;

    setViewRange((prev) => {
      const prevStart = Number(prev?.start);
      const prevEnd = Number(prev?.end);
      const wasFull = Number.isFinite(prevStart) && Number.isFinite(prevEnd)
        && prevStart === Number(prevFetch.start)
        && prevEnd === Number(prevFetch.end);

      if (wasFull) {
        return { start: newFetch.start, end: newFetch.end };
      }

      const clampedStart = clampNumber(prevStart, newFetch.start, newFetch.end);
      const clampedEnd = clampNumber(prevEnd, newFetch.start, newFetch.end);
      if (clampedEnd <= clampedStart) {
        return { start: newFetch.start, end: newFetch.end };
      }
      return { start: clampedStart, end: clampedEnd };
    });

    fetchRangeRef.current = newFetch;
  }, [startTime, endTime]);

  // Drive imperative redraws from viewRange changes (zoom/pan) without refetching.
  useEffect(() => {
    viewRangeRef.current = { start: Number(viewRange.start), end: Number(viewRange.end) };
    if (typeof redrawRef.current === 'function') {
      redrawRef.current();
    }
  }, [viewRange]);

  // Build hierarchical caches: process aggregates and threads grouped by pid/tid/level
  useEffect(() => {
    if (!data || data.length === 0 || !obd) {
      setProcessAggregates(new Map());
      setThreadsByPid(new Map());
      return;
    }

    const windowUs = Math.max(0, Number(endTime) - Number(startTime));
    const mergeGapUs = windowUs * MERGE_GAP_RATIO;
    const threadMap = new Map();

    data.forEach((ev) => {
      const pid = ev.pid ?? 'unknown';
      const tid = ev.tid ?? pid;
      const level = Number.isFinite(Number(ev.level)) ? Number(ev.level) : 0;
      const start = Number(ev.start);
      const end = Number(ev.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;

      if (!threadMap.has(pid)) threadMap.set(pid, new Map());
      const tidMap = threadMap.get(pid);
      if (!tidMap.has(tid)) tidMap.set(tid, new Map());
      const levelMap = tidMap.get(tid);
      if (!levelMap.has(level)) levelMap.set(level, []);

      levelMap.get(level).push({
        ...ev,
        pid,
        tid,
        level,
        start,
        end,
        count: ev.count ?? 1
      });
    });

    // Sort events within each level
    threadMap.forEach((tidMap) => {
      tidMap.forEach((levelMap) => {
        levelMap.forEach((arr) => {
          arr.sort((a, b) => a.start - b.start);
        });
      });
    });

    // Build process aggregates by merging close/overlapping events across all threads
    const processMap = new Map();
    threadMap.forEach((tidMap, pid) => {
      const all = [];
      tidMap.forEach((levelMap) => {
        levelMap.forEach((arr) => all.push(...arr));
      });
      all.sort((a, b) => a.start - b.start);

      const merged = [];
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
      processMap.set(pid, merged);
    });

    setThreadsByPid(threadMap);
    setProcessAggregates(processMap);
  }, [data, obd, startTime, endTime]);

  // Drop expanded pids that no longer exist
  useEffect(() => {
    setExpandedPids((prev) => prev.filter(pid => threadsByPid.has(pid) || processAggregates.has(pid)));
  }, [threadsByPid, processAggregates]);

  // Render chart with d3 (canvas + svg hybrid for scalability)
  useEffect(() => {
    if (!chartRef.current) return;

    const container = chartRef.current;
    const margin = { top: 24, right: 24, bottom: 24, left: 16 };
    const headerHeight = 24;          // process header row height
    const laneHeight = 18;            // per (tid, level) lane height inside expanded process
    const lanePadding = 3;
    const expandedPadding = 8;        // padding inside expanded process block
    const threadGap = 6;              // gap between different threads inside expanded block
    const pixelRatio = window.devicePixelRatio || 1;

    const renderChart = () => {
      container.innerHTML = '';
      if (minimapRef.current) minimapRef.current.innerHTML = '';
      if (xAxisRef.current) xAxisRef.current.innerHTML = '';

      // Handle empty data case
      if (!data || data.length === 0) {
        container.innerHTML = `<div class="chart-empty-state">No data to display</div>`;
        return;
      }

      // Build variable-height process blocks.
      // - Collapsed: show merged bars (processAggregates)
      // - Expanded: the same process row grows into a detail box, showing thread→level lanes
      //   (levels are compacted: missing levels do NOT create empty rows).
      const yAxisConfig = ganttConfig?.yAxis || {};
      const yAxisOrderMode = yAxisConfig.orderMode || processSortMode;
      const threadOrderModeRaw = yAxisConfig?.thread?.orderMode;
      const threadOrderMode = (threadOrderModeRaw === 'level' || threadOrderModeRaw === 'auto')
        ? threadOrderModeRaw
        : 'auto';
      const PROCESS_INDENT_PX = yAxisOrderMode === 'fork' ? 16 : 0;

      const pids = Array.from(processAggregates.keys());
      if (pids.length === 0) {
        container.innerHTML = `<div class="chart-empty-state">No processes found</div>`;
        return;
      }
      pids.sort((a, b) => {
        const na = parseFloat(a);
        const nb = parseFloat(b);
        if (!isNaN(na) && !isNaN(nb)) return na - nb;
        return a.toString().localeCompare(b.toString());
      });

      let orderedPids = pids.map(String);
      let depthByPid = new Map(orderedPids.map((pid) => [pid, 0]));

      if (yAxisOrderMode === 'fork') {
        // Reorder pids into fork-tree order and compute indent (depth), skipping fork edges
        // that reference pids not present in the current dataset.
        const canonicalIndex = new Map(pids.map((pid, i) => [String(pid), i]));
        const existingPids = new Set(pids.map((pid) => String(pid)));

        const fork = forkRelationsRef.current;
        const parentByPidExisting = new Map();   // pid -> ppid (only if ppid exists)
        const childrenByPidExisting = new Map(); // ppid -> [pid...]
        if (fork && fork.parentByPid instanceof Map) {
          for (const pid of existingPids) {
            const ppid = fork.parentByPid.get(pid);
            if (!ppid) continue;
            const ppidStr = String(ppid);
            if (!existingPids.has(ppidStr)) continue; // skip missing parent
            if (ppidStr === pid) continue;
            parentByPidExisting.set(pid, ppidStr);
            if (!childrenByPidExisting.has(ppidStr)) childrenByPidExisting.set(ppidStr, []);
            childrenByPidExisting.get(ppidStr).push(pid);
          }
        }

        // Deterministic order: preserve canonical pid ordering inside each sibling list.
        for (const [ppid, kids] of childrenByPidExisting.entries()) {
          kids.sort((a, b) => (canonicalIndex.get(a) ?? 0) - (canonicalIndex.get(b) ?? 0));
          childrenByPidExisting.set(ppid, kids);
        }

        const roots = pids
          .map(String)
          .filter((pid) => !parentByPidExisting.has(pid));
        roots.sort((a, b) => (canonicalIndex.get(a) ?? 0) - (canonicalIndex.get(b) ?? 0));

        const nextOrdered = [];
        const nextDepth = new Map();
        const visitedPids = new Set();
        const dfs = (pid, depth) => {
          if (!pid || visitedPids.has(pid)) return;
          visitedPids.add(pid);
          nextOrdered.push(pid);
          nextDepth.set(pid, depth);
          const kids = childrenByPidExisting.get(pid) || [];
          for (const child of kids) dfs(child, depth + 1);
        };
        for (const r of roots) dfs(r, 0);
        // Include any leftover pids (cycles/disconnected): treat as roots
        for (const pid of pids.map(String)) {
          if (!visitedPids.has(pid)) dfs(pid, 0);
        }

        orderedPids = nextOrdered;
        depthByPid = nextDepth;
      } else if (yAxisOrderMode === 'custom' || yAxisOrderMode === 'grouped') {
        const baseOrder = pids.map(String);
        const baseSet = new Set(baseOrder);
        const nextOrdered = [];
        const used = new Set();

        if (yAxisOrderMode === 'custom') {
          const customOrder = Array.isArray(yAxisConfig.customOrder) ? yAxisConfig.customOrder : [];
          customOrder.forEach((pid) => {
            const key = String(pid);
            if (baseSet.has(key) && !used.has(key)) {
              nextOrdered.push(key);
              used.add(key);
            }
          });
        } else {
          const groups = Array.isArray(yAxisConfig.groups) ? yAxisConfig.groups : [];
          const sortedGroups = [...groups].sort((a, b) => (a.order || 0) - (b.order || 0));
          sortedGroups.forEach((group) => {
            const groupPids = group?.pids || group?.tracks || group?.items || [];
            groupPids.forEach((pid) => {
              const key = String(pid);
              if (baseSet.has(key) && !used.has(key)) {
                nextOrdered.push(key);
                used.add(key);
              }
            });
          });
        }

        const includeUnspecified = yAxisConfig.includeUnspecified !== false;
        if (includeUnspecified) {
          baseOrder.forEach((pid) => {
            if (!used.has(pid)) {
              nextOrdered.push(pid);
              used.add(pid);
            }
          });
        }

        orderedPids = nextOrdered.length > 0 ? nextOrdered : baseOrder;
        depthByPid = new Map(orderedPids.map((pid) => [pid, 0]));
      }

      // Auto-size the left y-axis column to reduce wasted space.
      // We measure the widest visible label and add padding.
      const computeYAxisWidth = () => {
        try {
          const canvas = document.createElement('canvas');
          const ctx = canvas.getContext('2d');
          if (!ctx) return null;

          const LEFT_PAD = 8;
          const RIGHT_PAD = 12;
          const THREAD_INDENT = 18;

          let maxPx = 0;

          // Process labels (always visible)
          ctx.font = '700 12px system-ui';
          for (const pid of orderedPids) {
            const indentPx = (depthByPid.get(String(pid)) || 0) * PROCESS_INDENT_PX;
            const text = `▶ Process ${pid}`;
            const w = ctx.measureText(text).width;
            maxPx = Math.max(maxPx, LEFT_PAD + indentPx + w + RIGHT_PAD);
          }

          // Thread labels (only for expanded blocks)
          ctx.font = '500 11px system-ui';
          for (const pid of expandedPids) {
            const threadMap = threadsByPid.get(pid);
            if (!threadMap) continue;
            const procIndentPx = (depthByPid.get(String(pid)) || 0) * PROCESS_INDENT_PX;
            const tids = Array.from(threadMap.keys());
            for (const tid of tids) {
              const isMainThread = String(tid) === String(pid);
              const text = isMainThread ? 'main thread' : `thread ${tid}`;
              const w = ctx.measureText(text).width;
              maxPx = Math.max(maxPx, LEFT_PAD + procIndentPx + THREAD_INDENT + w + RIGHT_PAD);
            }
          }

          const MIN = 120;
          const MAX = 240;
          return Math.round(clampNumber(maxPx, MIN, MAX));
        } catch {
          return null;
        }
      };

      const measuredWidth = computeYAxisWidth();
      const Y_AXIS_WIDTH = measuredWidth || yAxisWidth || 180;
      // Avoid render loops: only update when it meaningfully changes.
      if (measuredWidth && Math.abs(measuredWidth - (yAxisWidth || 0)) >= 3) {
        setYAxisWidth(measuredWidth);
      }

      const buildAutoLanes = (events) => {
        if (!Array.isArray(events) || events.length === 0) return [];
        const sorted = [...events].sort((a, b) => {
          const byStart = (a.start ?? 0) - (b.start ?? 0);
          if (byStart !== 0) return byStart;
          return (a.end ?? 0) - (b.end ?? 0);
        });
        const lanes = [];
        const laneEnds = [];
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

      const buildLanesForPid = (pid) => {
        const threadMap = threadsByPid.get(pid);
        if (!threadMap) return [];

        const tids = Array.from(threadMap.keys()).sort((a, b) => {
          const na = parseFloat(a);
          const nb = parseFloat(b);
          if (!isNaN(na) && !isNaN(nb)) return na - nb;
          return a.toString().localeCompare(b.toString());
        });

        const lanes = [];
        tids.forEach((tid) => {
          const levelMap = threadMap.get(tid);
          if (!levelMap) return;

          const isMainThread = String(tid) === String(pid);
          if (threadOrderMode === 'auto') {
            const allEvents = [];
            levelMap.forEach((arr) => {
              if (Array.isArray(arr)) allEvents.push(...arr);
            });
            const autoLanes = buildAutoLanes(allEvents);
            autoLanes.forEach((events, idx) => {
              lanes.push({
                type: 'lane',
                pid,
                tid: String(tid),
                level: idx,
                threadLabel: idx === 0 ? (isMainThread ? 'main thread' : `thread ${tid}`) : '',
                events
              });
            });
            return;
          }

          const levels = Array.from(levelMap.keys())
            .map(v => (typeof v === 'string' ? Number(v) : v))
            .filter(v => Number.isFinite(v))
            .sort((a, b) => a - b);

          levels.forEach((level, idx) => {
            lanes.push({
              type: 'lane',
              pid,
              tid: String(tid),
              level,
              threadLabel: idx === 0 ? (isMainThread ? 'main thread' : `thread ${tid}`) : '',
              events: levelMap.get(level) || levelMap.get(String(level)) || []
            });
          });
        });

        // Visual gaps between threads for readability (not "empty levels")
        const withGaps = [];
        let lastTid = null;
        lanes.forEach((lane) => {
          if (lastTid !== null && lane.tid !== lastTid) {
            withGaps.push({ type: 'gap', height: threadGap });
          }
          withGaps.push(lane);
          lastTid = lane.tid;
        });
        return withGaps;
      };

      const blocks = [];
      let yCursor = margin.top;

      orderedPids.forEach((pid) => {
        const depth = depthByPid.get(String(pid)) || 0;
        const indentPx = depth * PROCESS_INDENT_PX;
        const expanded = expandedPids.includes(pid);
        if (!expanded) {
          blocks.push({
            pid,
            expanded: false,
            depth,
            indentPx,
            y0: yCursor,
            y1: yCursor + headerHeight,
            headerY0: yCursor,
            headerY1: yCursor + headerHeight,
            detailY0: null,
            detailY1: null,
            lanes: []
          });
          yCursor += headerHeight;
          return;
        }

        const lanes = buildLanesForPid(pid);
        const lanesHeight = lanes.reduce((sum, lane) => sum + (lane.type === 'gap' ? lane.height : laneHeight), 0);
        const blockHeight = headerHeight + expandedPadding + lanesHeight + expandedPadding;

        const block = {
          pid,
          expanded: true,
          depth,
          indentPx,
          y0: yCursor,
          y1: yCursor + blockHeight,
          headerY0: yCursor,
          headerY1: yCursor + headerHeight,
          detailY0: yCursor + headerHeight + expandedPadding,
          detailY1: yCursor + blockHeight - expandedPadding,
          lanes: []
        };

        let laneCursor = block.detailY0;
        block.lanes = lanes.map((lane) => {
          if (lane.type === 'gap') {
            const y0 = laneCursor;
            laneCursor += lane.height;
            return { ...lane, y0, y1: laneCursor };
          }
          const y0 = laneCursor;
          laneCursor += laneHeight;
          return { ...lane, y0, y1: laneCursor };
        });

        blocks.push(block);
        yCursor = block.y1;
      });

      const contentHeight = Math.max(0, yCursor - margin.top);
      const stageHeight = yCursor + margin.bottom;

      const containerWidth = container.clientWidth || 900;
      const containerHeight = container.clientHeight || 500;
      const innerWidth = Math.max(containerWidth - margin.left - margin.right, 320);

      container.style.position = 'relative';
      container.style.overflowY = 'auto';
      container.style.overflowX = 'hidden';

      const fetchStart = Number(startTime);
      const fetchEnd = Number(endTime);
      const fetchSpan = Math.max(1, fetchEnd - fetchStart);

      const getViewParams = () => {
        const v = viewRangeRef.current || { start: fetchStart, end: fetchEnd };
        let vs = Number(v.start);
        let ve = Number(v.end);
        if (!Number.isFinite(vs) || !Number.isFinite(ve) || ve <= vs) {
          vs = fetchStart;
          ve = fetchEnd;
        }
        vs = clampNumber(vs, fetchStart, fetchEnd);
        ve = clampNumber(ve, fetchStart, fetchEnd);
        if (ve <= vs) {
          vs = fetchStart;
          ve = fetchEnd;
        }
        const span = Math.max(1, ve - vs);
        const k = innerWidth / span;
        return { vs, ve, span, k };
      };

      const xOf = (t, p) => margin.left + (Number(t) - p.vs) * p.k;
      const tOf = (x, p) => p.vs + (Number(x) - margin.left) / p.k;

      // Canvas for bars (fast for large datasets)
      const canvas = document.createElement('canvas');
      canvas.className = 'gantt-canvas';
      canvas.width = Math.round((innerWidth + margin.left + margin.right) * pixelRatio);
      canvas.height = Math.round(stageHeight * pixelRatio);
      canvas.style.width = `${innerWidth + margin.left + margin.right}px`;
      canvas.style.height = `${stageHeight}px`;
      container.appendChild(canvas);
      const ctx = canvas.getContext('2d');
      ctx.scale(pixelRatio, pixelRatio);

      // SVG for axes and text
      const svg = d3.create('svg')
        .attr('class', 'gantt-svg')
        .attr('width', innerWidth + margin.left + margin.right)
        .attr('height', stageHeight)
        .style('width', `${innerWidth + margin.left + margin.right}px`)
        .style('height', `${stageHeight}px`)
        .style('position', 'absolute')
        .style('left', 0)
        .style('top', 0)
        .style('pointerEvents', 'none');

      container.appendChild(svg.node());

      const yAxisHost = yAxisRef.current;
      let yAxisGroup = null;
      if (yAxisHost) {
        yAxisHost.innerHTML = '';
        const axisSvg = d3.create('svg')
          .attr('class', 'gantt-yaxis-svg')
          .attr('width', Y_AXIS_WIDTH)
          .attr('height', stageHeight)
          .style('width', `${Y_AXIS_WIDTH}px`)
          .style('height', `${stageHeight}px`)
          .style('overflow', 'visible');
        yAxisGroup = axisSvg.append('g').attr('class', 'y-labels');
        yAxisHost.appendChild(axisSvg.node());
        yAxisHost.style.width = `${Y_AXIS_WIDTH}px`;
        yAxisHost.style.height = `${stageHeight}px`;
        yAxisHost.style.top = `${container.offsetTop}px`;
      }

      // Tooltip
      const tooltip = document.createElement('div');
      tooltip.className = 'gantt-tooltip';
      tooltip.style.display = 'none';
      container.appendChild(tooltip);

      // Top bar: minimap + fixed x-axis (does NOT refetch; driven by viewRange)
      const minimapHost = minimapRef.current;
      const axisHost = xAxisRef.current;
      const topWidth = innerWidth + margin.left + margin.right;
      const minimapHeight = Math.max(60, minimapHost ? (minimapHost.clientHeight || 60) : 60);
      const axisHeight = Math.max(32, axisHost ? (axisHost.clientHeight || 32) : 32);

      let minimapCtx = null;
      let minimapWindowEl = null;
      let minimapAxisGroup = null;

      if (minimapHost) {
        const mmCanvas = document.createElement('canvas');
        mmCanvas.width = Math.round(topWidth * pixelRatio);
        mmCanvas.height = Math.round(minimapHeight * pixelRatio);
        mmCanvas.style.width = `${topWidth}px`;
        mmCanvas.style.height = `${minimapHeight}px`;
        minimapHost.appendChild(mmCanvas);
        const ctx2d = mmCanvas.getContext('2d');
        ctx2d.scale(pixelRatio, pixelRatio);
        minimapCtx = ctx2d;

        const winEl = document.createElement('div');
        winEl.className = 'minimap-window';
        minimapHost.appendChild(winEl);
        minimapWindowEl = winEl;

        // Minimap time ticks overlay (for the full fetched range)
        const mmAxisSvg = d3.create('svg')
          .attr('width', topWidth)
          .attr('height', minimapHeight)
          .style('width', `${topWidth}px`)
          .style('height', `${minimapHeight}px`)
          .style('overflow', 'visible');
        minimapAxisGroup = mmAxisSvg.append('g')
          .attr('transform', `translate(0, ${minimapHeight - 12})`);
        minimapHost.appendChild(mmAxisSvg.node());
      }

      let axisGroup = null;
      if (axisHost) {
        const axisSvg = d3.create('svg')
          .attr('width', topWidth)
          .attr('height', axisHeight)
          .style('width', `${topWidth}px`)
          .style('height', `${axisHeight}px`)
          .style('overflow', 'visible');
        axisGroup = axisSvg.append('g')
          .attr('transform', `translate(0, ${axisHeight - 8})`);
        axisHost.appendChild(axisSvg.node());
      }

    // Precompute minimap multi-lane stripes (compressed overview).
    // We bin events into a small number of lanes based on current track order
    // so the overview reflects the main Gantt ordering.
    const overviewBinsCount = Math.min(900, Math.max(300, Math.floor(innerWidth)));
    const LANE_COUNT = 6;
    const colorConfig = ganttConfig?.colorMapping || GANTT_CONFIG.colorMapping;
    const defaultPalette = GANTT_CONFIG.colorMapping.palette;
    const laneDiffs = Array.from({ length: LANE_COUNT }, () => new Array(overviewBinsCount + 1).fill(0));
    const laneColorCounts = Array.from({ length: LANE_COUNT }, () => new Map());
    const pidToBlockIndex = new Map();
    const totalBlocks = Math.max(1, blocks.length);
    blocks.forEach((block, index) => {
      pidToBlockIndex.set(block.pid, index);
    });

    // Use raw events for richer overview (more like trace UI).
    for (const ev of data) {
      const s = Number(ev.start);
      const e = Number(ev.end);
      if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) continue;
      const sNorm = (s - fetchStart) / fetchSpan;
      const eNorm = (e - fetchStart) / fetchSpan;
      if (eNorm <= 0 || sNorm >= 1) continue;
      const i0 = Math.max(0, Math.min(overviewBinsCount - 1, Math.floor(sNorm * overviewBinsCount)));
      const i1 = Math.max(0, Math.min(overviewBinsCount, Math.ceil(eNorm * overviewBinsCount)));
      const blockIndex = pidToBlockIndex.get(ev.pid);
      let lane = 0;
      if (Number.isFinite(blockIndex)) {
        lane = Math.floor((blockIndex / totalBlocks) * LANE_COUNT);
      } else {
        const laneKey = resolveColorKey(ev, ev.tid ?? ev.pid ?? '', {
          type: 'lane',
          pid: ev.pid,
          tid: ev.tid,
          level: ev.level
        }, colorConfig);
        lane = hashStringToInt(laneKey) % LANE_COUNT;
      }
      lane = Math.max(0, Math.min(LANE_COUNT - 1, lane));
      laneDiffs[lane][i0] += 1;
      laneDiffs[lane][i1] -= 1;

      const trackKey = ev.tid ?? ev.pid ?? '';
      const color = resolveColor(ev, trackKey, {
        type: 'lane',
        pid: ev.pid,
        tid: ev.tid,
        level: ev.level
      }, colorConfig, defaultPalette);
      const weight = Math.max(1, i1 - i0);
      const colorCounts = laneColorCounts[lane];
      colorCounts.set(color, (colorCounts.get(color) || 0) + weight);
    }

    const laneColors = new Array(LANE_COUNT).fill(null);
    for (let lane = 0; lane < LANE_COUNT; lane++) {
      const colorCounts = laneColorCounts[lane];
      let bestColor = null;
      let bestScore = -1;
      colorCounts.forEach((score, color) => {
        if (score > bestScore) {
          bestScore = score;
          bestColor = color;
        }
      });
      laneColors[lane] = bestColor;
    }

    const laneBins = Array.from({ length: LANE_COUNT }, () => new Array(overviewBinsCount).fill(0));
    const laneMax = new Array(LANE_COUNT).fill(0);
    for (let lane = 0; lane < LANE_COUNT; lane++) {
      let acc = 0;
      for (let i = 0; i < overviewBinsCount; i++) {
        acc += laneDiffs[lane][i];
        laneBins[lane][i] = acc;
        laneMax[lane] = Math.max(laneMax[lane], acc);
      }
    }

      const colorFor = (item, trackKey, trackMeta) => (
        resolveColor(item, trackKey, trackMeta, colorConfig, defaultPalette)
      );

      const visibleState = {
        startIndex: 0,
        endIndex: 0,
        hoveredTrack: null,
        hoveredItem: null
      };

      const drawBars = () => {
        ctx.clearRect(0, 0, (innerWidth + margin.left + margin.right), stageHeight);

        const p = getViewParams();
        const yMin = container.scrollTop;
        const yMax = yMin + container.clientHeight;

        // Find first visible block (binary search)
        let lo = 0;
        let hi = blocks.length - 1;
        let startIdx = 0;
        while (lo <= hi) {
          const mid = Math.floor((lo + hi) / 2);
          if (blocks[mid].y1 < yMin) {
            lo = mid + 1;
          } else {
            startIdx = mid;
            hi = mid - 1;
          }
        }

        for (let i = startIdx; i < blocks.length; i++) {
          const block = blocks[i];
          if (block.y0 > yMax) break;

          const blockIndentPx = Number(block.indentPx) || 0;

          // Header background (full width)
          const headerIsHovered = visibleState.hoveredTrack === `proc-${block.pid}`;
          ctx.fillStyle = block.expanded ? '#eef2ff' : (i % 2 === 0 ? '#fbfbfb' : '#f4f4f4');
          ctx.fillRect(0, block.headerY0, margin.left + innerWidth + margin.right, headerHeight);
          if (headerIsHovered) {
            ctx.fillStyle = 'rgba(102, 126, 234, 0.12)';
            ctx.fillRect(0, block.headerY0, margin.left + innerWidth + margin.right, headerHeight);
          }

          const merged = processAggregates.get(block.pid) || [];

          if (!block.expanded) {
            // Collapsed: draw merged process bars in header row
            const y = block.headerY0 + 2;
            const h = headerHeight - 4;
            merged.forEach((item) => {
              const x1 = xOf(item.start ?? item.timeStart, p) + blockIndentPx;
              const x2 = xOf(item.end ?? item.timeEnd, p) + blockIndentPx;
              const leftBound = margin.left + blockIndentPx;
              const rightBound = margin.left + innerWidth + blockIndentPx;
              if (x2 < leftBound || x1 > rightBound) return;
              ctx.fillStyle = colorFor(item, `proc-${block.pid}`, { type: 'process', pid: block.pid });
              ctx.fillRect(x1, y, Math.max(1, x2 - x1), h);
            });
            continue;
          }

          // Expanded: draw a detail box (width based on process time extent), then draw lane events inside.
          if (merged.length > 0) {
            const minT = merged[0].start ?? merged[0].timeStart;
            const maxT = merged[merged.length - 1].end ?? merged[merged.length - 1].timeEnd;
            const boxX1 = xOf(minT, p) + blockIndentPx;
            const boxX2 = xOf(maxT, p) + blockIndentPx;
            const boxY0 = block.headerY0 + 1;
            const boxY1 = block.y1 - 1;
            const boxW = Math.max(6, boxX2 - boxX1);
            const boxH = Math.max(6, boxY1 - boxY0);

            // Box background/border
            ctx.fillStyle = 'rgba(79, 70, 229, 0.06)';
            ctx.fillRect(boxX1, boxY0, boxW, boxH);
            ctx.strokeStyle = 'rgba(79, 70, 229, 0.25)';
            ctx.lineWidth = 1;
            ctx.strokeRect(boxX1 + 0.5, boxY0 + 0.5, boxW, boxH);

            // Lanes (only visible ones)
            block.lanes.forEach((lane) => {
              if (lane.type !== 'lane') return;
              if (lane.y1 < yMin || lane.y0 > yMax) return;

              const laneY0 = lane.y0;
              const laneY1 = lane.y1;
              const laneH = laneY1 - laneY0;

              const events = lane.events || [];
              const barY = laneY0 + lanePadding;
              const barH = Math.max(2, laneH - lanePadding * 2);
              events.forEach((ev) => {
                const x1 = xOf(ev.start ?? ev.timeStart, p) + blockIndentPx;
                const x2 = xOf(ev.end ?? ev.timeEnd, p) + blockIndentPx;
                if (x2 < boxX1 || x1 > boxX1 + boxW) return;
                const barColor = colorFor(ev, lane.tid, { type: 'lane', pid: block.pid, tid: lane.tid, level: lane.level });
                const w = Math.max(1, x2 - x1);
                ctx.fillStyle = barColor;
                ctx.fillRect(x1, barY, w, barH);

                // Draw label on long bars
                const label = (ev.name || ev.label || '').toString();
                const LABEL_MIN_PX = 90;
                if (label && w >= LABEL_MIN_PX && barH >= 10) {
                  const clipX = Math.max(x1, boxX1);
                  const clipW = Math.min(x2, boxX1 + boxW) - clipX;
                  if (clipW >= LABEL_MIN_PX) {
                    ctx.save();
                    ctx.beginPath();
                    ctx.rect(clipX, barY, clipW, barH);
                    ctx.clip();
                    ctx.font = '11px system-ui';
                    ctx.textBaseline = 'middle';
                    ctx.fillStyle = pickTextColor(barColor);
                    ctx.fillText(label, clipX + 4, barY + barH / 2);
                    ctx.restore();
                  }
                }
              });
            });
          }
        }
      };

      const renderTopbar = () => {
        const p = getViewParams();

        // Minimap overview + window highlight
        if (minimapCtx && minimapWindowEl) {
          minimapCtx.clearRect(0, 0, topWidth, minimapHeight);
          minimapCtx.fillStyle = '#ffffff';
          minimapCtx.fillRect(0, 0, topWidth, minimapHeight);

          // Reserve a small strip at the bottom for tick labels
          const ticksReserve = 18;
          const usableH = Math.max(10, minimapHeight - 8 - ticksReserve);
          const laneH = usableH / LANE_COUNT;
          const binW = innerWidth / overviewBinsCount;

          for (let lane = 0; lane < LANE_COUNT; lane++) {
            const maxV = laneMax[lane] || 1;
            const yBase = 4 + (lane + 1) * laneH;
            const fallbackPalette = Array.isArray(colorConfig?.palette) && colorConfig.palette.length > 0
              ? colorConfig.palette
              : defaultPalette;
            const color = laneColors[lane] || fallbackPalette[lane % fallbackPalette.length];
            // draw with alpha safely (canvas doesn't accept #RRGGBBAA reliably across browsers)
            minimapCtx.fillStyle = color;
            minimapCtx.globalAlpha = 0.75;

            for (let i = 0; i < overviewBinsCount; i++) {
              const v = laneBins[lane][i];
              if (v <= 0) continue;
              const h = Math.sqrt(v / maxV) * (laneH - 2);
              const x = margin.left + i * binW;
              minimapCtx.fillRect(x, yBase - h, Math.max(1, binW), h);
            }
            minimapCtx.globalAlpha = 1;
          }

          let leftPx = margin.left + ((p.vs - fetchStart) / fetchSpan) * innerWidth;
          let widthPx = ((p.ve - p.vs) / fetchSpan) * innerWidth;
          leftPx = clampNumber(leftPx, margin.left, margin.left + innerWidth);
          widthPx = clampNumber(widthPx, 2, margin.left + innerWidth - leftPx);
          minimapWindowEl.style.left = `${leftPx}px`;
          minimapWindowEl.style.width = `${widthPx}px`;
        }

        // Minimap ticks for fetched range
        if (minimapAxisGroup) {
          const tickCount = Math.max(4, Math.floor(innerWidth / 160));
          const scale = d3.scaleLinear()
            .domain([fetchStart, fetchEnd])
            .range([margin.left, margin.left + innerWidth]);
          minimapAxisGroup.call(
            d3.axisBottom(scale)
              .ticks(tickCount)
              .tickFormat((d) => formatTimeUs(d))
          );
          minimapAxisGroup.selectAll('text')
            .style('font-size', '10px')
            .style('fill', '#6b7280');
          minimapAxisGroup.selectAll('path,line')
            .style('stroke', '#d1d5db');
        }

        // Fixed x-axis (zoom target)
        if (axisGroup) {
          const tickCount = Math.max(4, Math.floor(innerWidth / 140));
          const scale = d3.scaleLinear()
            .domain([p.vs, p.ve])
            .range([margin.left, margin.left + innerWidth]);
          axisGroup.call(
            d3.axisBottom(scale)
              .ticks(tickCount)
              .tickFormat((d) => formatTimeUs(d))
          );
          axisGroup.selectAll('text')
            .style('font-size', '12px')
            .style('fill', '#555');
          axisGroup.selectAll('path,line')
            .style('stroke', '#d0d0d0');
          // Ensure labels stay inside visible area
          axisGroup.selectAll('text')
            .attr('dy', '1.2em');
        }
      };

      const renderYLabels = () => {
        if (!yAxisGroup) return;
        const yMin = container.scrollTop;
        const yMax = yMin + container.clientHeight;
        const scrollY = container.scrollTop;

        // Binary search for first visible block
        let lo = 0;
        let hi = blocks.length - 1;
        let startIdx = 0;
        while (lo <= hi) {
          const mid = Math.floor((lo + hi) / 2);
          if (blocks[mid].y1 < yMin) {
            lo = mid + 1;
          } else {
            startIdx = mid;
            hi = mid - 1;
          }
        }

        const labels = [];
        const bgRects = [];

        for (let i = startIdx; i < blocks.length; i++) {
          const block = blocks[i];
          if (block.y0 > yMax) break;

          const blockIndentPx = Number(block.indentPx) || 0;

          // Background fill for the left Y-axis column to match viewport zebra rows / expanded highlight.
          if (block.expanded) {
            bgRects.push({
              key: `bg-proc-${block.pid}`,
              y: block.y0 - scrollY,
              h: block.y1 - block.y0,
              fill: '#eef2ff'
            });
          } else {
            bgRects.push({
              key: `bg-proc-${block.pid}`,
              y: block.headerY0 - scrollY,
              h: headerHeight,
              fill: (i % 2 === 0 ? '#fbfbfb' : '#f4f4f4')
            });
          }

          labels.push({
            key: `proc-${block.pid}`,
            kind: 'process',
            text: `${block.expanded ? '▼' : '▶'} Process ${block.pid}`,
            x: 8,
            y: block.headerY0 + headerHeight / 2 - scrollY,
            fontSize: 12,
            fontWeight: block.expanded ? 700 : 600,
            indent: blockIndentPx
          });

          if (block.expanded) {
            block.lanes.forEach((lane) => {
              if (lane.type !== 'lane') return;
              if (lane.y1 < yMin || lane.y0 > yMax) return;

              // Only show thread label once (no L1/L2 labels)
              if (lane.threadLabel) {
                labels.push({
                  key: `lane-${block.pid}-${lane.tid}-${lane.y0}`,
                  kind: 'lane',
                  text: lane.threadLabel,
                  x: 8,
                  y: lane.y0 + (lane.y1 - lane.y0) / 2 - scrollY,
                  fontSize: 11,
                  fontWeight: 500,
                  indent: blockIndentPx + 18
                });
              }
            });
          }
        }

        yAxisGroup.selectAll('rect.y-bg')
          .data(bgRects, d => d.key)
          .join('rect')
          .attr('class', 'y-bg')
          .attr('x', 0)
          .attr('y', d => d.y)
          .attr('width', Y_AXIS_WIDTH)
          .attr('height', d => d.h)
          .attr('fill', d => d.fill);

        yAxisGroup.selectAll('text')
          .data(labels, d => d.key)
          .join('text')
          .attr('x', d => d.x + (d.indent || 0))
          .attr('y', d => d.y)
          .attr('text-anchor', 'start')
          .attr('dominant-baseline', 'middle')
          .attr('fill', '#333')
          .style('font-size', d => `${d.fontSize || 12}px`)
          .style('font-weight', d => d.fontWeight || 500)
          .text(d => d.text);
      };

      const updateVisibleWindow = () => {
        // Kept for compatibility; draw/render handle visibility from scroll directly.
        visibleState.startIndex = 0;
        visibleState.endIndex = blocks.length;
      };

      const redraw = () => {
        updateVisibleWindow();
        drawBars();
        renderYLabels();
        renderTopbar();
      };

      // Expose redraw for viewRange updates (zoom/pan)
      redrawRef.current = redraw;

      // Initial render
      redraw();

      const findBlockByY = (y) => {
        let lo = 0;
        let hi = blocks.length - 1;
        while (lo <= hi) {
          const mid = Math.floor((lo + hi) / 2);
          const b = blocks[mid];
          if (y < b.y0) hi = mid - 1;
          else if (y > b.y1) lo = mid + 1;
          else return b;
        }
        return null;
      };

      const findItemAtPosition = (x, y) => {
        const block = findBlockByY(y);
        if (!block) return null;

        const p = getViewParams();
        const blockIndentPx = Number(block.indentPx) || 0;
        const time = tOf(Number(x) - blockIndentPx, p);

        // Header area
        if (y >= block.headerY0 && y <= block.headerY1) {
          if (block.expanded) return { area: 'header', block, lane: null, item: null };
          const bucket = processAggregates.get(block.pid) || [];
          let lo = 0;
          let hi = bucket.length - 1;
          while (lo <= hi) {
            const mid = Math.floor((lo + hi) / 2);
            const item = bucket[mid];
            const start = item.start ?? item.timeStart;
            const end = item.end ?? item.timeEnd;
            if (time < start) hi = mid - 1;
            else if (time > end) lo = mid + 1;
            else return { area: 'process', block, lane: null, item };
          }
          return { area: 'process', block, lane: null, item: null };
        }

        // Detail lanes (expanded)
        if (!block.expanded || !block.lanes || y < block.detailY0 || y > block.detailY1) {
          return { area: 'header', block, lane: null, item: null };
        }

        const lane = block.lanes.find(l => l.type === 'lane' && y >= l.y0 && y <= l.y1);
        if (!lane) return { area: 'lane', block, lane: null, item: null };

        const events = lane.events || [];
        let lo2 = 0;
        let hi2 = events.length - 1;
        while (lo2 <= hi2) {
          const mid = Math.floor((lo2 + hi2) / 2);
          const item = events[mid];
          const start = item.start ?? item.timeStart;
          const end = item.end ?? item.timeEnd;
          if (time < start) hi2 = mid - 1;
          else if (time > end) lo2 = mid + 1;
          else return { area: 'lane', block, lane, item };
        }
        return { area: 'lane', block, lane, item: null };
      };

      const handleMouseMove = (e) => {
        const rect = container.getBoundingClientRect();
        const x = e.clientX - rect.left + container.scrollLeft;
        const y = e.clientY - rect.top + container.scrollTop;
        const hit = findItemAtPosition(x, y);
        visibleState.hoveredTrack = hit ? `proc-${hit.block.pid}` : null;
        visibleState.hoveredItem = hit ? hit.item : null;
        redraw();

        if (hit && hit.item) {
          tooltip.style.display = 'block';
          tooltip.style.left = `${e.clientX + 12}px`;
          tooltip.style.top = `${e.clientY + 12}px`;
          const item = hit.item;
          const pid = item.pid ?? hit.block.pid ?? '';
          const tid = item.tid ?? hit.lane?.tid ?? '';
          const name = item.name ?? item.label ?? '';
          const category = item.cat ?? '';
          const startUs = Number(item.start ?? item.timeStart);
          const endUs = Number(item.end ?? item.timeEnd);
          const durationUs = Number.isFinite(startUs) && Number.isFinite(endUs) ? Math.max(0, endUs - startUs) : 0;
          const sqlId = item.id ?? null;

          if (hit.area === 'process') {
            tooltip.innerHTML = `
              <div class="tooltip-grid">
                <div class="tooltip-col">
                  <div class="tooltip-title">Process</div>
                  <div class="tooltip-row"><span class="tooltip-key">Process:</span><span class="tooltip-value">${escapeHtml(pid)}</span></div>
                  <div class="tooltip-row"><span class="tooltip-key">Duration:</span><span class="tooltip-value">${escapeHtml(formatDurationUs(durationUs))}</span></div>
                </div>
              </div>
            `;
            return;
          }

          const argsObj = (item.args && typeof item.args === 'object') ? item.args : {};
          const argEntries = Object.entries(argsObj);
          const MAX_ARGS = 24;
          const shownArgs = argEntries.slice(0, MAX_ARGS);
          const remainingCount = Math.max(0, argEntries.length - shownArgs.length);

          const argsHtml = shownArgs.length > 0
            ? shownArgs.map(([k, v]) => `
                <div class="tooltip-row">
                  <span class="tooltip-key">${escapeHtml(k)}:</span>
                  <span class="tooltip-value">${escapeHtml(formatArgValue(v))}</span>
                </div>
              `).join('')
            : `<div class="tooltip-muted">No arguments</div>`;

          const extraHtml = remainingCount > 0
            ? `<div class="tooltip-muted">… (+${remainingCount} more)</div>`
            : '';

          tooltip.innerHTML = `
            <div class="tooltip-grid">
              <div class="tooltip-col">
                <div class="tooltip-title">Details</div>
                <div class="tooltip-row"><span class="tooltip-key">Name:</span><span class="tooltip-value">${escapeHtml(name)}</span></div>
                <div class="tooltip-row"><span class="tooltip-key">Category:</span><span class="tooltip-value">${escapeHtml(category)}</span></div>
                <div class="tooltip-spacer"></div>
                <div class="tooltip-row"><span class="tooltip-key">Start time:</span><span class="tooltip-value">${escapeHtml(formatTimeUsFull(startUs))}</span></div>
                <div class="tooltip-row"><span class="tooltip-key">Duration:</span><span class="tooltip-value">${escapeHtml(formatDurationUs(durationUs))}</span></div>
                <div class="tooltip-spacer"></div>
                <div class="tooltip-row"><span class="tooltip-key">Thread:</span><span class="tooltip-value">${escapeHtml(tid ? `${tid} [${tid}]` : '')}</span></div>
                <div class="tooltip-row"><span class="tooltip-key">Process:</span><span class="tooltip-value">${escapeHtml(pid)}</span></div>
                <div class="tooltip-row"><span class="tooltip-key">SQL ID:</span><span class="tooltip-value">${sqlId !== null ? escapeHtml(`slice[${sqlId}]`) : ''}</span></div>
              </div>
              <div class="tooltip-col">
                <div class="tooltip-title">Arguments</div>
                ${argsHtml}
                ${extraHtml}
              </div>
            </div>
          `;
        } else {
          tooltip.style.display = 'none';
        }
      };

      const handleMouseLeave = () => {
        visibleState.hoveredTrack = null;
        visibleState.hoveredItem = null;
        tooltip.style.display = 'none';
        redraw();
      };

      let blockNextClick = false;
      const handleClick = (e) => {
        if (blockNextClick) {
          blockNextClick = false;
          return;
        }
        const rect = container.getBoundingClientRect();
        const xViewport = e.clientX - rect.left;
        const y = e.clientY - rect.top + container.scrollTop;
        // Toggle only when clicking in the left label column AND on the process header row
        if (xViewport > margin.left) return;
        const block = findBlockByY(y);
        if (!block) return;
        if (y < block.headerY0 || y > block.headerY1) return;
        const pid = block.pid;
        setExpandedPids((prev) => {
          const has = prev.includes(pid);
          if (has) return prev.filter(p => p !== pid);
          return [...prev, pid];
        });
        // keep scroll position
      };

      const handleAxisClick = (e) => {
        const rect = container.getBoundingClientRect();
        const y = e.clientY - rect.top + container.scrollTop;
        const block = findBlockByY(y);
        if (!block) return;
        if (y < block.headerY0 || y > block.headerY1) return;
        const pid = block.pid;
        setExpandedPids((prev) => {
          const has = prev.includes(pid);
          if (has) return prev.filter(p => p !== pid);
          return [...prev, pid];
        });
      };

      // Ctrl + wheel zoom on the fixed x-axis (client-side view zoom; no refetch)
      const handleAxisWheel = (e) => {
        if (!axisHost) return;
        // Default wheel: scroll the main viewport (keeps axis fixed)
        if (!(e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          container.scrollTop += e.deltaY;
          return;
        }

        e.preventDefault();

        const rect = axisHost.getBoundingClientRect();
        const xViewport = e.clientX - rect.left;
        if (xViewport < margin.left || xViewport > margin.left + innerWidth) return;

        setViewRange((prev) => {
          const prevStart = Number(prev?.start);
          const prevEnd = Number(prev?.end);
          const span = Math.max(1, prevEnd - prevStart);
          const zoomFactor = Math.exp(e.deltaY * 0.0015); // >1 zoom out, <1 zoom in
          const minSpan = 1000; // 1ms
          const newSpan = clampNumber(span * zoomFactor, minSpan, fetchSpan);

          const t = prevStart + ((xViewport - margin.left) / innerWidth) * span;
          let newStart = t - ((t - prevStart) * (newSpan / span));
          let newEnd = newStart + newSpan;

          if (newStart < fetchStart) {
            newStart = fetchStart;
            newEnd = newStart + newSpan;
          }
          if (newEnd > fetchEnd) {
            newEnd = fetchEnd;
            newStart = newEnd - newSpan;
          }

          newStart = clampNumber(newStart, fetchStart, fetchEnd);
          newEnd = clampNumber(newEnd, fetchStart, fetchEnd);
          if (newEnd <= newStart) {
            newStart = fetchStart;
            newEnd = fetchEnd;
          }
          return { start: Math.round(newStart), end: Math.round(newEnd) };
        });
      };

      // Ctrl+wheel zoom also works on the main viewport area (below).
      const handleViewportWheel = (e) => {
        if (!(e.ctrlKey || e.metaKey)) return;
        e.preventDefault();

        const rect = container.getBoundingClientRect();
        const xInChart = e.clientX - rect.left + container.scrollLeft;
        if (xInChart < margin.left || xInChart > margin.left + innerWidth) return;

        setViewRange((prev) => {
          const prevStart = Number(prev?.start);
          const prevEnd = Number(prev?.end);
          const span = Math.max(1, prevEnd - prevStart);
          const zoomFactor = Math.exp(e.deltaY * 0.0015);
          const minSpan = 1000; // 1ms
          const newSpan = clampNumber(span * zoomFactor, minSpan, fetchSpan);

          const t = prevStart + ((xInChart - margin.left) / innerWidth) * span;
          let newStart = t - ((t - prevStart) * (newSpan / span));
          let newEnd = newStart + newSpan;

          if (newStart < fetchStart) {
            newStart = fetchStart;
            newEnd = newStart + newSpan;
          }
          if (newEnd > fetchEnd) {
            newEnd = fetchEnd;
            newStart = newEnd - newSpan;
          }

          newStart = clampNumber(newStart, fetchStart, fetchEnd);
          newEnd = clampNumber(newEnd, fetchStart, fetchEnd);
          if (newEnd <= newStart) {
            newStart = fetchStart;
            newEnd = fetchEnd;
          }
          return { start: Math.round(newStart), end: Math.round(newEnd) };
        });
      };

      // Drag the minimap window to pan the view (client-side; no refetch)
      let isDraggingMinimap = false;
      let dragOffsetPx = 0;

      const panViewToLeftPx = (leftPx) => {
        const current = viewRangeRef.current || { start: fetchStart, end: fetchEnd };
        const spanUs = Math.max(1, Number(current.end) - Number(current.start));
        const windowPx = (spanUs / fetchSpan) * innerWidth;
        const minLeft = margin.left;
        const maxLeft = Math.max(minLeft, margin.left + innerWidth - windowPx);
        const clampedLeft = clampNumber(leftPx, minLeft, maxLeft);

        const newStart = fetchStart + ((clampedLeft - margin.left) / innerWidth) * fetchSpan;
        const newEnd = newStart + spanUs;
        setViewRange({ start: Math.round(newStart), end: Math.round(newEnd) });
      };

      const handleMinimapPointerDown = (e) => {
        if (!minimapHost || !minimapWindowEl) return;
        const rect = minimapHost.getBoundingClientRect();
        const x = e.clientX - rect.left;

        const p = getViewParams();
        const spanUs = p.span;
        const windowPx = (spanUs / fetchSpan) * innerWidth;
        const currentLeft = margin.left + ((p.vs - fetchStart) / fetchSpan) * innerWidth;

        if (e.target === minimapWindowEl) {
          dragOffsetPx = x - currentLeft;
        } else {
          // Click outside: center the window around the click
          dragOffsetPx = windowPx / 2;
          panViewToLeftPx(x - dragOffsetPx);
        }

        isDraggingMinimap = true;
        minimapHost.setPointerCapture(e.pointerId);
      };

      const handleMinimapPointerMove = (e) => {
        if (!isDraggingMinimap || !minimapHost) return;
        const rect = minimapHost.getBoundingClientRect();
        const x = e.clientX - rect.left;
        panViewToLeftPx(x - dragOffsetPx);
      };

      const handleMinimapPointerUp = () => {
        isDraggingMinimap = false;
      };

      // Drag the main chart to pan horizontally when zoomed in.
      let isDraggingChart = false;
      let dragStartClientX = 0;
      let dragStartView = null;
      let dragMoved = false;

      const canPanChart = () => {
        const current = viewRangeRef.current || { start: fetchStart, end: fetchEnd };
        return Math.max(1, Number(current.end) - Number(current.start)) < fetchSpan;
      };

      const handleChartPointerDown = (e) => {
        if (e.button !== 0) return;
        if (e.pointerType && e.pointerType !== 'mouse') return;
        if (!canPanChart()) return;
        const rect = container.getBoundingClientRect();
        const xViewport = e.clientX - rect.left;
        if (xViewport < margin.left || xViewport > margin.left + innerWidth) return;

        isDraggingChart = true;
        dragMoved = false;
        dragStartClientX = e.clientX;
        const current = viewRangeRef.current || { start: fetchStart, end: fetchEnd };
        dragStartView = { start: Number(current.start), end: Number(current.end) };
        container.setPointerCapture(e.pointerId);
      };

      const handleChartPointerMove = (e) => {
        if (!isDraggingChart || !dragStartView) return;
        const dx = e.clientX - dragStartClientX;
        if (Math.abs(dx) > 2) dragMoved = true;
        const span = Math.max(1, dragStartView.end - dragStartView.start);
        const p = getViewParams();
        const deltaUs = dx / p.k;
        let newStart = dragStartView.start - deltaUs;
        let newEnd = newStart + span;
        if (newStart < fetchStart) {
          newStart = fetchStart;
          newEnd = newStart + span;
        }
        if (newEnd > fetchEnd) {
          newEnd = fetchEnd;
          newStart = newEnd - span;
        }
        setViewRange({ start: Math.round(newStart), end: Math.round(newEnd) });
      };

      const handleChartPointerUp = () => {
        if (dragMoved) {
          blockNextClick = true;
        }
        isDraggingChart = false;
        dragStartView = null;
      };

      container.addEventListener('scroll', redraw);
      container.addEventListener('mousemove', handleMouseMove);
      container.addEventListener('mouseleave', handleMouseLeave);
      container.addEventListener('click', handleClick);
      container.addEventListener('pointerdown', handleChartPointerDown);
      container.addEventListener('pointermove', handleChartPointerMove);
      container.addEventListener('pointerup', handleChartPointerUp);
      container.addEventListener('pointercancel', handleChartPointerUp);
      container.addEventListener('wheel', handleViewportWheel, { passive: false });
      if (axisHost) axisHost.addEventListener('wheel', handleAxisWheel, { passive: false });
      if (yAxisHost) yAxisHost.addEventListener('click', handleAxisClick);
      if (minimapHost) {
        minimapHost.style.touchAction = 'none';
        minimapHost.addEventListener('pointerdown', handleMinimapPointerDown);
        minimapHost.addEventListener('pointermove', handleMinimapPointerMove);
        minimapHost.addEventListener('pointerup', handleMinimapPointerUp);
        minimapHost.addEventListener('pointercancel', handleMinimapPointerUp);
      }

      return () => {
        container.removeEventListener('scroll', redraw);
        container.removeEventListener('mousemove', handleMouseMove);
        container.removeEventListener('mouseleave', handleMouseLeave);
        container.removeEventListener('click', handleClick);
        container.removeEventListener('pointerdown', handleChartPointerDown);
        container.removeEventListener('pointermove', handleChartPointerMove);
        container.removeEventListener('pointerup', handleChartPointerUp);
        container.removeEventListener('pointercancel', handleChartPointerUp);
        container.removeEventListener('wheel', handleViewportWheel);
        if (axisHost) axisHost.removeEventListener('wheel', handleAxisWheel);
        if (yAxisHost) yAxisHost.removeEventListener('click', handleAxisClick);
        if (minimapHost) {
          minimapHost.removeEventListener('pointerdown', handleMinimapPointerDown);
          minimapHost.removeEventListener('pointermove', handleMinimapPointerMove);
          minimapHost.removeEventListener('pointerup', handleMinimapPointerUp);
          minimapHost.removeEventListener('pointercancel', handleMinimapPointerUp);
        }
        if (redrawRef.current === redraw) {
          redrawRef.current = null;
        }
      };
    };

    let teardown = null;
    const build = () => {
      if (teardown) teardown();
      teardown = renderChart();
    };

    build();

    const resizeObserver = new ResizeObserver(() => {
      build();
    });
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      if (teardown) teardown();
      container.innerHTML = '';
      if (minimapRef.current) minimapRef.current.innerHTML = '';
      if (xAxisRef.current) xAxisRef.current.innerHTML = '';
      if (yAxisRef.current) yAxisRef.current.innerHTML = '';
    };
  }, [data, startTime, endTime, bins, obd, processAggregates, threadsByPid, expandedPids, yAxisWidth, processSortMode, ganttConfig]);

  // Auto-scroll chat to bottom
  useEffect(() => {
    if (chatEndRef.current) {
      chatEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, currentStreamingMessage]);

  // Handle sending messages to LLM
  const handleSendMessage = async () => {
    if (!inputMessage.trim() || isStreaming) return;

    // Create user message with optional image
    let userMessage = { role: 'user', content: inputMessage };
    
    // If an image is selected, include it in the message
    // Note: This requires a vision-capable LLM API (e.g., GPT-4 Vision, Claude 3)
    // You would need to modify streamLLMResponse in llmConfig.js to support multimodal content
    if (selectedImageId) {
      const selectedImage = savedImages.find(img => img.id === selectedImageId);
      if (selectedImage) {
        userMessage.imageData = selectedImage.dataUrl;
        // For vision models, the content format would be:
        // content: [
        //   { type: 'text', text: inputMessage },
        //   { type: 'image_url', image_url: { url: selectedImage.dataUrl } }
        // ]
        console.log('Image attached to message:', selectedImageId);
      }
    }

    const newMessages = [...messages, userMessage];
    setMessages(newMessages);
    setInputMessage('');
    setIsStreaming(true);
    setCurrentStreamingMessage('');

    // Prepare enhanced context about the current chart data for tracks configuration
    const uniqueTracks = [...new Set(data.map(d => d.pid ?? d.tid ?? d.track))];
    const configSummary = [
      `yAxis.orderMode=${ganttConfig?.yAxis?.orderMode || 'default'}`,
      `yAxis.thread.orderMode=${ganttConfig?.yAxis?.thread?.orderMode || 'auto'}`,
      `color.mode=${ganttConfig?.colorMapping?.mode || 'byField'}`,
      `color.field=${ganttConfig?.colorMapping?.field || ''}`,
      `color.fields=${(ganttConfig?.colorMapping?.fields || []).join('|')}`
    ].join(', ');
    const chartContext = {
      totalTracks: uniqueTracks.length,
      trackNames: uniqueTracks.sort(),
      timeRange: data.length > 0 
        ? `${formatTimeUs(startTime)} to ${formatTimeUs(endTime)}`
        : 'unknown',
      dataPointCount: data.length,
      configSummary
    };

    const isWidgetRequest = /\bwidgets?\b/i.test(inputMessage);
    const enhancedSystemPrompt = isWidgetRequest
      ? getWidgetSystemPrompt(chartContext, widgetConfig, widgets)
      : getEnhancedSystemPrompt(chartContext);

    const contextualMessages = [
      { role: 'system', content: enhancedSystemPrompt },
      ...newMessages
    ];

    // Use a ref to accumulate the streaming message
    let accumulatedMessage = '';

    try {
      await streamLLMResponse(
        contextualMessages,
        (chunk) => {
          accumulatedMessage += chunk;
          setCurrentStreamingMessage(accumulatedMessage);
        },
        () => {
          // Streaming complete - process the response
          setMessages(prev => [
            ...prev,
            { role: 'assistant', content: accumulatedMessage }
          ]);
          setCurrentStreamingMessage('');
          setIsStreaming(false);

          // Check if the response contains a configuration update
          const configResponse = parseTrackConfigFromResponse(accumulatedMessage);
          if (configResponse?.action === 'update_gantt_config') {
            try {
              const nextConfig = applyGanttConfigPatch(ganttConfig, configResponse.patch);
              setGanttConfig(nextConfig);
              if (configResponse.patch?.yAxis?.orderMode) {
                const nextMode = configResponse.patch.yAxis.orderMode;
                setProcessSortMode(nextMode === 'fork' ? 'fork' : 'default');
              }
              setMessages(prev => [
                ...prev,
                {
                  role: 'system',
                  content: `✅ Gantt config updated: ${configResponse.description || 'Configuration updated successfully'}`
                }
              ]);
            } catch (error) {
              console.error('Error applying gantt config update:', error);
              setMessages(prev => [
                ...prev,
                {
                  role: 'system',
                  content: `⚠️ Could not apply gantt config update: ${error.message}`
                }
              ]);
            }
          } else if (configResponse?.action === 'configure_tracks') {
            console.log('Track configuration detected:', configResponse);

            // Convert LLM config to internal format and apply it
            try {
              const internalConfig = convertLLMConfigToTracksConfig(configResponse, data);
              if (internalConfig) {
                setTracksConfig(internalConfig);
              }

              // Add a confirmation message to chat
              setMessages(prev => [
                ...prev,
                {
                  role: 'system',
                  content: `✅ Track configuration applied: ${configResponse.config.description || 'Configuration updated successfully'}`
                }
              ]);
            } catch (error) {
              console.error('Error applying track configuration:', error);
              setMessages(prev => [
                ...prev,
                {
                  role: 'system',
                  content: `⚠️ Could not apply track configuration: ${error.message}`
                }
              ]);
            }
          } else if (configResponse?.action === 'create_widget') {
            try {
              const nextWidget = normalizeWidget(configResponse.widget);
              if (!nextWidget.html) {
                throw new Error('Widget HTML is empty.');
              }
              setWidgets(prev => [...prev, nextWidget]);
              setMessages(prev => [
                ...prev,
                {
                  role: 'system',
                  content: `✅ Widget added: ${nextWidget.name}`
                }
              ]);
            } catch (error) {
              console.error('Error creating widget:', error);
              setMessages(prev => [
                ...prev,
                {
                  role: 'system',
                  content: `⚠️ Could not create widget: ${error.message}`
                }
              ]);
            }
          } else if (configResponse?.action === 'update_widget') {
            try {
              const nextWidget = normalizeWidget(configResponse.widget);
              setWidgets(prev => {
                const index = prev.findIndex(item => item.id === nextWidget.id);
                if (index === -1) {
                  throw new Error(`Widget not found: ${nextWidget.id}`);
                }
                const updated = [...prev];
                const existing = updated[index];
                updated[index] = {
                  ...existing,
                  ...nextWidget,
                  html: nextWidget.html || existing.html,
                  listeners: nextWidget.listeners.length > 0 ? nextWidget.listeners : existing.listeners
                };
                return updated;
              });
              setMessages(prev => [
                ...prev,
                {
                  role: 'system',
                  content: `✅ Widget updated: ${nextWidget.name}`
                }
              ]);
            } catch (error) {
              console.error('Error updating widget:', error);
              setMessages(prev => [
                ...prev,
                {
                  role: 'system',
                  content: `⚠️ Could not update widget: ${error.message}`
                }
              ]);
            }
          } else if (configResponse?.action === 'update_widget_config') {
            try {
              const nextConfig = applyWidgetConfigPatch(widgetConfig, configResponse.patch);
              setWidgetConfig(nextConfig);
              setMessages(prev => [
                ...prev,
                {
                  role: 'system',
                  content: `✅ Widget layout/style updated: ${configResponse.description || 'Widget config updated successfully'}`
                }
              ]);
            } catch (error) {
              console.error('Error applying widget config update:', error);
              setMessages(prev => [
                ...prev,
                {
                  role: 'system',
                  content: `⚠️ Could not update widget layout/style: ${error.message}`
                }
              ]);
            }
          }
        },
        (error) => {
          console.error('Streaming error:', error);
          setMessages(prev => [
            ...prev,
            { role: 'assistant', content: `Error: ${error.message}. Please check your LLM API configuration.` }
          ]);
          setCurrentStreamingMessage('');
          setIsStreaming(false);
        }
      );
    } catch (error) {
      console.error('Error sending message:', error);
      setMessages(prev => [
        ...prev,
        { role: 'assistant', content: `Error: ${error.message}. Please check your LLM API configuration.` }
      ]);
      setIsStreaming(false);
    }
  };

  const handleKeyPress = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  // Handle capture of annotated chart for LLM
  const handleCaptureImage = async () => {
    if (drawingOverlayRef.current) {
      const blob = await drawingOverlayRef.current.exportAnnotatedImage();
      if (blob) {
        const dataUrl = await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result);
          reader.readAsDataURL(blob);
        });
        
        const newImage = {
          id: `img-${Date.now()}`,
          dataUrl,
          timestamp: new Date().toISOString(),
          size: blob.size
        };
        
        setSavedImages(prev => [...prev, newImage]);
        setSelectedImageId(newImage.id);
        
        // Show success message in chat
        setMessages(prev => [
          ...prev,
          { role: 'assistant', content: '📸 Chart captured successfully! The image is ready to send to the LLM.' }
        ]);
      }
    }
  };
  
  // Delete an image from saved images
  const handleDeleteImage = (imageId) => {
    setSavedImages(prev => prev.filter(img => img.id !== imageId));
    if (selectedImageId === imageId) {
      setSelectedImageId(null);
    }
  };
  
  // Select/deselect an image
  const handleSelectImage = (imageId) => {
    setSelectedImageId(prev => prev === imageId ? null : imageId);
  };

  // Handle clear drawings
  const handleClear = () => {
    if (drawingOverlayRef.current) {
      drawingOverlayRef.current.clearCanvas();
    }
  };

  if (loading && (!data || data.length === 0)) {
    return (
      <div className="App">
        <div className="loading">Loading events...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="App">
        <div className="error">
          <div style={{
            backgroundColor: '#fee',
            border: '1px solid #fcc',
            padding: '15px',
            borderRadius: '4px',
            color: '#c33',
            textAlign: 'center',
            fontFamily: 'system-ui'
          }}>
            Error loading data: {error}<br/>
            Start the API server at {API_URL}, place {FRONTEND_TRACE_LABEL} in the public folder, or upload a trace file.
          </div>
        </div>
        {showUploadPrompt && (
          <div className="upload-row">
            <label className="upload-label">
              Upload trace file
              <input
                type="file"
                accept=".pfw,.json,.txt"
                onChange={(e) => {
                  const file = e.target.files && e.target.files[0];
                  if (!file) return;
                  const reader = new FileReader();
                  reader.onload = () => {
                    const text = String(reader.result || '');
                    setLocalTraceText(text);
                    setLocalTraceName(file.name || 'uploaded trace');
                    setError(null);
                    setShowUploadPrompt(false);
                    setLoading(true);
                    setIsFetching(true);
                  };
                  reader.onerror = () => {
                    setError('Failed to read uploaded file.');
                  };
                  reader.readAsText(file);
                }}
              />
            </label>
            {localTraceName ? (
              <span className="upload-hint">Using local file: {localTraceName}</span>
            ) : (
              <span className="upload-hint">Used when backend and public trace are unavailable</span>
            )}
          </div>
        )}
      </div>
    );
  }

  if (!obd) {
    return (
      <div className="App">
        <div className="loading">Initializing...</div>
      </div>
    );
  }

  const widgetLayout = widgetConfig?.layout || {};
  const widgetContainerStyle = {
    ...(widgetConfig?.style?.container || {})
  };
  const widgetAreaStyle = {
    display: 'flex',
    flexDirection: widgetLayout.direction === 'row' ? 'row' : 'column',
    flexWrap: widgetLayout.wrap === 'wrap' ? 'wrap' : 'nowrap',
    gap: toCssSize(widgetLayout.gap, '12px'),
    width: '100%',
    maxWidth: toCssSize(widgetLayout.maxWidth, '100%'),
    alignItems: widgetLayout.alignItems || 'stretch'
  };
  const widgetCardStyle = widgetConfig?.style?.widgetCard || {};
  const widgetTitleStyle = widgetConfig?.style?.widgetTitle || {};

  return (
    <div className="App">
      <div className="main-content">
        <div className="left-panel">
          <div className="controls" style={widgetContainerStyle}>
            <div className="widget-area" ref={widgetAreaRef} style={widgetAreaStyle}>
              {widgets.length === 0 ? (
                <div className="widget-placeholder">
                  No widgets yet. Ask the assistant to create a widget.
                </div>
              ) : (
                widgets.map(widget => (
                  <div
                    key={widget.id}
                    className="widget-card"
                    data-widget-id={widget.id}
                    style={widgetCardStyle}
                  >
                    <div className="widget-title" style={widgetTitleStyle}>
                      {widget.name}
                    </div>
                    <div
                      className="widget-body"
                      dangerouslySetInnerHTML={{ __html: widget.html }}
                    />
                  </div>
                ))
              )}
            </div>
          </div>
          <div
            className="chart-container"
            style={{
              position: 'relative',
              '--gantt-yaxis-width': `${yAxisWidth}px`
            }}
          >
            <div className="gantt-topbar">
              <div ref={minimapRef} className="gantt-minimap" />
              <div ref={xAxisRef} className="gantt-xaxis" />
            </div>
            <div ref={yAxisRef} className="gantt-yaxis" />
            <div ref={chartRef} className="chart gantt-viewport"></div>
            <GanttDrawingOverlay
              ref={drawingOverlayRef}
              isActive={isDrawingMode}
              brushSize={brushSize}
              brushColor={brushColor}
            />
          </div>
        </div>
        
        <div className="right-panel">
          <div className="chat-header">
            <h3>Chart Assistant</h3>
            <p className="chat-subtitle">Ask questions about your data</p>
          </div>

          <div className="chat-messages">
            {messages.length === 0 && (
              <div className="chat-welcome">
                <p>👋 Hello! I'm your chart assistant.</p>
                <p>Ask me anything about the Gantt chart data, task scheduling, or resource utilization.</p>
              </div>
            )}
            
            {messages.map((msg, idx) => (
              <div key={idx} className={`message ${msg.role}`}>
                <div className="message-content">
                  {msg.content}
                </div>
              </div>
            ))}
            
            {isStreaming && currentStreamingMessage && (
              <div className="message assistant streaming">
                <div className="message-content">
                  {currentStreamingMessage}
                  <span className="cursor-blink">▊</span>
                </div>
              </div>
            )}
            
            {isStreaming && !currentStreamingMessage && (
              <div className="message assistant">
                <div className="message-content">
                  <span className="typing-indicator">
                    <span></span>
                    <span></span>
                    <span></span>
                  </span>
                </div>
              </div>
            )}
            
            <div ref={chatEndRef} />
          </div>
          
          {/* Image Thumbnails Gallery */}
          {savedImages.length > 0 && (
            <div className="image-gallery">
              <div className="gallery-header">Captured Images ({savedImages.length})</div>
              <div className="gallery-thumbnails">
                {savedImages.map((image) => (
                  <div 
                    key={image.id}
                    className={`thumbnail-wrapper ${selectedImageId === image.id ? 'selected' : ''}`}
                    onClick={() => handleSelectImage(image.id)}
                  >
                    <img 
                      src={image.dataUrl} 
                      alt="Captured chart" 
                      className="thumbnail-image"
                    />
                    <button
                      className="thumbnail-delete"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteImage(image.id);
                      }}
                      title="Delete image"
                    >
                      ×
                    </button>
                    {selectedImageId === image.id && (
                      <div className="thumbnail-selected-badge">✓</div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
          
          <div className="chat-input-container">
            <div className="chat-drawing-controls">
              <DrawingControls
                isActive={isDrawingMode}
                onToggle={setIsDrawingMode}
                onClear={handleClear}
                brushSize={brushSize}
                setBrushSize={setBrushSize}
                brushColor={brushColor}
                setBrushColor={setBrushColor}
                showSort={false}
              />
            </div>
            <div className="input-controls-row">
              <button 
                className="capture-button"
                onClick={handleCaptureImage}
                disabled={!isDrawingMode}
                title="Capture annotated chart"
              >
                📸
              </button>
              <textarea
                className="chat-input"
                placeholder="Ask about the chart data..."
                value={inputMessage}
                onChange={(e) => setInputMessage(e.target.value)}
                onKeyPress={handleKeyPress}
                disabled={isStreaming}
                rows="3"
              />
              <button 
                className="send-button"
                onClick={handleSendMessage}
                disabled={isStreaming || !inputMessage.trim()}
              >
                {isStreaming ? 'Sending...' : 'Send'}
              </button>
            </div>
            {selectedImageId && (
              <div className="selected-image-indicator">
                📎 Image will be sent with message
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;


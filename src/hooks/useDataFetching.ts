import { useCallback, useEffect, useRef } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import {
  analyzeAndInitialize,
  processEventsMinimal,
  dataMappingToFlatFieldMapping,
  getTimeMultiplier
} from '../agents';
import { applyGanttConfigPatch } from '../config/ganttConfig';
import {
  buildProcessForkRelations,
  buildProcessForkRelationsFromRawEvents,
  fetchDataWithFallback
} from '../utils/dataProcessing';
import { getThreadLaneFieldPath, inferProcessSortModeFromRule } from '../utils/processOrder';
import { clampNumber } from '../utils/formatting';
import { buildConfigBundle, downloadConfigBundle } from '../utils/configBundle';
import { resolveColorKey } from '../utils/color';
import { getValueAtPath } from '../utils/expression';
import {
  buildHierarchyLaneKey,
  getHierarchyFieldsFromMapping,
  pruneHierarchyConfig
} from '../utils/hierarchy';
import type { GanttDataMapping, ProcessSortMode } from '../types/ganttConfig';
import type { StreamingRequest, ViewState } from '../types/viewState';
import type { SpanSoAChunkBundle } from '../utils/soaBuffers';
import { buildSoAChunksFromPrimitives } from '../utils/soaBuffers';
import { perfMetrics } from '../utils/perfMetrics';
import { aggregateLaneEvents } from '../utils/lodAggregation';
import { resolveThreadLaneMode } from '../utils/processOrder';
import { tileCache } from '../cache/tileCache';
import { useStreamingData } from './useStreamingData';
import {
  createApiStreamingProvider,
  createSimulatedStreamingProvider
} from '../utils/streamingDataProvider';

// Safety default: do NOT prune events by viewport lane ids.
// Lane visibility is a render concern; data fetch/transform should keep full fidelity.
const ENABLE_VIEWPORT_LANE_FILTER = false;
// Safety default: do NOT prune events by viewport time domain.
const ENABLE_VIEWPORT_TIME_FILTER = true;
// Fetch full current OBD range instead of current viewport time domain.
const USE_VIEW_TIME_FOR_FETCH = false;

interface UseDataFetchingArgs {
  obd: any;
  startTime: number;
  endTime: number;
  bins: number;
  localTraceText: string;
  dataMapping: GanttDataMapping | null;
  ganttConfig: any;
  viewStateRef: React.MutableRefObject<ViewState>;
  apiUrl: string;
  traceUrl: string;
  defaultEndUs: number;
  setIsFetching: (value: boolean) => void;
  setData: (next: any[]) => void;
  setRawEvents?: (next: any[] | null) => void;
  setRenderSoA?: (next: SpanSoAChunkBundle | null) => void;
  setIsSoaPacking?: (value: boolean) => void;
  setIsMappingProcessing?: (value: boolean) => void;
  setDataMapping: Dispatch<SetStateAction<GanttDataMapping | null>>;
  setGanttConfig: (next: any) => void;
  setProcessSortMode: Dispatch<SetStateAction<ProcessSortMode>>;
  setMessages: (updater: (prev: any[]) => any[]) => void;
  setObd: (next: any) => void;
  setEndTime: (next: number) => void;
  setError: (value: any) => void;
  setShowUploadPrompt: (value: boolean) => void;
  setLoading: (value: boolean) => void;
  setViewRange: (updater: (prev: any) => any) => void;
  fetchRangeRef: React.MutableRefObject<{ start: number; end: number }>;
  viewRangeRef: React.MutableRefObject<{ start: number; end: number }>;
  redrawRef: React.MutableRefObject<(() => void) | null>;
  viewRange: { start: number; end: number };
  forkRelationsRef: React.MutableRefObject<any>;
  forkLoggedRef: React.MutableRefObject<boolean>;
  configSourceLabel?: string;
  autoAnalyzeOnFirstLoad?: boolean;
}

export function useDataFetching({
  obd,
  startTime,
  endTime,
  bins,
  localTraceText,
  dataMapping,
  ganttConfig,
  viewStateRef,
  apiUrl,
  traceUrl,
  defaultEndUs,
  setIsFetching,
  setData,
  setRawEvents,
  setRenderSoA,
  setIsSoaPacking,
  setIsMappingProcessing,
  setDataMapping,
  setGanttConfig,
  setProcessSortMode,
  setMessages,
  setObd,
  setEndTime,
  setError,
  setShowUploadPrompt,
  setLoading,
  setViewRange,
  fetchRangeRef,
  viewRangeRef,
  redrawRef,
  viewRange,
  forkRelationsRef,
  forkLoggedRef,
  configSourceLabel,
  autoAnalyzeOnFirstLoad = true
}: UseDataFetchingArgs) {
  const abortRef = useRef<AbortController | null>(null);
  const requestSeqRef = useRef(0);
  const debounceRef = useRef<number | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const dataMappingRef = useRef(dataMapping);
  const mappingChangedRef = useRef(false);
  const initialFitDoneRef = useRef(false);
  const ganttConfigRef = useRef(ganttConfig);
  const startTimeRef = useRef(startTime);
  const endTimeRef = useRef(endTime);
  const lastTransformedRef = useRef<any[] | null>(null);
  const lastThreadOrderModeRef = useRef<string>('auto');
  const soaRebuildRef = useRef<number | null>(null);
  const fullDataRef = useRef<any[] | null>(null);
  const apiStreamingProviderRef = useRef(createApiStreamingProvider());
  const simulatedStreamingProviderRef = useRef(createSimulatedStreamingProvider());

  const streamingEnabled = ganttConfig?.performance?.streamingEnabled === true;
  const streamingSimulate = ganttConfig?.performance?.streamingSimulate === true;
  const streamingMaxReqPerSec = ganttConfig?.performance?.streamingMaxReqPerSec;
  const streamingBufferFactor = ganttConfig?.performance?.streamingBufferFactor;

  const yieldToUi = useCallback(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    []
  );

  const getLaneKeyValue = useCallback((ev: any, path: string) => {
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
  }, []);

  const buildSoAForView = useCallback((events: any[], threadOrderMode: string) => {
    if (!Array.isArray(events) || events.length === 0) return null;
    const colorConfig = ganttConfigRef.current?.color;
    const legacyColorConfig = ganttConfigRef.current?.colorMapping;
    const laneFieldPath = getThreadLaneFieldPath(
      ganttConfigRef.current?.yAxis?.hierarchy2LaneRule
    );
    const laneBuckets = new Map<string, any[]>();
    if (threadOrderMode === 'auto') {
      const byHierarchyPath = new Map<string, Map<string, any[]>>();
      events.forEach((ev) => {
        const hierarchyValues = Array.isArray(ev?.hierarchyValues)
          ? ev.hierarchyValues
          : ['unknown', '<N/A>'];
        const hierarchy1 = String(hierarchyValues[0] ?? 'unknown');
        const hierarchyPath = String(
          hierarchyValues.length > 1
            ? hierarchyValues.slice(1).map((v: any) => String(v ?? '<N/A>')).join('|')
            : '<N/A>'
        );
        const hierarchyMap = byHierarchyPath.get(hierarchy1) || new Map<string, any[]>();
        const bucket = hierarchyMap.get(hierarchyPath) || [];
        bucket.push(ev);
        hierarchyMap.set(hierarchyPath, bucket);
        byHierarchyPath.set(hierarchy1, hierarchyMap);
      });
      const buildAutoLanes = (items: any[]) => {
        if (!Array.isArray(items) || items.length === 0) return [];
        const sorted = [...items].sort((a, b) => {
          const byStart = (a.start ?? 0) - (b.start ?? 0);
          if (byStart !== 0) return byStart;
          return (a.end ?? 0) - (b.end ?? 0);
        });
        const lanes: any[][] = [];
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
      byHierarchyPath.forEach((pathMap, hierarchy1) => {
        pathMap.forEach((items, hierarchyPath) => {
          const lanes = buildAutoLanes(items);
          lanes.forEach((laneEvents, idx) => {
            const pathValues = [hierarchy1, ...String(hierarchyPath).split('|').filter(Boolean)];
            const laneKey = buildHierarchyLaneKey(pathValues, idx);
            laneEvents.forEach((ev) => {
              ev.laneKey = laneKey;
            });
            laneBuckets.set(laneKey, laneEvents);
          });
        });
      });
    } else {
      events.forEach((ev) => {
        const hierarchyValues = Array.isArray(ev?.hierarchyValues)
          ? ev.hierarchyValues
          : ['unknown', '<N/A>'];
        let laneValue: unknown;
        if (laneFieldPath && threadOrderMode === 'level') {
          const raw = getLaneKeyValue(ev, laneFieldPath);
          laneValue = raw !== undefined && raw !== null ? raw : '<N/A>';
        } else {
          laneValue = ev?.level ?? 0;
        }
        const laneKey = buildHierarchyLaneKey(hierarchyValues, laneValue ?? 0);
        ev.laneKey = laneKey;
        const bucket = laneBuckets.get(laneKey) || [];
        bucket.push(ev);
        laneBuckets.set(laneKey, bucket);
      });
    }
    const primitives: any[] = [];
    const viewSnapshot = viewStateRef.current;
    const viewStart = Number(viewSnapshot?.timeDomain?.[0] ?? startTimeRef.current);
    const viewEnd = Number(viewSnapshot?.timeDomain?.[1] ?? endTimeRef.current);
    const viewportPxWidth = Number(viewSnapshot?.viewportPxWidth ?? 1);
    const pixelWindow = Number(viewSnapshot?.pixelWindow ?? 1);
    laneBuckets.forEach((laneEvents, laneId) => {
      laneEvents.sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
      const colorKeyForEvent = (ev: any) => {
        const hierarchyValues = Array.isArray(ev?.hierarchyValues)
          ? ev.hierarchyValues
          : ['unknown', '<N/A>'];
        const trackKey = String(
          hierarchyValues.length > 1
            ? hierarchyValues.slice(1).map((v: any) => String(v ?? '<N/A>')).join('|')
            : laneId
        );
        const trackMeta = {
          type: 'lane',
          hierarchy1: hierarchyValues[0],
          hierarchyPath: hierarchyValues.slice(1),
          level: ev?.level
        };
        return resolveColorKey(ev, trackKey, trackMeta, colorConfig, legacyColorConfig);
      };
      const lanePrimitives = aggregateLaneEvents(laneEvents, {
        laneId,
        timeDomain: [viewStart, viewEnd],
        viewportPxWidth,
        pixelWindow,
        eventsSortedByStart: true,
        colorKeyForEvent
      });
      // Avoid `arr.push(...bigArray)` which can throw RangeError (stack/arguments limit).
      for (let i = 0; i < lanePrimitives.length; i += 1) primitives.push(lanePrimitives[i]);
    });
    return buildSoAChunksFromPrimitives(primitives);
  }, [getLaneKeyValue, viewStateRef]);

  useEffect(() => {
    if (!workerRef.current) {
      workerRef.current = new Worker(
        new URL('../workers/dataWorker.ts', import.meta.url),
        { type: 'module' }
      );
    }
    return () => {
      if (workerRef.current) {
        workerRef.current.terminate();
        workerRef.current = null;
      }
    };
  }, []);

  const handleStreamingRequest = useCallback(
    async (request: StreamingRequest) => {
      if (!streamingEnabled) return;
      if (streamingSimulate) return;
      const useSimulated = !apiUrl;
      if (useSimulated && !Array.isArray(fullDataRef.current)) return;

      const requestId = ++requestSeqRef.current;
      if (abortRef.current) abortRef.current.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        setIsFetching(true);
        const fetchStartMs = performance.now();
        const sourceUnit = dataMappingRef.current?.xAxis?.timeUnit;
        const toSourceTime = (valueUs: number) => {
          switch (sourceUnit) {
            case 'ns':
              return valueUs * 1000;
            case 'ms':
              return valueUs / 1000;
            case 's':
              return valueUs / 1_000_000;
            case 'us':
            default:
              return valueUs;
          }
        };

        const viewSnapshot = viewStateRef.current;
        const viewStart = Number(viewSnapshot?.timeDomain?.[0] ?? startTimeRef.current);
        const viewEnd = Number(viewSnapshot?.timeDomain?.[1] ?? endTimeRef.current);
        const fetchWindowStart = Number(request.timeWindow?.[0] ?? viewStart);
        const fetchWindowEnd = Number(request.timeWindow?.[1] ?? viewEnd);
        const fetchStart = toSourceTime(fetchWindowStart);
        const fetchEnd = toSourceTime(fetchWindowEnd);

        const lanes = Array.isArray(request.laneIds) ? request.laneIds : [];
        const viewportPxWidth = Number(request.viewportPxWidth) || undefined;
        const pixelWindow = Number(request.summaryLevel) || 1;
        const threadOrderMode = resolveThreadLaneMode(
          ganttConfigRef.current?.yAxis?.hierarchy2LaneRule,
          ganttConfigRef.current?.yAxis?.thread?.orderMode
        );
        const webglEnabled = ganttConfigRef.current?.performance?.webglEnabled !== false;
        const laneFieldPath = getThreadLaneFieldPath(
          ganttConfigRef.current?.yAxis?.hierarchy2LaneRule
        );
        const filters = Array.isArray(viewSnapshot?.filters) ? viewSnapshot.filters : [];
        const filtersHash = JSON.stringify(filters || []);
        const tileSizeUs = Math.max(
          1_000_000,
          Math.floor(Math.abs(fetchWindowEnd - fetchWindowStart) / 50) || 1_000_000
        );
        const traceId = apiUrl || traceUrl || configSourceLabel || 'trace';

        const applyViewportFilter = (eventsToFilter: any[]) => {
          if (!Array.isArray(eventsToFilter) || eventsToFilter.length === 0) return [];
          let next = eventsToFilter;

          if (ENABLE_VIEWPORT_LANE_FILTER && lanes.length > 0) {
            const laneSet = new Set(lanes.map((lane) => String(lane)));
            next = next.filter((ev) => {
              const hierarchyValues = Array.isArray(ev?.hierarchyValues)
                ? ev.hierarchyValues.map((value: any) => String(value ?? ''))
                : [];
              const hierarchy1 = hierarchyValues[0] ?? '';
              const hierarchyPath = hierarchyValues.slice(1).join('|');
              const track = String(ev?.track ?? '');
              return (
                laneSet.has(hierarchy1) ||
                laneSet.has(hierarchyPath) ||
                (track && laneSet.has(track))
              );
            });
          }

          if (
            ENABLE_VIEWPORT_TIME_FILTER &&
            Number.isFinite(fetchWindowStart) &&
            Number.isFinite(fetchWindowEnd)
          ) {
            next = next.filter((ev) => {
              const start = Number(ev?.start ?? 0);
              const end = Number(ev?.end ?? 0);
              return end >= fetchWindowStart && start <= fetchWindowEnd;
            });
          }

          return next;
        };

        if (dataMappingRef.current && lanes.length > 0) {
          const cached = tileCache.getRange({
            traceId,
            laneIds: lanes,
            t0: fetchWindowStart,
            t1: fetchWindowEnd,
            pixelWindow,
            filtersHash,
            tileSizeUs
          });
          if (cached.hit) {
            const filteredTransformed = applyViewportFilter(cached.events);
            lastTransformedRef.current = cached.events;
            lastThreadOrderModeRef.current = threadOrderMode;
            if (typeof setRenderSoA === 'function') {
              if (webglEnabled) {
                setIsSoaPacking?.(true);
                setRenderSoA(buildSoAForView(filteredTransformed, threadOrderMode));
                setIsSoaPacking?.(false);
              } else {
                setRenderSoA(null);
              }
            }
            if (filteredTransformed.length > 0 || !dataMapping) {
              setData(filteredTransformed);
            }
            const forkFromTransformed = buildProcessForkRelations(filteredTransformed);
            if (forkFromTransformed?.parentByHierarchy1 instanceof Map) {
              forkRelationsRef.current = forkFromTransformed;
            }
            setError(null);
            setShowUploadPrompt(false);
            setLoading(false);
            setIsFetching(false);
            return;
          }
        }

        const provider = useSimulated
          ? simulatedStreamingProviderRef.current
          : apiStreamingProviderRef.current;
        const rawData = await provider.fetch(request, {
          apiUrl,
          bins,
          filters,
          signal: controller.signal,
          fullData: fullDataRef.current || undefined
        });
        const fetchMs = performance.now() - fetchStartMs;

        if (requestSeqRef.current !== requestId || controller.signal.aborted) return;

        const rawEvents = Array.isArray(rawData?.events) ? rawData.events : [];
        if (typeof setRawEvents === 'function') {
          setRawEvents(rawEvents.length > 0 ? rawEvents : null);
        }

        let transformed: any[] = [];
        let analysisResult: any = null;
        let workerSoA: SpanSoAChunkBundle | null = null;
        const decodeStartMs = performance.now();

        if (
          webglEnabled &&
          dataMappingRef.current &&
          Array.isArray(rawData?.events) &&
          rawData.events.length > 0 &&
          workerRef.current
        ) {
          const worker = workerRef.current;
          const workerResult = await new Promise<{
            id: number;
            events: any[];
            soaBundle: SpanSoAChunkBundle;
          }>((resolve, reject) => {
            const handleMessage = (event: MessageEvent) => {
              if (event.data?.id !== requestId) return;
              worker.removeEventListener('message', handleMessage);
              worker.removeEventListener('error', handleError);
              resolve(event.data);
            };
            const handleError = (event: ErrorEvent) => {
              worker.removeEventListener('message', handleMessage);
              worker.removeEventListener('error', handleError);
              reject(event.error || event.message);
            };
            worker.addEventListener('message', handleMessage);
            worker.addEventListener('error', handleError);
            worker.postMessage({
              id: requestId,
              rawEvents: rawData.events,
              dataMapping: dataMappingRef.current,
              colorConfig: ganttConfigRef.current?.color,
              legacyColorConfig: ganttConfigRef.current?.colorMapping,
              threadOrderMode,
              laneFieldPath,
              view: {
                timeDomain: [viewStart, viewEnd],
                viewportPxWidth: viewportPxWidth || 1,
                pixelWindow,
                visibleLaneIds: lanes
              }
            });
          });
          if (requestSeqRef.current !== requestId || controller.signal.aborted) return;
          transformed = workerResult.events;
          workerSoA = workerResult.soaBundle;
          } else if (!dataMappingRef.current && autoAnalyzeOnFirstLoad) {
          try {
            setIsMappingProcessing?.(true);
              analysisResult = await analyzeAndInitialize(rawData?.events || []);
            if (analysisResult?.dataMapping) {
              dataMappingRef.current = analysisResult.dataMapping;
              setDataMapping(analysisResult.dataMapping);
            }
            if (analysisResult?.ganttConfig) {
              ganttConfigRef.current = analysisResult.ganttConfig;
              setGanttConfig(analysisResult.ganttConfig);
            }
            if (analysisResult?.processSortMode) {
              setProcessSortMode(analysisResult.processSortMode);
            }
          } finally {
            setIsMappingProcessing?.(false);
          }
        } else if (dataMappingRef.current && Array.isArray(rawData?.events)) {
          try {
            setIsMappingProcessing?.(true);
            const flatMapping = dataMappingToFlatFieldMapping(dataMappingRef.current);
            const hierarchyFields = getHierarchyFieldsFromMapping(dataMappingRef.current);
            const timeMultiplier = getTimeMultiplier(dataMappingRef.current.xAxis.timeUnit);
            transformed = processEventsMinimal(
              rawData.events,
              flatMapping,
              timeMultiplier,
              hierarchyFields
            );
          } finally {
            setIsMappingProcessing?.(false);
          }
        }

        if (requestSeqRef.current !== requestId || controller.signal.aborted) return;

        lastTransformedRef.current = transformed;
        lastThreadOrderModeRef.current = threadOrderMode;

        const filteredTransformed = applyViewportFilter(transformed);
        const decodeMs = performance.now() - decodeStartMs;

        perfMetrics.record({
          timestamp: Date.now(),
          fetchMs,
          decodeMs
        });

        if (dataMappingRef.current && filteredTransformed.length > 0 && lanes.length > 0) {
          tileCache.setRange({
            traceId,
            laneIds: lanes,
            t0: fetchWindowStart,
            t1: fetchWindowEnd,
            pixelWindow,
            filtersHash,
            tileSizeUs,
            events: filteredTransformed
          });
        }

        if (typeof setRenderSoA === 'function') {
          if (webglEnabled) {
            setIsSoaPacking?.(true);
            setRenderSoA(workerSoA || buildSoAForView(filteredTransformed, threadOrderMode));
            setIsSoaPacking?.(false);
          } else {
            setRenderSoA(null);
          }
        }

        const forkFromRaw = Array.isArray(rawData?.events)
          ? buildProcessForkRelationsFromRawEvents(rawData.events)
          : null;
        const forkFromTransformed = buildProcessForkRelations(transformed);
        const forkRelations =
          forkFromRaw && forkFromRaw.edges.length > 0 ? forkFromRaw : forkFromTransformed;

        if (forkRelations && forkRelations.parentByHierarchy1 instanceof Map) {
          const prev = forkRelationsRef.current;
          const prevEdgeCount = Array.isArray(prev?.edges) ? prev.edges.length : 0;
          const nextEdgeCount = Array.isArray(forkRelations.edges) ? forkRelations.edges.length : 0;
          if (prev && prev.parentByHierarchy1 instanceof Map && prevEdgeCount > 0 && nextEdgeCount === 0) {
            // keep prev
          } else if (
            prev &&
            prev.parentByHierarchy1 instanceof Map &&
            prevEdgeCount > 0 &&
            nextEdgeCount > 0
          ) {
            const mergedParent = new Map<string, string>(prev.parentByHierarchy1);
            const mergedConflicts = [...(prev.conflicts || []), ...(forkRelations.conflicts || [])];
            forkRelations.parentByHierarchy1.forEach((value: string, key: string) => {
              if (!mergedParent.has(key)) {
                mergedParent.set(key, value);
                return;
              }
              if (mergedParent.get(key) !== value) {
                mergedConflicts.push({ hierarchy1: key, parents: [mergedParent.get(key), value] });
              }
            });
            forkRelations.parentByHierarchy1 = mergedParent;
            forkRelations.conflicts = mergedConflicts;
          }
          forkRelationsRef.current = forkRelations;
        }

        setError(null);
        setShowUploadPrompt(false);
        setLoading(false);
        setIsFetching(false);
      } catch (err: any) {
        if (requestSeqRef.current !== requestId || controller.signal.aborted) return;
        setError(err);
        setShowUploadPrompt(Boolean(err && err.needsUpload));
        setLoading(false);
        setIsFetching(false);
      }
    },
    [
      apiUrl,
      bins,
      configSourceLabel,
      dataMapping,
      defaultEndUs,
      setData,
      setDataMapping,
      setEndTime,
      setError,
      setGanttConfig,
      setIsFetching,
      setIsMappingProcessing,
      setIsSoaPacking,
      setLoading,
      setMessages,
      setObd,
      setProcessSortMode,
      setRawEvents,
      setRenderSoA,
      setShowUploadPrompt,
      streamingEnabled,
      streamingSimulate,
      traceUrl
    ]
  );

  useEffect(() => {
    dataMappingRef.current = dataMapping;
    tileCache.clear();
    mappingChangedRef.current = true;
  }, [dataMapping]);

  useEffect(() => {
    ganttConfigRef.current = ganttConfig;
  }, [ganttConfig]);

  useEffect(() => {
    startTimeRef.current = startTime;
  }, [startTime]);

  useEffect(() => {
    endTimeRef.current = endTime;
  }, [endTime]);

  const streamingStats = useStreamingData({
    config: {
      enabled: streamingEnabled,
      maxRequestsPerSec: streamingMaxReqPerSec,
      bufferFactor: streamingBufferFactor
    },
    viewStateRef,
    timeBounds: { start: startTime, end: endTime },
    onRequest: handleStreamingRequest
  });

  // Fetch and transform data when parameters change
  useEffect(() => {
    if (!obd) return;
    if (streamingEnabled && !streamingSimulate) return;

      const scheduleLoad = () => {

      const requestId = ++requestSeqRef.current;
      if (abortRef.current) abortRef.current.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      const loadData = async () => {
        try {
          setIsFetching(true);
          const fetchStartMs = performance.now();
          // Convert UI microseconds to source time unit for backend fetch
          const sourceUnit = dataMappingRef.current?.xAxis?.timeUnit;
          const toSourceTime = (valueUs: number) => {
            switch (sourceUnit) {
              case 'ns':
                return valueUs * 1000;
              case 'ms':
                return valueUs / 1000;
              case 's':
                return valueUs / 1_000_000;
              case 'us':
              default:
                return valueUs;
            }
          };

          const viewSnapshot = viewStateRef.current;
          const viewStart = Number(viewSnapshot?.timeDomain?.[0] ?? startTimeRef.current);
          const viewEnd = Number(viewSnapshot?.timeDomain?.[1] ?? endTimeRef.current);
          const fetchWindowStart = USE_VIEW_TIME_FOR_FETCH ? viewStart : Number(startTimeRef.current);
          const fetchWindowEnd = USE_VIEW_TIME_FOR_FETCH ? viewEnd : Number(endTimeRef.current);
          const fetchStart = toSourceTime(fetchWindowStart);
          const fetchEnd = toSourceTime(fetchWindowEnd);

          const lanes = Array.isArray(viewSnapshot?.visibleLaneIds)
            ? viewSnapshot.visibleLaneIds
            : [];
          const viewportPxWidth = Number(viewSnapshot?.viewportPxWidth) || undefined;
          const pixelWindow = Number(viewSnapshot?.pixelWindow) || 1;
          const threadOrderMode = resolveThreadLaneMode(
            ganttConfigRef.current?.yAxis?.hierarchy2LaneRule,
            ganttConfigRef.current?.yAxis?.thread?.orderMode
          );
          const webglEnabled = ganttConfigRef.current?.performance?.webglEnabled !== false;
          const laneFieldPath = getThreadLaneFieldPath(
            ganttConfigRef.current?.yAxis?.hierarchy2LaneRule
          );
          const filters = Array.isArray(viewSnapshot?.filters) ? viewSnapshot.filters : [];
          const filtersHash = JSON.stringify(filters || []);
          const tileSizeUs = Math.max(
            1_000_000,
            Math.floor(Math.abs(viewEnd - viewStart) / 50) || 1_000_000
          );
          const traceId = apiUrl || traceUrl || configSourceLabel || 'trace';

          const applyViewportFilter = (eventsToFilter: any[]) => {
            if (!Array.isArray(eventsToFilter) || eventsToFilter.length === 0) return [];
            let next = eventsToFilter;

            if (ENABLE_VIEWPORT_LANE_FILTER && lanes.length > 0) {
              const laneSet = new Set(lanes.map((lane) => String(lane)));
              next = next.filter((ev) => {
                const hierarchyValues = Array.isArray(ev?.hierarchyValues)
                  ? ev.hierarchyValues.map((value: any) => String(value ?? ''))
                  : [];
                const hierarchy1 = hierarchyValues[0] ?? '';
                const hierarchyPath = hierarchyValues.slice(1).join('|');
                const track = String(ev?.track ?? '');
                return (
                  laneSet.has(hierarchy1) ||
                  laneSet.has(hierarchyPath) ||
                  (track && laneSet.has(track))
                );
              });
            }

            if (
              ENABLE_VIEWPORT_TIME_FILTER &&
              Number.isFinite(viewStart) &&
              Number.isFinite(viewEnd)
            ) {
              next = next.filter((ev) => {
                const start = Number(ev?.start ?? 0);
                const end = Number(ev?.end ?? 0);
                return end >= viewStart && start <= viewEnd;
              });
            }

            return next;
          };

          if (dataMappingRef.current && lanes.length > 0) {
            const cached = tileCache.getRange({
              traceId,
              laneIds: lanes,
              t0: viewStart,
              t1: viewEnd,
              pixelWindow,
              filtersHash,
              tileSizeUs
            });
            if (cached.hit) {
              const filteredTransformed = applyViewportFilter(cached.events);
            lastTransformedRef.current = cached.events;
            lastThreadOrderModeRef.current = threadOrderMode;
              if (typeof setRenderSoA === 'function') {
                if (webglEnabled) {
                  setIsSoaPacking?.(true);
                  setRenderSoA(buildSoAForView(filteredTransformed, threadOrderMode));
                  setIsSoaPacking?.(false);
                } else {
                  setRenderSoA(null);
                }
              }
              if (filteredTransformed.length > 0 || !dataMapping) {
                setData(filteredTransformed);
              }
              const forkFromTransformed = buildProcessForkRelations(filteredTransformed);
              if (forkFromTransformed?.parentByHierarchy1 instanceof Map) {
                forkRelationsRef.current = forkFromTransformed;
              }
              setError(null);
              setShowUploadPrompt(false);
              setLoading(false);
              setIsFetching(false);
              return;
            }
          }

          const rawData = await fetchDataWithFallback(
            fetchStart,
            fetchEnd,
            bins,
            apiUrl,
            traceUrl,
            localTraceText,
            {
              signal: controller.signal,
              lanes: ENABLE_VIEWPORT_LANE_FILTER ? lanes : [],
              viewportPxWidth,
              pixelWindow,
              filters
            }
          );
          const fetchMs = performance.now() - fetchStartMs;

          if (requestSeqRef.current !== requestId || controller.signal.aborted) return;

          const rawEvents = Array.isArray(rawData?.events) ? rawData.events : [];
          if (typeof setRawEvents === 'function') {
            setRawEvents(rawEvents.length > 0 ? rawEvents : null);
          }
          if (streamingSimulate && rawEvents.length > 0) {
            fullDataRef.current = rawEvents;
          }

          const debugLogs = ganttConfigRef.current?.performance?.debugLogs === true;
          if (debugLogs) {
            // Debug: inspect shape of data received by frontend
            const events = rawData?.events;
            const eventCount = Array.isArray(events) ? events.length : 0;
            const sample = eventCount > 0 ? events[0] : null;
            const sampleStr = sample ? JSON.stringify(sample, null, 2) : '';
            const sampleSize = sampleStr.length;
            console.group('[Frontend] Raw data received');
            console.log('Top-level keys:', rawData ? Object.keys(rawData) : []);
            console.log('events count:', eventCount);
            if (rawData?.metadata) console.log('metadata:', rawData.metadata);
            if (sample) {
              console.log('First event keys:', Object.keys(sample));
              console.log(
                'First event (sample) size:',
                sampleSize,
                'chars (~' + Math.ceil(sampleSize / 4) + ' tokens)'
              );
              console.log(
                'First event sample:',
                sampleStr.slice(0, 2000) +
                  (sampleStr.length > 2000 ? '\n... (truncated)' : '')
              );
            }
            console.groupEnd();
          }

          // Process data via agent mapping only (no transformData fallback)
          let transformed: any[] = [];
          let analysisResult: any = null;
          let workerSoA: SpanSoAChunkBundle | null = null;
          const decodeStartMs = performance.now();

          if (
            webglEnabled &&
            dataMappingRef.current &&
            Array.isArray(rawData?.events) &&
            rawData.events.length > 0 &&
            workerRef.current
          ) {
            const worker = workerRef.current;
          const workerResult = await new Promise<{
              id: number;
              events: any[];
              soaBundle: SpanSoAChunkBundle;
            }>((resolve, reject) => {
              const handleMessage = (event: MessageEvent) => {
                if (event.data?.id !== requestId) return;
                worker.removeEventListener('message', handleMessage);
                worker.removeEventListener('error', handleError);
                resolve(event.data);
              };
              const handleError = (event: ErrorEvent) => {
                worker.removeEventListener('message', handleMessage);
                worker.removeEventListener('error', handleError);
                reject(event.error || event.message);
              };
              worker.addEventListener('message', handleMessage);
              worker.addEventListener('error', handleError);
              worker.postMessage({
                id: requestId,
                rawEvents: rawData.events,
                  dataMapping: dataMappingRef.current,
                  colorConfig: ganttConfigRef.current?.color,
                  legacyColorConfig: ganttConfigRef.current?.colorMapping,
                threadOrderMode,
                laneFieldPath,
                view: {
                  timeDomain: [viewStart, viewEnd],
                  viewportPxWidth: viewportPxWidth || 1,
                  pixelWindow,
                  visibleLaneIds: lanes
                }
              });
            });

            if (requestSeqRef.current !== requestId || controller.signal.aborted) return;

            transformed = Array.isArray(workerResult?.events) ? workerResult.events : [];
            workerSoA = workerResult?.soaBundle ?? null;
          } else if (
            !dataMappingRef.current &&
            Array.isArray(rawData?.events) &&
            rawData.events.length > 0
          ) {
            // First load: run agent to detect mapping and process events
            if (autoAnalyzeOnFirstLoad) {
              try {
                console.log('Running Data Analysis Agent for data mapping detection...');
                analysisResult = (await analyzeAndInitialize(rawData.events)) as any;
                if (analysisResult?.usedFallback) {
                  setError(
                    analysisResult?.error ||
                      'Data Analysis Agent failed. Check console for details.'
                  );
                } else if (analysisResult?.events) {
                  transformed = analysisResult.events;
                }
                console.log(`Processed ${transformed.length} events via agent mapping`);
              } catch (err) {
                console.error('Data Analysis Agent failed:', err);
                setError(
                  (err as Error)?.message ||
                    'Failed to detect data mapping. Check console for details.'
                );
              }
            }
            // When autoAnalyzeOnFirstLoad is false, Data Setup Modal handles mapping
          } else if (
            dataMappingRef.current &&
            Array.isArray(rawData?.events) &&
            rawData.events.length > 0
          ) {
            setIsMappingProcessing?.(true);
            await yieldToUi();
            try {
              const flatMapping = dataMappingToFlatFieldMapping(dataMappingRef.current);
              const hierarchyFields = getHierarchyFieldsFromMapping(dataMappingRef.current);
              const timeMultiplier = getTimeMultiplier(dataMappingRef.current.xAxis.timeUnit);
              transformed = processEventsMinimal(
                rawData.events,
                flatMapping,
                timeMultiplier,
                hierarchyFields
              );
            } finally {
              setIsMappingProcessing?.(false);
            }
          }

          if (requestSeqRef.current !== requestId || controller.signal.aborted) return;

          lastTransformedRef.current = transformed;
          lastThreadOrderModeRef.current = threadOrderMode;

          const filteredTransformed = applyViewportFilter(transformed);
          const decodeMs = performance.now() - decodeStartMs;

          perfMetrics.record({
            timestamp: Date.now(),
            fetchMs,
            decodeMs
          });

          if (dataMappingRef.current && filteredTransformed.length > 0 && lanes.length > 0) {
            tileCache.setRange({
              traceId,
              laneIds: lanes,
              t0: viewStart,
              t1: viewEnd,
              pixelWindow,
              filtersHash,
              tileSizeUs,
              events: filteredTransformed
            });
          }

          if (typeof setRenderSoA === 'function') {
            if (webglEnabled) {
              setIsSoaPacking?.(true);
              setRenderSoA(workerSoA || buildSoAForView(filteredTransformed, threadOrderMode));
              setIsSoaPacking?.(false);
            } else {
              setRenderSoA(null);
            }
          }

          // Build hierarchy1 fork relations from raw events first (start events may be instantaneous and
          // get filtered out by transformData, so using transformed alone can miss forks).
          const forkFromRaw = Array.isArray(rawData?.events)
            ? buildProcessForkRelationsFromRawEvents(rawData.events)
            : null;
          const forkFromTransformed = buildProcessForkRelations(transformed);
          const forkRelations =
            forkFromRaw && forkFromRaw.edges.length > 0 ? forkFromRaw : forkFromTransformed;

          // Don't wipe previously computed relations when a later fetch window lacks start events.
          if (forkRelations && forkRelations.parentByHierarchy1 instanceof Map) {
            const prev = forkRelationsRef.current;
            const prevEdgeCount = Array.isArray(prev?.edges) ? prev.edges.length : 0;
            const nextEdgeCount = Array.isArray(forkRelations.edges)
              ? forkRelations.edges.length
              : 0;
            if (prev && prev.parentByHierarchy1 instanceof Map && prevEdgeCount > 0 && nextEdgeCount === 0) {
              // keep prev
            } else if (
              prev &&
              prev.parentByHierarchy1 instanceof Map &&
              prevEdgeCount > 0 &&
              nextEdgeCount > 0
            ) {
              // merge: hierarchy1 -> parentHierarchy1 (keep first, warn on conflicts)
              const mergedParent = new Map<string, string>(prev.parentByHierarchy1);
              const mergedConflicts = [
                ...(prev.conflicts || []),
                ...(forkRelations.conflicts || [])
              ];
              for (const [h1, parentH1] of forkRelations.parentByHierarchy1.entries()) {
                const hierarchy1 = String(h1);
                const parentHierarchy1 = String(parentH1);
                if (!mergedParent.has(hierarchy1)) {
                  mergedParent.set(hierarchy1, parentHierarchy1);
                } else if (mergedParent.get(hierarchy1) !== parentHierarchy1) {
                  mergedConflicts.push({
                    hierarchy1,
                    parentHierarchy1Existing: mergedParent.get(hierarchy1)!,
                    parentHierarchy1New: parentHierarchy1
                  });
                }
              }
              const mergedChildren = new Map<string, string[]>();
              const mergedEdges: any[] = [];
              for (const [h1, parentH1] of mergedParent.entries()) {
                const hierarchy1 = String(h1);
                const parentHierarchy1 = String(parentH1);
                mergedEdges.push({ parentHierarchy1, hierarchy1 });
                if (!mergedChildren.has(parentHierarchy1)) mergedChildren.set(parentHierarchy1, []);
                mergedChildren.get(parentHierarchy1)!.push(hierarchy1);
              }
              forkRelationsRef.current = {
                ...forkRelations,
                parentByHierarchy1: mergedParent,
                childrenByHierarchy1: mergedChildren,
                edges: mergedEdges,
                conflicts: mergedConflicts
              };
            } else {
              forkRelationsRef.current = forkRelations;
            }
          }

          // When refetch returns 0 events but we already have a mapping, keep existing chart data
          // so the chart does not go empty (e.g. backend returns empty for current time range).
          const shouldUpdateData = filteredTransformed.length > 0 || !dataMapping;
          if (shouldUpdateData) {
            setData(filteredTransformed);
          }

          if (!forkLoggedRef.current && Array.isArray(transformed) && transformed.length > 0) {
            forkLoggedRef.current = true;
            try {
              const MAX_VERBOSE = 500;
              const MAX_EDGE_LOG = 200;
              const rel = forkRelationsRef.current || forkRelations;
              const edgeSample =
                rel.edges.length > MAX_EDGE_LOG ? rel.edges.slice(0, MAX_EDGE_LOG) : rel.edges;

              console.groupCollapsed(
                `[fork] edges=${rel.edges.length}, startEvents=${rel.startEventCount}, missingHierarchy1=${(rel as any).missingHierarchy1Count ?? 0}, missingPpid=${rel.missingPpidCount}`
              );
              console.log('edges sample (parentHierarchy1 -> hierarchy1):', edgeSample);
              if (rel.edges.length > MAX_EDGE_LOG) {
                console.log(`... +${rel.edges.length - MAX_EDGE_LOG} more edges`);
              }

              if (rel.parentByHierarchy1.size <= MAX_VERBOSE) {
                console.log('parentByHierarchy1:', Object.fromEntries(rel.parentByHierarchy1.entries()));
              } else {
                console.log('parentByHierarchy1 (Map):', rel.parentByHierarchy1);
              }

              if (rel.childrenByHierarchy1.size <= MAX_VERBOSE) {
                console.log(
                  'childrenByHierarchy1:',
                  Object.fromEntries(
                    [...rel.childrenByHierarchy1.entries()].map(([parent, children]) => [
                      parent,
                      [...children]
                    ])
                  )
                );
              } else {
                console.log('childrenByHierarchy1 (Map):', rel.childrenByHierarchy1);
              }

              if (rel.conflicts && rel.conflicts.length > 0) {
                console.warn('conflicts:', rel.conflicts);
              }

              if (rel.edges.length === 0) {
                console.warn('[fork] no edges detected. Debug snapshot:', {
                  rawStartContainsCount: forkFromRaw?.debug?.startContainsCount ?? 0,
                  rawStartNameExamples: forkFromRaw?.debug?.startNameExamples ?? [],
                  rawPpidSourceHits: forkFromRaw?.debug?.ppidSourceHits ?? null,
                  rawStartEventCount: forkFromRaw?.startEventCount ?? null,
                  rawMissingHierarchy1: forkFromRaw?.missingHierarchy1Count ?? null,
                  rawMissingPpid: forkFromRaw?.missingPpidCount ?? null
                });
              }
              console.groupEnd();
            } catch (e) {
              console.warn('[fork] failed to log fork relations:', e);
            }
          }

          // Apply analysis results if we detected the mapping on this load
          if (
            analysisResult &&
            analysisResult.dataMapping &&
            !dataMappingRef.current &&
            !analysisResult.usedFallback
          ) {
            setDataMapping(analysisResult.dataMapping);
            console.log('Data mapping detected:', analysisResult.dataMapping);

            // Apply initial config if one was generated
            if (analysisResult.config && Object.keys(analysisResult.config).length > 0) {
              console.log('Applying initial config:', analysisResult.config);
              const hierarchyFields = getHierarchyFieldsFromMapping(analysisResult.dataMapping);
              const hierarchyLevels = Math.max(
                1,
                Number(
                  analysisResult.dataMapping?.features?.hierarchyLevels ||
                    hierarchyFields.length ||
                    1
                )
              );
              const prunedBase = pruneHierarchyConfig(ganttConfigRef.current, hierarchyLevels);
              const nextConfig = applyGanttConfigPatch(
                prunedBase,
                analysisResult.config
              );
              setGanttConfig(nextConfig);

              if (analysisResult.config.yAxis?.hierarchy1OrderRule) {
                setProcessSortMode(
                  inferProcessSortModeFromRule(analysisResult.config.yAxis.hierarchy1OrderRule)
                );
              }

              const fieldCount = analysisResult.dataMapping.schema?.allFields?.length ?? 0;
              setMessages((prev) => [
                ...prev,
                {
                  role: 'system',
                  content: `Info: Data mapping auto-detected (${fieldCount} fields, format: ${analysisResult.dataMapping.schema?.dataFormat || 'unknown'}). Initial configuration applied.`
                }
              ]);
            }

            try {
              // Bundle stores only the dataMapping (including features).
              // Config is derived deterministically from the mapping at load time.
              const bundle = buildConfigBundle(
                analysisResult.dataMapping,
                undefined,
                configSourceLabel
              );
              downloadConfigBundle(bundle);
              setMessages((prev) => [
                ...prev,
                {
                  role: 'system',
                  content: 'Info: Configuration bundle downloaded for this dataset.'
                }
              ]);
            } catch (error) {
              console.warn('Failed to auto-download config bundle:', error);
            }
          }

          // Auto-fit time range
          if (filteredTransformed && filteredTransformed.length > 0) {
            let dataMinStart = Number.POSITIVE_INFINITY;
            let dataMaxEnd = 0;
            filteredTransformed.forEach((e: any) => {
              const start = Number(e.start ?? 0);
              const end = Number(e.end ?? 0);
              if (Number.isFinite(start)) dataMinStart = Math.min(dataMinStart, start);
              if (Number.isFinite(end)) dataMaxEnd = Math.max(dataMaxEnd, end);
            });

            const hasBounds =
              Number.isFinite(dataMinStart) &&
              Number.isFinite(dataMaxEnd) &&
              dataMaxEnd > dataMinStart;
            if (hasBounds) {
              const nextStart = Math.floor(dataMinStart);
              const nextEnd = Math.ceil(dataMaxEnd);
              const viewIsDefault =
                Number(viewRange?.start ?? 0) === 0 &&
                Number(viewRange?.end ?? defaultEndUs) === defaultEndUs;
              if (mappingChangedRef.current || (!initialFitDoneRef.current && viewIsDefault)) {
                mappingChangedRef.current = false;
                initialFitDoneRef.current = true;
                setObd([nextStart, nextEnd, 1]);
                setEndTime(nextEnd);
                setViewRange(() => ({ start: nextStart, end: nextEnd }));
              } else {
                const prevMax = Array.isArray(obd) ? Number(obd[1]) : defaultEndUs;
                const atCurrentMax = Number(endTimeRef.current) >= prevMax;
                if (atCurrentMax && Math.abs(nextEnd - prevMax) > 1) {
                  setObd([nextStart, nextEnd, 1]);
                  if (Number(endTimeRef.current) > nextEnd) setEndTime(nextEnd);
                } else if (nextEnd > prevMax) {
                  setObd([nextStart, nextEnd, 1]);
                }
              }
            }
          }

          if (requestSeqRef.current === requestId && !controller.signal.aborted) {
            setError(null);
            setShowUploadPrompt(false);
            setLoading(false);
            setIsFetching(false);
          }
        } catch (err: any) {
          if (controller.signal.aborted || requestSeqRef.current !== requestId) return;
          console.error('Error loading data:', err);
          setError(err.message);
          if (typeof setRenderSoA === 'function') {
            setRenderSoA(null);
          }
          setShowUploadPrompt(Boolean(err && err.needsUpload));
          setLoading(false);
          setIsFetching(false);
        }
      };

      loadData();
    };

    if (debounceRef.current) {
      window.clearTimeout(debounceRef.current);
    }
    debounceRef.current = window.setTimeout(scheduleLoad, 40);

    return () => {
      if (debounceRef.current) {
        window.clearTimeout(debounceRef.current);
      }
    };
  }, [
    apiUrl,
    autoAnalyzeOnFirstLoad,
    bins,
    dataMapping,
    localTraceText,
    traceUrl,
    defaultEndUs,
    configSourceLabel,
    forkLoggedRef,
    forkRelationsRef,
    setData,
    setRawEvents,
    setRenderSoA,
    setDataMapping,
    setGanttConfig,
    setProcessSortMode,
    setMessages,
    setObd,
    setEndTime,
    setError,
    setShowUploadPrompt,
    setLoading,
    setIsFetching,
    setIsMappingProcessing,
    yieldToUi,
    streamingEnabled,
    streamingSimulate
  ]);

  // Rebuild WebGL SoA when view changes (zoom/pan) without refetching
  useEffect(() => {
    if (typeof setRenderSoA !== 'function') return undefined;
    const webglEnabled = ganttConfigRef.current?.performance?.webglEnabled !== false;
    if (!webglEnabled) {
      setRenderSoA(null);
      return undefined;
    }
    if (!dataMappingRef.current) return undefined;
    const transformed = lastTransformedRef.current;
    if (!Array.isArray(transformed) || transformed.length === 0) return undefined;

    if (soaRebuildRef.current) {
      window.clearTimeout(soaRebuildRef.current);
    }

    const rebuild = () => {
      const viewSnapshot = viewStateRef.current;
      const viewStart = Number(
        viewSnapshot?.timeDomain?.[0] ?? viewRange?.start ?? startTimeRef.current
      );
      const viewEnd = Number(
        viewSnapshot?.timeDomain?.[1] ?? viewRange?.end ?? endTimeRef.current
      );
      const lanes = Array.isArray(viewSnapshot?.visibleLaneIds)
        ? viewSnapshot.visibleLaneIds
        : [];
      let next = transformed;

      if (ENABLE_VIEWPORT_LANE_FILTER && lanes.length > 0) {
        const laneSet = new Set(lanes.map((lane) => String(lane)));
        next = next.filter((ev) => {
          const hierarchyValues = Array.isArray(ev?.hierarchyValues)
            ? ev.hierarchyValues.map((value: any) => String(value ?? ''))
            : [];
          const hierarchy1 = hierarchyValues[0] ?? '';
          const hierarchyPath = hierarchyValues.slice(1).join('|');
          const track = String(ev?.track ?? '');
          return (
            laneSet.has(hierarchy1) ||
            laneSet.has(hierarchyPath) ||
            (track && laneSet.has(track))
          );
        });
      }

      if (
        ENABLE_VIEWPORT_TIME_FILTER &&
        Number.isFinite(viewStart) &&
        Number.isFinite(viewEnd)
      ) {
        next = next.filter((ev) => {
          const start = Number(ev?.start ?? 0);
          const end = Number(ev?.end ?? 0);
          return end >= viewStart && start <= viewEnd;
        });
      }

      const threadOrderMode =
        lastThreadOrderModeRef.current ||
        resolveThreadLaneMode(
          ganttConfigRef.current?.yAxis?.hierarchy2LaneRule,
          ganttConfigRef.current?.yAxis?.thread?.orderMode
        );

      setRenderSoA(buildSoAForView(next, threadOrderMode));
    };

    soaRebuildRef.current = window.setTimeout(rebuild, 30);

    return () => {
      if (soaRebuildRef.current) {
        window.clearTimeout(soaRebuildRef.current);
      }
    };
  }, [buildSoAForView, viewRange, setRenderSoA, setIsSoaPacking, ganttConfig?.performance?.webglEnabled]);

  // Keep viewRange within fetched range
  useEffect(() => {
    const newFetch = { start: Number(startTime), end: Number(endTime) };
    const prevFetch = fetchRangeRef.current;

    setViewRange((prev) => {
      const prevStart = Number(prev?.start);
      const prevEnd = Number(prev?.end);
      const wasFull =
        Number.isFinite(prevStart) &&
        Number.isFinite(prevEnd) &&
        prevStart === Number(prevFetch.start) &&
        prevEnd === Number(prevFetch.end);

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
  }, [startTime, endTime, setViewRange, fetchRangeRef]);

  // Drive imperative redraws from viewRange changes
  useEffect(() => {
    viewRangeRef.current = { start: Number(viewRange.start), end: Number(viewRange.end) };
    if (typeof redrawRef.current === 'function') {
      redrawRef.current();
    }
  }, [viewRange, viewRangeRef, redrawRef]);

  return { streamingStats };
}

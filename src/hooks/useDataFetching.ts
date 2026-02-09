import { useEffect } from 'react';
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
import { inferProcessSortModeFromRule } from '../utils/processOrder';
import { clampNumber } from '../utils/formatting';
import { buildConfigBundle, downloadConfigBundle } from '../utils/configBundle';
import type { GanttDataMapping, ProcessSortMode } from '../types/ganttConfig';

interface UseDataFetchingArgs {
  obd: any;
  startTime: number;
  endTime: number;
  bins: number;
  localTraceText: string;
  dataMapping: GanttDataMapping | null;
  ganttConfig: any;
  apiUrl: string;
  traceUrl: string;
  defaultEndUs: number;
  setIsFetching: (value: boolean) => void;
  setData: (next: any[]) => void;
  setRawEvents?: (next: any[] | null) => void;
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
  apiUrl,
  traceUrl,
  defaultEndUs,
  setIsFetching,
  setData,
  setRawEvents,
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
  // Fetch and transform data when parameters change
  useEffect(() => {
    if (!obd) return;

    const loadData = async () => {
      try {
        setIsFetching(true);
        // Convert UI microseconds to source time unit for backend fetch
        const sourceUnit = dataMapping?.xAxis?.timeUnit;
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
        const fetchStart = toSourceTime(startTime);
        const fetchEnd = toSourceTime(endTime);

        const rawData = await fetchDataWithFallback(
          fetchStart,
          fetchEnd,
          bins,
          apiUrl,
          traceUrl,
          localTraceText
        );
        const rawEvents = Array.isArray(rawData?.events) ? rawData.events : [];
        if (typeof setRawEvents === 'function') {
          setRawEvents(rawEvents.length > 0 ? rawEvents : null);
        }

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
            'First event (sample) size:', sampleSize, 'chars (~' + Math.ceil(sampleSize / 4) + ' tokens)'
          );
          console.log('First event sample:', sampleStr.slice(0, 2000) + (sampleStr.length > 2000 ? '\n... (truncated)' : ''));
        }
        console.groupEnd();

        // Process data via agent mapping only (no transformData fallback)
        let transformed: any[] = [];
        let analysisResult: any = null;

        if (!dataMapping && Array.isArray(rawData?.events) && rawData.events.length > 0) {
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
        } else if (dataMapping && Array.isArray(rawData?.events) && rawData.events.length > 0) {
          const flatMapping = dataMappingToFlatFieldMapping(dataMapping);
          const timeMultiplier = getTimeMultiplier(dataMapping.xAxis.timeUnit);
          transformed = processEventsMinimal(rawData.events, flatMapping, timeMultiplier);
        }

        // Build pid fork relations from raw events first (start events may be instantaneous and
        // get filtered out by transformData, so using transformed alone can miss forks).
        const forkFromRaw = Array.isArray(rawData?.events)
          ? buildProcessForkRelationsFromRawEvents(rawData.events)
          : null;
        const forkFromTransformed = buildProcessForkRelations(transformed);
        const forkRelations =
          forkFromRaw && forkFromRaw.edges.length > 0 ? forkFromRaw : forkFromTransformed;

        // Don't wipe previously computed relations when a later fetch window lacks start events.
        if (forkRelations && forkRelations.parentByPid instanceof Map) {
          const prev = forkRelationsRef.current;
          const prevEdgeCount = Array.isArray(prev?.edges) ? prev.edges.length : 0;
          const nextEdgeCount = Array.isArray(forkRelations.edges) ? forkRelations.edges.length : 0;
          if (prev && prev.parentByPid instanceof Map && prevEdgeCount > 0 && nextEdgeCount === 0) {
            // keep prev
          } else if (
            prev &&
            prev.parentByPid instanceof Map &&
            prevEdgeCount > 0 &&
            nextEdgeCount > 0
          ) {
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
            const mergedEdges: any[] = [];
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

        // When refetch returns 0 events but we already have a mapping, keep existing chart data
        // so the chart does not go empty (e.g. backend returns empty for current time range).
        const shouldUpdateData =
          transformed.length > 0 || !dataMapping;
        if (shouldUpdateData) {
          setData(transformed);
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
                Object.fromEntries(
                  [...rel.childrenByPid.entries()].map(([ppid, children]) => [ppid, [...children]])
                )
              );
            } else {
              console.log('childrenByPid (Map):', rel.childrenByPid);
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
                rawMissingPid: forkFromRaw?.missingPidCount ?? null,
                rawMissingPpid: forkFromRaw?.missingPpidCount ?? null
              });
            }
            console.groupEnd();
          } catch (e) {
            console.warn('[fork] failed to log fork relations:', e);
          }
        }

        // Apply analysis results if we detected the mapping on this load
        if (analysisResult && analysisResult.dataMapping && !dataMapping && !analysisResult.usedFallback) {
          setDataMapping(analysisResult.dataMapping);
          console.log('Data mapping detected:', analysisResult.dataMapping);

          // Apply initial config if one was generated
          if (analysisResult.config && Object.keys(analysisResult.config).length > 0) {
            console.log('Applying initial config:', analysisResult.config);
            const nextConfig = applyGanttConfigPatch(ganttConfig, analysisResult.config);
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
            const bundle = buildConfigBundle(
              analysisResult.dataMapping,
              analysisResult.config,
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
        if (transformed && transformed.length > 0) {
          const dataMaxEnd = transformed.reduce(
            (max: number, e: any) => Math.max(max, Number(e.end) || 0),
            0
          );
          if (Number.isFinite(dataMaxEnd) && dataMaxEnd > 0) {
            const prevMax = Array.isArray(obd) ? Number(obd[1]) : defaultEndUs;
            const atCurrentMax = Number(endTime) >= prevMax;
            if (atCurrentMax && Math.abs(dataMaxEnd - prevMax) > 1) {
              setObd([0, Math.ceil(dataMaxEnd), 1]);
              if (Number(endTime) > dataMaxEnd) setEndTime(Math.ceil(dataMaxEnd));
            } else if (dataMaxEnd > prevMax) {
              setObd([0, Math.ceil(dataMaxEnd), 1]);
            }
          }
        }

        setError(null);
        setShowUploadPrompt(false);
        setLoading(false);
        setIsFetching(false);
      } catch (err: any) {
        console.error('Error loading data:', err);
        setError(err.message);
        setShowUploadPrompt(Boolean(err && err.needsUpload));
        setLoading(false);
        setIsFetching(false);
      }
    };

    loadData();
  }, [startTime, endTime, bins, obd, localTraceText, dataMapping]);

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
}

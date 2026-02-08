import { useEffect } from 'react';
import { analyzeAndInitialize, processEventsMinimal } from '../agents';
import { applyGanttConfigPatch } from '../ganttConfig';
import {
  buildProcessForkRelations,
  buildProcessForkRelationsFromRawEvents,
  fetchDataWithFallback,
  transformData
} from '../utils/dataProcessing';
import { inferProcessSortModeFromRule } from '../utils/processOrder';
import { clampNumber } from '../utils/formatting';

interface UseDataFetchingArgs {
  obd: any;
  startTime: number;
  endTime: number;
  bins: number;
  localTraceText: string;
  dataSchema: any;
  fieldMapping: any;
  ganttConfig: any;
  apiUrl: string;
  traceUrl: string;
  defaultEndUs: number;
  setIsFetching: (value: boolean) => void;
  setData: (next: any[]) => void;
  setDataSchema: (next: any) => void;
  setFieldMapping: (next: any) => void;
  setGanttConfig: (next: any) => void;
  setProcessSortMode: (mode: string) => void;
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
}

export function useDataFetching({
  obd,
  startTime,
  endTime,
  bins,
  localTraceText,
  dataSchema,
  fieldMapping,
  ganttConfig,
  apiUrl,
  traceUrl,
  defaultEndUs,
  setIsFetching,
  setData,
  setDataSchema,
  setFieldMapping,
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
  forkLoggedRef
}: UseDataFetchingArgs) {
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
          apiUrl,
          traceUrl,
          localTraceText
        );

        // Process data - detect schema on first load, use existing mapping for subsequent loads
        let transformed;
        let analysisResult: any = null;

        // First time loading: detect schema and create field mapping
        if (!dataSchema && Array.isArray(rawData?.events) && rawData.events.length > 0) {
          try {
            console.log('Running Data Analysis Agent for schema detection...');
            analysisResult = (await analyzeAndInitialize(rawData.events)) as any;

            if (analysisResult.events && analysisResult.events.length > 0) {
              // Use processed events (original fields preserved, internal _start/_end added)
              transformed = analysisResult.events;
              console.log(
                `Processed ${transformed.length} events (original field names preserved)`
              );
            } else {
              // Fallback to legacy transform
              console.log('Schema detection returned no events, using legacy transform');
              transformed = transformData(rawData);
            }
          } catch (err) {
            console.error('Schema detection failed, using legacy transform:', err);
            transformed = transformData(rawData);
          }
        } else {
          // Subsequent loads: apply field mapping if available
          if (fieldMapping && Array.isArray(rawData?.events) && rawData.events.length > 0) {
            transformed = processEventsMinimal(rawData.events, fieldMapping);
          } else {
            // Fallback to legacy transform if no mapping or no events
            transformed = transformData(rawData);
          }
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

        // Apply analysis results if we detected schema on this load
        if (
          analysisResult &&
          analysisResult.schema &&
          analysisResult.schema.fields &&
          !dataSchema
        ) {
          setDataSchema(analysisResult.schema);
          setFieldMapping(analysisResult.fieldMapping);
          console.log('Data schema detected:', analysisResult.schema);
          console.log('Field mapping:', analysisResult.fieldMapping);

          // Apply initial config if one was generated
          if (analysisResult.config && Object.keys(analysisResult.config).length > 0) {
            console.log('Applying initial config:', analysisResult.config);
            const nextConfig = applyGanttConfigPatch(ganttConfig, analysisResult.config);
            setGanttConfig(nextConfig);

            // Update process sort mode if yAxis config was changed
            if (analysisResult.config.yAxis?.processOrderRule) {
              setProcessSortMode(
                inferProcessSortModeFromRule(analysisResult.config.yAxis.processOrderRule)
              );
            }

            setMessages((prev) => [
              ...prev,
              {
                role: 'system',
                content: `Info: Data schema auto-detected with ${analysisResult.schema.fields.length} fields. Initial configuration applied.`
              }
            ]);
          }
        }

        // Auto-fit time range (slider max) to real data end (max event end), when we are viewing the full current range.
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
              // Never block exploration if we discover data extends beyond current max
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
  }, [startTime, endTime, bins, obd, localTraceText]);

  // Keep viewRange within fetched range; if user isn't zoomed (viewRange == previous fetch range),
  // automatically track the full fetched window.
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

  // Drive imperative redraws from viewRange changes (zoom/pan) without refetching.
  useEffect(() => {
    viewRangeRef.current = { start: Number(viewRange.start), end: Number(viewRange.end) };
    if (typeof redrawRef.current === 'function') {
      redrawRef.current();
    }
  }, [viewRange, viewRangeRef, redrawRef]);
}

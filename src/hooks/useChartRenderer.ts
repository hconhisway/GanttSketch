import { useEffect, useMemo, useRef } from 'react';
import * as d3 from 'd3';
import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from 'react';
import { GANTT_CONFIG } from '../config/ganttConfig';
import type { GanttDataMapping, ProcessSortMode } from '../types/ganttConfig';
import type { ViewState } from '../types/viewState';
import type { RenderPrimitive } from '../types/data';
import type { SpanSoAChunkBundle } from '../utils/soaBuffers';
import { buildProcessStats } from '../utils/dataProcessing';
import { pickTextColor, resolveColor, resolveColorKey } from '../utils/color';
import {
  applyProcessOrderRule,
  comparePid,
  getThreadLaneFieldPath,
  normalizeProcessOrderRule,
  resolveThreadLaneMode
} from '../utils/processOrder';
import { buildTooltipHtml } from '../utils/tooltip';
import { clampNumber, formatTimeUs, formatTimeUsFull } from '../utils/formatting';
import { evalExpr, getValueAtPath, hashStringToInt, isEmptyValue } from '../utils/expression';
import {
  buildHierarchyLaneKey,
  getHierarchyFieldVarName,
  getHierarchyFieldsFromMapping,
  getHierarchyVarName,
  resolveHierarchyLod
} from '../utils/hierarchy';
import { useGanttChart } from './useGanttChart';
import { aggregateLaneEvents } from '../utils/lodAggregation';
import { createWebGLRenderer } from '../rendering/webglRenderer';
import { perfMetrics } from '../utils/perfMetrics';
import { PERF_BUDGETS } from '../config/perfBudgets';

type ViewRange = { start: number; end: number };
type ViewParams = { vs: number; ve: number; span: number; k: number };

type ThreadLevelMap = Map<string | number, any[]>;
type ThreadMap = Map<string, ThreadLevelMap>;
type ThreadsByHierarchy1 = Map<string, ThreadMap>;

interface UseChartRendererArgs {
  chartRef: RefObject<HTMLDivElement>;
  minimapRef: RefObject<HTMLDivElement>;
  xAxisRef: RefObject<HTMLDivElement>;
  yAxisRef: RefObject<HTMLDivElement>;
  viewRangeRef: MutableRefObject<ViewRange | null>;
  viewStateRef: MutableRefObject<ViewState>;
  redrawRef: MutableRefObject<(() => void) | null>;
  renderSoA: SpanSoAChunkBundle | null;
  isSoaPacking: boolean;
  chartData: any[];
  startTime: number;
  endTime: number;
  bins: number;
  obd: any;
  processAggregates: Map<string, any[]>;
  threadsByHierarchy1: ThreadsByHierarchy1;
  expandedHierarchy1Ids: string[];
  yAxisWidth: number;
  processSortMode: ProcessSortMode;
  ganttConfig: any;
  dataMapping: GanttDataMapping | null;
  setYAxisWidth: Dispatch<SetStateAction<number>>;
  setExpandedHierarchy1Ids: Dispatch<SetStateAction<string[]>>;
  setViewRange: Dispatch<SetStateAction<ViewRange>>;
  setViewState: Dispatch<SetStateAction<ViewState>>;
  forkRelationsRef: MutableRefObject<any>;
}

export function useChartRenderer({
  chartRef,
  minimapRef,
  xAxisRef,
  yAxisRef,
  viewRangeRef,
  viewStateRef,
  redrawRef,
  renderSoA,
  isSoaPacking,
  chartData,
  startTime,
  endTime,
  bins,
  obd,
  processAggregates,
  threadsByHierarchy1,
  expandedHierarchy1Ids,
  yAxisWidth,
  processSortMode,
  ganttConfig,
  dataMapping,
  setYAxisWidth,
  setExpandedHierarchy1Ids,
  setViewRange,
  setViewState,
  forkRelationsRef
}: UseChartRendererArgs) {
  const processStats = useMemo(() => buildProcessStats(chartData), [chartData]);
  const processOrderRule = useMemo(
    () => normalizeProcessOrderRule(ganttConfig?.yAxis || {}, processSortMode),
    [ganttConfig, processSortMode]
  );
  const threadOrderMode = useMemo(
    () =>
      resolveThreadLaneMode(
        ganttConfig?.yAxis?.hierarchy2LaneRule ?? ganttConfig?.yAxis?.threadLaneRule,
        ganttConfig?.yAxis?.thread?.orderMode
      ),
    [ganttConfig]
  );
  const threadLaneFieldPath = useMemo(
    () =>
      getThreadLaneFieldPath(
        ganttConfig?.yAxis?.hierarchy2LaneRule ?? ganttConfig?.yAxis?.threadLaneRule
      ),
    [ganttConfig]
  );
  const orderResult = useMemo(() => {
    const hierarchy1Ids = Array.from(processAggregates.keys());
    if (hierarchy1Ids.length === 0) {
      return { orderedHierarchy1Ids: [], depthByHierarchy1: new Map() };
    }
    hierarchy1Ids.sort(comparePid);
    return applyProcessOrderRule(processOrderRule, {
      pids: hierarchy1Ids,
      fork: forkRelationsRef.current,
      processStats
    });
  }, [processAggregates, processOrderRule, processStats, forkRelationsRef]);

  const arraysEqual = (a: string[], b: string[]) =>
    a.length === b.length && a.every((value, index) => value === b[index]);

  const overlayRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (overlayRef.current) {
      overlayRef.current.style.display = isSoaPacking ? 'flex' : 'none';
    }
  }, [isSoaPacking]);

  const updateViewStateFromRender = (partial: Partial<ViewState>) => {
    const prev = viewStateRef.current;
    if (!prev) return;
    let changed = false;
    const next = { ...prev };

    if (
      partial.viewportPxWidth !== undefined &&
      partial.viewportPxWidth !== prev.viewportPxWidth
    ) {
      next.viewportPxWidth = partial.viewportPxWidth;
      changed = true;
    }
    if (
      partial.devicePixelRatio !== undefined &&
      partial.devicePixelRatio !== prev.devicePixelRatio
    ) {
      next.devicePixelRatio = partial.devicePixelRatio;
      changed = true;
    }
    if (partial.scrollTop !== undefined && partial.scrollTop !== prev.scrollTop) {
      next.scrollTop = partial.scrollTop;
      changed = true;
    }
    if (partial.visibleLaneRange) {
      const [start, end] = partial.visibleLaneRange;
      const [prevStart, prevEnd] = prev.visibleLaneRange;
      if (start !== prevStart || end !== prevEnd) {
        next.visibleLaneRange = partial.visibleLaneRange;
        changed = true;
      }
    }
    if (partial.visibleLaneIds) {
      if (!arraysEqual(partial.visibleLaneIds, prev.visibleLaneIds)) {
        next.visibleLaneIds = partial.visibleLaneIds;
        changed = true;
      }
    }
    if (partial.laneOrder) {
      if (!arraysEqual(partial.laneOrder, prev.laneOrder)) {
        next.laneOrder = partial.laneOrder;
        changed = true;
      }
    }
    if (partial.pixelWindow !== undefined && partial.pixelWindow !== prev.pixelWindow) {
      next.pixelWindow = partial.pixelWindow;
      changed = true;
    }

    if (changed) {
      viewStateRef.current = next;
    }
  };

  // Render chart with d3 (canvas + svg hybrid for scalability)
  const renderChartEffect = () => {
    if (!chartRef.current) return;

    const container = chartRef.current;
    let pixelRatio = window.devicePixelRatio || 1;

    const renderChart = () => {
      container.innerHTML = '';
      if (minimapRef.current) minimapRef.current.innerHTML = '';
      if (xAxisRef.current) xAxisRef.current.innerHTML = '';

      // Handle empty data case
      if (!chartData || chartData.length === 0) {
        container.innerHTML = `<div class="chart-empty-state">No data to display</div>`;
        return;
      }

      // Build variable-height process blocks.
      // - Collapsed: show merged bars (processAggregates)
      // - Expanded: the same process row grows into a detail box, showing thread→level lanes
      //   (levels are compacted: missing levels do NOT create empty rows).
      const layoutConfig = ganttConfig?.layout || {};
      const yAxisLayout = layoutConfig?.yAxis || {};
      const margin = {
        top: layoutConfig?.margin?.top ?? 0,
        right: layoutConfig?.margin?.right ?? 24,
        bottom: layoutConfig?.margin?.bottom ?? 24,
        left: layoutConfig?.margin?.left ?? 16
      };
      const headerHeight = layoutConfig?.headerHeight ?? 24;
      const laneHeight = layoutConfig?.laneHeight ?? 18;
      const lanePadding = layoutConfig?.lanePadding ?? 3;
      const expandedPadding = layoutConfig?.expandedPadding ?? 8;
      const threadGap = layoutConfig?.hierarchy2Gap ?? layoutConfig?.threadGap ?? 6;

      const yAxisConfig = ganttConfig?.yAxis || {};
      const orderedHierarchy1Ids = orderResult.orderedHierarchy1Ids || [];
      const depthByHierarchy1 = orderResult.depthByHierarchy1 || new Map();
      if (orderedHierarchy1Ids.length === 0) {
        container.innerHTML = `<div class="chart-empty-state">No processes found</div>`;
        return;
      }

      const processLabelRule = yAxisConfig?.hierarchy1LabelRule ?? yAxisConfig?.processLabelRule;
      const threadLabelRule = yAxisConfig?.hierarchy2LabelRule ?? yAxisConfig?.threadLabelRule;
      const hierarchyFields = getHierarchyFieldsFromMapping(dataMapping);

      const hierarchy1Field =
        hierarchyFields[0] ?? ganttConfig?.yAxis?.hierarchy1Field ?? 'pid';
      const hierarchy2Field =
        hierarchyFields[1] ?? ganttConfig?.yAxis?.hierarchy2Field ?? 'tid';
      const resolveFieldDisplayName = (fieldPath: string) => {
        const key = String(fieldPath ?? '').trim();
        if (!key) return key;
        const schemaFields = Array.isArray(dataMapping?.schema?.allFields)
          ? dataMapping!.schema.allFields
          : [];
        const schemaExact = schemaFields.find((f: any) => String(f?.path ?? '').trim() === key);
        if (schemaExact?.path) return String(schemaExact.path).trim();
        const schemaCaseInsensitive = schemaFields.find(
          (f: any) => String(f?.path ?? '').trim().toLowerCase() === key.toLowerCase()
        );
        if (schemaCaseInsensitive?.path) return String(schemaCaseInsensitive.path).trim();
        return key;
      };
      const hierarchy1FieldDisplay = resolveFieldDisplayName(String(hierarchy1Field));
      const hierarchy2FieldDisplay = resolveFieldDisplayName(String(hierarchy2Field));
      const hierarchyDepthCount = Math.max(
        1,
        Number(dataMapping?.features?.hierarchyLevels ?? hierarchyFields.length ?? 2)
      );
      const hierarchyFieldDisplays = hierarchyFields.map((field) => resolveFieldDisplayName(String(field)));
      const buildHierarchyVars = (values: string[]) => {
        const vars: Record<string, string | boolean | number> = {};
        values.forEach((value, index) => {
          const level = index + 1;
          vars[getHierarchyVarName(level)] = value;
          vars[getHierarchyFieldVarName(level)] =
            hierarchyFieldDisplays[index] ??
            (level === 1 ? hierarchy1FieldDisplay : hierarchy2FieldDisplay);
        });
        return vars;
      };

      const getProcessLabel = (h1Value: string, depth: number, isExpanded: boolean) => {
        const ctx = {
          hierarchy1: String(h1Value),
          depth,
          isExpanded,
          stats: processStats.get(String(h1Value)) || {},
          vars: {
            hierarchy1: String(h1Value),
            hierarchy1Field: String(hierarchy1FieldDisplay),
            ...buildHierarchyVars([String(h1Value)]),
            depth,
            isExpanded
          }
        };
        const label = evalExpr(processLabelRule, ctx);
        if (!isEmptyValue(label)) return String(label);
        return `${isExpanded ? '▼' : '▶'} ${hierarchy1FieldDisplay}: ${h1Value}`;
      };

      const getThreadLabel = (
        _h1Value: string,
        h2Value: string | number,
        isMainThread: boolean
      ) => {
        const hierarchy2 = String(h2Value);
        const nestedHierarchyValues = [String(_h1Value), ...hierarchy2.split('|').filter(Boolean)];
        const ctx = {
          hierarchy1: String(_h1Value),
          hierarchy2,
          isMainThread,
          vars: {
            hierarchy1: String(_h1Value),
            hierarchy2,
            hierarchy1Field: String(hierarchy1FieldDisplay),
            hierarchy2Field: String(hierarchy2FieldDisplay),
            ...buildHierarchyVars(nestedHierarchyValues),
            isMainThread
          }
        };
        const label = evalExpr(threadLabelRule, ctx);
        if (!isEmptyValue(label)) return String(label);
        return `${hierarchy2FieldDisplay}: ${h2Value}`;
      };
      const getHierarchyNodeLabel = (
        h1Value: string,
        pathSegments: string[],
        isMainThread: boolean
      ) => {
        const level = Math.max(2, pathSegments.length + 1);
        const fieldDisplay =
          hierarchyFieldDisplays[level - 1] ??
          (level === 2 ? hierarchy2FieldDisplay : `Hierarchy ${level}`);
        const value = String(pathSegments[pathSegments.length - 1] ?? '');
        const pathValue = pathSegments.join('|');
        const ctx = {
          hierarchy1: String(h1Value),
          hierarchy2: pathValue,
          isMainThread,
          vars: {
            hierarchy1: String(h1Value),
            hierarchy2: pathValue,
            hierarchy1Field: String(hierarchy1FieldDisplay),
            hierarchy2Field: String(hierarchy2FieldDisplay),
            ...buildHierarchyVars([String(h1Value), ...pathSegments]),
            isMainThread
          }
        };
        const levelRule =
          (yAxisConfig as any)?.[`hierarchy${level}LabelRule`] ??
          (level === 2 ? threadLabelRule : null);
        const label = evalExpr(levelRule, ctx);
        if (!isEmptyValue(label)) return String(label);
        return `${fieldDisplay}: ${value}`;
      };

      // Auto-size the left y-axis column to reduce wasted space.
      // We measure the widest visible label and add padding.
      const computeYAxisWidth = () => {
        try {
          const canvas = document.createElement('canvas');
          const ctx = canvas.getContext('2d');
          if (!ctx) return null;

          const LEFT_PAD = yAxisLayout?.labelPadding?.left ?? 8;
          const RIGHT_PAD = yAxisLayout?.labelPadding?.right ?? 12;
          const THREAD_INDENT = yAxisLayout?.labelPadding?.hierarchy2Indent ?? yAxisLayout?.labelPadding?.threadIndent ?? 18;

          let maxPx = 0;

          // Hierarchy1 labels (always visible; no fork indent)
          ctx.font = (yAxisLayout?.hierarchy1Font ?? yAxisLayout?.processFont) || '700 12px system-ui';
          for (const hierarchy1Id of orderedHierarchy1Ids) {
            const text = getProcessLabel(hierarchy1Id, 0, false);
            const w = ctx.measureText(text).width;
            maxPx = Math.max(maxPx, LEFT_PAD + w + RIGHT_PAD);
          }

          // Hierarchy2 labels (only for expanded blocks)
          ctx.font = (yAxisLayout?.hierarchy2Font ?? yAxisLayout?.threadFont) || '500 11px system-ui';
          for (const hierarchy1Id of expandedHierarchy1Ids) {
            const threadMap = threadsByHierarchy1.get(hierarchy1Id);
            if (!threadMap) continue;
            const hierarchy2Ids = Array.from(threadMap.keys());
            for (const hierarchy2Id of hierarchy2Ids) {
              const isMainThread = String(hierarchy2Id) === String(hierarchy1Id);
              const text = getThreadLabel(hierarchy1Id, hierarchy2Id, isMainThread);
              const w = ctx.measureText(text).width;
              maxPx = Math.max(maxPx, LEFT_PAD + THREAD_INDENT + w + RIGHT_PAD);
            }
          }

          const MIN = yAxisLayout?.minWidth ?? 120;
          const MAX = yAxisLayout?.maxWidth ?? 240;
          return Math.round(clampNumber(maxPx, MIN, MAX));
        } catch {
          return null;
        }
      };

      const measuredWidth = yAxisLayout?.autoWidth === false ? null : computeYAxisWidth();
      const baseWidth = yAxisLayout?.baseWidth ?? 180;
      const Y_AXIS_WIDTH = measuredWidth || yAxisWidth || baseWidth;
      // Avoid render loops: only update when it meaningfully changes.
      if (measuredWidth && Math.abs(measuredWidth - (yAxisWidth || 0)) >= 3) {
        setYAxisWidth(measuredWidth);
      }

      const LEFT_PAD = yAxisLayout?.labelPadding?.left ?? 8;
      const RIGHT_PAD = yAxisLayout?.labelPadding?.right ?? 12;
      const THREAD_INDENT = yAxisLayout?.labelPadding?.hierarchy2Indent ?? yAxisLayout?.labelPadding?.threadIndent ?? 18;
      const MIN_LABEL_FONT_PX = Math.max(8, (yAxisLayout?.minFontSize as number) ?? 8);

      const measureCanvas = document.createElement('canvas');
      const measureCtx = measureCanvas.getContext('2d');
      const fitYAxisLabel = (
        text: string,
        fontWeight: number,
        baseFontSize: number,
        maxWidth: number
      ): { displayText: string; fontSize: number; title?: string } => {
        if (!measureCtx || maxWidth <= 0) return { displayText: text, fontSize: baseFontSize };
        const fontFamily = 'system-ui';
        const font = `${fontWeight} ${baseFontSize}px ${fontFamily}`;
        measureCtx.font = font;
        let w = measureCtx.measureText(text).width;
        if (w <= maxWidth) return { displayText: text, fontSize: baseFontSize };
        const fontSize = Math.max(MIN_LABEL_FONT_PX, Math.min(baseFontSize, Math.floor((baseFontSize * maxWidth) / w)));
        measureCtx.font = `${fontWeight} ${fontSize}px ${fontFamily}`;
        w = measureCtx.measureText(text).width;
        if (w <= maxWidth) return { displayText: text, fontSize };
        const ellipsis = '…';
        const ellipsisW = measureCtx.measureText(ellipsis).width;
        const budget = maxWidth - ellipsisW;
        let low = 0;
        let high = text.length;
        while (low < high) {
          const mid = Math.ceil((low + high) / 2);
          const segment = text.slice(0, mid);
          if (measureCtx.measureText(segment).width <= budget) low = mid;
          else high = mid - 1;
        }
        const displayText = (text.slice(0, low) || text[0] || '').trimEnd() + (low < text.length ? ellipsis : '');
        return { displayText, fontSize, title: text };
      };

      const TRIANGLE_LEFT = '\u25B6';
      const TRIANGLE_DOWN = '\u25BC';
      const getSymbolAndBody = (label: string): { symbol: string; body: string } => {
        const first = label.charAt(0);
        if (first === TRIANGLE_LEFT || first === TRIANGLE_DOWN) {
          return { symbol: first, body: label.slice(1).trimStart() };
        }
        return { symbol: '', body: label };
      };
      const measureSymbolWidth = (symbol: string, fontWeight: number): number => {
        if (!measureCtx || !symbol) return 0;
        measureCtx.font = `${fontWeight} 12px system-ui`;
        return measureCtx.measureText(symbol).width;
      };

      const buildAutoLanes = (events: any[]) => {
        if (!Array.isArray(events) || events.length === 0) return [];
        const sorted = [...events].sort((a, b) => {
          const byStart = (a.start ?? 0) - (b.start ?? 0);
          if (byStart !== 0) return byStart;
          return (a.end ?? 0) - (b.end ?? 0);
        });
        const lanes: any[] = [];
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
      const getLaneKeyValue = (ev: any, path: string): unknown => {
        const normalizedPath = String(path || '').startsWith('event.')
          ? String(path).slice(6)
          : String(path || '');
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
      };
      const buildRuleLanes = (events: any[]): Array<{ laneId: string | number; events: any[] }> => {
        if (!Array.isArray(events) || events.length === 0) return [];
        if (threadOrderMode === 'auto') {
          return buildAutoLanes(events).map((arr, idx) => ({ laneId: idx, events: arr }));
        }
        const byLevel = new Map<string | number, any[]>();
        const useFieldLanes = threadLaneFieldPath.length > 0;
        events.forEach((ev) => {
          let laneId: string | number = 0;
          if (useFieldLanes) {
            const raw = getLaneKeyValue(ev, threadLaneFieldPath);
            if (raw !== undefined && raw !== null) {
              laneId = typeof raw === 'number' && Number.isFinite(raw) ? raw : String(raw);
            } else {
              laneId = '<N/A>';
            }
          } else {
            laneId = Number.isFinite(Number(ev?.level)) ? Number(ev.level) : String(ev?.level ?? 0);
          }
          const bucket = byLevel.get(laneId);
          if (bucket) bucket.push(ev);
          else byLevel.set(laneId, [ev]);
        });
        const laneIds = Array.from(byLevel.keys()).sort((a, b) => {
          const na = Number(a);
          const nb = Number(b);
          if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
          return String(a).localeCompare(String(b), undefined, { numeric: true });
        });
        return laneIds.map((laneId) => {
          const bucket = [...(byLevel.get(laneId) ?? [])];
          bucket.sort((a, b) => {
            const byStart = Number(a?.start ?? 0) - Number(b?.start ?? 0);
            if (byStart !== 0) return byStart;
            return Number(a?.end ?? 0) - Number(b?.end ?? 0);
          });
          return { laneId, events: bucket };
        });
      };

      type HierarchyNode = {
        key: string;
        segment: string;
        fullPath: string[];
        children: Map<string, HierarchyNode>;
        events: any[];
        levelMap?: ThreadLevelMap;
      };

      const buildLanesForHierarchy1 = (hierarchy1Id: string) => {
        const threadMap = threadsByHierarchy1.get(hierarchy1Id);
        if (!threadMap) return [];
        const root: HierarchyNode = {
          key: '',
          segment: '',
          fullPath: [],
          children: new Map<string, HierarchyNode>(),
          events: []
        };
        const tidPaths = Array.from(threadMap.keys()).sort((a, b) =>
          String(a).localeCompare(String(b), undefined, { numeric: true })
        );
        tidPaths.forEach((tidPath) => {
          const levelMap = threadMap.get(tidPath);
          const pathEvents: any[] = [];
          if (levelMap) {
            levelMap.forEach((arr: any[]) => {
              if (!Array.isArray(arr) || arr.length === 0) return;
              for (const item of arr) pathEvents.push(item);
            });
          }
          const segments = String(tidPath)
            .split('|')
            .map((v) => v.trim())
            .filter(Boolean);
          let current = root;
          if (pathEvents.length > 0) current.events.push(...pathEvents);
          segments.forEach((segment, idx) => {
            const nextPath = [...current.fullPath, segment];
            const nextKey = nextPath.join('|');
            let node = current.children.get(segment);
            if (!node) {
              node = {
                key: nextKey,
                segment,
                fullPath: nextPath,
                children: new Map<string, HierarchyNode>(),
                events: []
              };
              current.children.set(segment, node);
            }
            if (pathEvents.length > 0) node.events.push(...pathEvents);
            if (idx === segments.length - 1) {
              node.levelMap = levelMap;
            }
            current = node;
          });
        });

        const lanes: any[] = [];
        const emitNodePackedLanes = (
          pathSegments: string[],
          sourceEvents: any[],
          startFrom: number = 0
        ) => {
          const hierarchy2Val = pathSegments.join('|');
          const packed = buildRuleLanes(sourceEvents);
          packed.slice(Math.max(0, startFrom)).forEach(({ laneId, events }) => {
            const laneKey = buildHierarchyLaneKey(
              [hierarchy1Id, ...pathSegments],
              `__group_lane__${String(laneId)}`
            );
            lanes.push({
              type: 'lane',
              hierarchy1: hierarchy1Id,
              hierarchy2: hierarchy2Val,
              hierarchyPath: [...pathSegments],
              hierarchyValues: [String(hierarchy1Id), ...pathSegments.map((segment) => String(segment))],
              level: laneId,
              laneKey,
              threadLabel: '',
              events
            });
          });
        };
        const emitLeafLanes = (
          pathSegments: string[],
          levelMap: ThreadLevelMap | undefined,
          rowLabel?: string
        ) => {
          if (!levelMap) return;
          const hierarchy2Path = pathSegments.join('|');
          const isMainThread = hierarchy2Path === String(hierarchy1Id);
          if (threadOrderMode === 'auto') {
            const allEvents: any[] = [];
            levelMap.forEach((arr: any[]) => {
              if (!Array.isArray(arr) || arr.length === 0) return;
              for (const item of arr) allEvents.push(item);
            });
            const autoLanes = buildAutoLanes(allEvents);
            autoLanes.forEach((events: any[], idx: number) => {
              const laneKey = buildHierarchyLaneKey([hierarchy1Id, ...pathSegments], idx);
              lanes.push({
                type: 'lane',
                hierarchy1: hierarchy1Id,
                hierarchy2: hierarchy2Path,
                hierarchyPath: [...pathSegments],
                hierarchyValues: [String(hierarchy1Id), ...pathSegments.map((segment) => String(segment))],
                level: idx,
                laneKey,
                threadLabel: idx === 0 ? (rowLabel ?? '') : '',
                events
              });
            });
            return;
          }
          const levels = Array.from(levelMap.keys()).sort((a, b) => {
            const na = Number(a);
            const nb = Number(b);
            if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
            return String(a).localeCompare(String(b), undefined, { numeric: true });
          });
          levels.forEach((level, idx) => {
            const events = levelMap.get(level) ?? levelMap.get(String(level)) ?? [];
            const laneKey = buildHierarchyLaneKey([hierarchy1Id, ...pathSegments], level);
            lanes.push({
              type: 'lane',
              hierarchy1: hierarchy1Id,
              hierarchy2: hierarchy2Path,
              hierarchyPath: [...pathSegments],
              hierarchyValues: [String(hierarchy1Id), ...pathSegments.map((segment) => String(segment))],
              level,
              laneKey,
              threadLabel: idx === 0 ? (rowLabel ?? '') : '',
              events
            });
          });
        };
        const emitNode = (node: HierarchyNode) => {
          const path = node.fullPath;
          const depth = path.length;
          const expandKey = [hierarchy1Id, ...path].join('|');
          const hasChildren = node.children.size > 0;
          const hasLeaf = Boolean(node.levelMap);
          const expandable = hasChildren;
          const expanded =
            expandedHierarchy1Ids.includes(expandKey) ||
            (path.length === 1 && !hasChildren && hierarchyDepthCount <= 2);
          const showLeafLanes = hasLeaf && (!hasChildren || expanded);
          const isLeafOnly = hasLeaf && !hasChildren;
          const packedNodeLanes = hasChildren ? buildRuleLanes(node.events) : [];
          const collapsedGroupEvents =
            packedNodeLanes.length > 0 ? packedNodeLanes[0].events : node.events;
          const groupEvents = hasChildren
            ? expanded
              ? []
              : collapsedGroupEvents
            : showLeafLanes
              ? []
              : node.events;
          if (!isLeafOnly) {
            const laneKey = buildHierarchyLaneKey([hierarchy1Id, ...path], '__group__');
            lanes.push({
              type: 'group',
              hierarchy1: hierarchy1Id,
              hierarchy2: path.join('|'),
              hierarchyPath: [...path],
              hierarchyValues: [String(hierarchy1Id), ...path.map((segment) => String(segment))],
              hierarchyDepth: depth,
              expandKey,
              expandable,
              expanded,
              laneKey,
              events: groupEvents,
              label: getHierarchyNodeLabel(hierarchy1Id, path, path.join('|') === String(hierarchy1Id))
            });
          }
          if (hasChildren && !expanded && packedNodeLanes.length > 1) {
            emitNodePackedLanes(path, node.events, 1);
          }
          if (hasChildren && expanded) {
            const children = Array.from(node.children.values()).sort((a, b) =>
              String(a.segment).localeCompare(String(b.segment), undefined, { numeric: true })
            );
            children.forEach((child) => emitNode(child));
          }
          if (showLeafLanes) {
            const rowLabel = isLeafOnly
              ? getHierarchyNodeLabel(hierarchy1Id, path, path.join('|') === String(hierarchy1Id))
              : undefined;
            emitLeafLanes(path, node.levelMap, rowLabel);
          }
        };
        const roots = Array.from(root.children.values()).sort((a, b) =>
          String(a.segment).localeCompare(String(b.segment), undefined, { numeric: true })
        );
        roots.forEach((node) => emitNode(node));
        return lanes;
      };

      type Block = {
        hierarchy1: string;
        expanded: boolean;
        depth: number;
        indentPx: number;
        y0: number;
        y1: number;
        headerY0: number;
        headerY1: number;
        detailY0: number | null;
        detailY1: number | null;
        lanes: any[];
      };

      const blocks: Block[] = [];
      let yCursor = margin.top;

      orderedHierarchy1Ids.forEach((hierarchy1Id) => {
        const depth = depthByHierarchy1.get(String(hierarchy1Id)) || 0;
        const expanded = expandedHierarchy1Ids.includes(hierarchy1Id);
        if (!expanded) {
          blocks.push({
            hierarchy1: hierarchy1Id,
            expanded: false,
            depth,
            indentPx: 0,
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

        const lanes = buildLanesForHierarchy1(hierarchy1Id);
        const lanesHeight = lanes.reduce((sum: number, lane: any) => sum + laneHeight, 0);
        const blockHeight = headerHeight + expandedPadding + lanesHeight + expandedPadding;

        const block: Block = {
          hierarchy1: hierarchy1Id,
          expanded: true,
          depth,
          indentPx: 0,
          y0: yCursor,
          y1: yCursor + blockHeight,
          headerY0: yCursor,
          headerY1: yCursor + headerHeight,
          detailY0: yCursor + headerHeight + expandedPadding,
          detailY1: yCursor + blockHeight - expandedPadding,
          lanes: []
        };

        let laneCursor = block.detailY0;
        block.lanes = lanes.map((lane: any) => {
          const y0 = laneCursor;
          laneCursor += laneHeight;
          return { ...lane, y0, y1: laneCursor };
        });

        blocks.push(block);
        yCursor = block.y1;
      });

      // Fork groups: parent + children as table-like segments (no indent; background + header style)
      const forkRelations = forkRelationsRef.current;
      const parentByHierarchy1 =
        forkRelations?.parentByHierarchy1 instanceof Map
          ? forkRelations.parentByHierarchy1
          : new Map<string, string>();
      type ForkGroup = { startBlockIndex: number; endBlockIndex: number; parentBlockIndex: number };
      const forkGroups: ForkGroup[] = [];
      const headerIdToGroupIndex: Record<string, number> = {};
      orderedHierarchy1Ids.forEach((id, i) => {
        const parent = parentByHierarchy1.get(String(id));
        if (!parent) {
          forkGroups.push({ startBlockIndex: i, endBlockIndex: i, parentBlockIndex: i });
          headerIdToGroupIndex[String(id)] = forkGroups.length - 1;
        } else {
          const gIdx = headerIdToGroupIndex[String(parent)];
          if (gIdx != null) {
            forkGroups[gIdx].endBlockIndex = i;
          } else {
            forkGroups.push({ startBlockIndex: i, endBlockIndex: i, parentBlockIndex: i });
            headerIdToGroupIndex[String(id)] = forkGroups.length - 1;
          }
        }
      });
      const hasForkStructure = forkGroups.some(
        (g) => g.endBlockIndex > g.startBlockIndex
      );

      const GAP_BETWEEN_FORK_GROUPS = 12;
      const FORK_CARD_RADIUS = 8;
      const FORK_CARD_STROKE = 'rgba(0,0,0,0.08)';
      if (hasForkStructure && forkGroups.length > 0) {
        const gapBeforeBlock = (blockIndex: number) =>
          GAP_BETWEEN_FORK_GROUPS * forkGroups.filter((g) => g.endBlockIndex < blockIndex).length;
        blocks.forEach((block, i) => {
          const offset = gapBeforeBlock(i);
          if (offset <= 0) return;
          block.y0 += offset;
          block.y1 += offset;
          block.headerY0 += offset;
          block.headerY1 += offset;
          if (block.detailY0 != null) block.detailY0 += offset;
          if (block.detailY1 != null) block.detailY1 += offset;
          block.lanes.forEach((lane: any) => {
            lane.y0 += offset;
            lane.y1 += offset;
          });
        });
        yCursor += forkGroups.length * GAP_BETWEEN_FORK_GROUPS;
      }

      const stageHeight = yCursor + margin.bottom;

      let containerWidth = container.clientWidth || 900;
      let innerWidth = Math.max(containerWidth - margin.left - margin.right, 320);
      const hierarchyLevels = Math.max(
        1,
        Number(dataMapping?.features?.hierarchyLevels ?? 2)
      );
      const lodConfig = resolveHierarchyLod(ganttConfig?.performance, hierarchyLevels);
      const configPixelWindow = Math.max(1, Number(lodConfig?.pixelWindow ?? 1));
      updateViewStateFromRender({
        viewportPxWidth: Math.round(innerWidth * pixelRatio),
        devicePixelRatio: pixelRatio,
        pixelWindow: configPixelWindow
      });

      container.style.position = 'relative';
      container.style.overflowY = 'auto';
      container.style.overflowX = 'hidden';

      const fetchStart = Number(startTime);
      const fetchEnd = Number(endTime);
      const fetchSpan = Math.max(1, fetchEnd - fetchStart);

      const getViewParams = (): ViewParams => {
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

      const xOf = (t: number, p: ViewParams) => margin.left + (Number(t) - p.vs) * p.k;
      const tOf = (x: number, p: ViewParams) => p.vs + (Number(x) - margin.left) / p.k;

      let stageWidth = innerWidth + margin.left + margin.right;

      // WebGL canvas for high-throughput rectangles
      const webglCanvas = document.createElement('canvas');
      webglCanvas.className = 'gantt-webgl';
      webglCanvas.width = Math.round(stageWidth * pixelRatio);
      webglCanvas.height = Math.round(stageHeight * pixelRatio);
      webglCanvas.style.width = `${stageWidth}px`;
      webglCanvas.style.height = `${stageHeight}px`;
      webglCanvas.style.position = 'absolute';
      webglCanvas.style.left = '0';
      webglCanvas.style.top = '0';
      webglCanvas.style.pointerEvents = 'none';
      container.appendChild(webglCanvas);
      const webglRenderer = createWebGLRenderer({ canvas: webglCanvas });

      // Canvas for labels and overlays
      const canvas = document.createElement('canvas');
      canvas.className = 'gantt-canvas';
      canvas.width = Math.round(stageWidth * pixelRatio);
      canvas.height = Math.round(stageHeight * pixelRatio);
      canvas.style.width = `${stageWidth}px`;
      canvas.style.height = `${stageHeight}px`;
      canvas.style.position = 'absolute';
      canvas.style.left = '0';
      canvas.style.top = '0';
      canvas.style.pointerEvents = 'none';
      container.appendChild(canvas);
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.scale(pixelRatio, pixelRatio);

      // SVG for axes and text
      const svg = d3
        .create('svg')
        .attr('class', 'gantt-svg')
        .attr('width', innerWidth + margin.left + margin.right)
        .attr('height', stageHeight)
        .style('width', `${innerWidth + margin.left + margin.right}px`)
        .style('height', `${stageHeight}px`)
        .style('position', 'absolute')
        .style('left', 0)
        .style('top', 0)
        .style('pointerEvents', 'none');
      const dependencyLayer = svg.append('g').attr('class', 'gantt-dependencies');

      const svgNode = svg.node();
      if (svgNode) {
        container.appendChild(svgNode);
      }

      let yAxisHost: HTMLDivElement | null = yAxisRef.current;
      let yAxisGroup: d3.Selection<SVGGElement, any, null, undefined> | null = null;
      let yAxisTooltipEl: HTMLDivElement | null = null;
      let yAxisSeparatorEl: HTMLDivElement | null = null;
      const viewportHeight = Math.max(100, container.clientHeight || 400);
      const ensureYAxis = () => {
        const host = yAxisHost || yAxisRef.current;
        if (!host || yAxisGroup) return;
        yAxisHost = host;
        host.innerHTML = '';
        const vh = Math.max(100, container.clientHeight || 400);
        const axisSvg = d3
          .create('svg')
          .attr('class', 'gantt-yaxis-svg')
          .attr('width', Y_AXIS_WIDTH)
          .attr('height', vh)
          .style('width', `${Y_AXIS_WIDTH}px`)
          .style('height', `${vh}px`)
          .style('overflow', 'visible');
        yAxisGroup = axisSvg.append('g').attr('class', 'y-labels');
        const axisNode = axisSvg.node();
        if (axisNode) {
          host.appendChild(axisNode);
        }
        yAxisSeparatorEl = document.createElement('div');
        yAxisSeparatorEl.className = 'gantt-yaxis-separator';
        yAxisSeparatorEl.style.top = '0';
        yAxisSeparatorEl.style.height = `${vh}px`;
        host.appendChild(yAxisSeparatorEl);
        yAxisTooltipEl = document.createElement('div');
        yAxisTooltipEl.className = 'gantt-yaxis-tooltip';
        yAxisTooltipEl.style.cssText = 'position:fixed;display:none;font-size:12px;font-weight:500;font-family:system-ui;background:#333;color:#fff;padding:6px 10px;border-radius:4px;pointer-events:none;z-index:1000;max-width:420px;white-space:normal;line-height:1.3;box-shadow:0 2px 8px rgba(0,0,0,0.2);';
        host.appendChild(yAxisTooltipEl);
        host.style.width = `${Y_AXIS_WIDTH}px`;
        host.style.height = `${vh}px`;
        host.style.top = `${container.offsetTop}px`;
      };
      ensureYAxis();

      // Tooltip
      const tooltip = document.createElement('div');
      tooltip.className = 'gantt-tooltip';
      tooltip.style.display = 'none';
      container.appendChild(tooltip);

      // SoA packing overlay
      const overlay = document.createElement('div');
      overlay.className = 'gantt-loading-overlay';
      overlay.textContent = 'Loading';
      overlay.style.cssText =
        'position:absolute;inset:0;display:none;align-items:center;justify-content:center;background:rgba(255,255,255,0.7);color:#111;font-size:14px;font-weight:600;z-index:5;pointer-events:none;';
      container.appendChild(overlay);
      overlayRef.current = overlay;

      // Top bar: minimap + fixed x-axis (does NOT refetch; driven by viewRange)
      const minimapHost = minimapRef.current;
      const axisHost = xAxisRef.current;
      let topWidth = innerWidth + margin.left + margin.right;
      const minimapHeight = Math.max(60, minimapHost ? minimapHost.clientHeight || 60 : 60);
      const axisHeight = Math.max(32, axisHost ? axisHost.clientHeight || 32 : 32);

      let minimapCtx: CanvasRenderingContext2D | null = null;
      let minimapWindowEl: HTMLDivElement | null = null;
      let minimapAxisGroup: d3.Selection<SVGGElement, any, null, undefined> | null = null;
      let minimapCanvasEl: HTMLCanvasElement | null = null;
      let minimapAxisSvgEl: SVGSVGElement | null = null;

      if (minimapHost) {
        const mmCanvas = document.createElement('canvas');
        mmCanvas.width = Math.round(topWidth * pixelRatio);
        mmCanvas.height = Math.round(minimapHeight * pixelRatio);
        mmCanvas.style.width = `${topWidth}px`;
        mmCanvas.style.height = `${minimapHeight}px`;
        minimapHost.appendChild(mmCanvas);
        minimapCanvasEl = mmCanvas;
        const ctx2d = mmCanvas.getContext('2d');
        if (ctx2d) {
          ctx2d.scale(pixelRatio, pixelRatio);
          minimapCtx = ctx2d;
        } else {
          minimapHost.removeChild(mmCanvas);
        }

        const winEl = document.createElement('div');
        winEl.className = 'minimap-window';
        minimapHost.appendChild(winEl);
        minimapWindowEl = winEl;

        // Minimap time ticks overlay (for the full fetched range)
        const mmAxisSvg = d3
          .create('svg')
          .attr('width', topWidth)
          .attr('height', minimapHeight)
          .style('width', `${topWidth}px`)
          .style('height', `${minimapHeight}px`)
          .style('overflow', 'visible');
        minimapAxisGroup = mmAxisSvg
          .append('g')
          .attr('transform', `translate(0, ${minimapHeight - 12})`);
        const mmAxisNode = mmAxisSvg.node();
        if (mmAxisNode) {
          minimapAxisSvgEl = mmAxisNode as SVGSVGElement;
          minimapHost.appendChild(mmAxisNode);
        }
      }

      let axisGroup: d3.Selection<SVGGElement, any, null, undefined> | null = null;
      let axisSvgEl: SVGSVGElement | null = null;
      if (axisHost) {
        const axisSvg = d3
          .create('svg')
          .attr('width', topWidth)
          .attr('height', axisHeight)
          .style('width', `${topWidth}px`)
          .style('height', `${axisHeight}px`)
          .style('overflow', 'visible');
        axisGroup = axisSvg.append('g').attr('transform', `translate(0, ${axisHeight - 8})`);
        const axisNode = axisSvg.node();
        if (axisNode) {
          axisSvgEl = axisNode as SVGSVGElement;
          axisHost.appendChild(axisNode);
        }
      }

      const resizeScene = () => {
        const nextPixelRatio = window.devicePixelRatio || 1;
        const nextContainerWidth = container.clientWidth || 900;
        const nextInnerWidth = Math.max(nextContainerWidth - margin.left - margin.right, 320);
        if (Math.abs(nextInnerWidth - innerWidth) < 1 && Math.abs(nextPixelRatio - pixelRatio) < 0.01) {
          return;
        }

        pixelRatio = nextPixelRatio;
        containerWidth = nextContainerWidth;
        innerWidth = nextInnerWidth;
        stageWidth = innerWidth + margin.left + margin.right;
        topWidth = stageWidth;

        const nextHierarchyLevels = Math.max(
          1,
          Number(dataMapping?.features?.hierarchyLevels ?? 2)
        );
        const nextLodConfig = resolveHierarchyLod(ganttConfig?.performance, nextHierarchyLevels);
        const nextConfigPixelWindow = Math.max(1, Number(nextLodConfig?.pixelWindow ?? 1));
        updateViewStateFromRender({
          viewportPxWidth: Math.round(innerWidth * pixelRatio),
          devicePixelRatio: pixelRatio,
          pixelWindow: nextConfigPixelWindow
        });

        webglCanvas.width = Math.round(stageWidth * pixelRatio);
        webglCanvas.height = Math.round(stageHeight * pixelRatio);
        webglCanvas.style.width = `${stageWidth}px`;
        webglCanvas.style.height = `${stageHeight}px`;

        canvas.width = Math.round(stageWidth * pixelRatio);
        canvas.height = Math.round(stageHeight * pixelRatio);
        canvas.style.width = `${stageWidth}px`;
        canvas.style.height = `${stageHeight}px`;
        ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);

        svg
          .attr('width', stageWidth)
          .style('width', `${stageWidth}px`)
          .attr('height', stageHeight)
          .style('height', `${stageHeight}px`);

        if (axisSvgEl) {
          axisSvgEl.setAttribute('width', `${topWidth}`);
          axisSvgEl.style.width = `${topWidth}px`;
          axisSvgEl.setAttribute('height', `${axisHeight}`);
          axisSvgEl.style.height = `${axisHeight}px`;
        }
        if (minimapCanvasEl) {
          minimapCanvasEl.width = Math.round(topWidth * pixelRatio);
          minimapCanvasEl.height = Math.round(minimapHeight * pixelRatio);
          minimapCanvasEl.style.width = `${topWidth}px`;
          minimapCanvasEl.style.height = `${minimapHeight}px`;
          const nextMinimapCtx = minimapCanvasEl.getContext('2d');
          if (nextMinimapCtx) {
            nextMinimapCtx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
            minimapCtx = nextMinimapCtx;
          }
        }
        if (minimapAxisSvgEl) {
          minimapAxisSvgEl.setAttribute('width', `${topWidth}`);
          minimapAxisSvgEl.style.width = `${topWidth}px`;
          minimapAxisSvgEl.setAttribute('height', `${minimapHeight}`);
          minimapAxisSvgEl.style.height = `${minimapHeight}px`;
        }

        redraw();
      };

      // Precompute minimap multi-lane stripes (compressed overview).
      // We bin events into a small number of lanes based on current track order
      // so the overview reflects the main Gantt ordering.
      const overviewBinsCount = Math.min(900, Math.max(300, Math.floor(innerWidth)));
      const LANE_COUNT = 6;
      const colorConfig = ganttConfig?.color || GANTT_CONFIG.color;
      const legacyColorConfig = ganttConfig?.colorMapping || GANTT_CONFIG.colorMapping;
      const defaultPalette = GANTT_CONFIG.color?.palette || [];
      if (webglRenderer) {
        const palette =
          Array.isArray(colorConfig?.palette) && colorConfig.palette.length > 0
            ? colorConfig.palette
            : defaultPalette;
        webglRenderer.setPalette(palette);
      }
      const laneDiffs = Array.from({ length: LANE_COUNT }, () =>
        new Array(overviewBinsCount + 1).fill(0)
      );
      const laneColorCounts = Array.from({ length: LANE_COUNT }, () => new Map());
      const hierarchy1ToBlockIndex = new Map();
      const totalBlocks = Math.max(1, blocks.length);
      blocks.forEach((block: any, index: number) => {
        hierarchy1ToBlockIndex.set(block.hierarchy1, index);
      });

      // Use raw events for richer overview (more like trace UI).
      for (const ev of chartData) {
        const s = Number(ev.start);
        const e = Number(ev.end);
        if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) continue;
        const sNorm = (s - fetchStart) / fetchSpan;
        const eNorm = (e - fetchStart) / fetchSpan;
        if (eNorm <= 0 || sNorm >= 1) continue;
        const i0 = Math.max(
          0,
          Math.min(overviewBinsCount - 1, Math.floor(sNorm * overviewBinsCount))
        );
        const i1 = Math.max(0, Math.min(overviewBinsCount, Math.ceil(eNorm * overviewBinsCount)));
        const blockIndex = hierarchy1ToBlockIndex.get(ev.hierarchy1);
        let lane = 0;
        if (Number.isFinite(blockIndex)) {
          lane = Math.floor((blockIndex / totalBlocks) * LANE_COUNT);
        } else {
          const laneKey = resolveColorKey(
            ev,
            ev.hierarchy2 ?? ev.hierarchy1 ?? '',
            {
              type: 'lane',
              hierarchy1: ev.hierarchy1,
              hierarchy2: ev.hierarchy2,
              level: ev.level
            },
            colorConfig,
            legacyColorConfig
          );
          lane = hashStringToInt(laneKey) % LANE_COUNT;
        }
        lane = Math.max(0, Math.min(LANE_COUNT - 1, lane));
        laneDiffs[lane][i0] += 1;
        laneDiffs[lane][i1] -= 1;

        const trackKey = ev.hierarchy2 ?? ev.hierarchy1 ?? '';
        const color = resolveColor(
          ev,
          trackKey,
          {
            type: 'lane',
            hierarchy1: ev.hierarchy1,
            hierarchy2: ev.hierarchy2,
            level: ev.level
          },
          colorConfig,
          defaultPalette,
          legacyColorConfig,
          processStats
        );
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

      const laneBins = Array.from({ length: LANE_COUNT }, () =>
        new Array(overviewBinsCount).fill(0)
      );
      const laneMax = new Array(LANE_COUNT).fill(0);
      for (let lane = 0; lane < LANE_COUNT; lane++) {
        let acc = 0;
        for (let i = 0; i < overviewBinsCount; i++) {
          acc += laneDiffs[lane][i];
          laneBins[lane][i] = acc;
          laneMax[lane] = Math.max(laneMax[lane], acc);
        }
      }

      const colorFor = (item: any, trackKey: string, trackMeta: any) =>
        resolveColor(
          item,
          trackKey,
          trackMeta,
          colorConfig,
          defaultPalette,
          legacyColorConfig,
          processStats
        );

      const visibleState: {
        startIndex: number;
        endIndex: number;
        hoveredTrack: string | null;
        hoveredItem: any | null;
      } = {
        startIndex: 0,
        endIndex: 0,
        hoveredTrack: null,
        hoveredItem: null
      };
      let lastLanePositions = new Map<string, { y: number; h: number }>();
      let lastGpuUploadMs: number | null = null;
      let lastRendererMode: 'webgl' | 'canvas' = 'canvas';
      let lastWebglInstanceCount: number | null = null;
      const lodCache = new Map<string, RenderPrimitive[]>();
      const MAX_LOD_CACHE_ENTRIES = 500;
      let instanceBuffer = new Float32Array(0);
      const ensureInstanceBuffer = (requiredPrimitives: number) => {
        const required = Math.max(0, requiredPrimitives * 6);
        if (instanceBuffer.length >= required) return instanceBuffer;
        const nextLength = Math.max(required, instanceBuffer.length > 0 ? instanceBuffer.length * 2 : 4096);
        instanceBuffer = new Float32Array(nextLength);
        return instanceBuffer;
      };

      const getLaneRenderEvents = (
        lane: any,
        laneKey: string,
        trackKey: string,
        trackMeta: any,
        p: ViewParams
      ): RenderPrimitive[] => {
        const laneEvents = Array.isArray(lane?.events) ? lane.events : [];
        const pixelWindow = Math.max(1, Number(viewStateRef.current?.pixelWindow ?? 1));
        const viewportPxWidth =
          Number(viewStateRef.current?.viewportPxWidth) || Math.round(innerWidth * pixelRatio);
        const laneId = laneKey;
        const cacheKey = `${laneId}|${laneEvents.length}|${p.vs}|${p.ve}|${pixelWindow}`;
        const cached = lodCache.get(cacheKey);
        if (cached) {
          lane.renderEvents = cached;
          return cached;
        }
        const colorKeyForEvent = (ev: any) =>
          resolveColorKey(ev, trackKey, trackMeta, colorConfig, legacyColorConfig);
        const primitives = aggregateLaneEvents(laneEvents, {
          laneId,
          timeDomain: [p.vs, p.ve],
          viewportPxWidth,
          pixelWindow,
          colorKeyForEvent
        });
        lane.renderEvents = primitives;
        if (lodCache.size >= MAX_LOD_CACHE_ENTRIES) {
          const oldestKey = lodCache.keys().next().value as string | undefined;
          if (oldestKey) lodCache.delete(oldestKey);
        }
        lodCache.set(cacheKey, primitives);
        return primitives;
      };

      const buildSummaryTooltipHtml = (item: any) => {
        const topCategories = Array.isArray(item?.attrSummary?.topCategories)
          ? item.attrSummary.topCategories.join(', ')
          : '';
        const avgDuration = Number(item?.attrSummary?.avgDuration ?? 0);
        const count = Number(item?.count ?? 0);
        const startUs = Number(item?.start ?? 0);
        const endUs = Number(item?.end ?? 0);
        return `
          <div class="tooltip-grid">
            <div class="tooltip-col">
              <div class="tooltip-title">Summary</div>
              <div class="tooltip-row">
                <span class="tooltip-key">Count:</span>
                <span class="tooltip-value">${count}</span>
              </div>
              <div class="tooltip-row">
                <span class="tooltip-key">Top:</span>
                <span class="tooltip-value">${topCategories || 'n/a'}</span>
              </div>
              <div class="tooltip-row">
                <span class="tooltip-key">Avg dur:</span>
                <span class="tooltip-value">${formatTimeUs(avgDuration)}</span>
              </div>
              <div class="tooltip-row">
                <span class="tooltip-key">Range:</span>
                <span class="tooltip-value">${formatTimeUs(startUs)} → ${formatTimeUs(endUs)}</span>
              </div>
            </div>
          </div>
        `;
      };

      const drawBars = () => {
        ctx.clearRect(0, 0, innerWidth + margin.left + margin.right, stageHeight);
        lastGpuUploadMs = null;
        lastRendererMode = 'canvas';
        lastWebglInstanceCount = null;

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

        let endIdx = startIdx;
        for (let i = startIdx; i < blocks.length; i++) {
          const block = blocks[i];
          if (block.y0 > yMax) {
            endIdx = Math.max(startIdx, i - 1);
            break;
          }
          endIdx = i;
        }

        const BUFFER_BLOCKS = 20;
        const bufferedStart = Math.max(0, startIdx - BUFFER_BLOCKS);
        const bufferedEnd = Math.min(blocks.length - 1, endIdx + BUFFER_BLOCKS);

        const laneRows = blocks.flatMap((block) => {
          const rows: Array<{ laneId: string; y0: number; y1: number }> = [
            { laneId: String(block.hierarchy1), y0: block.headerY0, y1: block.headerY1 }
          ];
          if (block.expanded && Array.isArray(block.lanes)) {
            block.lanes.forEach((lane: any) => {
              const hierarchyValues = Array.isArray(lane?.hierarchyValues)
                ? lane.hierarchyValues.map((value: any) => String(value ?? ''))
                : [];
              const laneId =
                hierarchyValues.length > 0
                  ? hierarchyValues.join('|')
                  : String(lane?.hierarchy2 ?? lane?.hierarchy1 ?? block.hierarchy1 ?? '');
              rows.push({ laneId, y0: lane.y0, y1: lane.y1 });
            });
          }
          return rows;
        });

        const laneOrder = laneRows.map((row) => row.laneId);

        let laneStartIdx = 0;
        let laneEndIdx = Math.max(0, laneRows.length - 1);
        let loLane = 0;
        let hiLane = laneRows.length - 1;
        while (loLane <= hiLane) {
          const mid = Math.floor((loLane + hiLane) / 2);
          if (laneRows[mid].y1 < yMin) {
            loLane = mid + 1;
          } else {
            laneStartIdx = mid;
            hiLane = mid - 1;
          }
        }
        laneEndIdx = laneStartIdx;
        for (let i = laneStartIdx; i < laneRows.length; i++) {
          const row = laneRows[i];
          if (row.y0 > yMax) {
            laneEndIdx = Math.max(laneStartIdx, i - 1);
            break;
          }
          laneEndIdx = i;
        }

        const BUFFER_LANES = 5;
        const laneBufferStart = Math.max(0, laneStartIdx - BUFFER_LANES);
        const laneBufferEnd = Math.min(laneRows.length - 1, laneEndIdx + BUFFER_LANES);
        const visibleLaneIdsSorted = laneOrder
          .slice(laneBufferStart, laneBufferEnd + 1)
          .filter(Boolean);

        updateViewStateFromRender({
          visibleLaneRange: [laneStartIdx, laneEndIdx],
          visibleLaneIds: visibleLaneIdsSorted,
          laneOrder,
          scrollTop: yMin
        });

        const lanePositions = lastLanePositions;
        lanePositions.clear();
        for (let i = bufferedStart; i <= bufferedEnd; i++) {
          const block = blocks[i];
          if (!block || !block.expanded) continue;
          block.lanes.forEach((lane: any) => {
            if (lane.type !== 'lane' && lane.type !== 'group') return;
            if (lane.y1 < yMin || lane.y0 > yMax) return;
            const laneKey = String(
              lane.laneKey ??
                buildHierarchyLaneKey(
                  Array.isArray(lane.hierarchyValues) && lane.hierarchyValues.length > 0
                    ? lane.hierarchyValues
                    : [
                        String(block.hierarchy1),
                        ...String(lane.hierarchy2 ?? '').split('|').filter(Boolean)
                      ],
                  lane.type === 'group' ? '__group__' : lane.level ?? 0
                )
            );
            lanePositions.set(laneKey, { y: lane.y0, h: lane.y1 - lane.y0 });
          });
        }
        lastLanePositions = lanePositions;

        const activeRenderer = webglRenderer || null;
        const webglEnabled = ganttConfig?.performance?.webglEnabled !== false;
        const laneKeySet = new Set(lanePositions.keys());
        const hasSoAKeyOverlap = Boolean(
          renderSoA?.chunks?.some((chunk) =>
            chunk.bundle.meta.laneKeys.some((key) => laneKeySet.has(String(key)))
          )
        );
        const useWebGL = Boolean(activeRenderer && renderSoA && webglEnabled && hasSoAKeyOverlap);
        const maxPrimitives = useWebGL
          ? Number.POSITIVE_INFINITY
          : PERF_BUDGETS.maxPrimitivesPerViewport;
        let renderedPrimitives = 0;
        let budgetExceeded = false;
        if (webglRenderer) {
          webglRenderer.clear(webglCanvas.width, webglCanvas.height);
        }
        if (useWebGL && renderSoA && activeRenderer) {
          let totalInstances = 0;
          for (const chunk of renderSoA.chunks) {
            const { soa, meta } = chunk.bundle;
            const instanceData = ensureInstanceBuffer(Math.min(soa.count, maxPrimitives));
            let instanceCount = 0;
            for (let i = 0; i < soa.count; i++) {
              if (instanceCount >= maxPrimitives) break;
              const laneIndex = soa.laneIds[i];
              const laneKey = meta.laneKeys[laneIndex];
              const lanePos = lanePositions.get(laneKey);
              if (!lanePos) continue;
              const x1 = xOf(soa.starts[i], p) * pixelRatio;
              const x2 = xOf(soa.ends[i], p) * pixelRatio;
              if (x2 - x1 < 0.5 * pixelRatio) continue; // Skip sub-pixel bars (phantom strips)
              const y = (lanePos.y + lanePadding) * pixelRatio;
              const h = Math.max(2, lanePos.h - lanePadding * 2) * pixelRatio;
              const offset = instanceCount * 6;
              instanceData[offset + 0] = x1;
              instanceData[offset + 1] = x2;
              instanceData[offset + 2] = y;
              instanceData[offset + 3] = h;
              instanceData[offset + 4] = soa.colorIds[i];
              instanceData[offset + 5] = soa.flags[i];
              instanceCount += 1;
            }
            if (instanceCount > 0) {
              const uploadStart = performance.now();
              activeRenderer.draw(
                { data: instanceData.subarray(0, instanceCount * 6), count: instanceCount },
                webglCanvas.width,
                webglCanvas.height
              );
              lastGpuUploadMs = performance.now() - uploadStart;
              totalInstances += instanceCount;
            }
            if (instanceCount >= maxPrimitives) {
              budgetExceeded = true;
              break;
            }
          }
          if (totalInstances > 0) {
            lastRendererMode = 'webgl';
            lastWebglInstanceCount = totalInstances;
            renderedPrimitives = totalInstances;
          }
        }

        const FORK_GROUP_FILL = '#e8eaf0';
        const FORK_HEADER_FILL = '#d0d6e8';
        const drawRoundRect = (
          cx: CanvasRenderingContext2D,
          x: number,
          y: number,
          w: number,
          h: number,
          r: number
        ) => {
          if (r <= 0 || h < 2 * r) {
            cx.rect(x, y, w, h);
            return;
          }
          cx.beginPath();
          cx.moveTo(x + r, y);
          cx.lineTo(x + w - r, y);
          cx.arcTo(x + w, y, x + w, y + r, r);
          cx.lineTo(x + w, y + h - r);
          cx.arcTo(x + w, y + h, x + w - r, y + h, r);
          cx.lineTo(x + r, y + h);
          cx.arcTo(x, y + h, x, y + h - r, r);
          cx.lineTo(x, y + r);
          cx.arcTo(x, y, x + r, y, r);
          cx.closePath();
        };
        if (hasForkStructure) {
        forkGroups.forEach((g) => {
          const startBlock = blocks[g.startBlockIndex];
          const endBlock = blocks[g.endBlockIndex];
          if (!startBlock || !endBlock || endBlock.y1 < yMin || startBlock.y0 > yMax) return;
          const groupY0 = Math.max(yMin, startBlock.y0);
          const groupY1 = Math.min(yMax, endBlock.y1);
          const cardH = groupY1 - groupY0;
          const fullW = margin.left + innerWidth + margin.right;
          const radius = Math.min(FORK_CARD_RADIUS, cardH / 2);
          drawRoundRect(ctx, 0, groupY0, fullW, cardH, radius);
          ctx.fillStyle = FORK_GROUP_FILL;
          ctx.fill();
          ctx.strokeStyle = FORK_CARD_STROKE;
          ctx.lineWidth = 1;
          ctx.stroke();
        });
        forkGroups.forEach((g) => {
          const parentBlock = blocks[g.parentBlockIndex];
          if (!parentBlock || parentBlock.headerY1 < yMin || parentBlock.headerY0 > yMax) return;
          ctx.fillStyle = FORK_HEADER_FILL;
          ctx.fillRect(
            0,
            parentBlock.headerY0,
            margin.left + innerWidth + margin.right,
            headerHeight
          );
        });
        }

        for (let i = startIdx; i < blocks.length; i++) {
          if (budgetExceeded) break;
          const block = blocks[i];
          if (block.y0 > yMax) break;

          const forkGroup = hasForkStructure
            ? forkGroups.find(
                (g) => g.startBlockIndex <= i && i <= g.endBlockIndex
              )
            : undefined;
          const isForkGroupHeader = forkGroup?.parentBlockIndex === i;
          const headerFill =
            forkGroup != null
              ? isForkGroupHeader
                ? FORK_HEADER_FILL
                : FORK_GROUP_FILL
              : block.expanded
                ? '#eef2ff'
                : i % 2 === 0
                  ? '#fbfbfb'
                  : '#f4f4f4';

          // Header background (full width)
          const headerIsHovered = visibleState.hoveredTrack === `proc-${block.hierarchy1}`;
          ctx.fillStyle = headerFill;
          ctx.fillRect(0, block.headerY0, margin.left + innerWidth + margin.right, headerHeight);
          if (headerIsHovered) {
            ctx.fillStyle = 'rgba(102, 126, 234, 0.12)';
            ctx.fillRect(0, block.headerY0, margin.left + innerWidth + margin.right, headerHeight);
          }

          const merged = processAggregates.get(block.hierarchy1) || [];

          if (!block.expanded) {
            // Collapsed: draw merged process bars in header row (timeline aligned to time axis, no indent)
            const y = block.headerY0 + 2;
            const h = headerHeight - 4;
            const leftBound = margin.left;
            const rightBound = margin.left + innerWidth;
            // Collapsed view: render each pixel at most once.
            // Events may come from multiple threads that overlap in time,
            // but the collapsed bar should be uniform — clip each event
            // to only its uncovered portion so no pixel is painted twice.
            let collapsedCoveredEnd = -Infinity;
            merged.forEach((item: any) => {
              if (budgetExceeded) return;
              renderedPrimitives += 1;
              if (renderedPrimitives > maxPrimitives) {
                budgetExceeded = true;
                return;
              }
              const x1Raw = xOf(item.start ?? item.timeStart ?? 0, p);
              const x2Raw = xOf(item.end ?? item.timeEnd ?? 0, p);
              if (x2Raw < leftBound || x1Raw > rightBound) return;
              // Skip sub-pixel bars to avoid phantom strips at axis boundaries
              if (x2Raw - x1Raw < 0.5) return;
              const x1 = Math.floor(x1Raw);
              const endPx = Math.max(x1 + 1, Math.ceil(x2Raw));
              // Only render the portion beyond what's already covered
              const drawX = Math.max(x1, collapsedCoveredEnd);
              if (drawX >= endPx) return; // fully covered
              ctx.fillStyle = colorFor(item, `proc-${block.hierarchy1}`, {
                type: 'process',
                hierarchy1: block.hierarchy1,
                hierarchyValues: [String(block.hierarchy1)]
              });
              ctx.fillRect(drawX, y, endPx - drawX, h);
              collapsedCoveredEnd = endPx;
            });
            continue;
          }

          // Expanded: draw a detail box (width based on process time extent), then draw lane events inside (timeline aligned, no indent).
          if (merged.length > 0) {
            const minT = merged[0].start ?? merged[0].timeStart;
            const maxT = merged[merged.length - 1].end ?? merged[merged.length - 1].timeEnd;
            const boxX1 = xOf(minT, p);
            const boxX2 = xOf(maxT, p);
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
            block.lanes.forEach((lane: any) => {
              if (lane.type !== 'lane' && lane.type !== 'group') return;
              if (lane.y1 < yMin || lane.y0 > yMax) return;

              const laneY0 = lane.y0;
              const laneY1 = lane.y1;
              const laneH = laneY1 - laneY0;

              const laneKey = String(
                lane.laneKey ??
                  buildHierarchyLaneKey(
                    Array.isArray(lane.hierarchyValues) && lane.hierarchyValues.length > 0
                      ? lane.hierarchyValues
                      : [
                          String(block.hierarchy1),
                          ...String(lane.hierarchy2 ?? '').split('|').filter(Boolean)
                        ],
                    lane.type === 'group' ? '__group__' : lane.level ?? 0
                  )
              );
              const laneHierarchyValues = [
                ...(Array.isArray(lane.hierarchyValues) && lane.hierarchyValues.length > 0
                  ? lane.hierarchyValues
                  : [String(block.hierarchy1)]),
                ...(
                  Array.isArray(lane.hierarchyValues) && lane.hierarchyValues.length > 0
                    ? []
                    : Array.isArray(lane.hierarchyPath)
                    ? lane.hierarchyPath
                    : String(lane.hierarchy2 ?? '').split('|')
                )
              ]
                .map((value: any) => String(value ?? '').trim())
                .filter(Boolean);
              const trackKey = laneHierarchyValues.slice(1).join('|') || laneHierarchyValues[0];
              const trackMeta = {
                type: lane.type === 'group' ? 'group' : 'lane',
                hierarchy1: block.hierarchy1,
                hierarchy2: trackKey,
                hierarchyPath: laneHierarchyValues.slice(1),
                hierarchyValues: laneHierarchyValues,
                level: lane.level
              };
              const events = getLaneRenderEvents(lane, laneKey, trackKey, trackMeta, p);
              const barY = laneY0 + lanePadding;
              const barH = Math.max(2, laneH - lanePadding * 2);

              // Pixel-snapped rendering with coverage clipping:
              // Snap coordinates to integers, then only render the uncovered
              // portion of each bar. This guarantees no pixel is painted twice
              // for non-overlapping events, even when bars are close in pixel
              // space due to zoom level or minimum-width enforcement.
              let coveredEnd = -Infinity;

              events.forEach((ev: any) => {
                if (budgetExceeded) return;
                renderedPrimitives += 1;
                if (renderedPrimitives > maxPrimitives) {
                  budgetExceeded = true;
                  return;
                }
                const tStart = ev.start ?? ev.timeStart ?? 0;
                const tEnd = ev.end ?? ev.timeEnd ?? 0;
                const isSummary = ev?.kind === 'summary';
                const x1Raw = xOf(tStart, p);
                const x2Raw = xOf(tEnd, p);
                if (x2Raw < boxX1 || x1Raw > boxX1 + boxW) return;
                // Skip sub-pixel bars to avoid phantom strips at axis boundaries
                if (x2Raw - x1Raw < 0.5) return;

                // Snap to integer pixels with consistent rounding
                const x1 = Math.floor(x1Raw);
                const endPx = Math.max(x1 + 1, Math.ceil(x2Raw));
                const w = endPx - x1;

                // Only render the portion beyond what's already covered
                const drawX = Math.max(x1, coveredEnd);
                if (drawX >= endPx) return; // fully covered

                const barColor = colorFor(ev, trackKey, {
                  type: 'lane',
                  hierarchy1: block.hierarchy1,
                  hierarchy2: trackKey,
                  hierarchyPath: laneHierarchyValues.slice(1),
                  hierarchyValues: laneHierarchyValues,
                  level: lane.level
                });
                if (!useWebGL) {
                  ctx.fillStyle = barColor;
                  ctx.fillRect(drawX, barY, endPx - drawX, barH);
                }

                coveredEnd = endPx;

                if (isSummary) {
                  const label = `${ev.count ?? 0}`;
                  const minBadgeWidth = 22;
                  if (endPx - drawX >= minBadgeWidth && barH >= 10) {
                    ctx.save();
                    ctx.font = '10px system-ui';
                    ctx.textBaseline = 'middle';
                    ctx.fillStyle = 'rgba(0,0,0,0.6)';
                    ctx.fillText(label, drawX + 4, barY + barH / 2);
                    ctx.restore();
                  }
                } else {
                  // Draw label on long bars (use full bar width for label sizing)
                  const label = (ev.name || ev.label || '').toString();
                  const LABEL_MIN_PX = layoutConfig?.label?.minBarLabelPx ?? 90;
                  if (label && w >= LABEL_MIN_PX && barH >= 10) {
                    const clipX = Math.max(x1, boxX1);
                    const clipW = Math.min(x1 + w, boxX1 + boxW) - clipX;
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
                }
              });
            });
          }
        }

        if (budgetExceeded) {
          ctx.save();
          ctx.fillStyle = 'rgba(17,24,39,0.75)';
          ctx.fillRect(margin.left + 8, margin.top + 8, 340, 24);
          ctx.fillStyle = '#fff';
          ctx.font = '12px system-ui';
          ctx.fillText('Too many primitives for current view. Zoom in for detail.', margin.left + 16, margin.top + 24);
          ctx.restore();
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
            const fallbackPalette =
              Array.isArray(colorConfig?.palette) && colorConfig.palette.length > 0
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

        const axisTimeFormat =
          ganttConfig?.xAxis?.timeFormat === 'full' ? formatTimeUsFull : formatTimeUs;

        // Minimap ticks for fetched range
        if (minimapAxisGroup) {
          const tickCount = Math.max(4, Math.floor(innerWidth / 160));
          const scale = d3
            .scaleLinear()
            .domain([fetchStart, fetchEnd])
            .range([margin.left, margin.left + innerWidth]);
          minimapAxisGroup.call(
            d3
              .axisBottom(scale)
              .ticks(tickCount)
              .tickFormat((d) => axisTimeFormat(d as number))
              // .tickSizeOuter(0)
          );
          minimapAxisGroup.selectAll('text').style('font-size', '10px').style('fill', '#6b7280');
          minimapAxisGroup.selectAll('path,line').style('stroke', '#d1d5db');
        }

        // Fixed x-axis (zoom target)
        if (axisGroup) {
          const tickCount = Math.max(4, Math.floor(innerWidth / 140));
          const scale = d3
            .scaleLinear()
            .domain([p.vs, p.ve])
            .range([margin.left, margin.left + innerWidth]);
          axisGroup.call(
            d3
              .axisBottom(scale)
              .ticks(tickCount)
              .tickFormat((d) => axisTimeFormat(d as number))
              // .tickSizeOuter(0)
          );
          axisGroup.selectAll('text').style('font-size', '12px').style('fill', '#555');
          axisGroup.selectAll('path,line').style('stroke', '#d0d0d0');
          // Ensure labels stay inside visible area
          axisGroup.selectAll('text').attr('dy', '1.2em');
        }
      };

      const renderDependencies = () => {
        dependencyLayer.selectAll('*').remove();
        const dependencyEnabled = dataMapping?.features?.dependencyLines;
        const dependencyField = dataMapping?.features?.dependencyField;
        if (!dependencyEnabled || !dependencyField) return;
        const selectionId = viewStateRef.current?.selection;
        if (!selectionId) return;
        const selected = chartData.find(
          (ev) => String(ev?.id ?? '') === String(selectionId)
        );
        if (!selected) return;

        const rawDeps =
          (selected as any)?.[dependencyField] ?? (selected as any)?.args?.[dependencyField];
        const depIds = Array.isArray(rawDeps)
          ? rawDeps
          : typeof rawDeps === 'string'
            ? rawDeps.split(',').map((id: string) => id.trim()).filter(Boolean)
            : [];
        if (depIds.length === 0) return;

        const maxEdges = Number(ganttConfig?.dependencies?.maxEdges ?? 200);
        const depEvents = depIds
          .slice(0, maxEdges)
          .map((id) => chartData.find((ev) => String(ev?.id ?? '') === String(id)))
          .filter(Boolean) as any[];
        if (depEvents.length === 0) return;

        const selectedKey = String(
          selected?.laneKey ??
            buildHierarchyLaneKey(
              Array.isArray(selected?.hierarchyValues) && selected.hierarchyValues.length > 0
                ? selected.hierarchyValues
                : [selected?.hierarchy1, selected?.hierarchy2],
              selected?.level ?? 0
            )
        );
        const selectedLane = lastLanePositions.get(selectedKey);
        if (!selectedLane) return;
        const p = getViewParams();
        const sx = xOf(selected.start, p);
        const sy = selectedLane.y + selectedLane.h / 2;

        dependencyLayer
          .selectAll('path')
          .data(depEvents)
          .join('path')
          .attr('d', (ev: any) => {
            const depKey = String(
              ev?.laneKey ??
                buildHierarchyLaneKey(
                  Array.isArray(ev?.hierarchyValues) && ev.hierarchyValues.length > 0
                    ? ev.hierarchyValues
                    : [ev?.hierarchy1, ev?.hierarchy2],
                  ev?.level ?? 0
                )
            );
            const depLane = lastLanePositions.get(depKey);
            if (!depLane) return '';
            const tx = xOf(ev.start, p);
            const ty = depLane.y + depLane.h / 2;
            const mx = (sx + tx) / 2;
            return `M${sx},${sy} C${mx},${sy} ${mx},${ty} ${tx},${ty}`;
          })
          .attr('fill', 'none')
          .attr('stroke', 'rgba(59,130,246,0.45)')
          .attr('stroke-width', 1);
      };

      const renderYLabels = () => {
        ensureYAxis();
        if (!yAxisGroup) return;
        const vh = Math.max(100, container.clientHeight || 400);
        if (yAxisHost) {
          yAxisHost.style.height = `${vh}px`;
          const yAxisSvg = yAxisHost.querySelector('svg');
          if (yAxisSvg) {
            yAxisSvg.setAttribute('height', String(vh));
            yAxisSvg.style.setProperty('height', `${vh}px`);
          }
        }
        const yMin = container.scrollTop;
        const yMax = yMin + (container.clientHeight || vh);
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
        let endIdx = startIdx;
        for (let i = startIdx; i < blocks.length; i++) {
          if (blocks[i].y0 > yMax) break;
          endIdx = i;
        }
        if (yAxisSeparatorEl && blocks[startIdx] && blocks[endIdx]) {
          const sepTop = blocks[startIdx].y0 - scrollY;
          const sepBottom = blocks[endIdx].y1 - scrollY;
          const sepH = Math.max(0, sepBottom - sepTop);
          yAxisSeparatorEl.style.top = `${sepTop}px`;
          yAxisSeparatorEl.style.height = `${sepH}px`;
        }

        const labels: Array<{
          key: string;
          kind: 'process' | 'lane';
          text: string;
          x: number;
          y: number;
          fontSize: number;
          fontWeight: number;
          indent: number;
          fullText: string;
          symbol?: string;
          symbolWidth?: number;
        }> = [];
        const bgRects: Array<{
          key: string;
          y: number;
          h: number;
          fill: string;
          rx?: number;
          ry?: number;
          stroke?: string;
        }> = [];
        const FORK_GROUP_FILL_Y = '#e8eaf0';
        const FORK_HEADER_FILL_Y = '#d0d6e8';

        if (hasForkStructure) {
          forkGroups.forEach((g, gi) => {
            const startBlock = blocks[g.startBlockIndex];
            const endBlock = blocks[g.endBlockIndex];
            if (!startBlock || !endBlock || endBlock.y1 < yMin || startBlock.y0 > yMax) return;
            const groupY = startBlock.y0 - scrollY;
            const groupH = endBlock.y1 - startBlock.y0;
            const radius = Math.min(FORK_CARD_RADIUS, groupH / 2);
            bgRects.push({
              key: `bg-forkgroup-${gi}`,
              y: groupY,
              h: groupH,
              fill: FORK_GROUP_FILL_Y,
              rx: radius,
              ry: radius,
              stroke: FORK_CARD_STROKE
            });
          });
          forkGroups.forEach((g, gi) => {
            const parentBlock = blocks[g.parentBlockIndex];
            if (!parentBlock || parentBlock.headerY1 < yMin || parentBlock.headerY0 > yMax) return;
            bgRects.push({
              key: `bg-forkheader-${gi}`,
              y: parentBlock.headerY0 - scrollY,
              h: headerHeight,
              fill: FORK_HEADER_FILL_Y
            });
          });
        }

        for (let i = startIdx; i < blocks.length; i++) {
          const block = blocks[i];
          if (block.y0 > yMax) break;

          const forkGroupY = hasForkStructure
            ? forkGroups.find(
                (g) => g.startBlockIndex <= i && i <= g.endBlockIndex
              )
            : undefined;
          const blockFill =
            forkGroupY != null
              ? forkGroupY.parentBlockIndex === i
                ? FORK_HEADER_FILL_Y
                : FORK_GROUP_FILL_Y
              : block.expanded
                ? '#eef2ff'
                : i % 2 === 0
                  ? '#fbfbfb'
                  : '#f4f4f4';

          if (forkGroupY == null) {
            if (block.expanded) {
              bgRects.push({
                key: `bg-proc-${block.hierarchy1}`,
                y: block.y0 - scrollY,
                h: block.y1 - block.y0,
                fill: blockFill
              });
            } else {
              bgRects.push({
                key: `bg-proc-${block.hierarchy1}`,
                y: block.headerY0 - scrollY,
                h: headerHeight,
                fill: blockFill
              });
            }
          }

          const processLabelFull = getProcessLabel(block.hierarchy1, block.depth, block.expanded);
          const procFw = block.expanded ? 700 : 600;
          const { symbol: procSymbol, body: processBody } = getSymbolAndBody(processLabelFull);
          const procSymbolW = measureSymbolWidth(procSymbol, procFw);
          const processAvailW = Y_AXIS_WIDTH - LEFT_PAD - RIGHT_PAD - procSymbolW;
          const processFit = fitYAxisLabel(
            processBody,
            procFw,
            12,
            Math.max(20, processAvailW)
          );
          labels.push({
            key: `proc-${block.hierarchy1}`,
            kind: 'process',
            text: processFit.displayText,
            x: LEFT_PAD,
            y: block.headerY0 + headerHeight / 2 - scrollY,
            fontSize: processFit.fontSize,
            fontWeight: procFw,
            indent: 0,
            fullText: processLabelFull,
            symbol: procSymbol || undefined,
            symbolWidth: procSymbolW || undefined
          });

          if (block.expanded) {
            block.lanes.forEach((lane: any) => {
              if (lane.type === 'group') {
                if (lane.y1 < yMin || lane.y0 > yMax) return;
                const groupIndent =
                  THREAD_INDENT +
                  Math.max(0, Number(lane.hierarchyDepth || 1) - 1) * 12;
                const groupBaseLabel = String(lane.label ?? lane.hierarchy2 ?? '');
                const groupSymbol = lane.expandable ? (lane.expanded ? '▼' : '▶') : '';
                const groupSymbolW = measureSymbolWidth(groupSymbol, 600);
                const groupAvailW =
                  Y_AXIS_WIDTH - LEFT_PAD - RIGHT_PAD - groupIndent - groupSymbolW;
                const groupFit = fitYAxisLabel(groupBaseLabel, 600, 11, Math.max(20, groupAvailW));
                labels.push({
                  key: `group-${block.hierarchy1}-${lane.expandKey}-${lane.y0}`,
                  kind: 'lane',
                  text: groupFit.displayText,
                  x: LEFT_PAD,
                  y: lane.y0 + (lane.y1 - lane.y0) / 2 - scrollY,
                  fontSize: groupFit.fontSize,
                  fontWeight: 600,
                  indent: groupIndent,
                  fullText: groupBaseLabel,
                  symbol: groupSymbol || undefined,
                  symbolWidth: groupSymbolW || undefined
                });
                return;
              }
              if (lane.type !== 'lane') return;
              if (lane.y1 < yMin || lane.y0 > yMax) return;

              // Only show thread label once (no L1/L2 labels); match group indent for leaf depth
              if (lane.threadLabel) {
                const depth = Math.max(1, Array.isArray(lane.hierarchyPath) ? lane.hierarchyPath.length : 1);
                const laneIndent =
                  THREAD_INDENT + Math.max(0, depth - 1) * 12;
                const laneAvailW = Y_AXIS_WIDTH - LEFT_PAD - RIGHT_PAD - laneIndent;
                const laneFit = fitYAxisLabel(
                  lane.threadLabel,
                  500,
                  11,
                  Math.max(20, laneAvailW)
                );
                labels.push({
                  key: `lane-${block.hierarchy1}-${lane.hierarchy2}-${lane.y0}`,
                  kind: 'lane',
                  text: laneFit.displayText,
                  x: LEFT_PAD,
                  y: lane.y0 + (lane.y1 - lane.y0) / 2 - scrollY,
                  fontSize: laneFit.fontSize,
                  fontWeight: 500,
                  indent: laneIndent,
                  fullText: lane.threadLabel
                });
              }
            });
          }
        }

        yAxisGroup
          .selectAll('rect.y-bg')
          .data(bgRects, (d: any) => d.key)
          .join('rect')
          .attr('class', 'y-bg')
          .attr('x', 0)
          .attr('y', (d) => d.y)
          .attr('width', Y_AXIS_WIDTH)
          .attr('height', (d) => d.h)
          .attr('rx', (d) => d.rx ?? 0)
          .attr('ry', (d) => d.ry ?? 0)
          .attr('fill', (d) => d.fill)
          .attr('stroke', (d) => d.stroke ?? 'none')
          .attr('stroke-width', (d) => (d.stroke ? 1 : 0));

        const labelGroups = yAxisGroup
          .selectAll('g.y-label')
          .data(labels, (d: any) => d.key)
          .join('g')
          .attr('class', 'y-label')
          .style('cursor', 'default');
        labelGroups.each(function (d: any) {
          const g = d3.select(this);
          g.selectAll('*').remove();
          const textEl = g
            .append('text')
            .attr('x', d.x + (d.indent || 0))
            .attr('y', d.y)
            .attr('text-anchor', 'start')
            .attr('dominant-baseline', 'middle')
            .attr('fill', '#333');
          if (d.symbol) {
            textEl
              .append('tspan')
              .attr('font-size', '12px')
              .style('font-weight', d.fontWeight)
              .text(d.symbol);
            textEl
              .append('tspan')
              .attr('dx', d.symbolWidth ?? 0)
              .attr('font-size', `${d.fontSize ?? 12}px`)
              .style('font-weight', d.fontWeight)
              .text(d.text);
          } else {
            textEl
              .append('tspan')
              .attr('font-size', `${d.fontSize ?? 12}px`)
              .style('font-weight', d.fontWeight)
              .text(d.text);
          }
        });
        if (yAxisTooltipEl) {
          const tip = yAxisTooltipEl;
          labelGroups
            .on('mouseenter', function (ev: MouseEvent, d: any) {
              const raw = d.fullText ?? '';
              tip.textContent = d.symbol ? raw.slice(1).trimStart() : raw;
              tip.style.display = 'block';
              tip.style.left = `${ev.clientX + 12}px`;
              tip.style.top = `${ev.clientY + 8}px`;
            })
            .on('mouseleave', () => {
              tip.style.display = 'none';
            })
            .on('mousemove', function (ev: MouseEvent) {
              tip.style.left = `${ev.clientX + 12}px`;
              tip.style.top = `${ev.clientY + 8}px`;
            });
        }
      };

      const updateVisibleWindow = () => {
        // Kept for compatibility; draw/render handle visibility from scroll directly.
        visibleState.startIndex = 0;
        visibleState.endIndex = blocks.length;
      };

      const redraw = () => {
        const renderStart = performance.now();
        updateVisibleWindow();
        drawBars();
        renderYLabels();
        renderTopbar();
        renderDependencies();
        const renderMs = performance.now() - renderStart;
        const interactionAt = Number(viewStateRef.current?.lastInteractionAt || 0);
        const interactionMs =
          interactionAt > 0 ? Math.max(0, Date.now() - interactionAt) : undefined;
        perfMetrics.record({
          timestamp: Date.now(),
          renderMs,
          gpuUploadMs: lastGpuUploadMs ?? undefined,
          interactionMs,
          rendererMode: lastRendererMode,
          webglInstanceCount: lastWebglInstanceCount ?? undefined
        });
      };

      // Expose redraw for viewRange updates (zoom/pan)
      redrawRef.current = redraw;
      onResize = resizeScene;

      // Initial render
      redraw();

      const findBlockByY = (y: number) => {
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

      const findItemAtPosition = (x: number, y: number) => {
        const block = findBlockByY(y);
        if (!block) return null;

        const p = getViewParams();
        const time = tOf(Number(x), p);

        // Header area
        if (y >= block.headerY0 && y <= block.headerY1) {
          if (block.expanded) return { area: 'header', block, lane: null, item: null };
          const bucket = processAggregates.get(block.hierarchy1) || [];
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
        if (
          !block.expanded ||
          !block.lanes ||
          block.detailY0 == null ||
          block.detailY1 == null ||
          y < block.detailY0 ||
          y > block.detailY1
        ) {
          return { area: 'header', block, lane: null, item: null };
        }

        const lane = block.lanes.find(
          (l: any) => (l.type === 'lane' || l.type === 'group') && y >= l.y0 && y <= l.y1
        );
        if (!lane) return { area: 'lane', block, lane: null, item: null };

        const events = lane.renderEvents || lane.events || [];
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

      let hoverFrame = 0;
      let lastHover: { clientX: number; clientY: number } | null = null;
      const handleMouseMove = (e: MouseEvent) => {
        lastHover = { clientX: e.clientX, clientY: e.clientY };
        if (hoverFrame) return;
        hoverFrame = requestAnimationFrame(() => {
          hoverFrame = 0;
          if (!lastHover) return;
          const rect = container.getBoundingClientRect();
          const x = lastHover.clientX - rect.left + container.scrollLeft;
          const y = lastHover.clientY - rect.top + container.scrollTop;
          const hit = findItemAtPosition(x, y);
          visibleState.hoveredTrack = hit ? `proc-${hit.block.hierarchy1}` : null;
          visibleState.hoveredItem = hit ? hit.item : null;
          redraw();

          if (hit && hit.item) {
            const tooltipConfig = ganttConfig?.tooltip || GANTT_CONFIG.tooltip;
            if (tooltipConfig?.enabled === false) {
              tooltip.style.display = 'none';
              return;
            }
            tooltip.style.display = 'block';
            tooltip.style.left = `${lastHover.clientX + 12}px`;
            tooltip.style.top = `${lastHover.clientY + 12}px`;
            const item = hit.item;
            if (item?.kind === 'summary') {
              tooltip.innerHTML = buildSummaryTooltipHtml(item);
              return;
            }
            const resolvedHierarchyValues =
              Array.isArray(item?.hierarchyValues) && item.hierarchyValues.length > 0
                ? item.hierarchyValues.map((value: any) => String(value ?? ''))
                : [
                    String(item?.hierarchy1 ?? hit.block.hierarchy1 ?? 'unknown'),
                    ...(
                      Array.isArray(hit.lane?.hierarchyPath)
                        ? hit.lane.hierarchyPath
                        : String(item?.hierarchy2 ?? hit.lane?.hierarchy2 ?? '').split('|')
                    )
                      .map((value: any) => String(value ?? '').trim())
                      .filter(Boolean)
                  ];
            const hierarchy1 = resolvedHierarchyValues[0] ?? 'unknown';
            const hierarchy2 = resolvedHierarchyValues.slice(1).join('|') || hierarchy1;
            const startUs = Number(item.start ?? item.timeStart);
            const endUs = Number(item.end ?? item.timeEnd);
            const durationUs =
              Number.isFinite(startUs) && Number.isFinite(endUs) ? Math.max(0, endUs - startUs) : 0;
            const sqlId = item.id ?? null;

            const stats = processStats.get(String(hierarchy1)) || {};
            const tooltipHtml = buildTooltipHtml(hit, tooltipConfig, {
              event: item,
              block: hit.block,
              lane: hit.lane,
              hierarchy1,
              hierarchy2: String(hierarchy2 ?? ''),
              hierarchyValues: resolvedHierarchyValues,
              startUs,
              endUs,
              durationUs,
              sqlId,
              stats,
              vars: {
                hierarchy1,
                hierarchy2,
                hierarchyValues: resolvedHierarchyValues,
                ...buildHierarchyVars(resolvedHierarchyValues),
                startUs,
                endUs,
                durationUs,
                sqlId
              }
            });
            tooltip.innerHTML = tooltipHtml;
          } else {
            tooltip.style.display = 'none';
          }
        });
      };

      const handleMouseLeave = () => {
        lastHover = null;
        if (hoverFrame) {
          cancelAnimationFrame(hoverFrame);
          hoverFrame = 0;
        }
        visibleState.hoveredTrack = null;
        visibleState.hoveredItem = null;
        tooltip.style.display = 'none';
        redraw();
      };

      let viewRangeSyncTimer: number | null = null;
      const syncViewRangeToState = () => {
        if (viewRangeSyncTimer) {
          window.clearTimeout(viewRangeSyncTimer);
          viewRangeSyncTimer = null;
        }
        const current = viewRangeRef.current || { start: fetchStart, end: fetchEnd };
        setViewRange({ start: Math.round(current.start), end: Math.round(current.end) });
      };
      const scheduleViewRangeStateSync = () => {
        if (viewRangeSyncTimer) {
          window.clearTimeout(viewRangeSyncTimer);
        }
        viewRangeSyncTimer = window.setTimeout(() => {
          viewRangeSyncTimer = null;
          const current = viewRangeRef.current || { start: fetchStart, end: fetchEnd };
          setViewRange({ start: Math.round(current.start), end: Math.round(current.end) });
        }, 180);
      };
      const updateViewRangeRefAndRedraw = (next: ViewRange, syncToState = false) => {
        const nextStart = Math.round(clampNumber(Number(next.start), fetchStart, fetchEnd));
        const nextEnd = Math.round(clampNumber(Number(next.end), fetchStart, fetchEnd));
        if (!Number.isFinite(nextStart) || !Number.isFinite(nextEnd) || nextEnd <= nextStart) return;
        const prev = viewRangeRef.current || { start: fetchStart, end: fetchEnd };
        if (nextStart === Number(prev.start) && nextEnd === Number(prev.end)) {
          if (syncToState) syncViewRangeToState();
          return;
        }
        viewRangeRef.current = { start: nextStart, end: nextEnd };
        redraw();
        if (syncToState) {
          syncViewRangeToState();
        } else {
          scheduleViewRangeStateSync();
        }
      };
      const markInteraction = () => {
        const prev = viewStateRef.current;
        if (prev) {
          viewStateRef.current = {
            ...prev,
            lastInteractionAt: Date.now()
          };
        }
      };

      let blockNextClick = false;
      const handleClick = (e: MouseEvent) => {
        if (blockNextClick) {
          blockNextClick = false;
          return;
        }
        const rect = container.getBoundingClientRect();
        const xViewport = e.clientX - rect.left;
        const y = e.clientY - rect.top + container.scrollTop;
        const x = xViewport + container.scrollLeft;
        if (xViewport > margin.left) {
          const hit = findItemAtPosition(x, y);
          if (hit?.item?.kind === 'summary') {
            const summaryStart = Number(hit.item.start ?? 0);
            const summaryEnd = Number(hit.item.end ?? 0);
            if (Number.isFinite(summaryStart) && Number.isFinite(summaryEnd) && summaryEnd > summaryStart) {
              setViewRange({ start: summaryStart, end: summaryEnd });
            }
          }
          if (hit?.item && hit.item.kind !== 'summary') {
            const nextId = hit.item.id ?? null;
            setViewState((prev) => ({
              ...prev,
              selection: nextId == null ? null : String(nextId)
            }));
          }
          return;
        }
        // Toggle only when clicking in the left label column AND on the process header row
        const block = findBlockByY(y);
        if (!block) return;
        if (y >= block.headerY0 && y <= block.headerY1) {
          const hierarchy1Id = block.hierarchy1;
          setExpandedHierarchy1Ids((prev) => {
            const has = prev.includes(hierarchy1Id);
            if (has) {
              const prefix = `${hierarchy1Id}|`;
              return prev.filter((p) => p !== hierarchy1Id && !p.startsWith(prefix));
            }
            return [...prev, hierarchy1Id];
          });
          return;
        }
        if (!block.expanded || !Array.isArray(block.lanes)) return;
        const row = block.lanes.find((lane: any) => y >= lane.y0 && y <= lane.y1);
        if (!row || row.type !== 'group' || !row.expandable) return;
        const expandKey = String(row.expandKey || '');
        if (!expandKey) return;
        setExpandedHierarchy1Ids((prev) => {
          const has = prev.includes(expandKey);
          if (has) {
            const prefix = `${expandKey}|`;
            return prev.filter((p) => p !== expandKey && !p.startsWith(prefix));
          }
          return [...prev, expandKey];
        });
        // keep scroll position
      };

      const handleAxisClick = (e: MouseEvent) => {
        const rect = container.getBoundingClientRect();
        const y = e.clientY - rect.top + container.scrollTop;
        const block = findBlockByY(y);
        if (!block) return;
        if (y >= block.headerY0 && y <= block.headerY1) {
          const hierarchy1Id = block.hierarchy1;
          setExpandedHierarchy1Ids((prev) => {
            const has = prev.includes(hierarchy1Id);
            if (has) {
              const prefix = `${hierarchy1Id}|`;
              return prev.filter((p) => p !== hierarchy1Id && !p.startsWith(prefix));
            }
            return [...prev, hierarchy1Id];
          });
          return;
        }
        if (!block.expanded || !Array.isArray(block.lanes)) return;
        const row = block.lanes.find((lane: any) => y >= lane.y0 && y <= lane.y1);
        if (!row || row.type !== 'group' || !row.expandable) return;
        const expandKey = String(row.expandKey || '');
        if (!expandKey) return;
        setExpandedHierarchy1Ids((prev) => {
          const has = prev.includes(expandKey);
          if (has) {
            const prefix = `${expandKey}|`;
            return prev.filter((p) => p !== expandKey && !p.startsWith(prefix));
          }
          return [...prev, expandKey];
        });
      };

      // Ctrl + wheel zoom on the fixed x-axis (client-side view zoom; no refetch)
      const handleAxisWheel = (e: WheelEvent) => {
        if (!axisHost) return;
        // Default wheel: scroll the main viewport (keeps axis fixed)
        if (!(e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          container.scrollTop += e.deltaY;
          return;
        }

        e.preventDefault();
        markInteraction();

        const rect = axisHost.getBoundingClientRect();
        const xViewport = e.clientX - rect.left;
        if (xViewport < margin.left || xViewport > margin.left + innerWidth) return;

        const prev = viewRangeRef.current || { start: fetchStart, end: fetchEnd };
        const prevStart = Number(prev?.start);
        const prevEnd = Number(prev?.end);
        const span = Math.max(1, prevEnd - prevStart);
        const zoomFactor = Math.exp(e.deltaY * 0.0015); // >1 zoom out, <1 zoom in
        const minSpan = 1000; // 1ms
        const newSpan = clampNumber(span * zoomFactor, minSpan, fetchSpan);

        const t = prevStart + ((xViewport - margin.left) / innerWidth) * span;
        let newStart = t - (t - prevStart) * (newSpan / span);
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
        updateViewRangeRefAndRedraw({ start: newStart, end: newEnd });
      };

      // Ctrl+wheel zoom also works on the main viewport area (below).
      const handleViewportWheel = (e: WheelEvent) => {
        if (!(e.ctrlKey || e.metaKey)) return;
        e.preventDefault();
        markInteraction();

        const rect = container.getBoundingClientRect();
        const xInChart = e.clientX - rect.left + container.scrollLeft;
        if (xInChart < margin.left || xInChart > margin.left + innerWidth) return;

        const prev = viewRangeRef.current || { start: fetchStart, end: fetchEnd };
        const prevStart = Number(prev?.start);
        const prevEnd = Number(prev?.end);
        const span = Math.max(1, prevEnd - prevStart);
        const zoomFactor = Math.exp(e.deltaY * 0.0015);
        const minSpan = 1000; // 1ms
        const newSpan = clampNumber(span * zoomFactor, minSpan, fetchSpan);

        const t = prevStart + ((xInChart - margin.left) / innerWidth) * span;
        let newStart = t - (t - prevStart) * (newSpan / span);
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
        updateViewRangeRefAndRedraw({ start: newStart, end: newEnd });
      };

      // Drag the minimap window to pan the view (client-side; no refetch)
      let isDraggingMinimap = false;
      let dragOffsetPx = 0;

      const panViewToLeftPx = (leftPx: number) => {
        const current = viewRangeRef.current || { start: fetchStart, end: fetchEnd };
        const spanUs = Math.max(1, Number(current.end) - Number(current.start));
        const windowPx = (spanUs / fetchSpan) * innerWidth;
        const minLeft = margin.left;
        const maxLeft = Math.max(minLeft, margin.left + innerWidth - windowPx);
        const clampedLeft = clampNumber(leftPx, minLeft, maxLeft);

        const newStart = fetchStart + ((clampedLeft - margin.left) / innerWidth) * fetchSpan;
        const newEnd = newStart + spanUs;
        updateViewRangeRefAndRedraw({ start: newStart, end: newEnd });
      };

      const handleMinimapPointerDown = (e: PointerEvent) => {
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

      const handleMinimapPointerMove = (e: PointerEvent) => {
        if (!isDraggingMinimap || !minimapHost) return;
        const rect = minimapHost.getBoundingClientRect();
        const x = e.clientX - rect.left;
        markInteraction();
        panViewToLeftPx(x - dragOffsetPx);
      };

      const handleMinimapPointerUp = () => {
        isDraggingMinimap = false;
        syncViewRangeToState();
      };

      // Drag the main chart to pan horizontally when zoomed in.
      let isDraggingChart = false;
      let dragStartClientX = 0;
      let dragStartView: ViewRange | null = null;
      let dragMoved = false;

      const canPanChart = () => {
        const current = viewRangeRef.current || { start: fetchStart, end: fetchEnd };
        return Math.max(1, Number(current.end) - Number(current.start)) < fetchSpan;
      };

      const handleChartPointerDown = (e: PointerEvent) => {
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

      const handleChartPointerMove = (e: PointerEvent) => {
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
        markInteraction();
        updateViewRangeRefAndRedraw({ start: newStart, end: newEnd });
      };

      const handleChartPointerUp = () => {
        if (dragMoved) {
          blockNextClick = true;
        }
        isDraggingChart = false;
        dragStartView = null;
        syncViewRangeToState();
      };

      let scrollRaf = 0;
      const handleScroll = () => {
        if (scrollRaf) return;
        scrollRaf = requestAnimationFrame(() => {
          scrollRaf = 0;
          redraw();
        });
      };
      container.addEventListener('scroll', handleScroll);
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
        if (hoverFrame) {
          cancelAnimationFrame(hoverFrame);
          hoverFrame = 0;
        }
        if (viewRangeSyncTimer) {
          window.clearTimeout(viewRangeSyncTimer);
          viewRangeSyncTimer = null;
        }
        if (scrollRaf) {
          cancelAnimationFrame(scrollRaf);
          scrollRaf = 0;
        }
        container.removeEventListener('scroll', handleScroll);
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
        if (webglRenderer) {
          webglRenderer.dispose();
        }
        if (redrawRef.current === redraw) {
          redrawRef.current = null;
        }
        if (overlayRef.current === overlay) {
          overlayRef.current = null;
        }
        if (onResize === resizeScene) {
          onResize = null;
        }
      };
    };

    let teardown: (() => void) | undefined;
    let onResize: (() => void) | null = null;
    let resizeRaf = 0;
    const build = () => {
      if (teardown) teardown();
      teardown = renderChart();
    };

    build();

    const resizeObserver = new ResizeObserver(() => {
      if (resizeRaf) return;
      resizeRaf = requestAnimationFrame(() => {
        resizeRaf = 0;
        if (onResize) {
          onResize();
        } else if (typeof redrawRef.current === 'function') {
          redrawRef.current();
        }
      });
    });
    resizeObserver.observe(container);

    return () => {
      if (resizeRaf) {
        cancelAnimationFrame(resizeRaf);
        resizeRaf = 0;
      }
      resizeObserver.disconnect();
      if (teardown) teardown();
      container.innerHTML = '';
      if (minimapRef.current) minimapRef.current.innerHTML = '';
      if (xAxisRef.current) xAxisRef.current.innerHTML = '';
      if (yAxisRef.current) yAxisRef.current.innerHTML = '';
    };
  };

  useGanttChart(renderChartEffect, [
    chartData,
    startTime,
    endTime,
    bins,
    obd,
    processAggregates,
    threadsByHierarchy1,
    renderSoA,
    expandedHierarchy1Ids,
    yAxisWidth,
    processSortMode,
    ganttConfig
  ]);
}

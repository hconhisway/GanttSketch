import { useEffect, useMemo, useRef } from 'react';
import * as d3 from 'd3';
import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from 'react';
import { GANTT_CONFIG } from '../config/ganttConfig';
import type {
  GanttDataMapping,
  ProcessSortMode,
  TimeScaleMode
} from '../types/ganttConfig';
import type { ViewState } from '../types/viewState';
import type { RenderPrimitive } from '../types/data';
import type { HierarchyAggregateNode } from '../types/hierarchyAggregation';
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
import { evalExpr, getValueAtPath, isEmptyValue } from '../utils/expression';
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
import {
  buildDependencyIndex,
  buildDependencyPath,
  getVisibleEdges
} from '../utils/dependencyGraph';
import {
  computeOverviewModel,
  drawOverviewChart,
  resolveBinCount
} from '../auxCharts';
import type { OverviewModel } from '../auxCharts';
import { computeLogicalClock } from '../scales/logicalClock';
import { createTimeScale, type TimeScaleViewParams } from '../scales/timeScale';

type ViewRange = { start: number; end: number };
type ViewParams = TimeScaleViewParams;

type ThreadLevelMap = Map<string | number, any[]>;
type ThreadMap = Map<string, ThreadLevelMap>;
type ThreadsByHierarchy1 = Map<string, ThreadMap>;

interface UseChartRendererArgs {
  scrollRef: RefObject<HTMLDivElement>;
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
  hierarchyTrees: Map<string, HierarchyAggregateNode>;
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
  scrollRef,
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
  hierarchyTrees,
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
  const fisheyeFocusTimeRef = useRef<number | null>(null);
  const logicalViewRangeRef = useRef<ViewRange | null>(null);
  const warnedLogicalFallbackRef = useRef(false);
  const dependencyField = dataMapping?.features?.dependencyField ?? null;
  const dependencyIndex = useMemo(
    () => buildDependencyIndex(chartData, dependencyField),
    [chartData, dependencyField]
  );
  const logicalClock = useMemo(
    () => computeLogicalClock(chartData, dependencyIndex),
    [chartData, dependencyIndex]
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
  const chartBlocksRef = useRef<any[]>([]);
  const chartTeardownRef = useRef<(() => void) | null>(null);
  const lastExpandToggleRef = useRef<{ key: string; at: number }>({ key: '', at: 0 });

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
    if (!scrollRef.current || !chartRef.current) return;

    const container = scrollRef.current;
    const stage = chartRef.current;
    let pixelRatio = window.devicePixelRatio || 1;

    const renderChart = () => {
      const hasExistingChart = !!stage.querySelector('.gantt-canvas');
      if (!hasExistingChart) {
        stage.innerHTML = '';
        if (minimapRef.current) minimapRef.current.innerHTML = '';
        if (xAxisRef.current) xAxisRef.current.innerHTML = '';
      }

      // Handle empty data case
      if (!chartData || chartData.length === 0) {
        if (!hasExistingChart) {
          stage.innerHTML = `<div class="chart-empty-state">No data to display</div>`;
        }
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
      const nestedRowHeight = Math.max(headerHeight, Number(layoutConfig?.nestedRowHeight ?? 36));
      const nestedLevelInset = Math.max(1, Number(layoutConfig?.nestedLevelInset ?? 3));

      const yAxisConfig = ganttConfig?.yAxis || {};
      const hierarchyDisplayMode = yAxisConfig?.hierarchyDisplayMode === 'nested' ? 'nested' : 'rows';
      const isNestedHierarchyMode = hierarchyDisplayMode === 'nested';
      const orderedHierarchy1Ids = orderResult.orderedHierarchy1Ids || [];
      const depthByHierarchy1 = orderResult.depthByHierarchy1 || new Map();
      if (orderedHierarchy1Ids.length === 0) {
        stage.innerHTML = `<div class="chart-empty-state">No processes found</div>`;
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
        for (let index = 0; index < values.length; index++) {
          const level = index + 1;
          vars[getHierarchyVarName(level)] = values[index];
          vars[getHierarchyFieldVarName(level)] =
            hierarchyFieldDisplays[index] ??
            (level === 1 ? hierarchy1FieldDisplay : hierarchy2FieldDisplay);
        }
        return vars;
      };
      const expandedHierarchyKeySet = new Set(expandedHierarchy1Ids);

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

          if (!isNestedHierarchyMode) {
            // Expanded hierarchy labels in row mode.
            ctx.font = (yAxisLayout?.hierarchy2Font ?? yAxisLayout?.threadFont) || '500 11px system-ui';
            for (const hierarchy1Id of expandedHierarchyKeySet) {
              if (String(hierarchy1Id).includes('|')) continue;
              const tree = hierarchyTrees.get(hierarchy1Id);
              if (!tree) continue;
              const stack = [...tree.children].reverse();
              while (stack.length > 0) {
                const node = stack.pop()!;
                const path = node.hierarchyValues.slice(1);
                const text = getHierarchyNodeLabel(hierarchy1Id, path, false);
                const indent = THREAD_INDENT + Math.max(0, path.length - 1) * 12;
                const w = ctx.measureText(text).width;
                maxPx = Math.max(maxPx, LEFT_PAD + indent + w + RIGHT_PAD);
                const expandKey = [hierarchy1Id, ...path].join('|');
                if (expandedHierarchyKeySet.has(expandKey)) {
                  for (let index = node.children.length - 1; index >= 0; index -= 1) {
                    stack.push(node.children[index]);
                  }
                }
              }
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
        for (let si = 0; si < sorted.length; si++) {
          const ev = sorted[si];
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
        }
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
      const getLaneRuleForHierarchyLevel = (level: number) => {
        for (let current = Math.max(2, Math.floor(level)); current >= 2; current -= 1) {
          const direct = (yAxisConfig as any)?.[`hierarchy${current}LaneRule`];
          if (direct != null) return direct;
        }
        return yAxisConfig?.hierarchy2LaneRule ?? yAxisConfig?.threadLaneRule;
      };
      const buildRuleLanes = (
        events: any[],
        laneRuleOverride?: any
      ): Array<{ laneId: string | number; events: any[] }> => {
        if (!Array.isArray(events) || events.length === 0) return [];
        const laneRule = laneRuleOverride ?? getLaneRuleForHierarchyLevel(2);
        const laneMode = resolveThreadLaneMode(laneRule, yAxisConfig?.thread?.orderMode);
        const laneFieldPath = getThreadLaneFieldPath(laneRule);
        if (laneMode === 'auto') {
          const autoLanes = buildAutoLanes(events);
          const out: Array<{ laneId: string | number; events: any[] }> = [];
          for (let idx = 0; idx < autoLanes.length; idx++) {
            out.push({ laneId: idx, events: autoLanes[idx] });
          }
          return out;
        }
        const byLevel = new Map<string | number, any[]>();
        const useFieldLanes = laneFieldPath.length > 0;
        for (let ei = 0; ei < events.length; ei++) {
          const ev = events[ei];
          let laneId: string | number = 0;
          if (useFieldLanes) {
            const raw = getLaneKeyValue(ev, laneFieldPath);
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
        }
        const laneIds = Array.from(byLevel.keys()).sort((a, b) => {
          const na = Number(a);
          const nb = Number(b);
          if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
          return String(a).localeCompare(String(b), undefined, { numeric: true });
        });
        const result: Array<{ laneId: string | number; events: any[] }> = [];
        for (let li = 0; li < laneIds.length; li++) {
          const laneId = laneIds[li];
          const bucket = [...(byLevel.get(laneId) ?? [])];
          bucket.sort((a, b) => {
            const byStart = Number(a?.start ?? 0) - Number(b?.start ?? 0);
            if (byStart !== 0) return byStart;
            return Number(a?.end ?? 0) - Number(b?.end ?? 0);
          });
          result.push({ laneId, events: bucket });
        }
        return result;
      };

      type HierarchyNode = {
        key: string;
        segment: string;
        fullPath: string[];
        children: Map<string, HierarchyNode>;
        events: any[];
        aggregateSegments: any[];
        levelMap?: ThreadLevelMap;
        kind?: 'nestedHierarchy';
        hierarchy1?: string;
        hierarchyValues?: string[];
        hierarchyLabel?: string;
        expandKey?: string;
        expandable?: boolean;
        expanded?: boolean;
        representativeEvent?: any | null;
        display?: { x1: number; x2: number; y0: number; y1: number } | null;
        displaySegments?: Array<{ x1: number; x2: number; y0: number; y1: number; sourceIndex: number }>;
      };

      type HierarchyBuildResult = {
        root: HierarchyNode;
        omittedCount: number;
      };

      /** Max thread paths per process to avoid stack overflow; raise if you need more. */
      const MAX_TID_PATHS_PER_HIERARCHY = 2000;
      /** Max tree nodes to process per process; raise if hierarchy is very deep. */
      const MAX_NODES_PER_HIERARCHY = 10000;

      const getSortedHierarchyChildren = (node: HierarchyNode) =>
        Array.from(node.children.values()).sort((a, b) =>
          String(a.segment).localeCompare(String(b.segment), undefined, { numeric: true })
        );

      const cloneHierarchyNodeFromAggregate = (node: HierarchyAggregateNode): HierarchyNode => {
        const children = new Map<string, HierarchyNode>();
        for (let index = 0; index < node.children.length; index += 1) {
          const child = cloneHierarchyNodeFromAggregate(node.children[index]);
          children.set(child.segment, child);
        }
        return {
          key: node.key,
          segment: node.segment,
          fullPath: node.hierarchyValues.slice(1),
          children,
          events: Array.isArray(node.sourceEvents) ? node.sourceEvents : [],
          aggregateSegments: Array.isArray(node.aggregateSegments) ? node.aggregateSegments : [],
          levelMap: node.levelMap as ThreadLevelMap | undefined,
          hierarchy1: node.hierarchy1
        };
      };

      const buildHierarchyTreeForHierarchy1 = (
        hierarchy1Id: string
      ): HierarchyBuildResult | null => {
        const aggregateTree = hierarchyTrees.get(hierarchy1Id);
        if (!aggregateTree) return null;
        const topNode = cloneHierarchyNodeFromAggregate(aggregateTree);
        const root: HierarchyNode = {
          key: '',
          segment: '',
          fullPath: [],
          children: topNode.children,
          events: topNode.events,
          aggregateSegments: topNode.aggregateSegments,
          levelMap: topNode.levelMap,
          hierarchy1: hierarchy1Id
        };
        return { root, omittedCount: 0 };
      };

      const buildLanesForHierarchy1 = (hierarchy1Id: string) => {
        const built = buildHierarchyTreeForHierarchy1(hierarchy1Id);
        if (!built) return [];
        const { root, omittedCount } = built;

        const lanes: any[] = [];
        const emitLeafLanes = (
          node: HierarchyNode,
          rowLabel?: string
        ) => {
          if (!node.levelMap) return;
          const pathSegments = node.fullPath;
          const levelMap = node.levelMap;
          const hierarchy2Path = pathSegments.join('|');
          const hierarchyValues = [
            String(hierarchy1Id),
            ...pathSegments.map((segment) => String(segment))
          ];
          const laneRule = getLaneRuleForHierarchyLevel(hierarchyValues.length);
          const allEvents: any[] = [];
          for (const arr of levelMap.values()) {
            if (!Array.isArray(arr) || arr.length === 0) continue;
            for (let i = 0; i < arr.length; i += 1) allEvents.push(arr[i]);
          }
          const resolvedLanes = buildRuleLanes(allEvents, laneRule);
          for (let idx = 0; idx < resolvedLanes.length; idx++) {
            const { laneId, events } = resolvedLanes[idx];
            const laneKey = buildHierarchyLaneKey([hierarchy1Id, ...pathSegments], laneId);
            lanes.push({
              type: 'lane',
              hierarchy1: hierarchy1Id,
              hierarchy2: hierarchy2Path,
              hierarchyPath: [...pathSegments],
              hierarchyValues,
              level: laneId,
              laneKey,
              threadLabel: idx === 0 ? (rowLabel ?? '') : '',
              events
            });
          }
        };
        const processNode = (node: HierarchyNode): HierarchyNode[] => {
          const path = node.fullPath;
          const depth = path.length;
          const expandKey = [hierarchy1Id, ...path].join('|');
          const hierarchyValues = [String(hierarchy1Id), ...path.map((segment) => String(segment))];
          const hasChildren = node.children.size > 0;
          const hasLeaf = Boolean(node.levelMap && node.levelMap.size > 0);
          const expandable = hasChildren || hasLeaf;
          const expanded = expandedHierarchyKeySet.has(expandKey);
          const hierarchyLabel = getHierarchyNodeLabel(
            hierarchy1Id,
            path,
            path.join('|') === String(hierarchy1Id)
          );
          node.kind = 'nestedHierarchy';
          node.hierarchy1 = hierarchy1Id;
          node.hierarchyValues = hierarchyValues;
          node.hierarchyLabel = hierarchyLabel;
          node.expandKey = expandKey;
          node.expandable = expandable;
          node.expanded = expanded;
          node.representativeEvent = Array.isArray(node.events) && node.events.length > 0 ? node.events[0] : null;
          node.display = null;
          const laneKey = buildHierarchyLaneKey([hierarchy1Id, ...path], '__group__');
          lanes.push({
            type: 'group',
            hierarchy1: hierarchy1Id,
            hierarchy2: path.join('|'),
            hierarchyPath: [...path],
            hierarchyValues,
            hierarchyDepth: depth,
            expandKey,
            expandable,
            expanded,
            laneKey,
            events: node.aggregateSegments,
            label: hierarchyLabel
          });
          if (hasLeaf && !hasChildren && expanded) {
            emitLeafLanes(node);
          }
          if (hasChildren && expanded) {
            return getSortedHierarchyChildren(node);
          }
          return [];
        };
        const roots = getSortedHierarchyChildren(root);
        if (roots.length === 0 && root.levelMap) {
          emitLeafLanes(root);
          return lanes;
        }
        const stack = [...roots].reverse();
        let nodesProcessed = 0;
        while (stack.length > 0 && nodesProcessed < MAX_NODES_PER_HIERARCHY) {
          const node = stack.pop()!;
          nodesProcessed += 1;
          const next = processNode(node);
          for (let i = next.length - 1; i >= 0; i--) stack.push(next[i]);
        }
        if (omittedCount > 0) {
          lanes.push({
            type: 'lane',
            hierarchy1: hierarchy1Id,
            hierarchy2: '',
            hierarchyPath: [],
            hierarchyValues: [String(hierarchy1Id)],
            level: '__more__',
            laneKey: `${hierarchy1Id}|__more__`,
            threadLabel: `… and ${omittedCount} more threads (first ${MAX_TID_PATHS_PER_HIERARCHY} shown; narrow time range to see all)`,
            events: []
          });
        }
        return lanes;
      };

      type NestedLeafLane = {
        hierarchy1: string;
        hierarchy2: string;
        hierarchyPath: string[];
        hierarchyValues: string[];
        level: string | number;
        laneKey: string;
        events: any[];
        nestedLane: any;
      };

      const getHierarchyValuesForNode = (node: HierarchyNode) => [
        String(node.hierarchy1 ?? ''),
        ...node.fullPath.map((segment) => String(segment ?? ''))
      ].filter((value, index) => index === 0 || Boolean(value));

      const getNestedExpandKey = (node: HierarchyNode) =>
        [String(node.hierarchy1 ?? ''), ...node.fullPath].filter(Boolean).join('|');

      const isNestedNodeExpanded = (node: HierarchyNode) => {
        const key = getNestedExpandKey(node);
        if (expandedHierarchyKeySet.has(key)) return true;
        const n = Math.max(1, node.aggregateSegments?.length ?? 1);
        for (let i = 0; i < n; i++) if (expandedHierarchyKeySet.has(`${key}|${i}`)) return true;
        return false;
      };

      const getNestedLeafLanesForNode = (node: HierarchyNode): NestedLeafLane[] => {
        if (!node.levelMap) return [];
        const hierarchyValues = getHierarchyValuesForNode(node);
        const hierarchyPath = hierarchyValues.slice(1);
        const hierarchy2 = hierarchyPath.join('|') || hierarchyValues[0] || String(node.hierarchy1 ?? '');
        const laneRule = getLaneRuleForHierarchyLevel(hierarchyValues.length);
        const allEvents: any[] = [];
        for (const arr of node.levelMap.values()) {
          if (!Array.isArray(arr) || arr.length === 0) continue;
          for (let i = 0; i < arr.length; i += 1) allEvents.push(arr[i]);
        }
        const resolvedLanes = buildRuleLanes(allEvents, laneRule);
        return resolvedLanes.map(({ laneId, events }) => {
          return {
            hierarchy1: String(node.hierarchy1 ?? ''),
            hierarchy2,
            hierarchyPath,
            hierarchyValues,
            level: laneId,
            laneKey: buildHierarchyLaneKey(hierarchyValues, laneId),
            events,
            nestedLane: {
              type: 'lane',
              hierarchy1: String(node.hierarchy1 ?? ''),
              hierarchy2,
              hierarchyPath,
              hierarchyValues,
              level: laneId,
              laneKey: buildHierarchyLaneKey(hierarchyValues, laneId),
              events
            }
          };
        });
      };

      const nestedHeightCache = new Map<string, number>();
      const measureNestedNodeBoxHeight = (node: HierarchyNode): number => {
        const cacheKey = `${String(node.hierarchy1 ?? '')}|${node.fullPath.join('|')}`;
        const cached = nestedHeightCache.get(cacheKey);
        if (cached != null) return cached;

        const hasChildren = node.children.size > 0;
        const expanded = isNestedNodeExpanded(node);
        const hasLeaf = Boolean(node.levelMap && node.levelMap.size > 0);
        const showLeafLevels = hasLeaf && expanded;
        const leafLaneCount = showLeafLevels ? getNestedLeafLanesForNode(node).length : 0;
        const leafContentHeight = leafLaneCount > 0 ? leafLaneCount * laneHeight : 0;

        let childContentHeight = 0;
        if (hasChildren && expanded) {
          const children = getSortedHierarchyChildren(node);
          for (let i = 0; i < children.length; i += 1) {
            childContentHeight += measureNestedNodeBoxHeight(children[i]) + (i < children.length - 1 ? nestedLevelInset : 0);
          }
        }

        let innerHeight = 14; // Base header height
        if (expanded) {
          if (showLeafLevels) {
            innerHeight += nestedLevelInset + leafContentHeight;
          }
          if (hasChildren) {
            innerHeight += nestedLevelInset + childContentHeight;
          }
        } else {
          innerHeight = Math.max(laneHeight, 14);
        }

        const boxHeight = innerHeight + nestedLevelInset * 2;
        nestedHeightCache.set(cacheKey, boxHeight);
        return boxHeight;
      };

      const getNestedNodeContentHeight = (node: HierarchyNode): number => {
        const hasLeaf = Boolean(node.levelMap && node.levelMap.size > 0);
        const hasChildren = node.children.size > 0;
        let h = nestedLevelInset * 2;
        if (hasLeaf) h += nestedLevelInset + getNestedLeafLanesForNode(node).length * laneHeight;
        if (hasChildren) {
          h += nestedLevelInset;
          const children = getSortedHierarchyChildren(node);
          for (let i = 0; i < children.length; i += 1) {
            h += measureNestedNodeBoxHeight(children[i]) + (i < children.length - 1 ? nestedLevelInset : 0);
          }
        }
        return h;
      };

      type Block = {
        hierarchy1: string;
        expanded: boolean;
        displayMode: 'rows' | 'nested';
        depth: number;
        indentPx: number;
        y0: number;
        y1: number;
        headerY0: number;
        headerY1: number;
        detailY0: number | null;
        detailY1: number | null;
        lanes: any[];
        nestedTree: HierarchyNode | null;
        nestedItems: any[];
        nestedOverflowLabel: string | null;
      };

      const OVERFLOW_LANE_MSG = 'Too many threads; try narrowing the time range or refresh.';
      const makeOverflowLane = (h1: string) => ({
        type: 'lane' as const,
        events: [] as any[],
        hierarchy1: h1,
        hierarchy2: '',
        hierarchyPath: [] as string[],
        hierarchyValues: [String(h1)],
        level: 0,
        laneKey: `${h1}|__overflow__`,
        threadLabel: OVERFLOW_LANE_MSG
      });

      const blocks: Block[] = [];
      let yCursor = margin.top;

      for (let hi = 0; hi < orderedHierarchy1Ids.length; hi++) {
        const hierarchy1Id = orderedHierarchy1Ids[hi];
        const depth = depthByHierarchy1.get(String(hierarchy1Id)) || 0;
        const expanded = expandedHierarchyKeySet.has(hierarchy1Id);
        if (!expanded) {
          blocks.push({
            hierarchy1: hierarchy1Id,
            expanded: false,
            displayMode: hierarchyDisplayMode,
            depth,
            indentPx: 0,
            y0: yCursor,
            y1: yCursor + headerHeight,
            headerY0: yCursor,
            headerY1: yCursor + headerHeight,
            detailY0: null,
            detailY1: null,
            lanes: [],
            nestedTree: null,
            nestedItems: [],
            nestedOverflowLabel: null
          });
          yCursor += headerHeight;
          continue;
        }

        if (isNestedHierarchyMode) {
          let nestedTree: HierarchyNode | null = null;
          let nestedOverflowLabel: string | null = null;
          try {
            const built = buildHierarchyTreeForHierarchy1(hierarchy1Id);
            nestedTree = built?.root ?? null;
            if ((built?.omittedCount ?? 0) > 0) {
              nestedOverflowLabel = `… and ${built!.omittedCount} more threads (first ${MAX_TID_PATHS_PER_HIERARCHY} shown; narrow time range to see all)`;
            }
          } catch (err: any) {
            const isStackOverflow =
              err instanceof RangeError ||
              (err?.message && String(err.message).toLowerCase().includes('stack'));
            if (isStackOverflow) {
              nestedOverflowLabel = 'Too many threads; try narrowing the time range or refresh.';
            } else {
              throw err;
            }
          }
          const singleLevelNested =
            nestedTree != null && nestedTree.children.size === 0;
          if (singleLevelNested) {
            let lanes: any[];
            try {
              lanes = buildLanesForHierarchy1(hierarchy1Id);
            } catch (err: any) {
              const isStackOverflow =
                err instanceof RangeError ||
                (err?.message && String(err.message).toLowerCase().includes('stack'));
              if (isStackOverflow) {
                lanes = [makeOverflowLane(hierarchy1Id)];
              } else {
                throw err;
              }
            }
            const lanesHeight = lanes.reduce((sum: number, lane: any) => sum + laneHeight, 0);
            const blockHeight = headerHeight + expandedPadding + lanesHeight + expandedPadding;
            const block: Block = {
              hierarchy1: hierarchy1Id,
              expanded: true,
              displayMode: 'rows',
              depth,
              indentPx: 0,
              y0: yCursor,
              y1: yCursor + blockHeight,
              headerY0: yCursor,
              headerY1: yCursor + headerHeight,
              detailY0: yCursor + headerHeight + expandedPadding,
              detailY1: yCursor + blockHeight - expandedPadding,
              lanes: [],
              nestedTree: null,
              nestedItems: [],
              nestedOverflowLabel: null
            };
            let laneCursor = block.detailY0;
            block.lanes = lanes.map((lane: any) => {
              const y0 = laneCursor;
              laneCursor += laneHeight;
              return { ...lane, y0, y1: laneCursor };
            });
            blocks.push(block);
            yCursor = block.y1;
            continue;
          }

          let blockHeight = nestedRowHeight;
          if (nestedTree) {
            const segmentCount = Math.max(1, Array.isArray(nestedTree.aggregateSegments) ? nestedTree.aggregateSegments.length : 1);
            const rootExpandKey = getNestedExpandKey(nestedTree);
            const contentHeight = getNestedNodeContentHeight(nestedTree);
            const rootExpandedByTopLevel = expandedHierarchyKeySet.has(rootExpandKey);
            let maxSegH = 14;
            for (let si = 0; si < segmentCount; si++) {
              const segExpanded = rootExpandedByTopLevel || expandedHierarchyKeySet.has(`${rootExpandKey}|${si}`);
              const segH = segExpanded ? 14 + contentHeight : 14;
              if (segH > maxSegH) maxSegH = segH;
            }
            blockHeight = Math.max(maxSegH, nestedRowHeight);
          }

          blocks.push({
            hierarchy1: hierarchy1Id,
            expanded: true,
            displayMode: 'nested',
            depth,
            indentPx: 0,
            y0: yCursor,
            y1: yCursor + blockHeight,
            headerY0: yCursor,
            headerY1: yCursor + Math.min(blockHeight, headerHeight),
            detailY0: yCursor,
            detailY1: yCursor + blockHeight,
            lanes: [],
            nestedTree,
            nestedItems: [],
            nestedOverflowLabel
          });
          yCursor += blockHeight + expandedPadding;
          continue;
        }

        let lanes: any[];
        try {
          lanes = buildLanesForHierarchy1(hierarchy1Id);
        } catch (err: any) {
          const isStackOverflow =
            err instanceof RangeError ||
            (err?.message && String(err.message).toLowerCase().includes('stack'));
          if (isStackOverflow) {
            lanes = [makeOverflowLane(hierarchy1Id)];
          } else {
            throw err;
          }
        }
        const lanesHeight = lanes.reduce((sum: number, lane: any) => sum + laneHeight, 0);
        const blockHeight = headerHeight + expandedPadding + lanesHeight + expandedPadding;

        const block: Block = {
          hierarchy1: hierarchy1Id,
          expanded: true,
          displayMode: 'rows',
          depth,
          indentPx: 0,
          y0: yCursor,
          y1: yCursor + blockHeight,
          headerY0: yCursor,
          headerY1: yCursor + headerHeight,
          detailY0: yCursor + headerHeight + expandedPadding,
          detailY1: yCursor + blockHeight - expandedPadding,
          lanes: [],
          nestedTree: null,
          nestedItems: [],
          nestedOverflowLabel: null
        };

        let laneCursor = block.detailY0;
        block.lanes = lanes.map((lane: any) => {
          const y0 = laneCursor;
          laneCursor += laneHeight;
          return { ...lane, y0, y1: laneCursor };
        });

        blocks.push(block);
        yCursor = block.y1;
      }

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

      // Fast lookup for "which fork group contains block i" (matches forkGroups.find semantics).
      const forkGroupByBlockIndex: Array<ForkGroup | undefined> = hasForkStructure
        ? new Array(blocks.length)
        : [];
      if (hasForkStructure) {
        let groupPtr = 0;
        const active: ForkGroup[] = [];
        let head = 0;
        for (let i = 0; i < blocks.length; i += 1) {
          while (groupPtr < forkGroups.length && forkGroups[groupPtr].startBlockIndex <= i) {
            active.push(forkGroups[groupPtr]);
            groupPtr += 1;
          }
          while (head < active.length && active[head].endBlockIndex < i) {
            head += 1;
          }
          forkGroupByBlockIndex[i] = head < active.length ? active[head] : undefined;
        }
      }

      const GAP_BETWEEN_FORK_GROUPS = 12;
      const FORK_CARD_RADIUS = 8;
      const FORK_CARD_STROKE = 'rgba(0,0,0,0.08)';
      if (hasForkStructure && forkGroups.length > 0) {
        // Avoid O(N^2) filtering: precompute cumulative fork-group ends.
        const forkEnds = forkGroups
          .map((g) => g.endBlockIndex)
          .sort((a, b) => a - b);
        let endedBeforeCount = 0;
        blocks.forEach((block, i) => {
          while (endedBeforeCount < forkEnds.length && forkEnds[endedBeforeCount] < i) {
            endedBeforeCount += 1;
          }
          const offset = GAP_BETWEEN_FORK_GROUPS * endedBeforeCount;
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

      // Precompute lane rows/order once per layout build (avoid O(N) allocations per redraw).
      const laneRows: Array<{ laneId: string; y0: number; y1: number }> = [];
      for (let i = 0; i < blocks.length; i += 1) {
        const block = blocks[i];
        laneRows.push({
          laneId: String(block.hierarchy1),
          y0: block.headerY0,
          y1: block.headerY1
        });
        if (block.expanded && Array.isArray(block.lanes)) {
          for (let li = 0; li < block.lanes.length; li += 1) {
            const lane: any = block.lanes[li];
            const hierarchyValues = Array.isArray(lane?.hierarchyValues)
              ? lane.hierarchyValues.map((value: any) => String(value ?? ''))
              : [];
            const laneId =
              hierarchyValues.length > 0
                ? hierarchyValues.join('|')
                : String(lane?.hierarchy2 ?? lane?.hierarchy1 ?? block.hierarchy1 ?? '');
            laneRows.push({ laneId, y0: lane.y0, y1: lane.y1 });
          }
        }
      }
      const laneOrder = laneRows.map((row) => row.laneId);
      updateViewStateFromRender({ laneOrder });

      chartBlocksRef.current = blocks;
      if (hasExistingChart) {
        redrawRef.current?.();
        return chartTeardownRef.current || (() => {});
      }

      let containerWidth = stage.clientWidth || 900;
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

      stage.style.position = 'relative';
      stage.style.height = `${stageHeight}px`;

      const physicalFetchStart = Number(startTime);
      const physicalFetchEnd = Number(endTime);
      const requestedTimeScaleMode = (ganttConfig?.xAxis?.timeScaleMode ??
        'physical') as TimeScaleMode;
      const logicalModeAvailable =
        requestedTimeScaleMode === 'logical' &&
        Boolean(dependencyField) &&
        logicalClock.available;
      const timeScaleMode: TimeScaleMode =
        requestedTimeScaleMode === 'logical'
          ? logicalModeAvailable
            ? 'logical'
            : 'physical'
          : requestedTimeScaleMode;
      if (requestedTimeScaleMode === 'logical' && !logicalModeAvailable) {
        if (!warnedLogicalFallbackRef.current) {
          console.warn(
            '[GanttChart] Logical time requires dependency data. Falling back to physical time.'
          );
          warnedLogicalFallbackRef.current = true;
        }
      } else {
        warnedLogicalFallbackRef.current = false;
      }

      const domainStart =
        timeScaleMode === 'logical' ? logicalClock.domain[0] : physicalFetchStart;
      const domainEnd =
        timeScaleMode === 'logical' ? logicalClock.domain[1] : physicalFetchEnd;
      const domainSpan = Math.max(1, domainEnd - domainStart);
      const normalizeDisplayValue = (value: number) =>
        timeScaleMode === 'logical' ? value : Math.round(value);
      const normalizeDisplayRange = (range: ViewRange): ViewRange => {
        let start = clampNumber(Number(range.start), domainStart, domainEnd);
        let end = clampNumber(Number(range.end), domainStart, domainEnd);
        if (timeScaleMode !== 'logical') {
          start = Math.round(start);
          end = Math.round(end);
        }
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
          return { start: domainStart, end: domainEnd };
        }
        return { start, end };
      };
      const getPhysicalViewRangeForState = (displayRange: ViewRange): ViewRange => {
        if (timeScaleMode !== 'logical') {
          return {
            start: Math.round(clampNumber(displayRange.start, physicalFetchStart, physicalFetchEnd)),
            end: Math.round(clampNumber(displayRange.end, physicalFetchStart, physicalFetchEnd))
          };
        }
        let start = logicalClock.mapLogicalToPhysical(displayRange.start);
        let end = logicalClock.mapLogicalToPhysical(displayRange.end);
        start = clampNumber(start, physicalFetchStart, physicalFetchEnd);
        end = clampNumber(end, physicalFetchStart, physicalFetchEnd);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
          start = physicalFetchStart;
          end = physicalFetchEnd;
        }
        return { start: Math.round(start), end: Math.round(end) };
      };
      const ensureLogicalViewRange = (): ViewRange => {
        if (timeScaleMode !== 'logical') {
          return { start: domainStart, end: domainEnd };
        }
        const current = logicalViewRangeRef.current;
        if (current) {
          const normalized = normalizeDisplayRange(current);
          if (normalized.end > normalized.start) {
            logicalViewRangeRef.current = normalized;
            return normalized;
          }
        }
        const currentPhysical = viewRangeRef.current || {
          start: physicalFetchStart,
          end: physicalFetchEnd
        };
        const mapped = normalizeDisplayRange({
          start: normalizeDisplayValue(
            logicalClock.mapPhysicalToLogical(Number(currentPhysical.start))
          ),
          end: normalizeDisplayValue(
            logicalClock.mapPhysicalToLogical(Number(currentPhysical.end))
          )
        });
        logicalViewRangeRef.current = mapped;
        return mapped;
      };
      const getStoredViewRange = (): ViewRange => {
        if (timeScaleMode === 'logical') {
          return ensureLogicalViewRange();
        }
        return normalizeDisplayRange(
          viewRangeRef.current || { start: physicalFetchStart, end: physicalFetchEnd }
        );
      };
      const setStoredViewRange = (next: ViewRange) => {
        const normalized = normalizeDisplayRange(next);
        if (timeScaleMode === 'logical') {
          logicalViewRangeRef.current = normalized;
        } else {
          viewRangeRef.current = normalized;
        }
        viewRangeRef.current = getPhysicalViewRangeForState(normalized);
      };
      let timeScale = createTimeScale({
        mode: timeScaleMode,
        left: margin.left,
        width: innerWidth,
        logarithmic: ganttConfig?.xAxis?.logarithmic,
        fisheye: ganttConfig?.xAxis?.fisheye,
        getFisheyeFocus: () => fisheyeFocusTimeRef.current
      });

      const getViewParams = (): ViewParams => {
        const v = getStoredViewRange();
        let vs = Number(v.start);
        let ve = Number(v.end);
        if (!Number.isFinite(vs) || !Number.isFinite(ve) || ve <= vs) {
          vs = domainStart;
          ve = domainEnd;
        }
        vs = clampNumber(vs, domainStart, domainEnd);
        ve = clampNumber(ve, domainStart, domainEnd);
        if (ve <= vs) {
          vs = domainStart;
          ve = domainEnd;
        }
        const span = Math.max(1, ve - vs);
        const k = innerWidth / span;
        return { vs, ve, span, k };
      };

      const xOf = (t: number, p: ViewParams) => timeScale.xOf(Number(t), p);
      const tOf = (x: number, p: ViewParams) => timeScale.tOf(Number(x), p);

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
      stage.appendChild(webglCanvas);
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
      stage.appendChild(canvas);
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
        stage.appendChild(svgNode);
      }

      let yAxisHost: HTMLDivElement | null = yAxisRef.current;
      let yAxisGroup: d3.Selection<SVGGElement, any, null, undefined> | null = null;
      let yAxisTooltipEl: HTMLDivElement | null = null;
      let yAxisSeparatorEl: HTMLDivElement | null = null;
      const ensureYAxis = () => {
        const host = yAxisHost || yAxisRef.current;
        if (!host || yAxisGroup) return;
        yAxisHost = host;
        host.innerHTML = '';
        const axisHeight = Math.max(stageHeight, 100);
        const axisSvg = d3
          .create('svg')
          .attr('class', 'gantt-yaxis-svg')
          .attr('width', Y_AXIS_WIDTH)
          .attr('height', axisHeight)
          .style('width', `${Y_AXIS_WIDTH}px`)
          .style('height', `${axisHeight}px`)
          .style('overflow', 'visible');
        yAxisGroup = axisSvg.append('g').attr('class', 'y-labels');
        const axisNode = axisSvg.node();
        if (axisNode) {
          host.appendChild(axisNode);
        }
        yAxisSeparatorEl = document.createElement('div');
        yAxisSeparatorEl.className = 'gantt-yaxis-separator';
        yAxisSeparatorEl.style.top = '0';
        yAxisSeparatorEl.style.height = `${axisHeight}px`;
        host.appendChild(yAxisSeparatorEl);
        yAxisTooltipEl = document.createElement('div');
        yAxisTooltipEl.className = 'gantt-yaxis-tooltip';
        yAxisTooltipEl.style.cssText = 'position:fixed;display:none;font-size:12px;font-weight:500;font-family:system-ui;background:#333;color:#fff;padding:6px 10px;border-radius:4px;pointer-events:none;z-index:1000;max-width:420px;white-space:normal;line-height:1.3;box-shadow:0 2px 8px rgba(0,0,0,0.2);';
        host.appendChild(yAxisTooltipEl);
        host.style.width = `${Y_AXIS_WIDTH}px`;
        host.style.height = `${axisHeight}px`;
      };
      ensureYAxis();

      // Tooltip
      const tooltip = document.createElement('div');
      tooltip.className = 'gantt-tooltip';
      tooltip.style.display = 'none';
      stage.appendChild(tooltip);

      // SoA packing overlay
      const overlay = document.createElement('div');
      overlay.className = 'gantt-loading-overlay';
      overlay.textContent = 'Loading';
      overlay.style.cssText =
        'position:absolute;inset:0;display:none;align-items:center;justify-content:center;background:rgba(255,255,255,0.7);color:#111;font-size:14px;font-weight:600;z-index:5;pointer-events:none;';
      stage.appendChild(overlay);
      overlayRef.current = overlay;

      // Top bar: minimap + fixed x-axis (does NOT refetch; driven by viewRange)
      const minimapHost = minimapRef.current;
      const axisHost = xAxisRef.current;
      let topWidth = innerWidth + margin.left + margin.right;
      const minimapHeight = Math.max(60, minimapHost ? minimapHost.clientHeight || 60 : 60);
      const axisHeight = Math.max(32, axisHost ? axisHost.clientHeight || 32 : 32);
      const minimapTicksReserve = 18;
      const minimapMarginTop = 4;
      const minimapMarginBottom = minimapTicksReserve + 4;
      const minimapAxisY = minimapHeight - minimapTicksReserve - 2;

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
          .attr('transform', `translate(0, ${minimapAxisY})`);
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
        const nextContainerWidth = stage.clientWidth || 900;
        const nextInnerWidth = Math.max(nextContainerWidth - margin.left - margin.right, 320);
        if (Math.abs(nextInnerWidth - innerWidth) < 1 && Math.abs(nextPixelRatio - pixelRatio) < 0.01) {
          return;
        }

        pixelRatio = nextPixelRatio;
        containerWidth = nextContainerWidth;
        innerWidth = nextInnerWidth;
        stageWidth = innerWidth + margin.left + margin.right;
        topWidth = stageWidth;
        stage.style.height = `${stageHeight}px`;
        timeScale = createTimeScale({
          mode: timeScaleMode,
          left: margin.left,
          width: innerWidth,
          logarithmic: ganttConfig?.xAxis?.logarithmic,
          fisheye: ganttConfig?.xAxis?.fisheye,
          getFisheyeFocus: () => fisheyeFocusTimeRef.current
        });

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

      const isLogicalDisplay = timeScaleMode === 'logical';
      const logicalRangeCache = new WeakMap<object, { start: number; end: number }>();
      const logicalEventCache = new WeakMap<object, any>();
      const logicalLaneEventsCache = new WeakMap<object, any[]>();
      const getPhysicalStart = (item: any) =>
        Number(item?.physicalStart ?? item?.start ?? item?.timeStart ?? 0);
      const getPhysicalEnd = (item: any) =>
        Number(item?.physicalEnd ?? item?.end ?? item?.timeEnd ?? 0);
      const mapPhysicalRangeToLogicalRange = (start: number, end: number) => {
        let logicalStart = logicalClock.mapPhysicalToLogical(start);
        let logicalEnd = logicalClock.mapPhysicalToLogical(end);
        if (!Number.isFinite(logicalStart)) logicalStart = domainStart;
        if (!Number.isFinite(logicalEnd)) logicalEnd = logicalStart + 1;
        logicalStart = clampNumber(logicalStart, domainStart, domainEnd);
        logicalEnd = clampNumber(logicalEnd, domainStart, domainEnd);
        if (logicalEnd <= logicalStart) {
          logicalEnd = Math.min(domainEnd, logicalStart + 1);
        }
        if (logicalEnd <= logicalStart) {
          logicalStart = domainStart;
          logicalEnd = domainEnd;
        }
        return { start: logicalStart, end: logicalEnd };
      };
      const getDisplayRange = (item: any) => {
        const physicalStart = getPhysicalStart(item);
        const physicalEnd = getPhysicalEnd(item);
        if (!isLogicalDisplay) {
          return { start: physicalStart, end: physicalEnd };
        }
        if (!item || typeof item !== 'object') {
          return mapPhysicalRangeToLogicalRange(physicalStart, physicalEnd);
        }
        const cached = logicalRangeCache.get(item);
        if (cached) return cached;
        const itemId = String(item?.id ?? '').trim();
        const exact = itemId ? logicalClock.eventSpanById.get(itemId) : null;
        const range = exact
          ? { start: exact.start, end: exact.end }
          : mapPhysicalRangeToLogicalRange(physicalStart, physicalEnd);
        logicalRangeCache.set(item, range);
        return range;
      };
      const toDisplayEvent = (event: any) => {
        if (!isLogicalDisplay || !event || typeof event !== 'object') return event;
        const cached = logicalEventCache.get(event);
        if (cached) return cached;
        const physicalStart = getPhysicalStart(event);
        const physicalEnd = getPhysicalEnd(event);
        const range = getDisplayRange(event);
        const itemId = String(event?.id ?? '').trim();
        const exact = itemId ? logicalClock.eventSpanById.get(itemId) : null;
        const displayEvent = {
          ...event,
          start: range.start,
          end: range.end,
          physicalStart,
          physicalEnd,
          logicalStart: exact?.start ?? range.start,
          logicalEnd: exact?.end ?? range.end,
          logicalLateness: exact?.lateness ?? 0
        };
        logicalEventCache.set(event, displayEvent);
        return displayEvent;
      };
      const getLaneDisplayEvents = (lane: any): any[] => {
        const laneEvents = Array.isArray(lane?.events) ? lane.events : [];
        if (!isLogicalDisplay) return laneEvents;
        const cached = logicalLaneEventsCache.get(lane);
        if (cached) return cached;
        const mapped = laneEvents
          .map((event: any) => toDisplayEvent(event))
          .sort(
            (a: any, b: any) =>
              Number(a?.start ?? 0) - Number(b?.start ?? 0) ||
              Number(a?.end ?? 0) - Number(b?.end ?? 0)
          );
        logicalLaneEventsCache.set(lane, mapped);
        return mapped;
      };
      const overviewEvents = isLogicalDisplay
        ? chartData.map((event) => toDisplayEvent(event))
        : chartData;

      // Auxiliary overview chart (minimap): compute model from config and chart data.
      const auxCharts = ganttConfig?.extensions?.auxCharts;
      const auxEnabled = auxCharts?.enabled !== false;
      const overviewConfig = auxCharts?.overview;
      const overviewBinsCount = resolveBinCount(overviewConfig, innerWidth);
      let overviewModel: OverviewModel | null = null;
      if (auxEnabled && overviewConfig && Array.isArray(chartData) && chartData.length > 0) {
        overviewModel = computeOverviewModel(
          overviewEvents,
          domainStart,
          domainEnd,
          overviewConfig,
          overviewBinsCount
        );
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
      const parseCssColor = (color: unknown): { r: number; g: number; b: number; a: number } | null => {
        if (typeof color !== 'string') return null;
        const value = color.trim();
        if (!value) return null;
        if (value.startsWith('#')) {
          const hex = value.slice(1);
          const full =
            hex.length === 3
              ? hex
                  .split('')
                  .map((ch) => ch + ch)
                  .join('')
              : hex;
          if (full.length !== 6) return null;
          const r = parseInt(full.slice(0, 2), 16);
          const g = parseInt(full.slice(2, 4), 16);
          const b = parseInt(full.slice(4, 6), 16);
          if (![r, g, b].every(Number.isFinite)) return null;
          return { r, g, b, a: 1 };
        }
        const rgbaMatch = value.match(
          /^rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)(?:\s*,\s*([0-9.]+))?\s*\)$/i
        );
        if (!rgbaMatch) return null;
        const r = Number(rgbaMatch[1]);
        const g = Number(rgbaMatch[2]);
        const b = Number(rgbaMatch[3]);
        const a = rgbaMatch[4] == null ? 1 : Number(rgbaMatch[4]);
        if (![r, g, b, a].every(Number.isFinite)) return null;
        return { r, g, b, a };
      };
      const haveSameOpaqueColor = (left: unknown, right: unknown) => {
        const leftParsed = parseCssColor(left);
        const rightParsed = parseCssColor(right);
        if (!leftParsed || !rightParsed) {
          return String(left ?? '').trim().toLowerCase() === String(right ?? '').trim().toLowerCase();
        }
        return (
          leftParsed.r === rightParsed.r &&
          leftParsed.g === rightParsed.g &&
          leftParsed.b === rightParsed.b
        );
      };
      const withScaledOpacity = (color: unknown, scale: number) => {
        const parsed = parseCssColor(color);
        if (!parsed) return typeof color === 'string' ? color : '#999999';
        const alpha = Math.max(0, Math.min(1, parsed.a * scale));
        return `rgba(${parsed.r}, ${parsed.g}, ${parsed.b}, ${alpha})`;
      };

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
        const laneEvents = getLaneDisplayEvents(lane);
        if (isLogicalDisplay) {
          lane.renderEvents = laneEvents;
          return laneEvents;
        }
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
          eventsSortedByStart: true,
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
        const startUs = getPhysicalStart(item);
        const endUs = getPhysicalEnd(item);
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

      const buildAggregateSegmentTooltipHtml = (item: any) => {
        const hierarchyValues = Array.isArray(item?.hierarchyValues) ? item.hierarchyValues : [];
        const title = hierarchyValues.slice(-1)[0] || hierarchyValues[0] || 'Aggregate';
        const startUs = Number(getPhysicalStart(item) ?? 0);
        const endUs = Number(getPhysicalEnd(item) ?? 0);
        const durationUs =
          Number.isFinite(startUs) && Number.isFinite(endUs) ? Math.max(0, endUs - startUs) : 0;
        return `
          <div class="tooltip-grid">
            <div class="tooltip-col">
              <div class="tooltip-title">${title}</div>
              <div class="tooltip-row">
                <span class="tooltip-key">Count:</span>
                <span class="tooltip-value">${Number(item?.count ?? 0)}</span>
              </div>
              <div class="tooltip-row">
                <span class="tooltip-key">Range:</span>
                <span class="tooltip-value">${formatTimeUs(startUs)} → ${formatTimeUs(endUs)}</span>
              </div>
              <div class="tooltip-row">
                <span class="tooltip-key">Duration:</span>
                <span class="tooltip-value">${formatTimeUs(durationUs)}</span>
              </div>
            </div>
          </div>
        `;
      };

      const getHierarchyNodeDisplayExtent = (node: HierarchyNode) => {
        const events = Array.isArray(node?.aggregateSegments) ? node.aggregateSegments : [];
        let start = Number.POSITIVE_INFINITY;
        let end = Number.NEGATIVE_INFINITY;
        let representativeEvent: any = node?.representativeEvent ?? null;
        for (let i = 0; i < events.length; i += 1) {
          const event = events[i];
          const range = getDisplayRange(event);
          const eventStart = Number(range?.start);
          const eventEnd = Number(range?.end);
          if (!Number.isFinite(eventStart) || !Number.isFinite(eventEnd)) continue;
          if (eventStart < start) {
            start = eventStart;
            representativeEvent = event;
          }
          if (eventEnd > end) end = eventEnd;
        }
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
        return { start, end, representativeEvent };
      };

      const getHierarchyNodePhysicalExtent = (node: HierarchyNode) => {
        const events = Array.isArray(node?.events) ? node.events : [];
        let start = Number.POSITIVE_INFINITY;
        let end = Number.NEGATIVE_INFINITY;
        for (let i = 0; i < events.length; i += 1) {
          const event = events[i];
          const eventStart = Number(getPhysicalStart(event));
          const eventEnd = Number(getPhysicalEnd(event));
          if (!Number.isFinite(eventStart) || !Number.isFinite(eventEnd)) continue;
          if (eventStart < start) start = eventStart;
          if (eventEnd > end) end = eventEnd;
        }
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
        return { start, end };
      };

      const buildNestedTooltipHtml = (node: HierarchyNode) => {
        const hierarchyValues = Array.isArray(node?.hierarchyValues) ? node.hierarchyValues : [];
        const title = node?.hierarchyLabel || hierarchyValues.slice(-1)[0] || 'Hierarchy';
        const pathText =
          hierarchyValues.length > 1 ? hierarchyValues.slice(1).join(' > ') : hierarchyValues[0] || 'n/a';
        const physicalExtent = getHierarchyNodePhysicalExtent(node);
        const startUs = physicalExtent?.start ?? 0;
        const endUs = physicalExtent?.end ?? 0;
        const durationUs =
          physicalExtent && Number.isFinite(startUs) && Number.isFinite(endUs)
            ? Math.max(0, endUs - startUs)
            : 0;
        const childCount = node?.children?.size ?? 0;
        const eventCount = Array.isArray(node?.events) ? node.events.length : 0;
        const stateLabel = node?.expandable ? (node?.expanded ? 'Expanded' : 'Collapsed') : 'Leaf';
        return `
          <div class="tooltip-grid">
            <div class="tooltip-col">
              <div class="tooltip-title">${title}</div>
              <div class="tooltip-row">
                <span class="tooltip-key">Path:</span>
                <span class="tooltip-value">${pathText || 'n/a'}</span>
              </div>
              <div class="tooltip-row">
                <span class="tooltip-key">State:</span>
                <span class="tooltip-value">${stateLabel}</span>
              </div>
              <div class="tooltip-row">
                <span class="tooltip-key">Children:</span>
                <span class="tooltip-value">${childCount}</span>
              </div>
              <div class="tooltip-row">
                <span class="tooltip-key">Events:</span>
                <span class="tooltip-value">${eventCount}</span>
              </div>
              <div class="tooltip-row">
                <span class="tooltip-key">Range:</span>
                <span class="tooltip-value">${formatTimeUs(startUs)} → ${formatTimeUs(endUs)}</span>
              </div>
              <div class="tooltip-row">
                <span class="tooltip-key">Duration:</span>
                <span class="tooltip-value">${formatTimeUs(durationUs)}</span>
              </div>
            </div>
          </div>
        `;
      };

      const drawNestedBlock = (
        block: Block,
        p: ViewParams,
        lanePositions: Map<string, { y: number; h: number }>
      ) => {
        if (!block.nestedTree || block.detailY0 == null || block.detailY1 == null) return;
        block.nestedItems = [];

        const chartLeft = margin.left;
        const chartRight = margin.left + innerWidth;
        let contentX1 = chartLeft;
        let contentX2 = chartRight;
        const merged = processAggregates.get(block.hierarchy1) || [];
        let leftmostPx = Infinity;
        let rightmostPx = -Infinity;
        for (let i = 0; i < merged.length; i++) {
          const displayRange = getDisplayRange(merged[i]);
          const x1Raw = xOf(displayRange.start, p);
          const x2Raw = xOf(displayRange.end, p);
          if (x2Raw < chartLeft || x1Raw > chartRight || x2Raw - x1Raw < 0.5) continue;
          const x1 = Math.floor(x1Raw);
          const endPx = Math.max(x1 + 1, Math.ceil(x2Raw));
          if (x1 < leftmostPx) leftmostPx = x1;
          if (endPx > rightmostPx) rightmostPx = endPx;
        }
        if (Number.isFinite(leftmostPx) && rightmostPx > leftmostPx) {
          contentX1 = Math.max(chartLeft, leftmostPx);
          contentX2 = Math.min(chartRight, rightmostPx);
        }
        if (contentX2 - contentX1 < 2) {
          const re = getHierarchyNodeDisplayExtent(block.nestedTree);
          if (re) {
            const x1R = xOf(re.start, p), x2R = xOf(re.end, p);
            contentX1 = Math.max(chartLeft, Math.min(x1R, x2R));
            contentX2 = Math.min(chartRight, Math.max(x1R, x2R));
          }
          if (contentX2 - contentX1 < 2) { contentX1 = chartLeft; contentX2 = chartRight; }
        }
        const parentDisplay = {
          x1: Math.floor(contentX1),
          x2: Math.max(Math.ceil(contentX2), Math.floor(contentX1) + 1),
          y0: block.detailY0,
          y1: block.detailY1
        };

        const wi = 2, wx = parentDisplay.x1 + wi, wy = parentDisplay.y0 + wi;
        const ww = Math.max(0, parentDisplay.x2 - parentDisplay.x1 - 2 * wi);
        const wh = Math.max(0, parentDisplay.y1 - parentDisplay.y0 - 2 * wi);
        const procMeta = { type: 'process' as const, hierarchy1: block.hierarchy1, hierarchyValues: [String(block.hierarchy1)] };
        const wrapColor = merged.length ? colorFor(merged[0], `proc-${block.hierarchy1}`, procMeta) : 'rgba(0,0,0,0.03)';
        ctx.save();
        ctx.fillStyle = wrapColor;
        ctx.fillRect(wx, wy, ww, wh);
        ctx.strokeStyle = 'rgba(17,24,39,0.08)';
        ctx.lineWidth = 1;
        ctx.strokeRect(wx + 0.5, wy + 0.5, ww - 1, wh - 1);
        ctx.font = '11px system-ui';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = pickTextColor(wrapColor);
        ctx.fillText(`− ${hierarchy1FieldDisplay}: ${block.hierarchy1}`, wx + 8, wy + 10);
        ctx.restore();

        const drawNestedLeafLevels = (node: HierarchyNode, hierarchyLabel: string, overrideY0?: number, overrideHeight?: number) => {
          if (!node.display) return;
          const clipSegments =
            Array.isArray(node.displaySegments) && node.displaySegments.length > 0
              ? node.displaySegments
              : [node.display];
          const leafLanes = getNestedLeafLanesForNode(node);
          if (leafLanes.length === 0) return;

          const contentY0 = overrideY0 ?? (node.display.y0 + 14); // 14 is base header height
          const contentHeight = overrideHeight ?? (node.display.y1 - contentY0 - nestedLevelInset);
          const contentY1 = contentY0 + contentHeight;
          if (contentHeight < 2) return;

          const laneSlotHeight = contentHeight / Math.max(leafLanes.length, 1);
          for (let laneIndex = 0; laneIndex < leafLanes.length; laneIndex += 1) {
            const leafLane = leafLanes[laneIndex];
            const laneY0 = contentY0 + laneIndex * laneSlotHeight;
            const laneY1 =
              laneIndex === leafLanes.length - 1
                ? contentY1
                : contentY0 + (laneIndex + 1) * laneSlotHeight;
            const laneH = laneY1 - laneY0;
            if (laneH < 2) continue;

            const barY = laneY0 + Math.min(1, lanePadding);
            const barH = Math.max(2, laneH - Math.min(2, lanePadding * 2));
            lanePositions.set(leafLane.laneKey, { y: barY, h: barH });

            const trackMeta = {
              type: 'lane',
              hierarchy1: leafLane.hierarchy1,
              hierarchy2: leafLane.hierarchy2,
              hierarchyPath: leafLane.hierarchyPath,
              hierarchyValues: leafLane.hierarchyValues,
              level: leafLane.level
            };
            const renderEvents = getLaneRenderEvents(
              leafLane.nestedLane,
              leafLane.laneKey,
              leafLane.hierarchy2,
              trackMeta,
              p
            );

            let coveredEnd = -Infinity;
            for (let eventIndex = 0; eventIndex < renderEvents.length; eventIndex += 1) {
              const ev = renderEvents[eventIndex];
              const displayRange = getDisplayRange(ev);
              const x1Raw = xOf(displayRange.start, p);
              const x2Raw = xOf(displayRange.end, p);
              const itemSegments: Array<{ x1: number; x2: number; y0: number; y1: number }> = [];
              const barColor = colorFor(ev, leafLane.hierarchy2, trackMeta);
              for (let segmentIndex = 0; segmentIndex < clipSegments.length; segmentIndex += 1) {
                const clip = clipSegments[segmentIndex];
                const drawLeft = Math.max(clip.x1, Math.min(x1Raw, x2Raw));
                const drawRight = Math.min(clip.x2, Math.max(x1Raw, x2Raw));
                if (
                  !Number.isFinite(drawLeft) ||
                  !Number.isFinite(drawRight) ||
                  drawRight < drawLeft
                ) {
                  continue;
                }

                const x1 = Math.floor(drawLeft);
                const endPx = Math.max(x1 + 1, Math.ceil(drawRight));
                const drawX = Math.max(x1, coveredEnd);
                if (drawX >= endPx) continue;

                ctx.fillStyle = barColor;
                ctx.fillRect(drawX, barY, endPx - drawX, barH);
                itemSegments.push({ x1: drawX, x2: endPx, y0: barY, y1: barY + barH });
                coveredEnd = endPx;
              }

              if (itemSegments.length === 0) continue;
              const labelTarget = itemSegments.reduce((best, segment) =>
                segment.x2 - segment.x1 > best.x2 - best.x1 ? segment : best
              );

              if (ev?.kind === 'summary') {
                const label = `${ev.count ?? 0}`;
                if (labelTarget.x2 - labelTarget.x1 >= 22 && barH >= 10) {
                  ctx.save();
                  ctx.font = '10px system-ui';
                  ctx.textBaseline = 'middle';
                  ctx.fillStyle = 'rgba(0,0,0,0.6)';
                  ctx.fillText(label, labelTarget.x1 + 4, barY + barH / 2);
                  ctx.restore();
                }
              } else {
                const label = (ev?.name || ev?.label || hierarchyLabel || '').toString();
                const minLabelPx = layoutConfig?.label?.minBarLabelPx ?? 90;
                if (label && labelTarget.x2 - labelTarget.x1 >= minLabelPx && barH >= 10) {
                  ctx.save();
                  ctx.beginPath();
                  ctx.rect(labelTarget.x1, barY, labelTarget.x2 - labelTarget.x1, barH);
                  ctx.clip();
                  ctx.font = '11px system-ui';
                  ctx.textBaseline = 'middle';
                  ctx.fillStyle = pickTextColor(barColor);
                  ctx.fillText(label, labelTarget.x1 + 4, barY + barH / 2);
                  ctx.restore();
                }
              }

              block.nestedItems.push({
                ...ev,
                kind: ev?.kind === 'summary' ? 'summary' : 'nestedEvent',
                hierarchy1: leafLane.hierarchy1,
                hierarchy2: leafLane.hierarchy2,
                hierarchyPath: leafLane.hierarchyPath,
                hierarchyValues: leafLane.hierarchyValues,
                level: leafLane.level,
                laneKey: leafLane.laneKey,
                nestedLane: leafLane.nestedLane,
                display: itemSegments[0],
                displaySegments: itemSegments
              });
            }
          }
        };

          const layoutDisplayWithinParent = (
          node: HierarchyNode,
          parentDisplay: { x1: number; x2: number; y0: number; y1: number }
        ) => {
          const extent = getHierarchyNodeDisplayExtent(node);
          if (!extent) return null;
          const x1Raw = xOf(extent.start, p);
          const x2Raw = xOf(extent.end, p);
          
          // Use parent display directly for clamping to avoid inset shrinking the visual extent incorrectly
          const drawLeft = Math.max(parentDisplay.x1, Math.min(x1Raw, x2Raw));
          const drawRight = Math.min(parentDisplay.x2, Math.max(x1Raw, x2Raw));
          
          if (drawRight < drawLeft) return null;
          const px1 = Math.floor(drawLeft);
          const px2 = Math.max(px1 + 1, Math.ceil(drawRight));

          const y0 = parentDisplay.y0;
          const y1 = parentDisplay.y1;
          const barH = y1 - y0;
          if (barH < 2) return null;

          const displaySegments = (Array.isArray(node.aggregateSegments) ? node.aggregateSegments : [])
            .map((segment, sourceIndex) => {
              const sx1Raw = xOf(Number(segment?.start ?? 0), p);
              const sx2Raw = xOf(Number(segment?.end ?? 0), p);
              const sDrawLeft = Math.max(px1, Math.min(sx1Raw, sx2Raw));
              const sDrawRight = Math.min(px2, Math.max(sx1Raw, sx2Raw));
              if (
                !Number.isFinite(sDrawLeft) ||
                !Number.isFinite(sDrawRight) ||
                sDrawRight < sDrawLeft
              ) {
                return null;
              }
              const sx1 = Math.floor(sDrawLeft);
              const sx2 = Math.max(sx1 + 1, Math.ceil(sDrawRight));
              return { x1: sx1, x2: sx2, y0, y1, sourceIndex };
            })
            .filter(Boolean) as Array<{ x1: number; x2: number; y0: number; y1: number; sourceIndex: number }>;

          if (displaySegments.length === 0) {
            return null;
          }
          const finalX1 = Math.min(...displaySegments.map((segment) => segment.x1));
          const finalX2 = Math.max(...displaySegments.map((segment) => segment.x2));
          return { display: { x1: finalX1, x2: finalX2, y0, y1 }, displaySegments };
        };

        const drawHierarchyNodeFrame = (
          node: HierarchyNode,
          display: { x1: number; x2: number; y0: number; y1: number },
          displaySegments: Array<{ x1: number; x2: number; y0: number; y1: number; sourceIndex: number }>,
          fillColor: string,
          textColorSource: string,
          hierarchyLabel: string,
          hasChildren: boolean,
          expandable: boolean,
          showLeafLevels: boolean,
          getSegmentExpanded: (segIdx: number) => boolean
        ) => {
          const barH = display.y1 - display.y0;
          ctx.save();
          ctx.fillStyle = fillColor;
          displaySegments.forEach((segment) => {
            ctx.fillRect(segment.x1, segment.y0, segment.x2 - segment.x1, barH);
          });
          ctx.restore();

          const strokeStyle = 'rgba(17, 24, 39, 0.18)';
          ctx.strokeStyle = strokeStyle;
          ctx.lineWidth = 1;
          displaySegments.forEach((segment) => {
            ctx.strokeRect(
              segment.x1 + 0.5,
              segment.y0 + 0.5,
              Math.max(0, segment.x2 - segment.x1 - 1),
              Math.max(0, barH - 1)
            );
          });

          const labelOffset = expandable ? 14 : 4;
          const labelMinPx = layoutConfig?.label?.minBarLabelPx ?? 90;
          const textColor = pickTextColor(textColorSource);

          if (barH >= 10) {
          displaySegments.forEach((segment, segIdx) => {
            const segmentWidth = segment.x2 - segment.x1;
            const segExpanded = getSegmentExpanded(segment.sourceIndex ?? segIdx);
            const headerHeight = segExpanded ? 14 : Math.max(14, barH);
            const textY = display.y0 + headerHeight / 2;

            if (expandable && segmentWidth >= 14) {
              ctx.save();
              ctx.font = '10px system-ui';
              ctx.textBaseline = 'middle';
              ctx.fillStyle = textColor;
              ctx.fillText(segExpanded ? '−' : '+', segment.x1 + 4, textY);
              ctx.restore();
            }

            if (hierarchyLabel && segmentWidth >= Math.max(labelMinPx, labelOffset + 20)) {
              ctx.save();
              ctx.beginPath();
              ctx.rect(segment.x1, display.y0, segmentWidth, headerHeight);
              ctx.clip();
              ctx.font = '11px system-ui';
              ctx.textBaseline = 'middle';
              ctx.fillStyle = textColor;
              ctx.fillText(hierarchyLabel, segment.x1 + labelOffset, textY);
              ctx.restore();
            }
          });
          }
        };

        const drawNode = (
          node: HierarchyNode,
          parentDisplay: { x1: number; x2: number; y0: number; y1: number }
        ) => {
          const extent = getHierarchyNodeDisplayExtent(node);
          if (!extent) {
            node.display = null;
            node.displaySegments = [];
            return;
          }

          const hierarchyValues = getHierarchyValuesForNode(node);
          const expandKey = getNestedExpandKey(node);
          const hasChildren = node.children.size > 0;
          const hasLeaf = Boolean(node.levelMap && node.levelMap.size > 0);
          const expandable = hasChildren || hasLeaf;
          const expanded = isNestedNodeExpanded(node);
          const showLeafLevels = hasLeaf && expanded;
          const layout = layoutDisplayWithinParent(node, parentDisplay);
          if (!layout) {
            node.display = null;
            node.displaySegments = [];
            return;
          }
          const { display, displaySegments } = layout;

          const hierarchyLabel = getHierarchyNodeLabel(
            block.hierarchy1,
            node.fullPath,
            node.fullPath.join('|') === String(block.hierarchy1)
          );
          const trackKey = hierarchyValues.slice(1).join('|') || hierarchyValues[0];
          const trackMeta = {
            type: 'group',
            hierarchy1: block.hierarchy1,
            hierarchy2: trackKey,
            hierarchyPath: hierarchyValues.slice(1),
            hierarchyValues,
            level: 0
          };
          const representativeEvent = extent.representativeEvent ?? node.representativeEvent ?? node.events[0];
          const getNodeBarColor = (targetNode: HierarchyNode) => {
            const targetHierarchyValues = getHierarchyValuesForNode(targetNode);
            const targetTrackKey =
              targetHierarchyValues.slice(1).join('|') || targetHierarchyValues[0];
            const targetTrackMeta = {
              type: 'group',
              hierarchy1: block.hierarchy1,
              hierarchy2: targetTrackKey,
              hierarchyPath: targetHierarchyValues.slice(1),
              hierarchyValues: targetHierarchyValues,
              level: 0
            };
            const targetExtent = getHierarchyNodeDisplayExtent(targetNode);
            const targetRepresentativeEvent =
              targetExtent?.representativeEvent ?? targetNode.representativeEvent ?? targetNode.events[0];
            return colorFor(
              targetRepresentativeEvent ?? { hierarchy1: block.hierarchy1, hierarchy2: targetTrackKey },
              targetTrackKey,
              targetTrackMeta
            );
          };
          const barColor = getNodeBarColor(node);
          const shouldFadeParent = getSortedHierarchyChildren(node).some((child) =>
            haveSameOpaqueColor(barColor, getNodeBarColor(child))
          );
          const parentFillColor = shouldFadeParent ? withScaledOpacity(barColor, 0.7) : barColor;

          node.kind = 'nestedHierarchy';
          node.hierarchy1 = block.hierarchy1;
          node.hierarchyValues = hierarchyValues;
          node.hierarchyLabel = hierarchyLabel;
          node.expandKey = expandKey;
          node.expandable = expandable;
          node.expanded = expanded;
          node.representativeEvent = representativeEvent ?? null;
          node.display = display;
          node.displaySegments = displaySegments;

          const getSegmentExpanded = (segIdx: number) =>
            expandedHierarchyKeySet.has(`${expandKey}|${segIdx}`);
          const isBlockRoot = node === block.nestedTree;
          if (!isBlockRoot) {
            drawHierarchyNodeFrame(
              node,
              display,
              displaySegments,
              parentFillColor,
              barColor,
              hierarchyLabel,
              hasChildren,
              expandable,
              showLeafLevels,
              getSegmentExpanded
            );
            block.nestedItems.push(node);
          }

          const rootExpandedByTopLevel = isBlockRoot && expandedHierarchyKeySet.has(expandKey);
          const expandedSegments = rootExpandedByTopLevel
            ? [{ x1: display.x1, x2: display.x2, y0: display.y0, y1: display.y1, sourceIndex: 0 }]
            : displaySegments.filter((segment, i) =>
                expandedHierarchyKeySet.has(`${expandKey}|${segment.sourceIndex ?? i}`)
              );
          const leafLanes = showLeafLevels ? getNestedLeafLanesForNode(node) : [];
          const leafContentHeight = leafLanes.length > 0 ? leafLanes.length * laneHeight : 0;

          for (const seg of expandedSegments) {
            ctx.save();
            ctx.beginPath();
            ctx.rect(seg.x1, display.y0 + 14, seg.x2 - seg.x1, Math.max(0, display.y1 - display.y0 - 14));
            ctx.clip();

            let currentY0 = display.y0 + 14;
            if (showLeafLevels && leafContentHeight > 0) {
              currentY0 += nestedLevelInset;
              drawNestedLeafLevels(node, hierarchyLabel, currentY0, leafContentHeight);
              currentY0 += leafContentHeight;
            }
            if (hasChildren && expanded) {
              currentY0 += nestedLevelInset;
              const children = getSortedHierarchyChildren(node);
              for (let i = 0; i < children.length; i += 1) {
                const child = children[i];
                const childHeight = measureNestedNodeBoxHeight(child);
                const childDisplay = {
                  x1: Math.max(display.x1 + nestedLevelInset, seg.x1),
                  x2: Math.min(display.x2 - nestedLevelInset, seg.x2),
                  y0: currentY0,
                  y1: currentY0 + childHeight
                };
                drawNode(child, childDisplay);
                currentY0 += childHeight + (i < children.length - 1 ? nestedLevelInset : 0);
              }
            }
            ctx.restore();
          }
        };

        drawNode(block.nestedTree, parentDisplay);

        if (block.nestedOverflowLabel) {
          ctx.save();
          ctx.font = '10px system-ui';
          ctx.textBaseline = 'bottom';
          ctx.fillStyle = 'rgba(17, 24, 39, 0.7)';
          ctx.fillText(block.nestedOverflowLabel, margin.left + 4, block.detailY1 + nestedLevelInset - 2, Math.max(20, innerWidth - 8));
          ctx.restore();
        }
      };

      const drawBars = () => {
        const blocks = chartBlocksRef.current ?? [];
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
        const hasSoAKeyOverlap = Boolean(
          renderSoA?.chunks?.some((chunk) =>
            chunk.bundle.meta.laneKeys.some((key) => lanePositions.has(String(key)))
          )
        );
        const useWebGL = Boolean(
          activeRenderer && renderSoA && webglEnabled && hasSoAKeyOverlap && !isLogicalDisplay
        );
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

        const drawProcessAggregateBars = (hierarchy1: string, headerY0: number, merged: any[]) => {
          const y = headerY0 + 2;
          const h = headerHeight - 4;
          const leftBound = margin.left;
          const rightBound = margin.left + innerWidth;
          let collapsedCoveredEnd = -Infinity;
          for (let itemIndex = 0; itemIndex < merged.length; itemIndex += 1) {
            const item = merged[itemIndex];
            if (budgetExceeded) return;
            renderedPrimitives += 1;
            if (renderedPrimitives > maxPrimitives) {
              budgetExceeded = true;
              return;
            }
            const displayRange = getDisplayRange(item);
            const x1Raw = xOf(displayRange.start, p);
            const x2Raw = xOf(displayRange.end, p);
            if (x2Raw < leftBound || x1Raw > rightBound) continue;
            if (x2Raw - x1Raw < 0.5) continue;
            const x1 = Math.floor(x1Raw);
            const endPx = Math.max(x1 + 1, Math.ceil(x2Raw));
            const drawX = Math.max(x1, collapsedCoveredEnd);
            if (drawX >= endPx) continue;
            ctx.fillStyle = colorFor(item, `proc-${hierarchy1}`, {
              type: 'process',
              hierarchy1,
              hierarchyValues: [String(hierarchy1)]
            });
            ctx.fillRect(drawX, y, endPx - drawX, h);
            collapsedCoveredEnd = endPx;
          }
        };

        for (let i = startIdx; i < blocks.length; i++) {
          if (budgetExceeded) break;
          const block = blocks[i];
          if (block.y0 > yMax) break;

          const forkGroup = hasForkStructure
            ? forkGroupByBlockIndex[i]
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
            drawProcessAggregateBars(block.hierarchy1, block.headerY0, merged);
            continue;
          }

          if (block.displayMode === 'nested') {
            drawNestedBlock(block, p, lanePositions);
            continue;
          }

          if (merged.length > 0) {
            drawProcessAggregateBars(block.hierarchy1, block.headerY0, merged);
          }

          // Expanded: draw a detail box (width based on process time extent), then draw lane events inside (timeline aligned, no indent).
          if (merged.length > 0) {
            const minT = getDisplayRange(merged[0]).start;
            const maxT = getDisplayRange(merged[merged.length - 1]).end;
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
            for (let laneIndex = 0; laneIndex < block.lanes.length; laneIndex += 1) {
              const lane: any = block.lanes[laneIndex];
              if (lane.type !== 'lane' && lane.type !== 'group') continue;
              if (lane.y1 < yMin || lane.y0 > yMax) continue;

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
                const displayRange = getDisplayRange(ev);
                const tStart = displayRange.start;
                const tEnd = displayRange.end;
                const isSummary = ev?.kind === 'summary';
                const x1Raw = xOf(tStart, p);
                const x2Raw = xOf(tEnd, p);
                if (x2Raw < boxX1 || x1Raw > boxX1 + boxW) return;
                // Skip sub-pixel bars to avoid phantom strips at axis boundaries
                // if (x2Raw - x1Raw < 0.1) return;

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
            }
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

          const marginTopMinimap = minimapMarginTop;
          const marginBottomMinimap = minimapMarginBottom;

          if (overviewModel) {
            drawOverviewChart(minimapCtx, overviewModel, {
              width: topWidth,
              height: minimapHeight,
              marginLeft: margin.left,
              marginRight: margin.right,
              marginTop: marginTopMinimap,
              marginBottom: marginBottomMinimap,
              fillStyle: 'rgba(76, 120, 168, 0.6)',
              palette:
                Array.isArray(colorConfig?.palette) && colorConfig.palette.length > 0
                  ? colorConfig.palette
                  : defaultPalette
            });
          }

          let leftPx = margin.left + ((p.vs - domainStart) / domainSpan) * innerWidth;
          let widthPx = ((p.ve - p.vs) / domainSpan) * innerWidth;
          leftPx = clampNumber(leftPx, margin.left, margin.left + innerWidth);
          widthPx = clampNumber(widthPx, 2, margin.left + innerWidth - leftPx);
          minimapWindowEl.style.top = `${marginTopMinimap}px`;
          minimapWindowEl.style.height = `${Math.max(0, minimapHeight - marginTopMinimap - marginBottomMinimap)}px`;
          minimapWindowEl.style.left = `${leftPx}px`;
          minimapWindowEl.style.width = `${widthPx}px`;
        }

        const axisTimeFormat =
          ganttConfig?.xAxis?.timeFormat === 'full' ? formatTimeUsFull : formatTimeUs;
        const axisTickFormat = (value: number) =>
          timeScaleMode === 'logical' ? `${Math.round(value)}` : axisTimeFormat(value);

        // Minimap ticks for the full current domain
        if (minimapAxisGroup) {
          const tickCount = Math.max(4, Math.floor(innerWidth / 160));
          const scale = d3
            .scaleLinear()
            .domain([domainStart, domainEnd])
            .range([margin.left, margin.left + innerWidth]);
          minimapAxisGroup.attr('transform', `translate(0, ${minimapAxisY})`);
          minimapAxisGroup.call(
            d3
              .axisBottom(scale)
              .ticks(tickCount)
              .tickFormat((d) => axisTickFormat(d as number))
              .tickSizeOuter(0)
              .tickSizeInner(4)
              .tickPadding(2)
          );
          minimapAxisGroup
            .selectAll('text')
            .style('font-size', '10px')
            .style('fill', '#6b7280')
            .style('font-family', 'system-ui')
            .style('font-variant-numeric', 'tabular-nums');
          minimapAxisGroup.selectAll('path,line').style('stroke', '#d1d5db');
        }

        // Fixed x-axis (zoom target)
        if (axisGroup) {
          const tickCount = Math.max(4, Math.floor(innerWidth / 140));
          const scale = timeScale.d3Scale(p);
          axisGroup.call(
            d3
              .axisBottom(scale as any)
              .ticks(tickCount)
              .tickFormat((d) => axisTickFormat(d as number))
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
        if (!dependencyEnabled || !dependencyField) return;
        const dependencyConfig = ganttConfig?.dependencies || GANTT_CONFIG.dependencies || {};
        const selectionId = String(viewStateRef.current?.selection ?? '').trim() || null;
        const amount = dependencyConfig.amount ?? '1hop';
        const persistence = dependencyConfig.persistence ?? 'onClick';
        const connector = dependencyConfig.connector ?? 'arrow';
        const drawingStyle = dependencyConfig.drawingStyle ?? 'spline';
        const strokeColor = dependencyConfig.strokeColor ?? 'rgba(59,130,246,0.45)';
        const strokeWidth = Math.max(0.5, Number(dependencyConfig.strokeWidth ?? 1.5));
        const arrowSize = Math.max(2, Number(dependencyConfig.arrowSize ?? 6));
        const maxEdges = Number(dependencyConfig.maxEdges ?? 200);

        if (persistence === 'toggle' && !viewStateRef.current?.dependenciesVisible) return;
        if (persistence === 'onClick' && !selectionId) return;

        const getLaneKey = (event: any) =>
          String(
            event?.laneKey ??
              buildHierarchyLaneKey(
                Array.isArray(event?.hierarchyValues) && event.hierarchyValues.length > 0
                  ? event.hierarchyValues
                  : [event?.hierarchy1, event?.hierarchy2],
                event?.level ?? 0
              )
          );
        const p = getViewParams();
        const xMin = margin.left - 40;
        const xMax = margin.left + innerWidth + 40;
        const edgeData = getVisibleEdges(dependencyIndex, amount, selectionId, maxEdges)
          .map((edge) => {
            const source = dependencyIndex.eventById.get(edge.sourceId);
            const target = dependencyIndex.eventById.get(edge.targetId);
            if (!source || !target) return null;
            const sourceLane = lastLanePositions.get(getLaneKey(source));
            const targetLane = lastLanePositions.get(getLaneKey(target));
            if (!sourceLane || !targetLane) return null;
            const sourceRange = getDisplayRange(source);
            const targetRange = getDisplayRange(target);
            const sx = xOf(sourceRange.start, p);
            const tx = xOf(targetRange.start, p);
            if ((sx < xMin && tx < xMin) || (sx > xMax && tx > xMax)) return null;
            const sy = sourceLane.y + sourceLane.h / 2;
            const ty = targetLane.y + targetLane.h / 2;
            return {
              ...edge,
              d: buildDependencyPath(drawingStyle, sx, sy, tx, ty)
            };
          })
          .filter(Boolean) as Array<{ sourceId: string; targetId: string; d: string }>;
        if (edgeData.length === 0) return;

        let markerRef: string | null = null;
        if (connector === 'arrow') {
          const markerId = 'gantt-dependency-arrow';
          markerRef = `url(#${markerId})`;
          dependencyLayer
            .append('defs')
            .append('marker')
            .attr('id', markerId)
            .attr('viewBox', `0 0 ${arrowSize} ${arrowSize}`)
            .attr('refX', arrowSize - 1)
            .attr('refY', arrowSize / 2)
            .attr('markerWidth', arrowSize)
            .attr('markerHeight', arrowSize)
            .attr('markerUnits', 'userSpaceOnUse')
            .attr('orient', 'auto')
            .append('path')
            .attr('d', `M0,0 L0,${arrowSize} L${arrowSize},${arrowSize / 2} z`)
            .attr('fill', strokeColor);
        }

        dependencyLayer
          .selectAll('path.gantt-dependency-path')
          .data(edgeData)
          .join('path')
          .attr('class', 'gantt-dependency-path')
          .attr('d', (edge: any) => edge.d)
          .attr('fill', 'none')
          .attr('stroke', strokeColor)
          .attr('stroke-width', strokeWidth)
          .attr('marker-end', markerRef);
      };

      const renderYLabels = () => {
        const blocks = chartBlocksRef.current ?? [];
        ensureYAxis();
        if (!yAxisGroup) return;
        if (yAxisHost) {
          yAxisHost.style.height = `${stageHeight}px`;
          const yAxisSvg = yAxisHost.querySelector('svg');
          if (yAxisSvg) {
            yAxisSvg.setAttribute('height', String(stageHeight));
            yAxisSvg.style.setProperty('height', `${stageHeight}px`);
          }
        }
        const yMin = container.scrollTop;
        const yMax = yMin + container.clientHeight;

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
        if (yAxisSeparatorEl) {
          yAxisSeparatorEl.style.top = '0px';
          yAxisSeparatorEl.style.height = `${stageHeight}px`;
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
            const groupY = startBlock.y0;
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
              y: parentBlock.headerY0,
              h: headerHeight,
              fill: FORK_HEADER_FILL_Y
            });
          });
        }

        for (let i = startIdx; i < blocks.length; i++) {
          const block = blocks[i];
          if (block.y0 > yMax) break;

          const forkGroupY = hasForkStructure
            ? forkGroupByBlockIndex[i]
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
                y: block.y0,
                h: block.y1 - block.y0,
                fill: blockFill
              });
            } else {
              bgRects.push({
                key: `bg-proc-${block.hierarchy1}`,
                y: block.headerY0,
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
            y: block.headerY0 + headerHeight / 2,
            fontSize: processFit.fontSize,
            fontWeight: procFw,
            indent: 0,
            fullText: processLabelFull,
            symbol: procSymbol || undefined,
            symbolWidth: procSymbolW || undefined
          });

          if (block.expanded && block.displayMode === 'rows') {
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
                  y: lane.y0 + (lane.y1 - lane.y0) / 2,
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
                  y: lane.y0 + (lane.y1 - lane.y0) / 2,
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
        visibleState.endIndex = (chartBlocksRef.current ?? []).length;
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

      // Scroll-only redraw: bars + y-labels depend on scroll; topbar/deps do not.
      const redrawForScroll = () => {
        const renderStart = performance.now();
        updateVisibleWindow();
        drawBars();
        renderYLabels();
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

      // Lightweight redraw used for hover-only updates (avoid relayout/axis work on mousemove).
      const redrawBarsOnly = () => {
        updateVisibleWindow();
        drawBars();
      };

      // Expose redraw for viewRange updates (zoom/pan)
      redrawRef.current = redraw;
      onResize = resizeScene;

      // Initial render
      redraw();

      const findBlockByY = (y: number) => {
        const blocks = chartBlocksRef.current ?? [];
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
          const bucket = processAggregates.get(block.hierarchy1) || [];
          let lo = 0;
          let hi = bucket.length - 1;
          while (lo <= hi) {
            const mid = Math.floor((lo + hi) / 2);
            const item = bucket[mid];
            const displayRange = getDisplayRange(item);
            const start = displayRange.start;
            const end = displayRange.end;
            if (time < start) hi = mid - 1;
            else if (time > end) lo = mid + 1;
            else return { area: 'process', block, lane: null, item };
          }
          return { area: 'header', block, lane: null, item: null };
        }

        // Detail lanes (expanded)
        if (
          !block.expanded ||
          block.detailY0 == null ||
          block.detailY1 == null ||
          y < block.detailY0 ||
          y > block.detailY1
        ) {
          return { area: 'header', block, lane: null, item: null };
        }

        if (block.displayMode === 'nested') {
          let bestHit: any = null;
          let bestArea = Number.POSITIVE_INFINITY;
          for (let idx = block.nestedItems.length - 1; idx >= 0; idx -= 1) {
            const item = block.nestedItems[idx];
            const segments = Array.isArray(item?.displaySegments) && item.displaySegments.length > 0
              ? item.displaySegments
              : item?.display
                ? [item.display]
                : [];
            for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
              const raw = segments[segmentIndex];
              if (!raw) continue;
              const segX1 = raw.x1 ?? (raw as any).sDrawLeft;
              const segX2 = raw.x2 ?? (raw as any).sDrawRight;
              const segY0 = raw.y0;
              const segY1 = raw.y1;
              if (segX1 == null || segX2 == null || segY0 == null || segY1 == null) continue;
              if (x >= segX1 && x <= segX2 && y >= segY0 && y <= segY1) {
                const area = Math.max(1, segX2 - segX1) * Math.max(1, segY1 - segY0);
                if (area < bestArea) {
                  bestArea = area;
                  bestHit = {
                    area: 'nested',
                    block,
                    lane: item?.nestedLane ?? null,
                    item,
                    segmentIndex,
                    segmentSourceIndex: (raw as any).sourceIndex ?? segmentIndex
                  };
                }
              }
            }
          }
          return bestHit ?? { area: 'nested', block, lane: null, item: null };
        }

        if (!block.lanes) {
          return { area: 'lane', block, lane: null, item: null };
        }

        const lane = block.lanes.find(
          (l: any) => (l.type === 'lane' || l.type === 'group') && y >= l.y0 && y <= l.y1
        );
        if (!lane) return { area: 'lane', block, lane: null, item: null };

        const events = lane.renderEvents || getLaneDisplayEvents(lane) || [];
        let lo2 = 0;
        let hi2 = events.length - 1;
        while (lo2 <= hi2) {
          const mid = Math.floor((lo2 + hi2) / 2);
          const item = events[mid];
          const displayRange = getDisplayRange(item);
          const start = displayRange.start;
          const end = displayRange.end;
          if (time < start) hi2 = mid - 1;
          else if (time > end) lo2 = mid + 1;
          else return { area: 'lane', block, lane, item };
        }
        return { area: 'lane', block, lane, item: null };
      };

      const setTrackedFisheyeFocus = (x: number) => {
        if (timeScaleMode !== 'fisheye') return false;
        if (ganttConfig?.xAxis?.fisheye?.focusTime != null) return false;
        if (x < margin.left || x > margin.left + innerWidth) return false;
        const p = getViewParams();
        const nextFocus = p.vs + ((x - margin.left) / innerWidth) * p.span;
        if (!Number.isFinite(nextFocus)) return false;
        const prevFocus = fisheyeFocusTimeRef.current;
        const minDelta = p.span / Math.max(innerWidth, 1);
        if (prevFocus != null && Math.abs(prevFocus - nextFocus) <= minDelta) return false;
        fisheyeFocusTimeRef.current = nextFocus;
        if (viewStateRef.current) {
          viewStateRef.current = {
            ...viewStateRef.current,
            fisheyeFocusTime: nextFocus
          };
        }
        return true;
      };
      const clearTrackedFisheyeFocus = () => {
        if (timeScaleMode !== 'fisheye') return false;
        if (ganttConfig?.xAxis?.fisheye?.focusTime != null) return false;
        if (fisheyeFocusTimeRef.current == null) return false;
        fisheyeFocusTimeRef.current = null;
        if (viewStateRef.current) {
          viewStateRef.current = {
            ...viewStateRef.current,
            fisheyeFocusTime: null
          };
        }
        return true;
      };

      let hoverFrame = 0;
      let lastHover: { clientX: number; clientY: number } | null = null;
      let lastTooltipItem: any = null;
      const handleMouseMove = (e: MouseEvent) => {
        if (isDraggingChart) return;
        lastHover = { clientX: e.clientX, clientY: e.clientY };
        if (hoverFrame) return;
        hoverFrame = requestAnimationFrame(() => {
          hoverFrame = 0;
          if (!lastHover) return;
          const rect = stage.getBoundingClientRect();
          const x = lastHover.clientX - rect.left;
          const y = lastHover.clientY - rect.top;
          const focusChanged = setTrackedFisheyeFocus(x);
          const hit = findItemAtPosition(x, y);
          const nextHoveredTrack = hit ? `proc-${hit.block.hierarchy1}` : null;
          const nextHoveredItem = hit ? hit.item : null;
          const hoverChanged =
            nextHoveredTrack !== visibleState.hoveredTrack ||
            nextHoveredItem !== visibleState.hoveredItem;
          visibleState.hoveredTrack = nextHoveredTrack;
          visibleState.hoveredItem = nextHoveredItem;

          // Handle cursor style for nested expand/collapse buttons (per-segment)
          if (hit?.item?.kind === 'nestedHierarchy' && hit.item.expandable) {
            const segs = hit.item.displaySegments || (hit.item.display ? [hit.item.display] : []);
            const segIdx = (hit as any).segmentIndex ?? 0;
            const segSourceIndex = (hit as any).segmentSourceIndex ?? segIdx;
            const segment = segs[segIdx];
            if (segment) {
              const normalizedSeg = {
                x1: segment.x1 ?? (segment as any).sDrawLeft,
                x2: segment.x2 ?? (segment as any).sDrawRight,
                y0: segment.y0,
                y1: segment.y1
              };
              const fullKey = `${hit.item.expandKey ?? ''}|${segSourceIndex}`;
              const isSegExpanded = expandedHierarchyKeySet.has(fullKey);
              const headerHeight = isSegExpanded ? 14 : Math.max(14, normalizedSeg.y1 - normalizedSeg.y0);
              if (
                x >= normalizedSeg.x1 &&
                x <= Math.min(normalizedSeg.x1 + 30, normalizedSeg.x2) &&
                y >= normalizedSeg.y0 &&
                y <= normalizedSeg.y0 + headerHeight
              ) {
                stage.style.cursor = 'pointer';
              } else {
                stage.style.cursor = 'default';
              }
            } else {
              stage.style.cursor = 'default';
            }
          } else {
            stage.style.cursor = 'default';
          }

          if (focusChanged) {
            redraw();
          } else if (hoverChanged) {
            redrawBarsOnly();
          }

          if (hit && hit.item) {
            const tooltipConfig = ganttConfig?.tooltip || GANTT_CONFIG.tooltip;
            if (tooltipConfig?.enabled === false) {
              tooltip.style.display = 'none';
              lastTooltipItem = null;
              return;
            }
            tooltip.style.display = 'block';
            tooltip.style.left = `${lastHover.clientX + 12}px`;
            tooltip.style.top = `${lastHover.clientY + 12}px`;
            const item = hit.item;
            if (item !== lastTooltipItem) {
              lastTooltipItem = item;
              if (item?.kind === 'nestedHierarchy') {
                tooltip.innerHTML = buildNestedTooltipHtml(item);
                return;
              }
              if (item?.kind === 'summary') {
                tooltip.innerHTML = buildSummaryTooltipHtml(item);
                return;
              }
              if (item?.kind === 'aggregateSegment') {
                tooltip.innerHTML = buildAggregateSegmentTooltipHtml(item);
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
              const startUs = getPhysicalStart(item);
              const endUs = getPhysicalEnd(item);
              const durationUs =
                Number.isFinite(startUs) && Number.isFinite(endUs)
                  ? Math.max(0, endUs - startUs)
                  : 0;
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
            }
          } else {
            lastTooltipItem = null;
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
        lastTooltipItem = null;
        tooltip.style.display = 'none';
        stage.style.cursor = 'default';
        const focusCleared = clearTrackedFisheyeFocus();
        if (focusCleared) redraw();
        else redrawBarsOnly();
      };

      let viewRangeSyncTimer: number | null = null;
      const syncViewRangeToState = () => {
        if (viewRangeSyncTimer) {
          window.clearTimeout(viewRangeSyncTimer);
          viewRangeSyncTimer = null;
        }
        const current = getStoredViewRange();
        const physicalRange = getPhysicalViewRangeForState(current);
        viewRangeRef.current = physicalRange;
        setViewRange(physicalRange);
      };
      const scheduleViewRangeStateSync = () => {
        if (viewRangeSyncTimer) {
          window.clearTimeout(viewRangeSyncTimer);
        }
        viewRangeSyncTimer = window.setTimeout(() => {
          viewRangeSyncTimer = null;
          const current = getStoredViewRange();
          const physicalRange = getPhysicalViewRangeForState(current);
          viewRangeRef.current = physicalRange;
          setViewRange(physicalRange);
        }, 180);
      };
      const updateViewRangeRefAndRedraw = (next: ViewRange, syncToState = false) => {
        const normalized = normalizeDisplayRange(next);
        const nextStart = normalized.start;
        const nextEnd = normalized.end;
        if (!Number.isFinite(nextStart) || !Number.isFinite(nextEnd) || nextEnd <= nextStart) return;
        const prev = getStoredViewRange();
        if (nextStart === Number(prev.start) && nextEnd === Number(prev.end)) {
          if (syncToState) syncViewRangeToState();
          return;
        }
        setStoredViewRange({ start: nextStart, end: nextEnd });
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

      const toggleHierarchyExpand = (expandKey: string, expand: boolean) => {
        const key = String(expandKey || '').trim();
        if (!key) return;
        const t = lastExpandToggleRef.current;
        if (t.key === key && Date.now() - t.at < 200) return;
        lastExpandToggleRef.current = { key, at: Date.now() };
        setExpandedHierarchy1Ids((prev) =>
          expand ? (prev.includes(key) ? prev : [...prev, key]) : prev.filter((p) => p !== key && !p.startsWith(`${key}|`))
        );
      };

      let blockNextClick = false;
      const handleClick = (e: MouseEvent) => {
        if (blockNextClick) {
          blockNextClick = false;
          return;
        }
        const rect = stage.getBoundingClientRect();
        const xViewport = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const x = xViewport;
        if (xViewport > margin.left) {
          const hit = findItemAtPosition(x, y);
          if (hit?.item?.kind === 'nestedHierarchy') {
            const baseKey = String(hit.item.expandKey || '');
            const segIdx = (hit as any).segmentIndex ?? 0;
            const segSourceIndex = (hit as any).segmentSourceIndex ?? segIdx;
            const segs = (hit.item.displaySegments || (hit.item.display ? [hit.item.display] : [])).map((s: any) => ({
              x1: s.x1 ?? s.sDrawLeft, x2: s.x2 ?? s.sDrawRight, y0: s.y0, y1: s.y1
            }));
            const seg = segs[segIdx] ?? segs[0];
            const fullKey = `${baseKey}|${segSourceIndex}`;
            const isExp = expandedHierarchyKeySet.has(fullKey);
            const h = seg ? (isExp ? 14 : Math.max(14, seg.y1 - seg.y0)) : 14;
            const inBtn = seg && x >= seg.x1 && x <= Math.min(seg.x1 + 30, seg.x2) && y >= seg.y0 && y <= seg.y0 + h;
            if (hit.item.expandable && baseKey && inBtn) {
              e.preventDefault();
              e.stopPropagation();
              toggleHierarchyExpand(fullKey, !isExp);
              return; // Important: prevent falling through
            }
            return;
          }
          if (hit?.item && hit.item.kind !== 'summary') {
            const nextId = hit.item.id ?? null;
            const nextSelection = nextId == null ? null : String(nextId);
            const prevSnap = viewStateRef.current;
            if (prevSnap) {
              viewStateRef.current = { ...prevSnap, selection: nextSelection };
            }
            setViewState((prev) => ({
              ...prev,
              selection: nextSelection
            }));
            renderDependencies();
          }
          return;
        }
        // Toggle only when clicking in the left label column AND on the process header row
        const block = findBlockByY(y);
        if (!block) return;
        if (y >= block.headerY0 && y <= block.headerY1) {
          e.preventDefault();
          e.stopPropagation();
          toggleHierarchyExpand(block.hierarchy1, !block.expanded);
          return;
        }
        if (!block.expanded || !Array.isArray(block.lanes)) return;
        const row = block.lanes.find((lane: any) => y >= lane.y0 && y <= lane.y1);
        if (!row || row.type !== 'group' || !row.expandable) return;
        const expandKey = String(row.expandKey || '');
        if (!expandKey) return;
        e.preventDefault();
        e.stopPropagation();
        toggleHierarchyExpand(expandKey, !(row as any).expanded);
        // keep scroll position
      };

      const handleAxisClick = (e: MouseEvent) => {
        const rect = yAxisHost?.getBoundingClientRect();
        if (!rect) return;
        const y = e.clientY - rect.top;
        const block = findBlockByY(y);
        if (!block) return;
        if (y >= block.headerY0 && y <= block.headerY1) {
          toggleHierarchyExpand(block.hierarchy1, !block.expanded);
          return;
        }
        if (!block.expanded || !Array.isArray(block.lanes)) return;
        const row = block.lanes.find((lane: any) => y >= lane.y0 && y <= lane.y1);
        if (!row || row.type !== 'group' || !row.expandable) return;
        const expandKey = String(row.expandKey || '');
        if (!expandKey) return;
        toggleHierarchyExpand(expandKey, !(row as any).expanded);
      };

      const zoomAtX = (xInChart: number, deltaY: number) => {
        const prev = getStoredViewRange();
        const prevStart = Number(prev.start);
        const prevEnd = Number(prev.end);
        const span = Math.max(1, prevEnd - prevStart);
        const zoomFactor = Math.exp(deltaY * 0.0015);
        const minSpan = 1;
        const newSpan = clampNumber(span * zoomFactor, minSpan, domainSpan);
        const p = getViewParams();
        const focusValue = tOf(xInChart, p);
        let newStart = focusValue - (focusValue - prevStart) * (newSpan / span);
        let newEnd = newStart + newSpan;

        if (newStart < domainStart) {
          newStart = domainStart;
          newEnd = newStart + newSpan;
        }
        if (newEnd > domainEnd) {
          newEnd = domainEnd;
          newStart = newEnd - newSpan;
        }

        if (newEnd <= newStart) {
          newStart = domainStart;
          newEnd = domainEnd;
        }
        updateViewRangeRefAndRedraw({ start: newStart, end: newEnd });
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
        zoomAtX(xViewport, e.deltaY);
      };

      // Ctrl+wheel zoom also works on the main viewport area (below).
      const handleViewportWheel = (e: WheelEvent) => {
        if (!(e.ctrlKey || e.metaKey)) return;
        e.preventDefault();
        markInteraction();

        const rect = stage.getBoundingClientRect();
        const xInChart = e.clientX - rect.left;
        if (xInChart < margin.left || xInChart > margin.left + innerWidth) return;
        zoomAtX(xInChart, e.deltaY);
      };

      // Drag the minimap window to pan the view (client-side; no refetch)
      let isDraggingMinimap = false;
      let dragOffsetPx = 0;

      const panViewToLeftPx = (leftPx: number) => {
        const current = getStoredViewRange();
        const spanUs = Math.max(1, Number(current.end) - Number(current.start));
        const windowPx = (spanUs / domainSpan) * innerWidth;
        const minLeft = margin.left;
        const maxLeft = Math.max(minLeft, margin.left + innerWidth - windowPx);
        const clampedLeft = clampNumber(leftPx, minLeft, maxLeft);

        const newStart = domainStart + ((clampedLeft - margin.left) / innerWidth) * domainSpan;
        const newEnd = newStart + spanUs;
        updateViewRangeRefAndRedraw({ start: newStart, end: newEnd });
      };

      const handleMinimapPointerDown = (e: PointerEvent) => {
        if (!minimapHost || !minimapWindowEl) return;
        const rect = minimapHost.getBoundingClientRect();
        const x = e.clientX - rect.left;

        const p = getViewParams();
        const spanUs = p.span;
        const windowPx = (spanUs / domainSpan) * innerWidth;
        const currentLeft = margin.left + ((p.vs - domainStart) / domainSpan) * innerWidth;

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
      let dragStartChartX = 0;
      let dragStartView: ViewRange | null = null;
      let dragStartParams: ViewParams | null = null;
      let dragMoved = false;

      const canPanChart = () => {
        const current = getStoredViewRange();
        return Math.max(1, Number(current.end) - Number(current.start)) < domainSpan;
      };

      const handleChartPointerDown = (e: PointerEvent) => {
        if (e.button !== 0) return;
        if (e.pointerType && e.pointerType !== 'mouse') return;
        if (!canPanChart()) return;
        const rect = stage.getBoundingClientRect();
        const xViewport = e.clientX - rect.left;
        if (xViewport < margin.left || xViewport > margin.left + innerWidth) return;

        isDraggingChart = true;
        dragMoved = false;
        dragStartClientX = e.clientX;
        dragStartChartX = xViewport;
        const current = getStoredViewRange();
        dragStartView = { start: Number(current.start), end: Number(current.end) };
        dragStartParams = getViewParams();
        stage.setPointerCapture(e.pointerId);
      };

      const handleChartPointerMove = (e: PointerEvent) => {
        if (!isDraggingChart || !dragStartView || !dragStartParams) return;
        const dx = e.clientX - dragStartClientX;
        if (Math.abs(dx) > 5) dragMoved = true;
        const span = Math.max(1, dragStartView.end - dragStartView.start);
        const rect = stage.getBoundingClientRect();
        const currentX = e.clientX - rect.left;
        const startDomain = tOf(dragStartChartX, dragStartParams);
        const currentDomain = tOf(currentX, dragStartParams);
        const deltaUs = startDomain - currentDomain;
        let newStart = dragStartView.start + deltaUs;
        let newEnd = newStart + span;
        if (newStart < domainStart) {
          newStart = domainStart;
          newEnd = newStart + span;
        }
        if (newEnd > domainEnd) {
          newEnd = domainEnd;
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
        dragStartParams = null;
        syncViewRangeToState();
      };

      let scrollRaf = 0;
      const handleScroll = () => {
        if (scrollRaf) return;
        scrollRaf = requestAnimationFrame(() => {
          scrollRaf = 0;
          redrawForScroll();
        });
      };
      const handleAxisMouseMove = (e: MouseEvent) => {
        if (!axisHost) return;
        const rect = axisHost.getBoundingClientRect();
        const x = e.clientX - rect.left;
        if (setTrackedFisheyeFocus(x)) {
          redraw();
        }
      };
      const handleAxisMouseLeave = (e: MouseEvent) => {
        const related = e.relatedTarget;
        if (related instanceof Node && stage.contains(related)) {
          return;
        }
        if (clearTrackedFisheyeFocus()) {
          redraw();
        }
      };
      container.addEventListener('scroll', handleScroll);
      stage.addEventListener('mousemove', handleMouseMove);
      stage.addEventListener('mouseleave', handleMouseLeave);
      stage.addEventListener('click', handleClick);
      stage.addEventListener('pointerdown', handleChartPointerDown);
      stage.addEventListener('pointermove', handleChartPointerMove);
      stage.addEventListener('pointerup', handleChartPointerUp);
      stage.addEventListener('pointercancel', handleChartPointerUp);
      stage.addEventListener('wheel', handleViewportWheel, { passive: false });
      if (axisHost) {
        axisHost.addEventListener('wheel', handleAxisWheel, { passive: false });
        axisHost.addEventListener('mousemove', handleAxisMouseMove);
        axisHost.addEventListener('mouseleave', handleAxisMouseLeave);
      }
      if (yAxisHost) yAxisHost.addEventListener('click', handleAxisClick);
      if (minimapHost) {
        minimapHost.style.touchAction = 'none';
        minimapHost.addEventListener('pointerdown', handleMinimapPointerDown);
        minimapHost.addEventListener('pointermove', handleMinimapPointerMove);
        minimapHost.addEventListener('pointerup', handleMinimapPointerUp);
        minimapHost.addEventListener('pointercancel', handleMinimapPointerUp);
      }

      const cleanup = () => {
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
        stage.removeEventListener('mousemove', handleMouseMove);
        stage.removeEventListener('mouseleave', handleMouseLeave);
        stage.removeEventListener('click', handleClick);
        stage.removeEventListener('pointerdown', handleChartPointerDown);
        stage.removeEventListener('pointermove', handleChartPointerMove);
        stage.removeEventListener('pointerup', handleChartPointerUp);
        stage.removeEventListener('pointercancel', handleChartPointerUp);
        stage.removeEventListener('wheel', handleViewportWheel);
        if (axisHost) {
          axisHost.removeEventListener('wheel', handleAxisWheel);
          axisHost.removeEventListener('mousemove', handleAxisMouseMove);
          axisHost.removeEventListener('mouseleave', handleAxisMouseLeave);
        }
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
      chartTeardownRef.current = cleanup;
      return cleanup;
    };

    let teardown: (() => void) | undefined;
    let onResize: (() => void) | null = null;
    let resizeRaf = 0;
    const build = () => {
      const hasExistingChart = !!stage.querySelector('.gantt-canvas');
      if (teardown && !hasExistingChart) teardown();
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
      stage.innerHTML = '';
      if (minimapRef.current) minimapRef.current.innerHTML = '';
      if (xAxisRef.current) xAxisRef.current.innerHTML = '';
      if (yAxisRef.current) yAxisRef.current.innerHTML = '';
    };
  };

  useGanttChart(renderChartEffect, [
    chartData,
    dataMapping,
    startTime,
    endTime,
    bins,
    obd,
    processAggregates,
    threadsByHierarchy1,
    hierarchyTrees,
    renderSoA,
    expandedHierarchy1Ids,
    yAxisWidth,
    processSortMode,
    ganttConfig
  ]);
}

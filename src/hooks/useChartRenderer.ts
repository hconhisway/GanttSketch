import { useMemo } from 'react';
import * as d3 from 'd3';
import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from 'react';
import { GANTT_CONFIG } from '../config/ganttConfig';
import type { ProcessSortMode } from '../types/ganttConfig';
import { buildProcessStats } from '../utils/dataProcessing';
import { pickTextColor, resolveColor, resolveColorKey } from '../utils/color';
import {
  applyProcessOrderRule,
  comparePid,
  normalizeProcessOrderRule,
  resolveThreadLaneMode
} from '../utils/processOrder';
import { buildTooltipHtml } from '../utils/tooltip';
import { clampNumber, formatTimeUs } from '../utils/formatting';
import { evalExpr, hashStringToInt, isEmptyValue } from '../utils/expression';
import { useGanttChart } from './useGanttChart';

type ViewRange = { start: number; end: number };
type ViewParams = { vs: number; ve: number; span: number; k: number };

type ThreadLevelMap = Map<string | number, any[]>;
type ThreadMap = Map<string, ThreadLevelMap>;
type ThreadsByPid = Map<string, ThreadMap>;

interface UseChartRendererArgs {
  chartRef: RefObject<HTMLDivElement>;
  minimapRef: RefObject<HTMLDivElement>;
  xAxisRef: RefObject<HTMLDivElement>;
  yAxisRef: RefObject<HTMLDivElement>;
  viewRangeRef: MutableRefObject<ViewRange | null>;
  redrawRef: MutableRefObject<(() => void) | null>;
  chartData: any[];
  startTime: number;
  endTime: number;
  bins: number;
  obd: any;
  processAggregates: Map<string, any[]>;
  threadsByPid: ThreadsByPid;
  expandedPids: string[];
  yAxisWidth: number;
  processSortMode: ProcessSortMode;
  ganttConfig: any;
  setYAxisWidth: Dispatch<SetStateAction<number>>;
  setExpandedPids: Dispatch<SetStateAction<string[]>>;
  setViewRange: Dispatch<SetStateAction<ViewRange>>;
  forkRelationsRef: MutableRefObject<any>;
}

export function useChartRenderer({
  chartRef,
  minimapRef,
  xAxisRef,
  yAxisRef,
  viewRangeRef,
  redrawRef,
  chartData,
  startTime,
  endTime,
  bins,
  obd,
  processAggregates,
  threadsByPid,
  expandedPids,
  yAxisWidth,
  processSortMode,
  ganttConfig,
  setYAxisWidth,
  setExpandedPids,
  setViewRange,
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
  const orderResult = useMemo(() => {
    const pids = Array.from(processAggregates.keys());
    if (pids.length === 0) {
      return { orderedPids: [], depthByPid: new Map() };
    }
    pids.sort(comparePid);
    return applyProcessOrderRule(processOrderRule, {
      pids,
      fork: forkRelationsRef.current,
      processStats
    });
  }, [processAggregates, processOrderRule, processStats, forkRelationsRef]);

  // Render chart with d3 (canvas + svg hybrid for scalability)
  const renderChartEffect = () => {
    if (!chartRef.current) return;

    const container = chartRef.current;
    const pixelRatio = window.devicePixelRatio || 1;

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
        top: layoutConfig?.margin?.top ?? 24,
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
      const PROCESS_INDENT_PX = yAxisLayout?.hierarchy1Indent ?? yAxisLayout?.processIndent ?? 16;

      const orderedPids = orderResult.orderedPids || [];
      const depthByPid = orderResult.depthByPid || new Map();
      if (orderedPids.length === 0) {
        container.innerHTML = `<div class="chart-empty-state">No processes found</div>`;
        return;
      }

      const processLabelRule = yAxisConfig?.hierarchy1LabelRule ?? yAxisConfig?.processLabelRule;
      const threadLabelRule = yAxisConfig?.hierarchy2LabelRule ?? yAxisConfig?.threadLabelRule;

      const getProcessLabel = (pid: string, depth: number, isExpanded: boolean) => {
        const ctx = {
          pid: String(pid),
          depth,
          isExpanded,
          stats: processStats.get(String(pid)) || {},
          vars: { pid: String(pid), depth, isExpanded }
        };
        const label = evalExpr(processLabelRule, ctx);
        if (!isEmptyValue(label)) return String(label);
        return `${isExpanded ? '▼' : '▶'} Row ${pid}`;
      };

      const getThreadLabel = (pid: string, tid: string | number, isMainThread: boolean) => {
        const ctx = {
          pid: String(pid),
          tid: String(tid),
          isMainThread,
          vars: { pid: String(pid), tid: String(tid), isMainThread }
        };
        const label = evalExpr(threadLabelRule, ctx);
        if (!isEmptyValue(label)) return String(label);
        return isMainThread ? 'main thread' : `thread ${tid}`;
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

          // Hierarchy1 labels (always visible)
          ctx.font = (yAxisLayout?.hierarchy1Font ?? yAxisLayout?.processFont) || '700 12px system-ui';
          for (const pid of orderedPids) {
            const indentPx = (depthByPid.get(String(pid)) || 0) * PROCESS_INDENT_PX;
            const text = getProcessLabel(pid, depthByPid.get(String(pid)) || 0, false);
            const w = ctx.measureText(text).width;
            maxPx = Math.max(maxPx, LEFT_PAD + indentPx + w + RIGHT_PAD);
          }

          // Hierarchy2 labels (only for expanded blocks)
          ctx.font = (yAxisLayout?.hierarchy2Font ?? yAxisLayout?.threadFont) || '500 11px system-ui';
          for (const pid of expandedPids) {
            const threadMap = threadsByPid.get(pid);
            if (!threadMap) continue;
            const procIndentPx = (depthByPid.get(String(pid)) || 0) * PROCESS_INDENT_PX;
            const tids = Array.from(threadMap.keys());
            for (const tid of tids) {
              const isMainThread = String(tid) === String(pid);
              const text = getThreadLabel(pid, tid, isMainThread);
              const w = ctx.measureText(text).width;
              maxPx = Math.max(maxPx, LEFT_PAD + procIndentPx + THREAD_INDENT + w + RIGHT_PAD);
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

      const buildLanesForPid = (pid: string) => {
        const threadMap = threadsByPid.get(pid);
        if (!threadMap) return [];

        const tids = Array.from(threadMap.keys()).sort((a, b) => {
          const na = parseFloat(String(a));
          const nb = parseFloat(String(b));
          if (!isNaN(na) && !isNaN(nb)) return na - nb;
          return a.toString().localeCompare(b.toString());
        });

        const lanes: any[] = [];
        tids.forEach((tid) => {
          const levelMap = threadMap.get(tid);
          if (!levelMap) return;

          const isMainThread = String(tid) === String(pid);
          if (threadOrderMode === 'auto') {
            const allEvents: any[] = [];
            levelMap.forEach((arr: any[]) => {
              if (!Array.isArray(arr) || arr.length === 0) return;
              for (const item of arr) {
                allEvents.push(item);
              }
            });
            const autoLanes = buildAutoLanes(allEvents);
            autoLanes.forEach((events: any[], idx: number) => {
              lanes.push({
                type: 'lane',
                pid,
                tid: String(tid),
                level: idx,
                threadLabel: idx === 0 ? getThreadLabel(pid, tid, isMainThread) : '',
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
            lanes.push({
              type: 'lane',
              pid,
              tid: String(tid),
              level,
              threadLabel: idx === 0 ? getThreadLabel(pid, tid, isMainThread) : '',
              events
            });
          });
        });

        // Visual gaps between threads for readability (not "empty levels")
        const withGaps: any[] = [];
        let lastTid: string | null = null;
        lanes.forEach((lane) => {
          if (lastTid !== null && lane.tid !== lastTid) {
            withGaps.push({ type: 'gap', height: threadGap });
          }
          withGaps.push(lane);
          lastTid = lane.tid;
        });
        return withGaps;
      };

      type Block = {
        pid: string;
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
        const lanesHeight = lanes.reduce(
          (sum: number, lane: any) => sum + (lane.type === 'gap' ? lane.height : laneHeight),
          0
        );
        const blockHeight = headerHeight + expandedPadding + lanesHeight + expandedPadding;

        const block: Block = {
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
        block.lanes = lanes.map((lane: any) => {
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

      // Canvas for bars (fast for large datasets)
      const canvas = document.createElement('canvas');
      canvas.className = 'gantt-canvas';
      canvas.width = Math.round((innerWidth + margin.left + margin.right) * pixelRatio);
      canvas.height = Math.round(stageHeight * pixelRatio);
      canvas.style.width = `${innerWidth + margin.left + margin.right}px`;
      canvas.style.height = `${stageHeight}px`;
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

      const svgNode = svg.node();
      if (svgNode) {
        container.appendChild(svgNode);
      }

      const yAxisHost = yAxisRef.current;
      let yAxisGroup: d3.Selection<SVGGElement, any, null, undefined> | null = null;
      let yAxisTooltipEl: HTMLDivElement | null = null;
      if (yAxisHost) {
        yAxisHost.innerHTML = '';
        const axisSvg = d3
          .create('svg')
          .attr('class', 'gantt-yaxis-svg')
          .attr('width', Y_AXIS_WIDTH)
          .attr('height', stageHeight)
          .style('width', `${Y_AXIS_WIDTH}px`)
          .style('height', `${stageHeight}px`)
          .style('overflow', 'visible');
        yAxisGroup = axisSvg.append('g').attr('class', 'y-labels');
        const axisNode = axisSvg.node();
        if (axisNode) {
          yAxisHost.appendChild(axisNode);
        }
        yAxisTooltipEl = document.createElement('div');
        yAxisTooltipEl.className = 'gantt-yaxis-tooltip';
        yAxisTooltipEl.style.cssText = 'position:fixed;display:none;font-size:12px;font-weight:500;font-family:system-ui;background:#333;color:#fff;padding:6px 10px;border-radius:4px;pointer-events:none;z-index:1000;max-width:420px;white-space:normal;line-height:1.3;box-shadow:0 2px 8px rgba(0,0,0,0.2);';
        yAxisHost.appendChild(yAxisTooltipEl);
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
      const minimapHeight = Math.max(60, minimapHost ? minimapHost.clientHeight || 60 : 60);
      const axisHeight = Math.max(32, axisHost ? axisHost.clientHeight || 32 : 32);

      let minimapCtx: CanvasRenderingContext2D | null = null;
      let minimapWindowEl: HTMLDivElement | null = null;
      let minimapAxisGroup: d3.Selection<SVGGElement, any, null, undefined> | null = null;

      if (minimapHost) {
        const mmCanvas = document.createElement('canvas');
        mmCanvas.width = Math.round(topWidth * pixelRatio);
        mmCanvas.height = Math.round(minimapHeight * pixelRatio);
        mmCanvas.style.width = `${topWidth}px`;
        mmCanvas.style.height = `${minimapHeight}px`;
        minimapHost.appendChild(mmCanvas);
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
          minimapHost.appendChild(mmAxisNode);
        }
      }

      let axisGroup: d3.Selection<SVGGElement, any, null, undefined> | null = null;
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
          axisHost.appendChild(axisNode);
        }
      }

      // Precompute minimap multi-lane stripes (compressed overview).
      // We bin events into a small number of lanes based on current track order
      // so the overview reflects the main Gantt ordering.
      const overviewBinsCount = Math.min(900, Math.max(300, Math.floor(innerWidth)));
      const LANE_COUNT = 6;
      const colorConfig = ganttConfig?.color || GANTT_CONFIG.color;
      const legacyColorConfig = ganttConfig?.colorMapping || GANTT_CONFIG.colorMapping;
      const defaultPalette = GANTT_CONFIG.color?.palette || [];
      const laneDiffs = Array.from({ length: LANE_COUNT }, () =>
        new Array(overviewBinsCount + 1).fill(0)
      );
      const laneColorCounts = Array.from({ length: LANE_COUNT }, () => new Map());
      const pidToBlockIndex = new Map();
      const totalBlocks = Math.max(1, blocks.length);
      blocks.forEach((block: any, index: number) => {
        pidToBlockIndex.set(block.pid, index);
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
        const blockIndex = pidToBlockIndex.get(ev.pid);
        let lane = 0;
        if (Number.isFinite(blockIndex)) {
          lane = Math.floor((blockIndex / totalBlocks) * LANE_COUNT);
        } else {
          const laneKey = resolveColorKey(
            ev,
            ev.tid ?? ev.pid ?? '',
            {
              type: 'lane',
              pid: ev.pid,
              tid: ev.tid,
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

        const trackKey = ev.tid ?? ev.pid ?? '';
        const color = resolveColor(
          ev,
          trackKey,
          {
            type: 'lane',
            pid: ev.pid,
            tid: ev.tid,
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

      const drawBars = () => {
        ctx.clearRect(0, 0, innerWidth + margin.left + margin.right, stageHeight);

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
          ctx.fillStyle = block.expanded ? '#eef2ff' : i % 2 === 0 ? '#fbfbfb' : '#f4f4f4';
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
            const leftBound = margin.left + blockIndentPx;
            const rightBound = margin.left + innerWidth + blockIndentPx;
            // Collapsed view: render each pixel at most once.
            // Events may come from multiple threads that overlap in time,
            // but the collapsed bar should be uniform — clip each event
            // to only its uncovered portion so no pixel is painted twice.
            let collapsedCoveredEnd = -Infinity;
            merged.forEach((item: any) => {
              const x1Raw = xOf(item.start ?? item.timeStart ?? 0, p) + blockIndentPx;
              const x2Raw = xOf(item.end ?? item.timeEnd ?? 0, p) + blockIndentPx;
              if (x2Raw < leftBound || x1Raw > rightBound) return;
              const x1 = Math.round(x1Raw);
              const endPx = x1 + Math.max(1, Math.round(x2Raw) - x1);
              // Only render the portion beyond what's already covered
              const drawX = Math.max(x1, collapsedCoveredEnd);
              if (drawX >= endPx) return; // fully covered
              ctx.fillStyle = colorFor(item, `proc-${block.pid}`, {
                type: 'process',
                pid: block.pid
              });
              ctx.fillRect(drawX, y, endPx - drawX, h);
              collapsedCoveredEnd = endPx;
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
            block.lanes.forEach((lane: any) => {
              if (lane.type !== 'lane') return;
              if (lane.y1 < yMin || lane.y0 > yMax) return;

              const laneY0 = lane.y0;
              const laneY1 = lane.y1;
              const laneH = laneY1 - laneY0;

              const events = lane.events || [];
              const barY = laneY0 + lanePadding;
              const barH = Math.max(2, laneH - lanePadding * 2);

              // Pixel-snapped rendering with coverage clipping:
              // Snap coordinates to integers, then only render the uncovered
              // portion of each bar. This guarantees no pixel is painted twice
              // for non-overlapping events, even when bars are close in pixel
              // space due to zoom level or minimum-width enforcement.
              let coveredEnd = -Infinity;

              events.forEach((ev: any) => {
                const tStart = ev.start ?? ev.timeStart ?? 0;
                const tEnd = ev.end ?? ev.timeEnd ?? 0;
                const x1Raw = xOf(tStart, p) + blockIndentPx;
                const x2Raw = xOf(tEnd, p) + blockIndentPx;
                if (x2Raw < boxX1 || x1Raw > boxX1 + boxW) return;

                // Snap to integer pixels
                const x1 = Math.round(x1Raw);
                const w = Math.max(1, Math.round(x2Raw) - x1);
                const endPx = x1 + w;

                // Only render the portion beyond what's already covered
                const drawX = Math.max(x1, coveredEnd);
                if (drawX >= endPx) return; // fully covered

                const barColor = colorFor(ev, lane.tid, {
                  type: 'lane',
                  pid: block.pid,
                  tid: lane.tid,
                  level: lane.level
                });
                ctx.fillStyle = barColor;
                ctx.fillRect(drawX, barY, endPx - drawX, barH);

                coveredEnd = endPx;

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
              .tickFormat((d) => formatTimeUs(d as number))
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
              .tickFormat((d) => formatTimeUs(d as number))
          );
          axisGroup.selectAll('text').style('font-size', '12px').style('fill', '#555');
          axisGroup.selectAll('path,line').style('stroke', '#d0d0d0');
          // Ensure labels stay inside visible area
          axisGroup.selectAll('text').attr('dy', '1.2em');
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
        const bgRects: Array<{ key: string; y: number; h: number; fill: string }> = [];

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
              fill: i % 2 === 0 ? '#fbfbfb' : '#f4f4f4'
            });
          }

          const processLabelFull = getProcessLabel(block.pid, block.depth, block.expanded);
          const procFw = block.expanded ? 700 : 600;
          const { symbol: procSymbol, body: processBody } = getSymbolAndBody(processLabelFull);
          const procSymbolW = measureSymbolWidth(procSymbol, procFw);
          const processAvailW = Y_AXIS_WIDTH - LEFT_PAD - RIGHT_PAD - blockIndentPx - procSymbolW;
          const processFit = fitYAxisLabel(
            processBody,
            procFw,
            12,
            Math.max(20, processAvailW)
          );
          labels.push({
            key: `proc-${block.pid}`,
            kind: 'process',
            text: processFit.displayText,
            x: LEFT_PAD,
            y: block.headerY0 + headerHeight / 2 - scrollY,
            fontSize: processFit.fontSize,
            fontWeight: procFw,
            indent: blockIndentPx,
            fullText: processLabelFull,
            symbol: procSymbol || undefined,
            symbolWidth: procSymbolW || undefined
          });

          if (block.expanded) {
            block.lanes.forEach((lane: any) => {
              if (lane.type !== 'lane') return;
              if (lane.y1 < yMin || lane.y0 > yMax) return;

              // Only show thread label once (no L1/L2 labels)
              if (lane.threadLabel) {
                const laneIndent = blockIndentPx + THREAD_INDENT;
                const laneAvailW = Y_AXIS_WIDTH - LEFT_PAD - RIGHT_PAD - laneIndent;
                const laneFit = fitYAxisLabel(
                  lane.threadLabel,
                  500,
                  11,
                  Math.max(20, laneAvailW)
                );
                labels.push({
                  key: `lane-${block.pid}-${lane.tid}-${lane.y0}`,
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
          .attr('fill', (d) => d.fill);

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
        updateVisibleWindow();
        drawBars();
        renderYLabels();
        renderTopbar();
      };

      // Expose redraw for viewRange updates (zoom/pan)
      redrawRef.current = redraw;

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

        const lane = block.lanes.find((l: any) => l.type === 'lane' && y >= l.y0 && y <= l.y1);
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
          visibleState.hoveredTrack = hit ? `proc-${hit.block.pid}` : null;
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
            const pid = item.pid ?? hit.block.pid ?? '';
            const tid = item.tid ?? hit.lane?.tid ?? '';
            const startUs = Number(item.start ?? item.timeStart);
            const endUs = Number(item.end ?? item.timeEnd);
            const durationUs =
              Number.isFinite(startUs) && Number.isFinite(endUs) ? Math.max(0, endUs - startUs) : 0;
            const sqlId = item.id ?? null;

            const stats = processStats.get(String(pid)) || {};
            const tooltipHtml = buildTooltipHtml(hit, tooltipConfig, {
              event: item,
              block: hit.block,
              lane: hit.lane,
              pid,
              tid: String(tid ?? ''),
              startUs,
              endUs,
              durationUs,
              sqlId,
              stats,
              vars: { pid, tid, startUs, endUs, durationUs, sqlId }
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

      let blockNextClick = false;
      const handleClick = (e: MouseEvent) => {
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
          if (has) return prev.filter((p) => p !== pid);
          return [...prev, pid];
        });
        // keep scroll position
      };

      const handleAxisClick = (e: MouseEvent) => {
        const rect = container.getBoundingClientRect();
        const y = e.clientY - rect.top + container.scrollTop;
        const block = findBlockByY(y);
        if (!block) return;
        if (y < block.headerY0 || y > block.headerY1) return;
        const pid = block.pid;
        setExpandedPids((prev) => {
          const has = prev.includes(pid);
          if (has) return prev.filter((p) => p !== pid);
          return [...prev, pid];
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
          return { start: Math.round(newStart), end: Math.round(newEnd) };
        });
      };

      // Ctrl+wheel zoom also works on the main viewport area (below).
      const handleViewportWheel = (e: WheelEvent) => {
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
          return { start: Math.round(newStart), end: Math.round(newEnd) };
        });
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
        setViewRange({ start: Math.round(newStart), end: Math.round(newEnd) });
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
        panViewToLeftPx(x - dragOffsetPx);
      };

      const handleMinimapPointerUp = () => {
        isDraggingMinimap = false;
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
        if (hoverFrame) {
          cancelAnimationFrame(hoverFrame);
          hoverFrame = 0;
        }
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

    let teardown: (() => void) | undefined;
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
  };

  useGanttChart(renderChartEffect, [
    chartData,
    startTime,
    endTime,
    bins,
    obd,
    processAggregates,
    threadsByPid,
    expandedPids,
    yAxisWidth,
    processSortMode,
    ganttConfig
  ]);
}

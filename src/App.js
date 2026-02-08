import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as d3 from 'd3';
import './App.css';
import { GANTT_CONFIG, cloneGanttConfig, applyGanttConfigPatch } from './ganttConfig';
import { GANTT_CONFIG_UI_SPEC } from './ganttConfigUiSpec';
import { cloneWidgetConfig } from './widgetConfig';
import { parseMessageSegments } from './utils/configPatch';
import { buildProcessStats, processTracksConfig } from './utils/dataProcessing';
import { pickTextColor, resolveColor, resolveColorKey } from './utils/color';
import {
  applyProcessOrderRule,
  buildPatchForPath,
  comparePid,
  inferProcessSortModeFromRule,
  normalizeProcessOrderRule,
  resolveThreadLaneMode
} from './utils/processOrder';
import { buildTooltipHtml } from './utils/tooltip';
import { buildWidgetHandler, normalizeWidget } from './utils/widget';
import { clampNumber, formatTimeUs } from './utils/formatting';
import { evalExpr, getValueAtPath, hashStringToInt, isEmptyValue } from './utils/expression';
import { WidgetArea } from './components/WidgetArea';
import { GanttChart } from './components/GanttChart';
import { ConfigPanel } from './components/ConfigPanel';
import { ChatMessages } from './components/ChatMessages';
import { ImageGallery } from './components/ImageGallery';
import { ChatInput } from './components/ChatInput';
import { ConfigEditorModal } from './components/ConfigEditorModal';
import { WidgetEditorModal } from './components/WidgetEditorModal';
import { LeftPanel } from './components/LeftPanel';
import { RightPanel } from './components/RightPanel';
import { useDataFetching } from './hooks/useDataFetching';
import { useProcessAggregates } from './hooks/useProcessAggregates';
import { useChatAgent } from './hooks/useChatAgent';
import { useGanttChart } from './hooks/useGanttChart';

// API configuration
const API_URL = 'http://127.0.0.1:8080/get-events';
const FRONTEND_TRACE_URL = `${process.env.PUBLIC_URL || ''}/unet3d_a100--verify-1.pfw`;
const FRONTEND_TRACE_LABEL = 'unet3d_a100--verify-1.pfw';
const DEFAULT_END_US = 100_000_000; // 100s, microseconds
const MERGE_GAP_RATIO = 0.01; // merge gap as fraction of total time window

function App() {
  const chartRef = useRef();
  const minimapRef = useRef();
  const xAxisRef = useRef();
  const yAxisRef = useRef();
  const chatEndRef = useRef();
  const drawingOverlayRef = useRef();
  const widgetAreaRef = useRef(null);
  const widgetHandlersRef = useRef([]);
  const configEditorTextareaRef = useRef(null);
  const configHighlightTimeoutRef = useRef(null);
  const ganttConfigRef = useRef(null);
  const tracksConfigRef = useRef(null);
  const widgetApiRef = useRef(null);
  const redrawRef = useRef(null);
  const viewRangeRef = useRef({ start: 0, end: DEFAULT_END_US });
  const fetchRangeRef = useRef({ start: 0, end: DEFAULT_END_US });
  const forkRelationsRef = useRef({ parentByPid: new Map(), childrenByPid: new Map(), edges: [] });
  const forkLoggedRef = useRef(false);
  const [data, setData] = useState([]);
  const [dataSchema, setDataSchema] = useState(null); // Schema detected from data
  const [fieldMapping, setFieldMapping] = useState(null); // Maps semantic roles to original field names
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
  const [yAxisWidth, setYAxisWidth] = useState(GANTT_CONFIG?.layout?.yAxis?.baseWidth ?? 180);

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
    inferProcessSortModeFromRule(GANTT_CONFIG.yAxis?.processOrderRule)
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

  const trackConfigResult = useMemo(
    () => processTracksConfig(data, tracksConfig),
    [data, tracksConfig]
  );
  const chartData = trackConfigResult.processedData;

  // Config UI editor state
  const [activeConfigItem, setActiveConfigItem] = useState(null);
  const [configEditorText, setConfigEditorText] = useState('');
  const [configEditorError, setConfigEditorError] = useState('');
  const [configHighlightId, setConfigHighlightId] = useState(null);

  // Widget configuration and instances
  const [widgetConfig, setWidgetConfig] = useState(() => cloneWidgetConfig());
  const [widgets, setWidgets] = useState([]);

  // Widget agent mode toggle
  const [isWidgetAgentMode, setIsWidgetAgentMode] = useState(false);

  // Widget editor state (similar to config editor)
  const [activeWidget, setActiveWidget] = useState(null);
  const [widgetEditorText, setWidgetEditorText] = useState('');
  const [widgetEditorError, setWidgetEditorError] = useState('');
  const [widgetHighlightId, setWidgetHighlightId] = useState(null);
  const widgetHighlightTimeoutRef = useRef(null);

  useDataFetching({
    obd,
    startTime,
    endTime,
    bins,
    localTraceText,
    dataSchema,
    fieldMapping,
    ganttConfig,
    apiUrl: API_URL,
    traceUrl: FRONTEND_TRACE_URL,
    defaultEndUs: DEFAULT_END_US,
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
  });

  useProcessAggregates({
    data: chartData,
    obd,
    startTime,
    endTime,
    mergeGapRatio: MERGE_GAP_RATIO,
    setThreadsByPid,
    setProcessAggregates,
    setExpandedPids,
    threadsByPid,
    processAggregates
  });

  const processStats = useMemo(() => buildProcessStats(chartData), [chartData]);
  const processOrderRule = useMemo(
    () => normalizeProcessOrderRule(ganttConfig?.yAxis || {}, processSortMode),
    [ganttConfig, processSortMode]
  );
  const threadOrderMode = useMemo(
    () =>
      resolveThreadLaneMode(
        ganttConfig?.yAxis?.threadLaneRule,
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
  }, [processAggregates, processOrderRule, processStats]);

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

    widgetHandlersRef.current.forEach((binding) => {
      binding.element.removeEventListener(binding.event, binding.handler);
    });
    widgetHandlersRef.current = [];

    widgets.forEach((widget) => {
      const widgetRoot = host.querySelector(`[data-widget-id="${widget.id}"]`);
      if (!widgetRoot) return;
      const listeners = Array.isArray(widget.listeners) ? widget.listeners : [];
      listeners.forEach((listener) => {
        const handlerFn = buildWidgetHandler(listener.handler);
        if (!handlerFn) return;
        const elements = listener.selector
          ? widgetRoot.querySelectorAll(listener.selector)
          : [widgetRoot];
        elements.forEach((element) => {
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
      const threadGap = layoutConfig?.threadGap ?? 6;

      const yAxisConfig = ganttConfig?.yAxis || {};
      const PROCESS_INDENT_PX = yAxisLayout?.processIndent ?? 16;

      const orderedPids = orderResult.orderedPids || [];
      const depthByPid = orderResult.depthByPid || new Map();
      if (orderedPids.length === 0) {
        container.innerHTML = `<div class="chart-empty-state">No processes found</div>`;
        return;
      }

      const processLabelRule = yAxisConfig?.processLabelRule;
      const threadLabelRule = yAxisConfig?.threadLabelRule;

      const getProcessLabel = (pid, depth, isExpanded) => {
        const ctx = {
          pid: String(pid),
          depth,
          isExpanded,
          stats: processStats.get(String(pid)) || {},
          vars: { pid: String(pid), depth, isExpanded }
        };
        const label = evalExpr(processLabelRule, ctx);
        if (!isEmptyValue(label)) return String(label);
        return `${isExpanded ? '▼' : '▶'} Process ${pid}`;
      };

      const getThreadLabel = (pid, tid, isMainThread) => {
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
          const THREAD_INDENT = yAxisLayout?.labelPadding?.threadIndent ?? 18;

          let maxPx = 0;

          // Process labels (always visible)
          ctx.font = yAxisLayout?.processFont || '700 12px system-ui';
          for (const pid of orderedPids) {
            const indentPx = (depthByPid.get(String(pid)) || 0) * PROCESS_INDENT_PX;
            const text = getProcessLabel(pid, depthByPid.get(String(pid)) || 0, false);
            const w = ctx.measureText(text).width;
            maxPx = Math.max(maxPx, LEFT_PAD + indentPx + w + RIGHT_PAD);
          }

          // Thread labels (only for expanded blocks)
          ctx.font = yAxisLayout?.threadFont || '500 11px system-ui';
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
                threadLabel: idx === 0 ? getThreadLabel(pid, tid, isMainThread) : '',
                events
              });
            });
            return;
          }

          const levels = Array.from(levelMap.keys())
            .map((v) => (typeof v === 'string' ? Number(v) : v))
            .filter((v) => Number.isFinite(v))
            .sort((a, b) => a - b);

          levels.forEach((level, idx) => {
            lanes.push({
              type: 'lane',
              pid,
              tid: String(tid),
              level,
              threadLabel: idx === 0 ? getThreadLabel(pid, tid, isMainThread) : '',
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
        const lanesHeight = lanes.reduce(
          (sum, lane) => sum + (lane.type === 'gap' ? lane.height : laneHeight),
          0
        );
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

      container.appendChild(svg.node());

      const yAxisHost = yAxisRef.current;
      let yAxisGroup = null;
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
      const minimapHeight = Math.max(60, minimapHost ? minimapHost.clientHeight || 60 : 60);
      const axisHeight = Math.max(32, axisHost ? axisHost.clientHeight || 32 : 32);

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
        minimapHost.appendChild(mmAxisSvg.node());
      }

      let axisGroup = null;
      if (axisHost) {
        const axisSvg = d3
          .create('svg')
          .attr('width', topWidth)
          .attr('height', axisHeight)
          .style('width', `${topWidth}px`)
          .style('height', `${axisHeight}px`)
          .style('overflow', 'visible');
        axisGroup = axisSvg.append('g').attr('transform', `translate(0, ${axisHeight - 8})`);
        axisHost.appendChild(axisSvg.node());
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
      blocks.forEach((block, index) => {
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

      const colorFor = (item, trackKey, trackMeta) =>
        resolveColor(
          item,
          trackKey,
          trackMeta,
          colorConfig,
          defaultPalette,
          legacyColorConfig,
          processStats
        );

      const visibleState = {
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
            merged.forEach((item) => {
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
            block.lanes.forEach((lane) => {
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

              events.forEach((ev) => {
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
              .tickFormat((d) => formatTimeUs(d))
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
              .tickFormat((d) => formatTimeUs(d))
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
              fill: i % 2 === 0 ? '#fbfbfb' : '#f4f4f4'
            });
          }

          labels.push({
            key: `proc-${block.pid}`,
            kind: 'process',
            text: getProcessLabel(block.pid, block.depth, block.expanded),
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

        yAxisGroup
          .selectAll('rect.y-bg')
          .data(bgRects, (d) => d.key)
          .join('rect')
          .attr('class', 'y-bg')
          .attr('x', 0)
          .attr('y', (d) => d.y)
          .attr('width', Y_AXIS_WIDTH)
          .attr('height', (d) => d.h)
          .attr('fill', (d) => d.fill);

        yAxisGroup
          .selectAll('text')
          .data(labels, (d) => d.key)
          .join('text')
          .attr('x', (d) => d.x + (d.indent || 0))
          .attr('y', (d) => d.y)
          .attr('text-anchor', 'start')
          .attr('dominant-baseline', 'middle')
          .attr('fill', '#333')
          .style('font-size', (d) => `${d.fontSize || 12}px`)
          .style('font-weight', (d) => d.fontWeight || 500)
          .text((d) => d.text);
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

        const lane = block.lanes.find((l) => l.type === 'lane' && y >= l.y0 && y <= l.y1);
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
      let lastHover = null;
      const handleMouseMove = (e) => {
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
          if (has) return prev.filter((p) => p !== pid);
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
          if (has) return prev.filter((p) => p !== pid);
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

  // Auto-scroll chat to bottom
  useEffect(() => {
    if (chatEndRef.current) {
      chatEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, currentStreamingMessage]);

  useEffect(() => {
    if (!configHighlightId || activeConfigItem?.id !== configHighlightId) return;
    const textarea = configEditorTextareaRef.current;
    if (!textarea) return;
    const frame = requestAnimationFrame(() => {
      textarea.focus();
      textarea.select();
    });
    return () => cancelAnimationFrame(frame);
  }, [configHighlightId, activeConfigItem]);

  useEffect(() => {
    if (!configHighlightId) return;
    const selector = `.config-button[data-config-item-id="${configHighlightId}"]`;
    const button = document.querySelector(selector);
    if (button) {
      button.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [configHighlightId]);

  // Handle capture of annotated chart for LLM
  const handleCaptureImage = useCallback(async () => {
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

        setSavedImages((prev) => [...prev, newImage]);
        setSelectedImageId(newImage.id);

        // Show success message in chat
        setMessages((prev) => [
          ...prev,
          {
            role: 'assistant',
            content: '📸 Chart captured successfully! The image is ready to send to the LLM.'
          }
        ]);
      }
    }
  }, [setMessages, setSavedImages, setSelectedImageId]);

  // Delete an image from saved images
  const handleDeleteImage = useCallback(
    (imageId) => {
      setSavedImages((prev) => prev.filter((img) => img.id !== imageId));
      if (selectedImageId === imageId) {
        setSelectedImageId(null);
      }
    },
    [selectedImageId, setSavedImages, setSelectedImageId]
  );

  // Select/deselect an image
  const handleSelectImage = useCallback(
    (imageId) => {
      setSelectedImageId((prev) => (prev === imageId ? null : imageId));
    },
    [setSelectedImageId]
  );

  // Handle clear drawings
  const handleClear = useCallback(() => {
    if (drawingOverlayRef.current) {
      drawingOverlayRef.current.clearCanvas();
    }
  }, []);

  const clearConfigHighlight = useCallback(() => {
    if (configHighlightTimeoutRef.current) {
      clearTimeout(configHighlightTimeoutRef.current);
      configHighlightTimeoutRef.current = null;
    }
    setConfigHighlightId(null);
  }, [setConfigHighlightId]);

  const handleOpenConfigEditor = useCallback(
    (item, options = {}) => {
      if (!item) return;
      const { configOverride, highlight = false } = options;
      const sourceConfig = configOverride || ganttConfig;
      const currentValue = getValueAtPath(sourceConfig, item.path);
      const serialized = currentValue === undefined ? '' : JSON.stringify(currentValue, null, 2);
      setActiveConfigItem(item);
      setConfigEditorText(serialized);
      setConfigEditorError('');
      if (highlight) {
        setConfigHighlightId(item.id);
        if (configHighlightTimeoutRef.current) {
          clearTimeout(configHighlightTimeoutRef.current);
        }
        configHighlightTimeoutRef.current = setTimeout(() => {
          setConfigHighlightId(null);
          configHighlightTimeoutRef.current = null;
        }, 3500);
      } else {
        clearConfigHighlight();
      }
    },
    [
      clearConfigHighlight,
      ganttConfig,
      setActiveConfigItem,
      setConfigEditorError,
      setConfigEditorText,
      setConfigHighlightId
    ]
  );

  const handleCloseConfigEditor = useCallback(() => {
    clearConfigHighlight();
    setActiveConfigItem(null);
    setConfigEditorText('');
    setConfigEditorError('');
  }, [clearConfigHighlight, setActiveConfigItem, setConfigEditorError, setConfigEditorText]);

  const handleSaveConfigEditor = useCallback(() => {
    if (!activeConfigItem) return;
    try {
      const parsed = configEditorText ? JSON.parse(configEditorText) : null;
      const patch = buildPatchForPath(activeConfigItem.path, parsed);
      const nextConfig = applyGanttConfigPatch(ganttConfig, patch);
      setGanttConfig(nextConfig);
      if (activeConfigItem.path === 'yAxis.processOrderRule') {
        setProcessSortMode(inferProcessSortModeFromRule(parsed));
      } else if (activeConfigItem.path === 'yAxis.orderMode') {
        setProcessSortMode(parsed === 'fork' ? 'fork' : 'default');
      }
      clearConfigHighlight();
      setMessages((prev) => [
        ...prev,
        {
          role: 'system',
          content: `✅ Updated ${activeConfigItem.label}`
        }
      ]);
      setConfigEditorError('');
      handleCloseConfigEditor();
    } catch (error) {
      setConfigEditorError(`Invalid JSON: ${error.message}`);
      return;
    }
  }, [
    activeConfigItem,
    clearConfigHighlight,
    configEditorText,
    ganttConfig,
    handleCloseConfigEditor,
    setConfigEditorError,
    setGanttConfig,
    setMessages,
    setProcessSortMode
  ]);

  // Widget editor handlers
  const clearWidgetHighlight = useCallback(() => {
    if (widgetHighlightTimeoutRef.current) {
      clearTimeout(widgetHighlightTimeoutRef.current);
      widgetHighlightTimeoutRef.current = null;
    }
    setWidgetHighlightId(null);
  }, [setWidgetHighlightId]);

  const handleOpenWidgetEditor = useCallback(
    (widget, options = {}) => {
      if (!widget) return;
      const { highlight = false } = options;
      const serialized = JSON.stringify(
        {
          id: widget.id,
          name: widget.name,
          html: widget.html,
          listeners: widget.listeners,
          description: widget.description
        },
        null,
        2
      );
      setActiveWidget(widget);
      setWidgetEditorText(serialized);
      setWidgetEditorError('');
      if (highlight) {
        setWidgetHighlightId(widget.id);
        if (widgetHighlightTimeoutRef.current) {
          clearTimeout(widgetHighlightTimeoutRef.current);
        }
        widgetHighlightTimeoutRef.current = setTimeout(() => {
          setWidgetHighlightId(null);
          widgetHighlightTimeoutRef.current = null;
        }, 3500);
      } else {
        clearWidgetHighlight();
      }
    },
    [
      clearWidgetHighlight,
      setActiveWidget,
      setWidgetEditorError,
      setWidgetEditorText,
      setWidgetHighlightId
    ]
  );

  const { handleSendMessage, handleKeyPress } = useChatAgent({
    inputMessage,
    isStreaming,
    selectedImageId,
    savedImages,
    messages,
    data,
    ganttConfig,
    startTime,
    endTime,
    activeConfigItem,
    dataSchema,
    fieldMapping,
    isWidgetAgentMode,
    widgetConfig,
    widgets,
    setMessages,
    setInputMessage,
    setIsStreaming,
    setCurrentStreamingMessage,
    setGanttConfig,
    setProcessSortMode,
    setTracksConfig,
    setWidgets,
    setWidgetConfig,
    handleOpenConfigEditor,
    handleOpenWidgetEditor
  });

  const handleCloseWidgetEditor = useCallback(() => {
    clearWidgetHighlight();
    setActiveWidget(null);
    setWidgetEditorText('');
    setWidgetEditorError('');
  }, [clearWidgetHighlight, setActiveWidget, setWidgetEditorError, setWidgetEditorText]);

  const handleSaveWidgetEditor = useCallback(() => {
    if (!activeWidget) return;
    try {
      const parsed = widgetEditorText ? JSON.parse(widgetEditorText) : null;
      if (!parsed || !parsed.id) {
        throw new Error('Widget must have an id.');
      }
      const updatedWidget = normalizeWidget(parsed);
      setWidgets((prev) => {
        const index = prev.findIndex((w) => w.id === activeWidget.id);
        if (index === -1) {
          // New widget - shouldn't happen via editor, but handle gracefully
          return [...prev, updatedWidget];
        }
        const updated = [...prev];
        updated[index] = updatedWidget;
        return updated;
      });
      clearWidgetHighlight();
      setMessages((prev) => [
        ...prev,
        {
          role: 'system',
          content: `✅ Updated widget: ${updatedWidget.name}`
        }
      ]);
      setWidgetEditorError('');
      handleCloseWidgetEditor();
    } catch (error) {
      setWidgetEditorError(`Invalid JSON: ${error.message}`);
      return;
    }
  }, [
    activeWidget,
    clearWidgetHighlight,
    handleCloseWidgetEditor,
    setMessages,
    setWidgetEditorError,
    setWidgets,
    widgetEditorText
  ]);

  const handleDeleteWidget = useCallback(
    (widgetId) => {
      setWidgets((prev) => prev.filter((w) => w.id !== widgetId));
      if (activeWidget?.id === widgetId) {
        handleCloseWidgetEditor();
      }
      setMessages((prev) => [
        ...prev,
        {
          role: 'system',
          content: `🗑️ Widget deleted`
        }
      ]);
    },
    [activeWidget, handleCloseWidgetEditor, setMessages, setWidgets]
  );

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
          <div
            style={{
              backgroundColor: '#fee',
              border: '1px solid #fcc',
              padding: '15px',
              borderRadius: '4px',
              color: '#c33',
              textAlign: 'center',
              fontFamily: 'system-ui'
            }}
          >
            Error loading data: {error}
            <br />
            Start the API server at {API_URL}, place {FRONTEND_TRACE_LABEL} in the public folder, or
            upload a trace file.
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
              <span className="upload-hint">
                Used when backend and public trace are unavailable
              </span>
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

  return (
    <div className="App">
      <div className="main-content">
        <LeftPanel>
          <WidgetArea widgets={widgets} widgetConfig={widgetConfig} widgetAreaRef={widgetAreaRef} />
          <GanttChart
            chartRef={chartRef}
            minimapRef={minimapRef}
            xAxisRef={xAxisRef}
            yAxisRef={yAxisRef}
            drawingOverlayRef={drawingOverlayRef}
            isDrawingMode={isDrawingMode}
            brushSize={brushSize}
            brushColor={brushColor}
            yAxisWidth={yAxisWidth}
          />
        </LeftPanel>

        <RightPanel>
          <div className="chat-header">
            <h3>Chart Assistant</h3>
            <p className="chat-subtitle">Ask questions about your data</p>
          </div>

          <ConfigPanel
            configSpec={GANTT_CONFIG_UI_SPEC}
            activeConfigItem={activeConfigItem}
            configHighlightId={configHighlightId}
            onOpenConfigEditor={handleOpenConfigEditor}
            widgets={widgets}
            activeWidget={activeWidget}
            widgetHighlightId={widgetHighlightId}
            onOpenWidgetEditor={handleOpenWidgetEditor}
          />

          <ChatMessages
            messages={messages}
            isStreaming={isStreaming}
            currentStreamingMessage={currentStreamingMessage}
            chatEndRef={chatEndRef}
            parseMessageSegments={parseMessageSegments}
          />

          <ImageGallery
            savedImages={savedImages}
            selectedImageId={selectedImageId}
            onSelectImage={handleSelectImage}
            onDeleteImage={handleDeleteImage}
          />

          <ChatInput
            inputMessage={inputMessage}
            setInputMessage={setInputMessage}
            isStreaming={isStreaming}
            onSend={handleSendMessage}
            onKeyPress={handleKeyPress}
            isWidgetAgentMode={isWidgetAgentMode}
            setIsWidgetAgentMode={setIsWidgetAgentMode}
            isDrawingMode={isDrawingMode}
            setIsDrawingMode={setIsDrawingMode}
            brushSize={brushSize}
            setBrushSize={setBrushSize}
            brushColor={brushColor}
            setBrushColor={setBrushColor}
            onClear={handleClear}
            onCaptureImage={handleCaptureImage}
            selectedImageId={selectedImageId}
          />

          <ConfigEditorModal
            activeConfigItem={activeConfigItem}
            configEditorText={configEditorText}
            setConfigEditorText={setConfigEditorText}
            configEditorError={configEditorError}
            configHighlightId={configHighlightId}
            configEditorTextareaRef={configEditorTextareaRef}
            onSave={handleSaveConfigEditor}
            onClose={handleCloseConfigEditor}
          />

          <WidgetEditorModal
            activeWidget={activeWidget}
            widgetEditorText={widgetEditorText}
            setWidgetEditorText={setWidgetEditorText}
            widgetEditorError={widgetEditorError}
            widgetHighlightId={widgetHighlightId}
            onSave={handleSaveWidgetEditor}
            onDelete={handleDeleteWidget}
            onClose={handleCloseWidgetEditor}
          />
        </RightPanel>
      </div>
    </div>
  );
}

export default App;

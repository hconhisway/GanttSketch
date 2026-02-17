import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './App.css';
import { GANTT_CONFIG, cloneGanttConfig, applyGanttConfigPatch, normalizeGanttConfig } from './config/ganttConfig';
import { GANTT_CONFIG_UI_SPEC } from './config/ganttConfigUiSpec';
import { cloneWidgetConfig } from './config/widgetConfig';
import {
  analyzeAndInitialize,
  deriveConfigFromMapping,
  dataMappingToFlatFieldMapping,
  dataMappingToLegacySchema,
  getTimeMultiplier,
  processEventsMinimal
} from './agents';
import { parseMessageSegments } from './utils/configPatch';
import { processTracksConfig } from './utils/dataProcessing';
import { inferProcessSortModeFromRule } from './utils/processOrder';
import { buildConfigBundle, downloadConfigBundle } from './utils/configBundle';
import {
  getHierarchyFieldsFromMapping,
  normalizeHierarchyFeatures,
  pruneHierarchyConfig
} from './utils/hierarchy';
import { WidgetArea } from './components/widget/WidgetArea';
import { GanttChart } from './components/chart/GanttChart';
import { ConfigPanel } from './components/config/ConfigPanel';
import { ChatMessages } from './components/chat/ChatMessages';
import { ImageGallery } from './components/ImageGallery';
import { ChatInput } from './components/chat/ChatInput';
import { ApiConfigModal } from './components/chat/ApiConfigModal';
import { ConfigEditorModal } from './components/config/ConfigEditorModal';
import { DataSetupModal } from './components/config/DataSetupModal';
import { WidgetEditorModal } from './components/widget/WidgetEditorModal';
import { LeftPanel } from './components/layout/LeftPanel';
import { RightPanel } from './components/layout/RightPanel';
import { PerfOverlay } from './components/PerfOverlay';
import { useDataFetching } from './hooks/useDataFetching';
import { useProcessAggregates } from './hooks/useProcessAggregates';
import { useChatAgent } from './hooks/useChatAgent';
import { useChartRenderer } from './hooks/useChartRenderer';
import { useConfigEditor } from './hooks/useConfigEditor';
import { useWidgetEditor } from './hooks/useWidgetEditor';
import { useWidgetBindings } from './hooks/useWidgetBindings';
import { useImageCapture } from './hooks/useImageCapture';
import type { ChatMessage } from './types/chat';
import type { NormalizedEvent, TracksConfig } from './types/data';
import type { GanttConfig, GanttDataMapping, ProcessSortMode } from './types/ganttConfig';
import type { Widget, WidgetConfig } from './types/widget';
import type { ViewState } from './types/viewState';
import type { SpanSoAChunkBundle } from './utils/soaBuffers';
import { perfMetrics } from './utils/perfMetrics';
import {
  loadSessionState,
  saveSessionState,
  parseSessionIdFromHash
} from './utils/sessionStore';
import { getLLMConfig, setLLMConfig } from './config/llmConfig';

type ViewRange = { start: number; end: number };
type WidgetBinding = { element: Element; event: string; handler: EventListener };

// API configuration: use same origin in browser so requests hit the server the user is visiting.
const API_URL =
  process.env.REACT_APP_API_URL ||
  (typeof window !== 'undefined'
    ? `${window.location.origin}/get-events`
    : 'http://127.0.0.1:8080/get-events');
// Use same origin at runtime so export goes to the server the user is visiting (avoids
// deploy builds with localhost baking in and requests hitting the visitor's machine).
const EXPORT_ANYWIDGET_URL =
  process.env.REACT_APP_EXPORT_ANYWIDGET_URL ||
  (typeof window !== 'undefined'
    ? `${window.location.origin}/api/export-anywidget`
    : 'https://virtranoteapp.sci.utah.edu/api/export-anywidget');
const FRONTEND_TRACE_URL = `${process.env.PUBLIC_URL || ''}/unet3d_a100--verify-1.pfw`;
const FRONTEND_TRACE_LABEL = 'unet3d_a100--verify-1.pfw';
const DEFAULT_END_US = 2e15; // Large enough for epoch-microsecond traces (~1.76e15 typical); 100_000_000 would filter out most events

function App() {
  const getInitialViewState = (): ViewState => ({
    timeDomain: [0, DEFAULT_END_US],
    viewportPxWidth: 0,
    devicePixelRatio: typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1,
    pixelWindow: 1,
    visibleLaneRange: [0, 0],
    visibleLaneIds: [],
    laneOrder: [],
    filters: [],
    scrollTop: 0,
    selection: null,
    expandedHierarchy1Ids: [],
    lastInteractionAt: 0
  });
  const chartRef = useRef<HTMLDivElement>(null!);
  const minimapRef = useRef<HTMLDivElement>(null!);
  const xAxisRef = useRef<HTMLDivElement>(null!);
  const yAxisRef = useRef<HTMLDivElement>(null!);
  const chatEndRef = useRef<HTMLDivElement>(null!);
  const drawingOverlayRef = useRef<any>(null);
  const widgetAreaRef = useRef<HTMLDivElement>(null!);
  const widgetHandlersRef = useRef<WidgetBinding[]>([]);
  const ganttConfigRef = useRef<GanttConfig | null>(null);
  const tracksConfigRef = useRef<TracksConfig | null>(null);
  const widgetApiRef = useRef<any>(null);
  const redrawRef = useRef<(() => void) | null>(null);
  const viewStateRef = useRef<ViewState>(getInitialViewState());
  const viewRangeRef = useRef<ViewRange>({ start: 0, end: DEFAULT_END_US });
  const fetchRangeRef = useRef<ViewRange>({ start: 0, end: DEFAULT_END_US });
  const forkRelationsRef = useRef({
    parentByHierarchy1: new Map<string, string | null>(),
    childrenByHierarchy1: new Map<string, string[]>(),
    edges: [] as any[]
  });
  const forkLoggedRef = useRef(false);
  const [data, setData] = useState<NormalizedEvent[]>([]);
  const [rawEvents, setRawEvents] = useState<any[] | null>(null);
  const [dataMapping, setDataMapping] = useState<GanttDataMapping | null>(null); // Universal data mapping
  const [loading, setLoading] = useState(true);
  const [, setIsFetching] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [obd, setObd] = useState<[number, number, number]>([0, DEFAULT_END_US, 1]); // [begin, end, bins]
  const [startTime] = useState(0);
  const [endTime, setEndTime] = useState(DEFAULT_END_US);
  const [bins] = useState(1000);
  const [viewState, setViewState] = useState<ViewState>(getInitialViewState);
  const [processAggregates, setProcessAggregates] = useState<Map<string, any[]>>(new Map());
  const [threadsByHierarchy1, setThreadsByHierarchy1] = useState<Map<string, any>>(new Map());
  const [renderSoA, setRenderSoA] = useState<SpanSoAChunkBundle | null>(null);
  const [isSoaPacking, setIsSoaPacking] = useState(false);
  const [isMappingProcessing, setIsMappingProcessing] = useState(false);
  const [yAxisWidth, setYAxisWidth] = useState(GANTT_CONFIG?.layout?.yAxis?.baseWidth ?? 180);
  const [ganttLoadingVisible, setGanttLoadingVisible] = useState(false);
  const ganttLoadingStartRef = useRef<number | null>(null);
  const ganttLoadingHideRef = useRef<number | null>(null);

  const viewRange = useMemo(
    () => ({ start: viewState.timeDomain[0], end: viewState.timeDomain[1] }),
    [viewState.timeDomain]
  );
  const expandedHierarchy1Ids = viewState.expandedHierarchy1Ids;

  const setViewStateSafe = useCallback(
    (updater: React.SetStateAction<ViewState>) => {
      setViewState((prev) => {
        const base = viewStateRef.current || prev;
        const next =
          typeof updater === 'function'
            ? (updater as (prevState: ViewState) => ViewState)(base)
            : updater;
        viewStateRef.current = next;
        return next;
      });
    },
    []
  );

  const setViewRange = useCallback(
    (updater: React.SetStateAction<ViewRange>) => {
      setViewStateSafe((prev) => {
        const nextRange =
          typeof updater === 'function'
            ? (updater as (prevRange: ViewRange) => ViewRange)({
                start: prev.timeDomain[0],
                end: prev.timeDomain[1]
              })
            : updater;
        const nextStart = Number(nextRange.start);
        const nextEnd = Number(nextRange.end);
        if (!Number.isFinite(nextStart) || !Number.isFinite(nextEnd)) return prev;
        if (nextStart === prev.timeDomain[0] && nextEnd === prev.timeDomain[1]) return prev;
        return { ...prev, timeDomain: [nextStart, nextEnd] };
      });
    },
    [setViewStateSafe]
  );

  const setExpandedHierarchy1Ids = useCallback(
    (updater: React.SetStateAction<string[]>) => {
      setViewStateSafe((prev) => {
        const nextExpanded =
          typeof updater === 'function'
            ? (updater as (prevList: string[]) => string[])(prev.expandedHierarchy1Ids)
            : updater;
        if (nextExpanded === prev.expandedHierarchy1Ids) return prev;
        return { ...prev, expandedHierarchy1Ids: nextExpanded };
      });
    },
    [setViewStateSafe]
  );

  // Chat state
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputMessage, setInputMessage] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [currentStreamingMessage, setCurrentStreamingMessage] = useState('');
  const [isExportingAnywidget, setIsExportingAnywidget] = useState(false);

  // Drawing state
  const [isDrawingMode, setIsDrawingMode] = useState(false);
  const [brushSize, setBrushSize] = useState(3);
  const [brushColor, setBrushColor] = useState('#ff0000');
  const [ganttConfig, setGanttConfig] = useState<GanttConfig>(() => cloneGanttConfig());
  useEffect(() => {
    // One-time migration for malformed historical label rules in memory.
    setGanttConfig((prev) => normalizeGanttConfig(prev));
  }, []);
  const [processSortMode, setProcessSortMode] = useState<ProcessSortMode>(
    inferProcessSortModeFromRule(GANTT_CONFIG.yAxis?.hierarchy1OrderRule)
  ); // 'fork' | 'default'
  const [localTraceText, setLocalTraceText] = useState('');
  const [localTraceName, setLocalTraceName] = useState('');
  const [showUploadPrompt, setShowUploadPrompt] = useState(false);
  const [showApiConfig, setShowApiConfig] = useState(false);
  const configFileInputRef = useRef<HTMLInputElement | null>(null);

  // Image storage for LLM
  const {
    savedImages,
    selectedImageId,
    handleCaptureImage,
    handleDeleteImage,
    handleSelectImage
  } = useImageCapture({
    drawingOverlayRef,
    setMessages
  });

  // Tracks configuration
  const [tracksConfig, setTracksConfig] = useState<TracksConfig>({
    sortMode: 'asc', // 'asc', 'desc', 'custom', 'grouped'
    customSort: undefined,
    groups: undefined,
    filter: undefined,
    trackList: undefined
  });

  const trackConfigResult = useMemo(
    () => processTracksConfig(data, tracksConfig),
    [data, tracksConfig]
  );
  const chartData = trackConfigResult.processedData;
  const hierarchyLevels = Math.max(1, Number(dataMapping?.features?.hierarchyLevels ?? 2));
  const hierarchy1Lod = ganttConfig?.performance?.hierarchy1LOD;
  const mergeUtilGap =
    hierarchyLevels >= 1
      ? Number(hierarchy1Lod?.mergeUtilGap ?? ganttConfig?.xAxis?.mergeGapRatio ?? 0.002)
      : 0.002;

  // Derive backward-compat values from dataMapping for agents
  const dataSchema = useMemo(
    () => (dataMapping ? dataMappingToLegacySchema(dataMapping) : null),
    [dataMapping]
  );
  const fieldMapping = useMemo(
    () => (dataMapping ? dataMappingToFlatFieldMapping(dataMapping) : null),
    [dataMapping]
  );

  // Build config panel spec: Data Mapping (single consolidated entry) + Gantt Config sections
  const configSpec = useMemo(() => {
    const dataMappingSection = {
      id: 'dataMapping',
      title: 'Data Mapping',
      description: 'How data fields map to chart elements (auto-detected, editable)',
      items: [
        {
          id: 'dataMapping',
          label: 'Edit Data Mapping',
          path: 'dataMapping',
          description:
            'Time axis, hierarchy, identity, color, bar label, tooltip, schema, and feature flags. Lane attribute selection is configured in ganttConfig.yAxis.hierarchy2LaneRule.',
          example: JSON.stringify(
            {
              xAxis: { startField: 'ts', endField: null, durationField: 'dur', timeUnit: 'us' },
              yAxis: { hierarchyFields: ['pid', 'tid'], parentField: 'ppid' },
              identity: { nameField: 'name', categoryField: 'cat', idField: 'id' },
              color: { keyField: 'pid' },
              barLabel: { field: 'name' },
              tooltip: {
                fields: [
                  { sourceField: 'name', label: 'Name', format: 'none' },
                  { sourceField: 'ts', label: 'Start', format: 'time' },
                  { sourceField: 'dur', label: 'Duration', format: 'duration' }
                ],
                showArgs: true,
                argsField: 'args'
              },
              schema: { dataFormat: '', allFields: [], notes: '' },
              features: {
                hierarchyLevels: 2,
                hierarchyFields: ['pid', 'tid'],
                forkTree: true,
                dependencyLines: false,
                dependencyField: null,
                lanePacking: 'autoPack',
                flameChart: false,
                colorStrategy: 'hierarchy1'
              }
            },
            null,
            2
          ),
          source: 'dataMapping'
          // no mappingKey = edit entire dataMapping object
        }
      ]
    };
    const levelCount = Math.max(1, Number(dataMapping?.features?.hierarchyLevels ?? 2));
    const yAxisDynamicItems: Array<{
      id: string;
      label: string;
      path: string;
      description: string;
      example: string;
    }> = [];
    for (let level = 3; level <= levelCount; level += 1) {
      yAxisDynamicItems.push(
        {
          id: `yAxis.hierarchy${level}Field`,
          label: `Hierarchy ${level} Field`,
          path: `yAxis.hierarchy${level}Field`,
          description: 'Field path for this hierarchy level.',
          example: `"hierarchy${level}"`
        },
        {
          id: `yAxis.hierarchy${level}LaneRule`,
          label: `Hierarchy ${level} Lane Rule`,
          path: `yAxis.hierarchy${level}LaneRule`,
          description: 'Lane arrangement rule for this hierarchy level.',
          example: JSON.stringify({ type: 'transform', name: 'autoPack' }, null, 2)
        },
        {
          id: `yAxis.hierarchy${level}LabelRule`,
          label: `Hierarchy ${level} Label Rule`,
          path: `yAxis.hierarchy${level}LabelRule`,
          description: 'Label expression for this hierarchy level.',
          example: JSON.stringify(
            {
              type: 'expr',
              expr: {
                op: 'concat',
                args: [
                  { op: 'var', name: `hierarchy${level}Field` },
                  ': ',
                  { op: 'var', name: `hierarchy${level}` }
                ]
              }
            },
            null,
            2
          )
        }
      );
    }
    const performanceItems: Array<{
      id: string;
      label: string;
      path: string;
      description: string;
      example: string;
    }> = [];
    for (let level = 1; level <= levelCount; level += 1) {
      if (level === 1) {
        performanceItems.push({
          id: 'performance.hierarchy1LOD.mergeUtilGap',
          label: 'Hierarchy 1 LOD Merge Util Gap',
          path: 'performance.hierarchy1LOD.mergeUtilGap',
          description: 'Merge gap as fraction of time window for hierarchy 1 LOD.',
          example: '0.002'
        });
      } else {
        performanceItems.push({
          id: `performance.hierarchy${level}LOD.pixelWindow`,
          label: `Hierarchy ${level} LOD Pixel Window`,
          path: `performance.hierarchy${level}LOD.pixelWindow`,
          description: 'Pixel window size for this hierarchy LOD.',
          example: '1'
        });
      }
    }
    const webglEnabledItem = {
      id: 'performance.webglEnabled',
      label: 'Enable WebGL',
      path: 'performance.webglEnabled',
      description: 'Enable WebGL rendering when available.',
      example: 'true'
    };
    const showOverlayItem = {
      id: 'performance.showOverlay',
      label: 'Show Overlay',
      path: 'performance.showOverlay',
      description: 'Show performance overlay.',
      example: 'false'
    };
    const streamingEnabledItem = {
      id: 'performance.streamingEnabled',
      label: 'Streaming Mode',
      path: 'performance.streamingEnabled',
      description: 'Enable viewport streaming fetch.',
      example: 'false'
    };
    const streamingMaxReqItem = {
      id: 'performance.streamingMaxReqPerSec',
      label: 'Streaming Max Req/sec',
      path: 'performance.streamingMaxReqPerSec',
      description: 'Max streaming requests per second.',
      example: '1'
    };
    const streamingBufferItem = {
      id: 'performance.streamingBufferFactor',
      label: 'Streaming Buffer Factor',
      path: 'performance.streamingBufferFactor',
      description: 'Buffer size as fraction of viewport span.',
      example: '0.5'
    };
    const streamingSimulateItem = {
      id: 'performance.streamingSimulate',
      label: 'Streaming Simulate',
      path: 'performance.streamingSimulate',
      description: 'Simulate streaming using full data (debug).',
      example: 'true'
    };
    const specWithPerformance = GANTT_CONFIG_UI_SPEC.map((section) => {
      if (section.id === 'performance') {
        return {
          ...section,
          items: [
            ...performanceItems,
            webglEnabledItem,
            showOverlayItem,
            streamingEnabledItem,
            streamingMaxReqItem,
            streamingBufferItem,
            streamingSimulateItem
          ]
        };
      }
      if (section.id === 'yAxis' && yAxisDynamicItems.length > 0) {
        return {
          ...section,
          items: [...section.items, ...yAxisDynamicItems]
        };
      }
      return section;
    });
    return [dataMappingSection, ...specWithPerformance];
  }, [dataMapping]);

  const updateTimeRangeFromEvents = useCallback(
    (events: any[]) => {
      if (!Array.isArray(events) || events.length === 0) return;
      const dataMaxEnd = events.reduce(
        (max: number, e: any) => Math.max(max, Number(e.end) || 0),
        0
      );
      if (!Number.isFinite(dataMaxEnd) || dataMaxEnd <= 0) return;
      const prevMax = Array.isArray(obd) ? Number(obd[1]) : DEFAULT_END_US;
      const atCurrentMax = Number(endTime) >= prevMax;
      if (atCurrentMax && Math.abs(dataMaxEnd - prevMax) > 1) {
        setObd([0, Math.ceil(dataMaxEnd), 1]);
        if (Number(endTime) > dataMaxEnd) setEndTime(Math.ceil(dataMaxEnd));
      } else if (dataMaxEnd > prevMax) {
        setObd([0, Math.ceil(dataMaxEnd), 1]);
      }
    },
    [obd, endTime, setObd, setEndTime]
  );

  const applyMappingToRawEvents = useCallback(
    async (mapping: GanttDataMapping) => {
      if (!rawEvents || rawEvents.length === 0) return;
      setIsMappingProcessing(true);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      try {
        const flatMapping = dataMappingToFlatFieldMapping(mapping);
        const hierarchyFields = getHierarchyFieldsFromMapping(mapping);
        const timeMultiplier = getTimeMultiplier(mapping.xAxis.timeUnit);
        const processed = processEventsMinimal(rawEvents, flatMapping, timeMultiplier, hierarchyFields);
        setData(processed);
        updateTimeRangeFromEvents(processed);

        const derived = deriveConfigFromMapping(mapping);
        if (derived && Object.keys(derived).length > 0) {
          const hierarchyLevels = Math.max(
            1,
            Number(mapping?.features?.hierarchyLevels || hierarchyFields.length || 1)
          );
          const prunedBase = pruneHierarchyConfig(ganttConfig, hierarchyLevels);
          const nextConfig = applyGanttConfigPatch(prunedBase, derived);
          setGanttConfig(nextConfig);
          if (derived?.yAxis?.hierarchy1OrderRule) {
            setProcessSortMode(inferProcessSortModeFromRule(derived.yAxis.hierarchy1OrderRule));
          }
        }
      } finally {
        setIsMappingProcessing(false);
      }
    },
    [
      rawEvents,
      setData,
      updateTimeRangeFromEvents,
      ganttConfig,
      setGanttConfig,
      setProcessSortMode
    ]
  );

  // Config UI editor state
  const {
    activeConfigItem,
    configEditorText,
    setConfigEditorText,
    configEditorError,
    configHighlightId,
    configEditorTextareaRef,
    handleOpenConfigEditor,
    handleCloseConfigEditor,
    handleSaveConfigEditor,
    handleExportDataMapping
  } = useConfigEditor({
    ganttConfig,
    setGanttConfig,
    setProcessSortMode,
    setMessages,
    dataMapping,
    setDataMapping,
    onApplyDataMapping: applyMappingToRawEvents
  });

  // Widget configuration and instances
  const [widgetConfig, setWidgetConfig] = useState<WidgetConfig>(() => cloneWidgetConfig());
  const [widgets, setWidgets] = useState<Widget[]>([]);

  // Widget agent mode toggle
  const [isWidgetAgentMode, setIsWidgetAgentMode] = useState(false);

  // Widget editor state (similar to config editor)
  const {
    activeWidget,
    widgetEditorText,
    setWidgetEditorText,
    widgetEditorError,
    widgetHighlightId,
    handleOpenWidgetEditor,
    handleCloseWidgetEditor,
    handleSaveWidgetEditor,
    handleDeleteWidget
  } = useWidgetEditor({
    setWidgets,
    setMessages
  });

  // Session load: hydrate from IndexedDB on mount (Perfetto-style per-session isolation)
  const sessionLoadedRef = useRef(false);
  useEffect(() => {
    if (sessionLoadedRef.current) return;
    sessionLoadedRef.current = true;
    const sessionId = parseSessionIdFromHash();
    if (!sessionId) return;
    loadSessionState(sessionId).then((state) => {
      if (!state) return;
      if (state.localTraceText !== undefined) setLocalTraceText(state.localTraceText);
      if (state.localTraceName !== undefined) setLocalTraceName(state.localTraceName);
      if (state.dataMapping !== undefined) setDataMapping(state.dataMapping as GanttDataMapping);
      if (state.ganttConfig !== undefined)
        setGanttConfig(normalizeGanttConfig(state.ganttConfig as GanttConfig));
      if (state.tracksConfig !== undefined) setTracksConfig(state.tracksConfig as TracksConfig);
      if (state.widgetConfig !== undefined) setWidgetConfig(state.widgetConfig as WidgetConfig);
      if (state.widgets !== undefined) setWidgets(state.widgets as Widget[]);
      if (state.messages !== undefined) setMessages(state.messages as ChatMessage[]);
      if (state.llmConfig && Object.keys(state.llmConfig).length > 0) {
        const c = state.llmConfig;
        const current = getLLMConfig();
        setLLMConfig({
          provider: c.provider ? { ...current.provider, name: c.provider } : undefined,
          apiKey: c.apiKey,
          apiEndpoint: c.apiEndpoint,
          model: c.model,
          temperature: c.temperature,
          maxTokens: c.maxTokens,
          useMaxCompletionParam: c.useMaxCompletionParam
        });
      }
    }).catch((err) => console.warn('Session load failed:', err));
  }, []);

  // Debounced session save: persist state to IndexedDB when it changes
  const saveDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const sessionId = parseSessionIdFromHash();
    if (!sessionId) return;
    if (saveDebounceRef.current) clearTimeout(saveDebounceRef.current);
    saveDebounceRef.current = setTimeout(() => {
      const cfg = getLLMConfig();
      saveSessionState(sessionId, {
        localTraceText,
        localTraceName,
        dataMapping,
        ganttConfig,
        tracksConfig,
        widgetConfig,
        widgets,
        messages,
        llmConfig: {
          provider: cfg.provider.name,
          apiKey: cfg.apiKey,
          apiEndpoint: cfg.apiEndpoint,
          model: cfg.model,
          temperature: cfg.temperature,
          maxTokens: cfg.maxTokens,
          useMaxCompletionParam: cfg.useMaxCompletionParam
        }
      }).catch((err) => console.warn('Session save failed:', err));
      saveDebounceRef.current = null;
    }, 800);
    return () => {
      if (saveDebounceRef.current) clearTimeout(saveDebounceRef.current);
    };
  }, [
    localTraceText,
    localTraceName,
    dataMapping,
    ganttConfig,
    tracksConfig,
    widgetConfig,
    widgets,
    messages
  ]);

  const saveSessionNow = useCallback(() => {
    const sessionId = parseSessionIdFromHash();
    if (!sessionId) return;
    const cfg = getLLMConfig();
    saveSessionState(sessionId, {
      localTraceText,
      localTraceName,
      dataMapping,
      ganttConfig,
      tracksConfig,
      widgetConfig,
      widgets,
      messages,
      llmConfig: {
        provider: cfg.provider.name,
        apiKey: cfg.apiKey,
        apiEndpoint: cfg.apiEndpoint,
        model: cfg.model,
        temperature: cfg.temperature,
        maxTokens: cfg.maxTokens,
        useMaxCompletionParam: cfg.useMaxCompletionParam
      }
    }).catch((err) => console.warn('Session save failed:', err));
  }, [
    localTraceText,
    localTraceName,
    dataMapping,
    ganttConfig,
    tracksConfig,
    widgetConfig,
    widgets,
    messages
  ]);

  const { streamingStats } = useDataFetching({
    obd,
    startTime,
    endTime,
    bins,
    localTraceText,
    dataMapping,
    ganttConfig,
    viewStateRef,
    apiUrl: API_URL,
    traceUrl: FRONTEND_TRACE_URL,
    defaultEndUs: DEFAULT_END_US,
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
    configSourceLabel: localTraceName || FRONTEND_TRACE_LABEL,
    autoAnalyzeOnFirstLoad: false
  });

  const handleToggleStreaming = useCallback(
    (enabled: boolean) => {
      setGanttConfig((prev) =>
        applyGanttConfigPatch(prev, {
          performance: { streamingEnabled: enabled }
        })
      );
    },
    [setGanttConfig]
  );

  const showDataSetupModal = Boolean(
    rawEvents && rawEvents.length > 0 && !dataMapping
  );
  const showGanttLoading = isAnalyzing || isSoaPacking || isMappingProcessing;
  const GANTT_LOADING_MIN_MS = 350;
  const ganttLoadingLabel = 'Loading...';
  const streamingEnabled = ganttConfig?.performance?.streamingEnabled === true;
  const streamingSimulated =
    streamingEnabled && ganttConfig?.performance?.streamingSimulate === true;

  useEffect(() => {
    if (showGanttLoading) {
      ganttLoadingStartRef.current = performance.now();
      if (ganttLoadingHideRef.current) {
        window.clearTimeout(ganttLoadingHideRef.current);
        ganttLoadingHideRef.current = null;
      }
      setGanttLoadingVisible(true);
      return;
    }

    if (!ganttLoadingVisible) return;
    const startedAt = ganttLoadingStartRef.current ?? performance.now();
    const elapsed = performance.now() - startedAt;
    const remaining = Math.max(0, GANTT_LOADING_MIN_MS - elapsed);
    if (ganttLoadingHideRef.current) {
      window.clearTimeout(ganttLoadingHideRef.current);
    }
    ganttLoadingHideRef.current = window.setTimeout(() => {
      setGanttLoadingVisible(false);
      ganttLoadingHideRef.current = null;
    }, remaining);
    return () => {
      if (ganttLoadingHideRef.current) {
        window.clearTimeout(ganttLoadingHideRef.current);
        ganttLoadingHideRef.current = null;
      }
    };
  }, [showGanttLoading, ganttLoadingVisible]);


  const handleRunDataAnalysis = useCallback(async () => {
    if (!rawEvents || rawEvents.length === 0) {
      setMessages((prev) => [
        ...prev,
        { role: 'system', content: '⚠️ No raw events available to analyze.' }
      ]);
      return;
    }

    setIsAnalyzing(true);
    try {
      const analysisResult = await analyzeAndInitialize(rawEvents);
      setDataMapping(analysisResult.dataMapping);
      if (Array.isArray(analysisResult.events) && analysisResult.events.length > 0) {
        setData(analysisResult.events);
        updateTimeRangeFromEvents(analysisResult.events);
      }

      if (analysisResult.config && Object.keys(analysisResult.config).length > 0) {
        const nextConfig = applyGanttConfigPatch(ganttConfig, analysisResult.config);
        setGanttConfig(nextConfig);
        if (analysisResult.config.yAxis?.hierarchy1OrderRule) {
          setProcessSortMode(
            inferProcessSortModeFromRule(analysisResult.config.yAxis.hierarchy1OrderRule)
          );
        }
      }

      try {
        // Bundle stores only the dataMapping (including features).
        // Config is derived deterministically from the mapping at load time.
        const bundle = buildConfigBundle(
          analysisResult.dataMapping,
          undefined,
          localTraceName || FRONTEND_TRACE_LABEL
        );
        downloadConfigBundle(bundle);
      } catch (error) {
        console.warn('Failed to download config bundle:', error);
      }

      setMessages((prev) => [
        ...prev,
        { role: 'system', content: '✅ Data analysis completed. Configuration bundle downloaded.' }
      ]);
    } catch (error: any) {
      console.error('Error running data analysis:', error);
      setMessages((prev) => [
        ...prev,
        { role: 'system', content: `⚠️ Data analysis failed: ${error?.message || error}` }
      ]);
    } finally {
      setIsAnalyzing(false);
    }
  }, [
    rawEvents,
    ganttConfig,
    localTraceName,
    setData,
    setDataMapping,
    setGanttConfig,
    setMessages,
    setProcessSortMode,
    updateTimeRangeFromEvents
  ]);

  const handleTriggerConfigLoad = useCallback(() => {
    configFileInputRef.current?.click();
  }, []);

  const handleConfigFileChange = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files && event.target.files[0];
      if (!file) return;
      event.target.value = '';

      try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        const mapping = parsed?.dataMapping || (parsed?.xAxis && parsed?.yAxis ? parsed : null);

        if (!mapping) {
          throw new Error('Missing dataMapping in the config file.');
        }

        const typedMapping = normalizeHierarchyFeatures(mapping as GanttDataMapping);
        setDataMapping(typedMapping);
        await applyMappingToRawEvents(typedMapping);

        if (parsed?.ganttConfig) {
          setGanttConfig(normalizeGanttConfig(parsed.ganttConfig));
          setProcessSortMode(inferProcessSortModeFromRule(parsed.ganttConfig?.yAxis?.hierarchy1OrderRule ?? parsed.ganttConfig?.yAxis?.processOrderRule));
        } else if (parsed?.ganttConfigPatch) {
          const nextConfig = applyGanttConfigPatch(ganttConfig, parsed.ganttConfigPatch);
          setGanttConfig(nextConfig);
          if (parsed.ganttConfigPatch?.yAxis?.hierarchy1OrderRule ?? parsed.ganttConfigPatch?.yAxis?.processOrderRule) {
            setProcessSortMode(
              inferProcessSortModeFromRule(parsed.ganttConfigPatch.yAxis?.hierarchy1OrderRule ?? parsed.ganttConfigPatch.yAxis?.processOrderRule)
            );
          }
        } else if (typedMapping.features) {
          // No explicit ganttConfig in the bundle — derive from mapping features
          const derived = deriveConfigFromMapping(typedMapping);
          if (derived && Object.keys(derived).length > 0) {
            const nextConfig = applyGanttConfigPatch(ganttConfig, derived);
            setGanttConfig(nextConfig);
            if (derived.yAxis?.hierarchy1OrderRule) {
              setProcessSortMode(inferProcessSortModeFromRule(derived.yAxis.hierarchy1OrderRule));
            }
          }
        }

        setMessages((prev) => [
          ...prev,
          { role: 'system', content: `✅ Config loaded: ${file.name}` }
        ]);
      } catch (error: any) {
        console.error('Failed to load config file:', error);
        setMessages((prev) => [
          ...prev,
          { role: 'system', content: `⚠️ Could not load config: ${error?.message || error}` }
        ]);
      }
    },
    [
      applyMappingToRawEvents,
      ganttConfig,
      setDataMapping,
      setGanttConfig,
      setMessages,
      setProcessSortMode
    ]
  );

  useProcessAggregates({
    data: chartData,
    obd,
    startTime,
    endTime,
    mergeUtilGap,
    hierarchy2LaneRule: ganttConfig?.yAxis?.hierarchy2LaneRule,
    setThreadsByHierarchy1,
    setProcessAggregates,
    setExpandedHierarchy1Ids,
    threadsByHierarchy1,
    processAggregates
  });

  useChartRenderer({
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
    setViewState: setViewStateSafe,
    forkRelationsRef
  });

  useEffect(() => {
    ganttConfigRef.current = ganttConfig;
  }, [ganttConfig]);

  useEffect(() => {
    const globalAny = window as any;
    globalAny.__ganttPerfMetrics = perfMetrics;
  }, []);

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

  useWidgetBindings({
    widgets,
    widgetAreaRef,
    widgetApiRef,
    widgetHandlersRef
  });

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
  }, [configHighlightId, activeConfigItem, configEditorTextareaRef]);

  useEffect(() => {
    if (!configHighlightId) return;
    const selector = `.config-button[data-config-item-id="${configHighlightId}"]`;
    const button = document.querySelector(selector);
    if (button) {
      button.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [configHighlightId]);

  // Handle clear drawings
  const handleClear = useCallback(() => {
    if (drawingOverlayRef.current) {
      drawingOverlayRef.current.clearCanvas();
    }
  }, []);

  const handleExportAnywidget = useCallback(async () => {
    if (isExportingAnywidget) return;
    setIsExportingAnywidget(true);
    setMessages((prev) => [
      ...prev,
      { role: 'system', content: '⏳ Export started: running build + anywidget generation...' }
    ]);

    try {
      const response = await fetch(EXPORT_ANYWIDGET_URL, {
        method: 'POST'
      });

      if (!response.ok) {
        let errorMessage = `Export failed with status ${response.status}.`;
        try {
          const errorPayload = await response.json();
          const stage = errorPayload?.stage ? ` [${String(errorPayload.stage)}]` : '';
          if (errorPayload?.message) {
            errorMessage = `${String(errorPayload.message)}${stage}`;
          }
        } catch {
          // Fall back to generic status message when payload is not JSON.
        }
        throw new Error(errorMessage);
      }

      const blob = await response.blob();
      const contentDisposition = response.headers.get('content-disposition') || '';
      const fileNameMatch = contentDisposition.match(/filename="?([^"]+)"?/i);
      const fileName = fileNameMatch?.[1] || 'gantt_anywidget.py';

      const downloadUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = downloadUrl;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(downloadUrl);

      setMessages((prev) => [
        ...prev,
        { role: 'system', content: `✅ Anywidget export complete: ${fileName}` }
      ]);
    } catch (error: any) {
      console.error('Anywidget export failed:', error);
      setMessages((prev) => [
        ...prev,
        {
          role: 'system',
          content: `⚠️ Anywidget export failed: ${error?.message || error}. Start local export server with "npm run export:server".`
        }
      ]);
    } finally {
      setIsExportingAnywidget(false);
    }
  }, [isExportingAnywidget, setMessages]);

  const { handleSendMessage, handleKeyPress } = useChatAgent({
    inputMessage,
    isStreaming,
    selectedImageId,
    savedImages,
    messages,
    data,
    dataMapping,
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
    setDataMapping,
    setGanttConfig,
    setProcessSortMode,
    setTracksConfig,
    setWidgets,
    setWidgetConfig,
    handleOpenConfigEditor,
    handleOpenWidgetEditor,
    onApplyDataMapping: applyMappingToRawEvents
  });

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
      <PerfOverlay
        visible={Boolean(ganttConfig?.performance?.showOverlay)}
        streamingEnabled={streamingEnabled}
        streamingSimulated={streamingSimulated}
        streamingStats={streamingStats}
        onToggleStreaming={handleToggleStreaming}
      />
      <DataSetupModal
        open={showDataSetupModal}
        eventCount={rawEvents?.length ?? 0}
        isAnalyzing={isAnalyzing}
        onRunAnalysis={handleRunDataAnalysis}
        onLoadConfig={handleTriggerConfigLoad}
      />
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
            isBusy={ganttLoadingVisible}
            busyLabel={ganttLoadingLabel}
          />
        </LeftPanel>

        <RightPanel>
          <div className="chat-header">
            <h4>Customization Panel</h4>
            <button
              type="button"
              className="export-anywidget-btn"
              onClick={handleExportAnywidget}
              disabled={isExportingAnywidget}
              title="Run npm build + anywidget script and download .py file"
            >
              {isExportingAnywidget ? 'Exporting...' : 'Export Anywidget'}
            </button>
            {/* <p className="chat-subtitle">Ask questions about your data</p> */}
          </div>

          <ConfigPanel
            configSpec={configSpec}
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
            onOpenApiConfig={() => setShowApiConfig(true)}
          />

          <input
            ref={configFileInputRef}
            type="file"
            accept=".json,application/json"
            style={{ display: 'none' }}
            onChange={handleConfigFileChange}
          />

          <ApiConfigModal
            open={showApiConfig}
            onClose={() => setShowApiConfig(false)}
            onSave={saveSessionNow}
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
            onExport={handleExportDataMapping}
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

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
  const [isFetching, setIsFetching] = useState(false);
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
  const [backendHealth, setBackendHealth] = useState<any | null>(null);
  const [isUploadingTrace, setIsUploadingTrace] = useState(false);
  const [isReadingTrace, setIsReadingTrace] = useState(false);
  const [isUploadDragOver, setIsUploadDragOver] = useState(false);
  const [uploadUiMessage, setUploadUiMessage] = useState<string | null>(null);
  const [showApiConfig, setShowApiConfig] = useState(false);
  const traceFileInputRef = useRef<HTMLInputElement | null>(null);
  const configFileInputRef = useRef<HTMLInputElement | null>(null);
  const sessionId = useMemo(() => parseSessionIdFromHash() || '', []);

  const getApiOrigin = useCallback(() => {
    if (typeof window === 'undefined') return '';
    try {
      const u = new URL(API_URL, window.location.origin);
      return u.origin;
    } catch {
      return '';
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!showUploadPrompt) {
      setBackendHealth(null);
      return () => {
        cancelled = true;
      };
    }
    const origin = getApiOrigin();
    if (!origin) return () => {
      cancelled = true;
    };

    const healthUrl = sessionId
      ? `${origin}/health?session=${encodeURIComponent(sessionId)}`
      : `${origin}/health`;
    fetch(healthUrl, { cache: 'no-store' })
      .then((res) => {
        if (!res.ok) throw new Error(`health http ${res.status}`);
        return res.json();
      })
      .then((json) => {
        if (cancelled) return;
        setBackendHealth(json);
      })
      .catch(() => {
        if (cancelled) return;
        setBackendHealth({ status: 'unreachable' });
      });

    return () => {
      cancelled = true;
    };
  }, [getApiOrigin, showUploadPrompt, sessionId]);

  const uploadTraceToBackend = useCallback(
    async (file: File): Promise<boolean> => {
      const origin = getApiOrigin();
      if (!origin) {
        setError('Backend URL is not configured.');
        setUploadUiMessage('Backend URL is not configured or invalid.');
        setShowUploadPrompt(true);
        return false;
      }

      setUploadUiMessage(null);
      setIsUploadingTrace(true);
      try {
        const form = new FormData();
        form.append('file', file, file.name);
        form.append('format', 'auto');

        const uploadUrl = sessionId
          ? `${origin}/api/upload-trace?session=${encodeURIComponent(sessionId)}`
          : `${origin}/api/upload-trace`;
        const resp = await fetch(uploadUrl, {
          method: 'POST',
          body: form
        });

        let payload: any = null;
        const contentType = resp.headers.get('content-type') || '';
        if (!contentType.includes('application/json')) {
          // Most common cause: hitting the React dev server (returns index.html 200).
          const text = await resp.text().catch(() => '');
          const snippet = text ? text.slice(0, 200).replace(/\s+/g, ' ') : '';
          throw new Error(
            `Upload endpoint did not return JSON (got "${contentType || 'unknown'}"). ` +
              `You are likely not proxying /api/upload-trace to the backend. ` +
              `If using "npm start", set REACT_APP_API_URL=http://127.0.0.1:8080/get-events and restart, ` +
              `or configure nginx to proxy /api/upload-trace to :8080. ` +
              (snippet ? `Response starts with: ${snippet}` : '')
          );
        }

        try {
          payload = await resp.json();
        } catch (e) {
          throw new Error(
            'Upload endpoint returned invalid JSON. Check that /api/upload-trace is served by the Python backend.'
          );
        }

        if (!resp.ok) {
          const msg =
            payload?.error ||
            payload?.message ||
            `Upload failed (HTTP ${resp.status}).`;
          throw new Error(String(msg));
        }
        if (payload?.ok !== true) {
          const msg =
            payload?.error ||
            payload?.message ||
            'Upload failed: backend did not return ok=true.';
          throw new Error(String(msg));
        }

        // Clear local text mode so fetch path uses backend.
        setLocalTraceText('');
        setLocalTraceName(file.name || 'uploaded trace');
        setError(null);
        setUploadUiMessage(null);
        setShowUploadPrompt(false);
        setLoading(true);
        setIsFetching(true);
        return true;
      } catch (e: any) {
        const raw = e?.message ? String(e.message) : '';
        let friendly = 'Upload failed. Please check that the backend server is available.';
        if (raw && /not configured/i.test(raw)) {
          friendly = 'Backend URL is not configured or invalid.';
        } else if (raw && /(did not return json|not proxying|proxy)/i.test(raw)) {
          friendly =
            'Upload endpoint is not connected to the backend (missing proxy / reverse proxy configuration).';
        } else if (raw && /(failed to fetch|networkerror)/i.test(raw)) {
          friendly = 'Cannot reach the backend. Make sure it is running and reachable.';
        } else if (raw) {
          const trimmed = raw.length > 240 ? `${raw.slice(0, 240)}…` : raw;
          friendly = `Upload failed: ${trimmed}`;
        }
        setError(raw || 'Upload failed.');
        setUploadUiMessage(friendly);
        setShowUploadPrompt(true);
        return false;
      } finally {
        setIsUploadingTrace(false);
      }
    },
    [
      getApiOrigin,
      sessionId,
      setError,
      setIsFetching,
      setLoading,
      setLocalTraceName,
      setLocalTraceText,
      setShowUploadPrompt,
      setUploadUiMessage
    ]
  );

  const readFileAsText = useCallback((file: File) => {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('Failed to read uploaded file.'));
      reader.readAsText(file);
    });
  }, []);

  const handleTraceFileSelected = useCallback(
    async (file: File) => {
      setUploadUiMessage(null);
      const name = String(file.name || '').toLowerCase();
      const isTextTrace = name.endsWith('.pfw') || name.endsWith('.json') || name.endsWith('.txt');
      const isSqlite = name.endsWith('.sqlite') || name.endsWith('.db');
      const isOtf2Archive =
        name.endsWith('.zip') || name.endsWith('.tar.gz') || name.endsWith('.tgz') || name.endsWith('.tar');

      const backendStatus = backendHealth?.status;
      const backendRunning = backendStatus === 'healthy';
      const backendUnreachable = backendStatus === 'unreachable';

      // When backend is running, always upload so the backend serves data to the frontend.
      // For .sqlite/.zip/.tar.gz/.tgz/.tar (OTF2) uploads, backend is required.
      if (backendRunning || isSqlite || isOtf2Archive) {
        await uploadTraceToBackend(file);
        return;
      }

      // Fallback: parse local text-based trace only when backend is unavailable.
      if (!isTextTrace) {
        setError(
          'This file type requires the backend. Start the backend to upload .sqlite/.zip/.tar.gz/.tgz, or upload a .pfw/.json/.txt.'
        );
        setUploadUiMessage('This file type requires the backend. Please start it and try again.');
        setShowUploadPrompt(true);
        return;
      }

      // If backend status is unknown (health still pending), try uploading first.
      if (!backendUnreachable) {
        const ok = await uploadTraceToBackend(file);
        if (ok) return;
      }

      setIsReadingTrace(true);
      try {
        const text = await readFileAsText(file);
        setLocalTraceText(text);
        setLocalTraceName(file.name || 'uploaded trace');
        setError(null);
        setShowUploadPrompt(false);
        setLoading(true);
        setIsFetching(true);
      } catch (e: any) {
        setError(e?.message ? String(e.message) : 'Failed to read uploaded file.');
        setUploadUiMessage('Failed to read the file. Please retry or check the file format.');
        setShowUploadPrompt(true);
      } finally {
        setIsReadingTrace(false);
      }
    },
    [
      backendHealth?.status,
      readFileAsText,
      uploadTraceToBackend,
      setError,
      setIsFetching,
      setLoading,
      setLocalTraceName,
      setLocalTraceText,
      setShowUploadPrompt,
      setUploadUiMessage
    ]
  );

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
    sessionId,
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

  const hasAnyTraceEvents = useMemo(() => {
    const rawCount = Array.isArray(rawEvents) ? rawEvents.length : 0;
    const transformedCount = Array.isArray(data) ? data.length : 0;
    return rawCount > 0 || transformedCount > 0;
  }, [rawEvents, data]);

  const showUploadScreen = showUploadPrompt || !hasAnyTraceEvents;
  const uploadBusy =
    isUploadingTrace || isReadingTrace || isFetching || isAnalyzing || isSoaPacking || isMappingProcessing;
  const uploadBusyLabel = isUploadingTrace
    ? 'Uploading…'
    : isReadingTrace
      ? 'Reading file…'
      : isAnalyzing || isSoaPacking || isMappingProcessing
        ? 'Processing data…'
        : isFetching || loading
          ? 'Loading data…'
          : null;

  if (showUploadScreen) {
    const backendStatus = backendHealth?.status;
    const backendStatusText =
      backendStatus === 'healthy'
        ? 'Backend: connected'
        : backendStatus === 'unreachable'
          ? 'Backend: unreachable'
          : 'Backend: unknown';
    const selectedName = localTraceName ? String(localTraceName) : '';
    const subtitlePrefix = error ? 'No usable data detected yet. ' : '';
    const subtitle = `${subtitlePrefix}Select a trace file to start visualizing. Supports .pfw/.json/.txt (can be parsed locally when the backend is down); .sqlite/.db/.zip/.tar.gz (OTF2) requires the backend.`;

    return (
      <div className="App">
        <div className="centered-screen">
          <div className="upload-card">
            <div className="upload-card-header">
              <h2 className="upload-title">Upload Trace Data</h2>
              <p className="upload-subtitle">{subtitle}</p>
            </div>

            <div
              className={`upload-dropzone ${isUploadDragOver ? 'dragover' : ''}`}
              onDragEnter={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setIsUploadDragOver(true);
              }}
              onDragOver={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
              onDragLeave={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setIsUploadDragOver(false);
              }}
              onDrop={async (e) => {
                e.preventDefault();
                e.stopPropagation();
                setIsUploadDragOver(false);
                const file = e.dataTransfer?.files?.[0];
                if (!file) return;
                await handleTraceFileSelected(file);
              }}
            >
              <div className="upload-dropzone-inner">
                <input
                  ref={traceFileInputRef}
                  type="file"
                  accept=".pfw,.json,.txt,.sqlite,.db,.zip,.tar.gz,.tgz,.tar"
                  style={{ display: 'none' }}
                  onChange={async (e) => {
                    const file = e.target.files && e.target.files[0];
                    if (!file) return;
                    // Allow re-selecting the same file to re-trigger upload.
                    e.currentTarget.value = '';
                    await handleTraceFileSelected(file);
                  }}
                  disabled={isUploadingTrace || isReadingTrace}
                />
                <button
                  type="button"
                  className="upload-primary"
                  onClick={() => traceFileInputRef.current?.click()}
                  disabled={isUploadingTrace || isReadingTrace}
                >
                  Choose file
                </button>
                <div className="upload-secondary">or drag and drop here</div>
              </div>
            </div>

            <div className="upload-meta">
              <span>
                <strong>Current</strong> {selectedName ? `Selected: ${selectedName}` : 'No file selected'}
              </span>
              <span>{backendStatusText}</span>
            </div>

            {uploadUiMessage && (
              <div className="upload-loading" role="status" aria-live="polite">
                <span>{uploadUiMessage}</span>
              </div>
            )}

            {uploadBusy && uploadBusyLabel && (
              <div className="upload-loading" role="status" aria-live="polite">
                <div className="upload-spinner" />
                <span>{uploadBusyLabel}</span>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (!obd) {
    return (
      <div className="App">
        <div className="centered-screen">
          <div className="loading">Initializing...</div>
        </div>
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

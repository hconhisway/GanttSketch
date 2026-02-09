import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './App.css';
import { GANTT_CONFIG, cloneGanttConfig, applyGanttConfigPatch, normalizeGanttConfig } from './config/ganttConfig';
import { GANTT_CONFIG_UI_SPEC } from './config/ganttConfigUiSpec';
import { cloneWidgetConfig } from './config/widgetConfig';
import {
  analyzeAndInitialize,
  dataMappingToFlatFieldMapping,
  dataMappingToLegacySchema,
  getTimeMultiplier,
  processEventsMinimal
} from './agents';
import { parseMessageSegments } from './utils/configPatch';
import { processTracksConfig } from './utils/dataProcessing';
import { inferProcessSortModeFromRule } from './utils/processOrder';
import { buildConfigBundle, downloadConfigBundle } from './utils/configBundle';
import { WidgetArea } from './components/widget/WidgetArea';
import { GanttChart } from './components/chart/GanttChart';
import { ConfigPanel } from './components/config/ConfigPanel';
import { ChatMessages } from './components/chat/ChatMessages';
import { ImageGallery } from './components/ImageGallery';
import { ChatInput } from './components/chat/ChatInput';
import { ConfigEditorModal } from './components/config/ConfigEditorModal';
import { DataSetupModal } from './components/config/DataSetupModal';
import { WidgetEditorModal } from './components/widget/WidgetEditorModal';
import { LeftPanel } from './components/layout/LeftPanel';
import { RightPanel } from './components/layout/RightPanel';
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

type ViewRange = { start: number; end: number };
type WidgetBinding = { element: Element; event: string; handler: EventListener };

// API configuration
const API_URL = 'http://127.0.0.1:8080/get-events';
const FRONTEND_TRACE_URL = `${process.env.PUBLIC_URL || ''}/unet3d_a100--verify-1.pfw`;
const FRONTEND_TRACE_LABEL = 'unet3d_a100--verify-1.pfw';
const DEFAULT_END_US = 2e15; // Large enough for epoch-microsecond traces (~1.76e15 typical); 100_000_000 would filter out most events

function App() {
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
  const viewRangeRef = useRef<ViewRange>({ start: 0, end: DEFAULT_END_US });
  const fetchRangeRef = useRef<ViewRange>({ start: 0, end: DEFAULT_END_US });
  const forkRelationsRef = useRef({
    parentByPid: new Map<string, string | null>(),
    childrenByPid: new Map<string, string[]>(),
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
  const [startTime, setStartTime] = useState(0);
  const [endTime, setEndTime] = useState(DEFAULT_END_US);
  const [bins, setBins] = useState(1000);
  const [viewRange, setViewRange] = useState<ViewRange>({ start: 0, end: DEFAULT_END_US });
  const [processAggregates, setProcessAggregates] = useState<Map<string, any[]>>(new Map());
  const [threadsByPid, setThreadsByPid] = useState<Map<string, any>>(new Map());
  const [expandedPids, setExpandedPids] = useState<string[]>([]);
  const [yAxisWidth, setYAxisWidth] = useState(GANTT_CONFIG?.layout?.yAxis?.baseWidth ?? 180);

  // Chat state
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputMessage, setInputMessage] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [currentStreamingMessage, setCurrentStreamingMessage] = useState('');

  // Drawing state
  const [isDrawingMode, setIsDrawingMode] = useState(false);
  const [brushSize, setBrushSize] = useState(3);
  const [brushColor, setBrushColor] = useState('#ff0000');
  const [ganttConfig, setGanttConfig] = useState<GanttConfig>(() => cloneGanttConfig());
  const [processSortMode, setProcessSortMode] = useState<ProcessSortMode>(
    inferProcessSortModeFromRule(GANTT_CONFIG.yAxis?.hierarchy1OrderRule)
  ); // 'fork' | 'default'
  const [localTraceText, setLocalTraceText] = useState('');
  const [localTraceName, setLocalTraceName] = useState('');
  const [showUploadPrompt, setShowUploadPrompt] = useState(false);
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
            'Time axis, process/thread, identity, color, bar label, tooltip and schema. Edit the full mapping in one place.',
          example: JSON.stringify(
            {
              xAxis: { startField: 'ts', endField: null, durationField: 'dur', timeUnit: 'us' },
              yAxis: { hierarchy1Field: 'pid', hierarchy2Field: 'tid', parentField: 'ppid', levelField: 'level' },
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
              schema: { dataFormat: '', allFields: [], notes: '' }
            },
            null,
            2
          ),
          source: 'dataMapping'
          // no mappingKey = edit entire dataMapping object
        }
      ]
    };
    return [dataMappingSection, ...GANTT_CONFIG_UI_SPEC];
  }, [dataMapping]);

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
    setDataMapping
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

  useDataFetching({
    obd,
    startTime,
    endTime,
    bins,
    localTraceText,
    dataMapping,
    ganttConfig,
    apiUrl: API_URL,
    traceUrl: FRONTEND_TRACE_URL,
    defaultEndUs: DEFAULT_END_US,
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
    configSourceLabel: localTraceName || FRONTEND_TRACE_LABEL,
    autoAnalyzeOnFirstLoad: false
  });

  const showDataSetupModal = Boolean(
    rawEvents && rawEvents.length > 0 && !dataMapping
  );

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
    (mapping: GanttDataMapping) => {
      if (!rawEvents || rawEvents.length === 0) return;
      const flatMapping = dataMappingToFlatFieldMapping(mapping);
      const timeMultiplier = getTimeMultiplier(mapping.xAxis.timeUnit);
      const processed = processEventsMinimal(rawEvents, flatMapping, timeMultiplier);
      setData(processed);
      updateTimeRangeFromEvents(processed);
    },
    [rawEvents, setData, updateTimeRangeFromEvents]
  );

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
        const bundle = buildConfigBundle(
          analysisResult.dataMapping,
          analysisResult.config,
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

        setDataMapping(mapping as GanttDataMapping);
        applyMappingToRawEvents(mapping as GanttDataMapping);

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
    mergeGapRatio: ganttConfig?.xAxis?.mergeGapRatio ?? 0.002,
    hierarchy2LaneRule: ganttConfig?.yAxis?.hierarchy2LaneRule,
    setThreadsByPid,
    setProcessAggregates,
    setExpandedPids,
    threadsByPid,
    processAggregates
  });

  useChartRenderer({
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
  });

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
  }, [configHighlightId, activeConfigItem]);

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
          />
        </LeftPanel>

        <RightPanel>
          <div className="chat-header">
            <h3>Chart Assistant</h3>
            <p className="chat-subtitle">Ask questions about your data</p>
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
          />

          <input
            ref={configFileInputRef}
            type="file"
            accept=".json,application/json"
            style={{ display: 'none' }}
            onChange={handleConfigFileChange}
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

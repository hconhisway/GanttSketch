import { useCallback } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { streamLLMResponse } from '../config/llmConfig';
import { applyGanttConfigPatch } from '../config/ganttConfig';
import { applyWidgetConfigPatch } from '../config/widgetConfig';
import {
  parseTrackConfigFromResponse,
  convertLLMConfigToTracksConfig
} from '../config/tracksConfigPrompt';
import { getWidgetSystemPrompt } from '../agents/widgetAgent';
import { buildSystemPrompt, extractTargetPath } from '../agents';
import { FLAT_CONFIG_ITEMS } from '../utils/configPatch';
import { extractEventFieldPaths } from '../utils/dataProcessing';
import { buildPatchForPath, inferProcessSortModeFromRule } from '../utils/processOrder';
import { normalizeWidget, findConfigItemForPatch } from '../utils/widget';
import { formatTimeUs } from '../utils/formatting';
import { getValueAtPath } from '../utils/expression';
import { validateWidget } from '../config/widgetValidator';
import type { ProcessSortMode } from '../types/ganttConfig';

const MAX_EVENT_PROMPT_CHARS = 1200;
const MAX_ARRAY_PREVIEW = 20;
const MAX_OBJECT_KEYS = 20;
const MAX_STRING_CHARS = 200;

function trimEventForPrompt(event: any): any {
  if (event == null || typeof event !== 'object') return event;

  const clipValue = (value: any): any => {
    if (value == null) return value;
    if (typeof value === 'string') {
      return value.length > MAX_STRING_CHARS ? `${value.slice(0, MAX_STRING_CHARS)}...` : value;
    }
    if (Array.isArray(value)) {
      if (value.length > MAX_ARRAY_PREVIEW) return `[${value.length} items]`;
      return value.map((entry) =>
        typeof entry === 'object' && entry !== null ? '[object]' : entry
      );
    }
    if (typeof value === 'object') {
      const keys = Object.keys(value);
      if (keys.length > MAX_OBJECT_KEYS) return `[object ${keys.length} keys]`;
      const preview: Record<string, any> = {};
      keys.forEach((key) => {
        const entry = (value as any)[key];
        preview[key] = typeof entry === 'object' && entry !== null ? '[object]' : entry;
      });
      return preview;
    }
    return value;
  };

  const trimmed: Record<string, any> = {};
  Object.keys(event).forEach((key) => {
    trimmed[key] = clipValue((event as any)[key]);
  });

  const json = JSON.stringify(trimmed);
  if (json.length <= MAX_EVENT_PROMPT_CHARS) return trimmed;

  const preferredKeys = [
    'name',
    'cat',
    'hierarchy1',
    'hierarchy2',
    'ts',
    'dur',
    'start',
    'end',
    'timestamp',
    'type'
  ];
  const compact: Record<string, any> = {};
  preferredKeys.forEach((key) => {
    if (key in trimmed) compact[key] = trimmed[key];
  });
  if (Object.keys(compact).length === 0) {
    Object.keys(trimmed)
      .slice(0, 10)
      .forEach((key) => {
        compact[key] = trimmed[key];
      });
  }
  return compact;
}

interface UseChatAgentArgs {
  inputMessage: string;
  isStreaming: boolean;
  selectedImageId: string | null;
  savedImages: Array<{ id: string; dataUrl: string }>;
  messages: any[];
  data: any[];
  ganttConfig: any;
  startTime: number;
  endTime: number;
  activeConfigItem: any;
  dataSchema: any;
  fieldMapping: any;
  isWidgetAgentMode: boolean;
  widgetConfig: any;
  widgets: any[];
  setMessages: (next: any[] | ((prev: any[]) => any[])) => void;
  setInputMessage: (value: string) => void;
  setIsStreaming: (value: boolean) => void;
  setCurrentStreamingMessage: (value: string) => void;
  setGanttConfig: (value: any) => void;
  setProcessSortMode: Dispatch<SetStateAction<ProcessSortMode>>;
  setTracksConfig: (value: any) => void;
  setWidgets: (updater: (prev: any[]) => any[]) => void;
  setWidgetConfig: (value: any) => void;
  handleOpenConfigEditor: (item: any, options?: any) => void;
  handleOpenWidgetEditor: (widget: any, options?: any) => void;
}

export function useChatAgent({
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
}: UseChatAgentArgs) {
  const handleSendMessage = useCallback(async () => {
    if (!inputMessage.trim() || isStreaming) return;

    // Create user message with optional image
    let userMessage: any = { role: 'user', content: inputMessage };

    // If an image is selected, include it in the message
    // Note: This requires a vision-capable LLM API (e.g., GPT-4 Vision, Claude 3)
    // You would need to modify streamLLMResponse in llmConfig.ts to support multimodal content
    if (selectedImageId) {
      const selectedImage = savedImages.find((img) => img.id === selectedImageId);
      if (selectedImage) {
        userMessage.imageData = selectedImage.dataUrl;
        // For vision models, the content format would be:
        // content: [
        //   { type: 'text', text: inputMessage },
        //   { type: 'image_url', image_url: { url: selectedImage.dataUrl } }
        // ]
        console.log('Image attached to message:', selectedImageId);
      }
    }

    const newMessages = [...messages, userMessage];
    setMessages(newMessages);
    setInputMessage('');
    setIsStreaming(true);
    setCurrentStreamingMessage('');

    // Prepare enhanced context about the current chart data for tracks configuration
    const uniqueTracks = [...new Set(data.map((d) => d.hierarchy1 ?? d.hierarchy2 ?? d.track))];
    const configSummary = [
      `yAxis.hierarchy1OrderRule=${ganttConfig?.yAxis?.hierarchy1OrderRule?.name || 'pidAsc'}`,
      `yAxis.hierarchy2LaneRule=${ganttConfig?.yAxis?.hierarchy2LaneRule?.name || 'autoPack'}`,
      `color.keyRule=${ganttConfig?.color?.keyRule ? 'rule' : 'default'}`,
      `color.palette=${(ganttConfig?.color?.palette || []).length}`,
      `tooltip=${ganttConfig?.tooltip?.enabled === false ? 'off' : 'on'}`
    ].join(', ');
    const activeConfigContext = activeConfigItem
      ? {
          id: activeConfigItem.id,
          label: activeConfigItem.label,
          path: activeConfigItem.path,
          description: activeConfigItem.description,
          example: activeConfigItem.example,
          currentValue: getValueAtPath(ganttConfig, activeConfigItem.path)
        }
      : null;
    const chartContext = {
      totalTracks: uniqueTracks.length,
      trackNames: uniqueTracks.sort(),
      timeRange:
        data.length > 0 ? `${formatTimeUs(startTime)} to ${formatTimeUs(endTime)}` : 'unknown',
      dataPointCount: data.length,
      configSummary,
      activeConfigItem: activeConfigContext
    };

    // Use widget agent mode toggle instead of regex detection
    const eventFields = extractEventFieldPaths(data, 80);
    const sampleEvents = Array.isArray(data) ? data.slice(0, 5).map(trimEventForPrompt) : [];
    console.log('[Config Agent] Event fields extracted:', eventFields);
    console.log('[Config Agent] Sample events:', sampleEvents.length);
    console.log('[Agent Mode] Widget agent mode:', isWidgetAgentMode);
    const enhancedSystemPrompt = isWidgetAgentMode
      ? getWidgetSystemPrompt(chartContext, widgetConfig, widgets, {
          dataSchema,
          fieldMapping,
          eventFields,
          sampleEvents
        })
      : buildSystemPrompt({
          schema: dataSchema,
          currentConfig: ganttConfig,
          activeConfigItem: activeConfigContext,
          eventFields,
          sampleEvents,
          fieldMapping
        });

    const contextualMessages = [{ role: 'system', content: enhancedSystemPrompt }, ...newMessages];

    // Use a ref to accumulate the streaming message
    let accumulatedMessage = '';

    try {
      await streamLLMResponse(
        contextualMessages,
        (chunk) => {
          accumulatedMessage += chunk;
          setCurrentStreamingMessage(accumulatedMessage);
        },
        () => {
          // Streaming complete - process the response
          setMessages((prev) => [...prev, { role: 'assistant', content: accumulatedMessage }]);
          setCurrentStreamingMessage('');
          setIsStreaming(false);

          // Check if the response contains a configuration update
          const configResponse = parseTrackConfigFromResponse(accumulatedMessage) as any;
          if (configResponse?.action === 'clarification_needed') {
            const question =
              configResponse.question || 'Could you clarify the requested configuration?';
            const suggestions = Array.isArray(configResponse.suggestions)
              ? ` Suggestions: ${configResponse.suggestions.join(', ')}`
              : '';
            setMessages((prev) => [
              ...prev,
              {
                role: 'system',
                content: `Question: ${question}${suggestions}`
              }
            ]);
          } else if (configResponse?.action === 'update_gantt_config') {
            try {
              let patchToApply = configResponse.patch;
              if (activeConfigItem?.path) {
                const nextValue = getValueAtPath(configResponse.patch, activeConfigItem.path);
                if (nextValue === undefined) {
                  setMessages((prev) => [
                    ...prev,
                    {
                      role: 'system',
                      content: `⚠️ No update applied. The assistant must update only: ${activeConfigItem.path}`
                    }
                  ]);
                  return;
                }
                patchToApply = buildPatchForPath(activeConfigItem.path, nextValue);
              }
              const nextConfig = applyGanttConfigPatch(ganttConfig, patchToApply);
              setGanttConfig(nextConfig);
              if (patchToApply?.yAxis?.hierarchy1OrderRule) {
                setProcessSortMode(
                  inferProcessSortModeFromRule(patchToApply.yAxis.hierarchy1OrderRule)
                );
              } else if (patchToApply?.yAxis?.orderMode) {
                const nextMode = patchToApply.yAxis.orderMode;
                setProcessSortMode(nextMode === 'fork' ? 'fork' : 'default');
              }
              // Use extractTargetPath to find which config item was modified
              const targetPath = configResponse.targetPath || extractTargetPath(patchToApply);
              const matchedItem = targetPath
                ? FLAT_CONFIG_ITEMS.find((item) => item.path === targetPath) ||
                  findConfigItemForPatch(patchToApply)
                : activeConfigItem?.path &&
                    getValueAtPath(patchToApply, activeConfigItem.path) !== undefined
                  ? activeConfigItem
                  : findConfigItemForPatch(patchToApply);
              if (matchedItem) {
                handleOpenConfigEditor(matchedItem, {
                  configOverride: nextConfig,
                  highlight: true
                });
              }
              setMessages((prev) => [
                ...prev,
                {
                  role: 'system',
                  content: `✅ Gantt config updated: ${configResponse.description || 'Configuration updated successfully'}`
                }
              ]);
            } catch (error: any) {
              console.error('Error applying gantt config update:', error);
              setMessages((prev) => [
                ...prev,
                {
                  role: 'system',
                  content: `⚠️ Could not apply gantt config update: ${error.message}`
                }
              ]);
            }
          } else if (configResponse?.action === 'configure_tracks') {
            console.log('Track configuration detected:', configResponse);

            // Convert LLM config to internal format and apply it
            try {
              const internalConfig = convertLLMConfigToTracksConfig(configResponse, data);
              if (internalConfig) {
                setTracksConfig(internalConfig);
              }

              // Add a confirmation message to chat
              setMessages((prev) => [
                ...prev,
                {
                  role: 'system',
                  content: `✅ Track configuration applied: ${configResponse.config.description || 'Configuration updated successfully'}`
                }
              ]);
            } catch (error: any) {
              console.error('Error applying track configuration:', error);
              setMessages((prev) => [
                ...prev,
                {
                  role: 'system',
                  content: `⚠️ Could not apply track configuration: ${error.message}`
                }
              ]);
            }
          } else if (configResponse?.action === 'create_widget') {
            try {
              const rawWidget = normalizeWidget(configResponse.widget);

              // Validate and auto-fix the widget
              const validation = validateWidget(rawWidget, widgets);

              if (!validation.valid) {
                console.error('Widget validation errors:', validation.errors);
                throw new Error(validation.errors.join('; '));
              }

              const nextWidget = validation.widget;

              // Log any fixes or warnings
              if (validation.fixes.length > 0) {
                console.log('[Widget Validator] Auto-fixes applied:', validation.fixes);
              }
              if (validation.warnings.length > 0) {
                console.warn('[Widget Validator] Warnings:', validation.warnings);
              }

              if (!nextWidget.html) {
                throw new Error('Widget HTML is empty.');
              }

              setWidgets((prev) => [...prev, nextWidget]);
              // Auto-open the widget editor for the newly created widget
              handleOpenWidgetEditor(nextWidget, { highlight: true });

              // Build message with any fixes/warnings
              let statusMsg = `✅ Widget added: ${nextWidget.name}`;
              if (validation.fixes.length > 0) {
                statusMsg += `\n(Auto-fixes: ${validation.fixes.join(', ')})`;
              }
              if (validation.warnings.length > 0) {
                statusMsg += `\n⚠️ Warnings: ${validation.warnings.join(', ')}`;
              }

              setMessages((prev) => [
                ...prev,
                {
                  role: 'system',
                  content: statusMsg
                }
              ]);
            } catch (error: any) {
              console.error('Error creating widget:', error);
              setMessages((prev) => [
                ...prev,
                {
                  role: 'system',
                  content: `⚠️ Could not create widget: ${error.message}`
                }
              ]);
            }
          } else if (configResponse?.action === 'update_widget') {
            try {
              const rawWidget = normalizeWidget(configResponse.widget);

              // Validate the widget (exclude current widget from conflict check)
              const otherWidgets = widgets.filter((w) => w.id !== rawWidget.id);
              const validation = validateWidget(rawWidget, otherWidgets);

              if (!validation.valid) {
                console.error('Widget validation errors:', validation.errors);
                throw new Error(validation.errors.join('; '));
              }

              const nextWidget = validation.widget;

              // Log any fixes or warnings
              if (validation.fixes.length > 0) {
                console.log('[Widget Validator] Auto-fixes applied:', validation.fixes);
              }
              if (validation.warnings.length > 0) {
                console.warn('[Widget Validator] Warnings:', validation.warnings);
              }

              setWidgets((prev) => {
                const index = prev.findIndex((item) => item.id === rawWidget.id);
                if (index === -1) {
                  throw new Error(`Widget not found: ${rawWidget.id}`);
                }
                const updated = [...prev];
                const existing = updated[index];
                updated[index] = {
                  ...existing,
                  ...nextWidget,
                  html: nextWidget.html || existing.html,
                  listeners:
                    nextWidget.listeners.length > 0 ? nextWidget.listeners : existing.listeners
                };
                return updated;
              });

              // Build message with any fixes/warnings
              let statusMsg = `✅ Widget updated: ${nextWidget.name}`;
              if (validation.fixes.length > 0) {
                statusMsg += `\n(Auto-fixes: ${validation.fixes.join(', ')})`;
              }
              if (validation.warnings.length > 0) {
                statusMsg += `\n⚠️ Warnings: ${validation.warnings.join(', ')}`;
              }

              setMessages((prev) => [
                ...prev,
                {
                  role: 'system',
                  content: statusMsg
                }
              ]);
            } catch (error: any) {
              console.error('Error updating widget:', error);
              setMessages((prev) => [
                ...prev,
                {
                  role: 'system',
                  content: `⚠️ Could not update widget: ${error.message}`
                }
              ]);
            }
          } else if (configResponse?.action === 'update_widget_config') {
            try {
              const nextConfig = applyWidgetConfigPatch(widgetConfig, configResponse.patch);
              setWidgetConfig(nextConfig);
              setMessages((prev) => [
                ...prev,
                {
                  role: 'system',
                  content: `✅ Widget layout/style updated: ${configResponse.description || 'Widget config updated successfully'}`
                }
              ]);
            } catch (error: any) {
              console.error('Error applying widget config update:', error);
              setMessages((prev) => [
                ...prev,
                {
                  role: 'system',
                  content: `⚠️ Could not update widget layout/style: ${error.message}`
                }
              ]);
            }
          }
        },
        (error) => {
          console.error('Streaming error:', error);
          setIsStreaming(false);
          setCurrentStreamingMessage('');
          const message = error?.message || String(error || 'Unknown LLM error');
          setMessages((prev) => [
            ...prev,
            {
              role: 'system',
              content: `⚠️ LLM request failed: ${message}`
            }
          ]);
        }
      );
    } catch (error: any) {
      console.error('Error sending message:', error);
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: `Error: ${error.message}. Please check your LLM API configuration.`
        }
      ]);
      setIsStreaming(false);
    }
  }, [
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
  ]);

  const handleKeyPress = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSendMessage();
      }
    },
    [handleSendMessage]
  );

  return { handleSendMessage, handleKeyPress };
}

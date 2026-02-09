import { useCallback, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { applyGanttConfigPatch } from '../config/ganttConfig';
import { buildPatchForPath, inferProcessSortModeFromRule } from '../utils/processOrder';
import { getValueAtPath } from '../utils/expression';
import { buildConfigBundle, downloadConfigBundle } from '../utils/configBundle';
import type { GanttDataMapping, ProcessSortMode } from '../types/ganttConfig';

interface UseConfigEditorArgs {
  ganttConfig: any;
  setGanttConfig: Dispatch<SetStateAction<any>>;
  setProcessSortMode: Dispatch<SetStateAction<ProcessSortMode>>;
  setMessages: Dispatch<SetStateAction<any[]>>;
  dataMapping?: GanttDataMapping | null;
  setDataMapping?: Dispatch<SetStateAction<GanttDataMapping | null>>;
}

interface OpenConfigEditorOptions {
  configOverride?: any;
  highlight?: boolean;
}

export function useConfigEditor({
  ganttConfig,
  setGanttConfig,
  setProcessSortMode,
  setMessages,
  dataMapping,
  setDataMapping
}: UseConfigEditorArgs) {
  const [activeConfigItem, setActiveConfigItem] = useState<any>(null);
  const [configEditorText, setConfigEditorText] = useState('');
  const [configEditorError, setConfigEditorError] = useState('');
  const [configHighlightId, setConfigHighlightId] = useState<string | null>(null);
  const configEditorTextareaRef = useRef<HTMLTextAreaElement>(null!);
  const configHighlightTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearConfigHighlight = useCallback(() => {
    if (configHighlightTimeoutRef.current) {
      clearTimeout(configHighlightTimeoutRef.current);
      configHighlightTimeoutRef.current = null;
    }
    setConfigHighlightId(null);
  }, [setConfigHighlightId]);

  const handleOpenConfigEditor = useCallback(
    (item: any, options: OpenConfigEditorOptions = {}) => {
      if (!item) return;
      const { configOverride, highlight = false } = options;

      let currentValue: any;
      if (item?.source === 'dataMapping') {
        // Read full dataMapping or a sub-key
        if (item.mappingKey) {
          currentValue = dataMapping ? (dataMapping as any)[item.mappingKey] : undefined;
        } else {
          currentValue = dataMapping ?? undefined;
        }
      } else {
        const sourceConfig = configOverride || ganttConfig;
        currentValue = getValueAtPath(sourceConfig, item.path);
      }

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
      dataMapping,
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

      // Handle dataMapping editing (full object or sub-key)
      if (activeConfigItem.source === 'dataMapping') {
        if (!setDataMapping) {
          throw new Error('Data mapping editor is not configured.');
        }
        if (parsed !== null && (typeof parsed !== 'object' || Array.isArray(parsed))) {
          throw new Error('Data mapping must be a JSON object.');
        }
        if (activeConfigItem.mappingKey) {
          if (!dataMapping) throw new Error('Data mapping is not set.');
          setDataMapping({
            ...dataMapping,
            [activeConfigItem.mappingKey]: parsed
          } as GanttDataMapping);
        } else {
          setDataMapping(parsed as GanttDataMapping);
        }
        clearConfigHighlight();
        setMessages((prev) => [
          ...prev,
          {
            role: 'system',
            content: `\u2705 Updated ${activeConfigItem.label}`
          }
        ]);
        setConfigEditorError('');
        handleCloseConfigEditor();
        return;
      }

      // Standard ganttConfig editing
      const patch = buildPatchForPath(activeConfigItem.path, parsed);
      const nextConfig = applyGanttConfigPatch(ganttConfig, patch);
      setGanttConfig(nextConfig);
      if (activeConfigItem.path === 'yAxis.hierarchy1OrderRule' || activeConfigItem.path === 'yAxis.processOrderRule') {
        setProcessSortMode(inferProcessSortModeFromRule(parsed));
      } else if (activeConfigItem.path === 'yAxis.orderMode') {
        setProcessSortMode(parsed === 'fork' ? 'fork' : 'default');
      }
      clearConfigHighlight();
      setMessages((prev) => [
        ...prev,
        {
          role: 'system',
          content: `\u2705 Updated ${activeConfigItem.label}`
        }
      ]);
      setConfigEditorError('');
      handleCloseConfigEditor();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setConfigEditorError(`Invalid JSON: ${message}`);
      return;
    }
  }, [
    activeConfigItem,
    clearConfigHighlight,
    configEditorText,
    dataMapping,
    ganttConfig,
    handleCloseConfigEditor,
    setConfigEditorError,
    setDataMapping,
    setGanttConfig,
    setMessages,
    setProcessSortMode
  ]);

  const handleExportDataMapping = useCallback(() => {
    if (!activeConfigItem || activeConfigItem.source !== 'dataMapping') return;
    try {
      const parsed = configEditorText ? JSON.parse(configEditorText) : null;
      if (parsed !== null && (typeof parsed !== 'object' || Array.isArray(parsed))) {
        throw new Error('Data mapping must be a JSON object.');
      }
      let fullMapping: GanttDataMapping;
      if (activeConfigItem.mappingKey) {
        if (!dataMapping) throw new Error('Data mapping is not set.');
        fullMapping = {
          ...dataMapping,
          [activeConfigItem.mappingKey]: parsed
        } as GanttDataMapping;
      } else {
        if (parsed === null) throw new Error('Data mapping is empty.');
        fullMapping = parsed as GanttDataMapping;
      }
      const bundle = buildConfigBundle(fullMapping, undefined, 'datamapping_export');
      downloadConfigBundle(bundle);
      setConfigEditorError('');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setConfigEditorError(`Export failed: ${message}`);
    }
  }, [activeConfigItem, configEditorText, dataMapping, setConfigEditorError]);

  return {
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
  };
}

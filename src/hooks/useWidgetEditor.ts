import { useCallback, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { Widget } from '../types/widget';
import { normalizeWidget } from '../utils/widget';

interface UseWidgetEditorArgs {
  setWidgets: Dispatch<SetStateAction<Widget[]>>;
  setMessages: Dispatch<SetStateAction<any[]>>;
}

interface OpenWidgetEditorOptions {
  highlight?: boolean;
}

export function useWidgetEditor({ setWidgets, setMessages }: UseWidgetEditorArgs) {
  const [activeWidget, setActiveWidget] = useState<Widget | null>(null);
  const [widgetEditorText, setWidgetEditorText] = useState('');
  const [widgetEditorError, setWidgetEditorError] = useState('');
  const [widgetHighlightId, setWidgetHighlightId] = useState<string | null>(null);
  const widgetHighlightTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearWidgetHighlight = useCallback(() => {
    if (widgetHighlightTimeoutRef.current) {
      clearTimeout(widgetHighlightTimeoutRef.current);
      widgetHighlightTimeoutRef.current = null;
    }
    setWidgetHighlightId(null);
  }, [setWidgetHighlightId]);

  const handleOpenWidgetEditor = useCallback(
    (widget: Widget, options: OpenWidgetEditorOptions = {}) => {
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
    [clearWidgetHighlight, setActiveWidget, setWidgetEditorError, setWidgetEditorText, setWidgetHighlightId]
  );

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
      const message = error instanceof Error ? error.message : String(error);
      setWidgetEditorError(`Invalid JSON: ${message}`);
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
    (widgetId: string) => {
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

  return {
    activeWidget,
    widgetEditorText,
    setWidgetEditorText,
    widgetEditorError,
    widgetHighlightId,
    handleOpenWidgetEditor,
    handleCloseWidgetEditor,
    handleSaveWidgetEditor,
    handleDeleteWidget
  };
}

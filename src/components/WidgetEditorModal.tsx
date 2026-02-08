import React from 'react';
import { Widget } from '../types/widget';

interface WidgetEditorModalProps {
  activeWidget: Widget | null;
  widgetEditorText: string;
  setWidgetEditorText: (value: string) => void;
  widgetEditorError: string | null;
  widgetHighlightId: string | null;
  onSave: () => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}

export const WidgetEditorModal = React.memo(function WidgetEditorModal({
  activeWidget,
  widgetEditorText,
  setWidgetEditorText,
  widgetEditorError,
  widgetHighlightId,
  onSave,
  onDelete,
  onClose
}: WidgetEditorModalProps) {
  if (!activeWidget) return null;

  return (
    <div className="config-editor-modal widget-editor-modal" role="dialog" aria-modal="true">
      <div
        className={`config-editor widget-editor-window ${widgetHighlightId === activeWidget.id ? 'highlight' : ''}`}
      >
        <div className="config-editor-header widget-editor-header">
          <div className="config-editor-title">Edit Widget: {activeWidget.name}</div>
          <div className="config-editor-path">ID: {activeWidget.id}</div>
        </div>
        {activeWidget.description && (
          <div className="config-editor-description">{activeWidget.description}</div>
        )}
        <textarea
          className={`config-editor-textarea widget-editor-textarea ${widgetHighlightId === activeWidget.id ? 'highlight' : ''}`}
          value={widgetEditorText}
          onChange={(e) => setWidgetEditorText(e.target.value)}
          placeholder="Edit widget JSON here"
          rows={12}
        />
        <pre className="config-editor-example widget-editor-example">
          {`Widget format:
{
  "id": "widget-id",
  "name": "Widget Name",
  "html": "<label>...</label><select>...</select>",
  "listeners": [
    {
      "selector": "select",
      "event": "change",
      "handler": "console.log(payload.value);"
    }
  ],
  "description": "What this widget does"
}`}
        </pre>
        {widgetEditorError && <div className="config-editor-error">{widgetEditorError}</div>}
        <div className="config-editor-actions widget-editor-actions">
          <button type="button" className="config-editor-save" onClick={onSave}>
            Save
          </button>
          <button
            type="button"
            className="config-editor-cancel widget-delete-button"
            onClick={() => onDelete(activeWidget.id)}
          >
            Delete
          </button>
          <button type="button" className="config-editor-cancel" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
});

import React from 'react';

interface ConfigEditorModalProps {
  activeConfigItem: any;
  configEditorText: string;
  setConfigEditorText: (value: string) => void;
  configEditorError: string | null;
  configHighlightId: string | null;
  configEditorTextareaRef: React.RefObject<HTMLTextAreaElement>;
  onSave: () => void;
  onClose: () => void;
  /** When set, an Export button is shown (for Data Mapping editor only). */
  onExport?: () => void;
}

export const ConfigEditorModal = React.memo(function ConfigEditorModal({
  activeConfigItem,
  configEditorText,
  setConfigEditorText,
  configEditorError,
  configHighlightId,
  configEditorTextareaRef,
  onSave,
  onClose,
  onExport
}: ConfigEditorModalProps) {
  if (!activeConfigItem) return null;

  const isDataMappingEditor = activeConfigItem?.source === 'dataMapping';

  return (
    <div className="config-editor-modal" role="dialog" aria-modal="true">
      <div
        className={`config-editor config-editor-window ${configHighlightId === activeConfigItem.id ? 'highlight' : ''}`}
      >
        <div className="config-editor-header">
          <div className="config-editor-title">Edit: {activeConfigItem.label}</div>
          <div className="config-editor-path">{activeConfigItem.path}</div>
        </div>
        {activeConfigItem.description && (
          <div className="config-editor-description">{activeConfigItem.description}</div>
        )}
        <textarea
          ref={configEditorTextareaRef}
          className={`config-editor-textarea ${configHighlightId === activeConfigItem.id ? 'highlight' : ''}`}
          value={configEditorText}
          onChange={(e) => setConfigEditorText(e.target.value)}
          placeholder="the threshold for merging events on the top level, gaps larger than this_value * total time will be merged."
          rows={8}
        />
        {activeConfigItem.example && (
          <pre className="config-editor-example">{activeConfigItem.example}</pre>
        )}
        {configEditorError && <div className="config-editor-error">{configEditorError}</div>}
        <div className="config-editor-actions">
          <button type="button" className="config-editor-save" onClick={onSave}>
            Save
          </button>
          {isDataMappingEditor && onExport && (
            <button type="button" className="config-editor-export" onClick={onExport}>
              Export
            </button>
          )}
          <button type="button" className="config-editor-cancel" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
});

import React from 'react';
import { Widget } from '../../types/widget';

interface ConfigPanelProps {
  configSpec: Array<{
    id: string;
    title: string;
    description?: string;
    items: Array<{
      id: string;
      label: string;
      path: string;
      description?: string;
      example?: string;
      source?: string;
      mappingKey?: string;
    }>;
  }>;
  activeConfigItem: any;
  configHighlightId: string | null;
  onOpenConfigEditor: (item: any) => void;
  widgets: Widget[];
  activeWidget: Widget | null;
  widgetHighlightId: string | null;
  onOpenWidgetEditor: (widget: Widget) => void;
}

export const ConfigPanel = React.memo(function ConfigPanel({
  configSpec,
  activeConfigItem,
  configHighlightId,
  onOpenConfigEditor,
  widgets,
  activeWidget,
  widgetHighlightId,
  onOpenWidgetEditor
}: ConfigPanelProps) {
  return (
    <div className="chat-config-panel">
      {configSpec.map((domain) => (
        <div key={domain.id} className="config-domain">
          <div className="config-domain-header">
            <span className="config-domain-title">{domain.title}</span>
            {domain.description && (
              <span className="config-domain-subtitle">{domain.description}</span>
            )}
          </div>
          <div className="config-buttons">
            {domain.items.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`config-button ${activeConfigItem?.id === item.id ? 'active' : ''} ${configHighlightId === item.id ? 'highlight' : ''}`}
                data-config-item-id={item.id}
                title={item.description || item.label}
                onClick={() => onOpenConfigEditor(item)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
      ))}

      {/* Added Widgets Section */}
      <div className="config-domain widgets-domain">
        <div className="config-domain-header">
          <span className="config-domain-title">Added Widgets</span>
          <span className="config-domain-subtitle">Custom UI widgets created by the assistant</span>
        </div>
        <div className="config-buttons widget-buttons">
          {widgets.length === 0 ? (
            <span className="no-widgets-hint">
              No widgets yet. Enable Widget Mode below to create widgets.
            </span>
          ) : (
            widgets.map((widget) => (
              <button
                key={widget.id}
                type="button"
                className={`config-button widget-config-button ${activeWidget?.id === widget.id ? 'active' : ''} ${widgetHighlightId === widget.id ? 'highlight' : ''}`}
                data-widget-id={widget.id}
                title={widget.description || widget.name}
                onClick={() => onOpenWidgetEditor(widget)}
              >
                {widget.name}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
});

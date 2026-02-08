import React from 'react';
import { toCssSize } from '../utils/formatting';
import { Widget, WidgetConfig } from '../types/widget';

interface WidgetAreaProps {
  widgets: Widget[];
  widgetConfig: WidgetConfig;
  widgetAreaRef: React.RefObject<HTMLDivElement>;
}

export const WidgetArea = React.memo(function WidgetArea({
  widgets,
  widgetConfig,
  widgetAreaRef
}: WidgetAreaProps) {
  // Widget layout - DynaVis-style compact toolbar
  const widgetLayout = widgetConfig?.layout || {};
  const widgetContainerStyle = {}; // Let CSS handle container styling
  const widgetAreaStyle: React.CSSProperties = {
    // Minimal overrides - let CSS handle most styling
    maxWidth:
      widgetLayout.maxWidth && widgetLayout.maxWidth !== '100%'
        ? toCssSize(widgetLayout.maxWidth, '100%')
        : undefined
  };
  const widgetCardStyle = {}; // Let CSS handle card styling
  const widgetTitleStyle = {}; // Let CSS handle title styling

  return (
    <div className="controls" style={widgetContainerStyle}>
      <div className="widget-area" ref={widgetAreaRef} style={widgetAreaStyle}>
        {widgets.length === 0 ? (
          <div className="widget-placeholder">
            No widgets yet. Ask the assistant to create a widget.
          </div>
        ) : (
          widgets.map((widget) => (
            <div
              key={widget.id}
              className="widget-card"
              data-widget-id={widget.id}
              style={widgetCardStyle}
            >
              <div className="widget-title" style={widgetTitleStyle}>
                {widget.name}
              </div>
              <div className="widget-body" dangerouslySetInnerHTML={{ __html: widget.html }} />
            </div>
          ))
        )}
      </div>
    </div>
  );
});

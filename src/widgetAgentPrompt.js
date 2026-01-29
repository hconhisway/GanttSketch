import { WIDGET_AGENT_GUIDE, summarizeWidgetConfig } from './widgetConfig';

function summarizeWidgets(widgets) {
  if (!Array.isArray(widgets) || widgets.length === 0) {
    return 'none';
  }
  return widgets
    .map(widget => `${widget.id}: ${widget.name}`)
    .join(', ');
}

function serializeWidgets(widgets) {
  if (!Array.isArray(widgets) || widgets.length === 0) {
    return '[]';
  }
  const safe = widgets.map(widget => ({
    id: widget.id,
    name: widget.name,
    html: widget.html,
    listeners: widget.listeners,
    description: widget.description
  }));
  return JSON.stringify(safe, null, 2);
}

export function getWidgetSystemPrompt(chartContext, widgetConfig, widgets) {
  const contextInfo = `

## Current Chart Context

- Total tracks: ${chartContext.totalTracks || 'unknown'}
- Track names: ${chartContext.trackNames?.slice(0, 10).join(', ') || 'loading...'}${chartContext.trackNames?.length > 10 ? '...' : ''}
- Time range: ${chartContext.timeRange || 'unknown'}
- Data points: ${chartContext.dataPointCount || 'unknown'}
- Current gantt config: ${chartContext.configSummary || 'unknown'}

## Current Widget Config
- ${summarizeWidgetConfig(widgetConfig)}

## Current Widgets
- ${summarizeWidgets(widgets)}

## Current Widgets Sheet (JSON)
${serializeWidgets(widgets)}
`;

  return WIDGET_AGENT_GUIDE + contextInfo;
}

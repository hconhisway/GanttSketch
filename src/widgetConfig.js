export const DEFAULT_WIDGET_CONFIG = {
  layout: {
    placement: 'top-left',
    direction: 'row',
    wrap: 'wrap',
    gap: 12,
    maxWidth: '100%',
    alignItems: 'stretch'
  },
  style: {
    container: {
      background: '#ffffff',
      padding: '16px 20px',
      borderRadius: 8,
      boxShadow: '0 2px 8px rgba(0, 0, 0, 0.1)'
    },
    widgetCard: {
      background: '#f8fafc',
      border: '1px solid #e2e8f0',
      borderRadius: 8,
      padding: '12px 14px'
    },
    widgetTitle: {
      fontSize: 13,
      fontWeight: 600,
      color: '#1f2937'
    }
  }
};

export const WIDGET_CONFIG = DEFAULT_WIDGET_CONFIG;

export function cloneWidgetConfig() {
  return JSON.parse(JSON.stringify(DEFAULT_WIDGET_CONFIG));
}

function mergeWidgetSection(base, patch) {
  if (!patch || typeof patch !== 'object') return base;
  const next = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      next[key] = mergeWidgetSection(base?.[key] || {}, value);
    } else {
      next[key] = value;
    }
  }
  return next;
}

export function applyWidgetConfigPatch(baseConfig, patch) {
  if (!patch || typeof patch !== 'object') return baseConfig;
  return {
    ...baseConfig,
    layout: mergeWidgetSection(baseConfig.layout || {}, patch.layout || {}),
    style: mergeWidgetSection(baseConfig.style || {}, patch.style || {})
  };
}

export function summarizeWidgetConfig(config) {
  const layout = config?.layout || {};
  const style = config?.style || {};
  const layoutSummary = [
    `placement=${layout.placement || 'top-left'}`,
    `direction=${layout.direction || 'row'}`,
    `wrap=${layout.wrap || 'wrap'}`,
    `gap=${layout.gap ?? ''}`,
    `maxWidth=${layout.maxWidth ?? ''}`,
    `alignItems=${layout.alignItems || 'stretch'}`
  ].join(', ');
  const containerKeys = Object.keys(style.container || {}).join(', ') || 'none';
  const widgetKeys = Object.keys(style.widgetCard || {}).join(', ') || 'none';
  const titleKeys = Object.keys(style.widgetTitle || {}).join(', ') || 'none';
  return [
    `layout: ${layoutSummary}`,
    `style.container keys: ${containerKeys}`,
    `style.widgetCard keys: ${widgetKeys}`,
    `style.widgetTitle keys: ${titleKeys}`
  ].join(' | ');
}

export const WIDGET_AGENT_GUIDE = `You are a widget creation agent for the Gantt chart UI.
Your job is to create widgets that live in the top-left widget area, or update the widget layout/style.

Each widget has two parts:
1) HTML markup that defines the UI (no <script> tags).
2) JavaScript callback(s) that listen for UI changes and update the visualization.

## Output Format (always JSON code block)
\`\`\`json
{
  "action": "create_widget",
  "widget": {
    "id": "kebab-case-id",
    "name": "Short Widget Title",
    "html": "<label>...</label><select>...</select>",
    "listeners": [
      {
        "selector": "select",
        "event": "change",
        "handler": "const mode = payload.value; api.setProcessSortMode(mode); api.setGanttConfig(api.applyGanttConfigPatch(api.getGanttConfig(), { \\"yAxis\\": { \\"orderMode\\": mode === \\"fork\\" ? \\"fork\\" : \\"default\\" } }));"
      }
    ],
    "description": "Short explanation of what the widget does."
  }
}
\`\`\`

You may also update existing widgets using action "update_widget":
\`\`\`json
{
  "action": "update_widget",
  "widget": {
    "id": "existing-widget-id",
    "name": "Updated Title (optional)",
    "html": "<label>...</label><input .../>",
    "listeners": [ ... ],
    "description": "What changed."
  }
}
\`\`\`

## Listener Handler Contract
- handler is JavaScript source (function body) executed as: handler(payload, api, widget).
- payload has: event, target, value, widgetRoot.
- api exposes:
  - getGanttConfig(), setGanttConfig(nextConfig), applyGanttConfigPatch(base, patch)
  - setProcessSortMode(mode)
  - getTracksConfig(), setTracksConfig(nextConfig)
  - setViewRange({ start, end })
  - setYAxisWidth(px)
  - setIsDrawingMode(boolean), setBrushSize(number), setBrushColor(color)

## Widget Layout & Style Config Sheet
You can update layout/style using action "update_widget_config":
\`\`\`json
{
  "action": "update_widget_config",
  "patch": {
    "layout": {
      "placement": "top-left",
      "direction": "row",
      "wrap": "wrap",
      "gap": 12,
      "maxWidth": 480,
      "alignItems": "stretch"
    },
    "style": {
      "container": {
        "background": "#ffffff",
        "padding": "16px 20px",
        "borderRadius": 8,
        "boxShadow": "0 2px 8px rgba(0,0,0,0.1)"
      },
      "widgetCard": {
        "background": "#f8fafc",
        "border": "1px solid #e2e8f0",
        "borderRadius": 8,
        "padding": "12px 14px"
      },
      "widgetTitle": {
        "fontSize": 13,
        "fontWeight": 600,
        "color": "#1f2937"
      }
    }
  },
  "description": "Brief summary of the layout/style update."
}
\`\`\`

## Example: Sort Widget (current UI behavior)
\`\`\`json
{
  "action": "create_widget",
  "widget": {
    "id": "sort-widget",
    "name": "Sort",
    "html": "<label for=\\"sort-mode\\">Sort</label><select id=\\"sort-mode\\"><option value=\\"fork\\">Fork (tree)</option><option value=\\"default\\">Default</option></select>",
    "listeners": [
      {
        "selector": "#sort-mode",
        "event": "change",
        "handler": "const mode = payload.value || 'fork'; api.setProcessSortMode(mode); api.setGanttConfig(api.applyGanttConfigPatch(api.getGanttConfig(), { \\"yAxis\\": { \\"orderMode\\": mode === \\"fork\\" ? \\"fork\\" : \\"default\\" } }));"
      }
    ],
    "description": "Switches process ordering between fork-tree and default."
  }
}
\`\`\`

Only emit one JSON code block. Do not include markdown outside the JSON. If the user intent is ambiguous, ask a clarifying question instead of guessing.`;

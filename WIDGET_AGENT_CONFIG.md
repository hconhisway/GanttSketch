# Widget Agent Config Sheet

This sheet describes the widget agent contract for creating UI widgets and
updating widget layout/style.

## Trigger
- The widget agent is used when the user message contains the keyword "widget".

## Widget Definition
Each widget has two parts:
1) HTML markup that defines the UI (no `<script>` tags).
2) JavaScript callback(s) that listen for UI changes and update the visualization.

### Widget JSON Shape
```json
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
        "handler": "const mode = payload.value; api.setProcessSortMode(mode); api.setGanttConfig(api.applyGanttConfigPatch(api.getGanttConfig(), { \"yAxis\": { \"orderMode\": mode === \"fork\" ? \"fork\" : \"default\" } }));"
      }
    ],
    "description": "Short explanation of what the widget does."
  }
}
```

### Update Existing Widget
```json
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
```

### Listener Handler Contract
- handler is JavaScript source (function body) executed as: `handler(payload, api, widget)`.
- payload has: `event`, `target`, `value`, `widgetRoot`.
- api exposes:
  - `getGanttConfig()`, `setGanttConfig(nextConfig)`, `applyGanttConfigPatch(base, patch)`
  - `setProcessSortMode(mode)`
  - `getTracksConfig()`, `setTracksConfig(nextConfig)`
  - `setViewRange({ start, end })`
  - `setYAxisWidth(px)`
  - `setIsDrawingMode(boolean)`, `setBrushSize(number)`, `setBrushColor(color)`

## Widget Layout & Style (Config Sheet)
These layout/style settings can be updated by the agent using
`action: "update_widget_config"`.

```json
{
  "action": "update_widget_config",
  "patch": {
    "layout": {
      "placement": "top-left",
      "direction": "row",
      "wrap": "wrap",
      "gap": 12,
      "maxWidth": "100%",
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
```

## Example: Sort Widget (Current Behavior)
```json
{
  "action": "create_widget",
  "widget": {
    "id": "sort-widget",
    "name": "Sort",
    "html": "<label for=\"sort-mode\">Sort</label><select id=\"sort-mode\"><option value=\"fork\">Fork (tree)</option><option value=\"default\">Default</option></select>",
    "listeners": [
      {
        "selector": "#sort-mode",
        "event": "change",
        "handler": "const mode = payload.value || 'fork'; api.setProcessSortMode(mode); api.setGanttConfig(api.applyGanttConfigPatch(api.getGanttConfig(), { \"yAxis\": { \"orderMode\": mode === \"fork\" ? \"fork\" : \"default\" } }));"
      }
    ],
    "description": "Switches process ordering between fork-tree and default."
  }
}
```

/**
 * Gantt Config Schema Reference
 * 
 * This file documents all valid configuration paths and formats for the Gantt chart.
 * Used by the Widget Agent to generate correct config patches.
 */

/**
 * Color Configuration Schema
 * 
 * The color config determines how bars are colored in the chart.
 */
export const COLOR_CONFIG_SCHEMA = {
  // Fixed color - applies same color to ALL bars
  // Use this for simple "make everything black" requests
  fixedColor: {
    type: 'string',
    description: 'A single color applied to all bars. Overrides palette and rules.',
    examples: [
      'rgba(0,0,0,0.38)',
      '#2563EB',
      'rgb(255, 0, 0)'
    ],
    usage: `api.setGanttConfig(api.applyGanttConfigPatch(api.getGanttConfig(), {
  color: { fixedColor: 'rgba(0,0,0,0.38)' }
}));`
  },

  // Palette - array of color strings for hashing
  palette: {
    type: 'array<string>',
    description: 'Array of hex/rgb color strings. Colors are selected by hashing the colorKey.',
    examples: [
      ['#2563EB', '#0EA5E9', '#14B8A6', '#10B981'],
      ['#ff0000', '#00ff00', '#0000ff']
    ],
    usage: `api.setGanttConfig(api.applyGanttConfigPatch(api.getGanttConfig(), {
  color: { 
    palette: ['#2563EB', '#0EA5E9', '#14B8A6', '#10B981']
  }
}));`
  },

  // Key Rule - expression that determines the color key
  keyRule: {
    type: 'object',
    description: 'Expression object that returns a value used for color hashing. NOT a string.',
    format: {
      type: 'expr',
      expr: '{ op: "...", ... }'
    },
    examples: [
      // Color by category
      { type: 'expr', expr: { op: 'get', path: 'event.cat' } },
      // Color by name
      { type: 'expr', expr: { op: 'get', path: 'event.name' } },
      // Color by process
      { type: 'expr', expr: { op: 'var', name: 'pid' } },
      // Coalesce multiple fields
      {
        type: 'expr',
        expr: {
          op: 'coalesce',
          args: [
            { op: 'get', path: 'event.cat' },
            { op: 'get', path: 'event.name' }
          ]
        }
      }
    ],
    usage: `api.setGanttConfig(api.applyGanttConfigPatch(api.getGanttConfig(), {
  color: { 
    keyRule: { type: 'expr', expr: { op: 'get', path: 'event.cat' } }
  }
}));`
  },

  // Color Rule - expression that returns the final color
  colorRule: {
    type: 'object',
    description: 'Expression that returns the final color string. Usually uses paletteHash.',
    format: {
      type: 'expr',
      expr: '{ op: "paletteHash", args: [...] }'
    },
    examples: [
      // Hash to palette
      {
        type: 'expr',
        expr: {
          op: 'paletteHash',
          args: [
            { op: 'var', name: 'colorKey' },
            { op: 'var', name: 'palette' }
          ]
        }
      },
      // Conditional color
      {
        type: 'expr',
        expr: {
          op: 'if',
          args: [
            { op: '==', args: [{ op: 'get', path: 'event.cat' }, 'error'] },
            '#ff0000',
            { op: 'paletteHash', args: [{ op: 'var', name: 'colorKey' }, { op: 'var', name: 'palette' }] }
          ]
        }
      }
    ]
  }
};

/**
 * Y-Axis Configuration Schema
 */
export const YAXIS_CONFIG_SCHEMA = {
  processOrderRule: {
    type: 'object',
    description: 'Rule for ordering processes on the Y-axis.',
    examples: [
      // Fork tree (parent-child hierarchy)
      { type: 'transform', name: 'forkTree', params: { includeUnspecified: true } },
      // Sort by PID ascending
      { type: 'transform', name: 'pidAsc' },
      // Sort by PID descending
      { type: 'transform', name: 'pidDesc' },
      // Custom order
      { type: 'transform', name: 'customList', params: { list: ['pid1', 'pid2'], includeUnspecified: true } }
    ]
  },

  threadLaneRule: {
    type: 'object',
    description: 'Rule for arranging thread lanes within a process.',
    examples: [
      { type: 'transform', name: 'autoPack' },
      { type: 'transform', name: 'byLevel' }
    ]
  }
};

/**
 * View Range Configuration
 */
export const VIEW_RANGE_SCHEMA = {
  start: {
    type: 'number',
    description: 'Start time in microseconds'
  },
  end: {
    type: 'number',
    description: 'End time in microseconds'
  }
};

/**
 * Layout Configuration Schema
 */
export const LAYOUT_CONFIG_SCHEMA = {
  laneHeight: {
    type: 'number',
    description: 'Height of each lane in pixels',
    default: 18
  },
  lanePadding: {
    type: 'number',
    description: 'Padding between lanes in pixels',
    default: 3
  },
  'yAxis.baseWidth': {
    type: 'number',
    description: 'Base width of the Y-axis label area',
    default: 180
  }
};

/**
 * Expression DSL Reference
 * 
 * Operations available in expr objects.
 */
export const EXPRESSION_OPS = {
  // Value getters
  'get': { 
    description: 'Get a value from an object path',
    format: '{ op: "get", path: "event.fieldName" }',
    example: { op: 'get', path: 'event.cat' }
  },
  'var': {
    description: 'Get a context variable',
    format: '{ op: "var", name: "varName" }',
    variables: ['pid', 'tid', 'level', 'colorKey', 'palette', 'startUs', 'durationUs', 'trackKey']
  },

  // String operations
  'concat': { description: 'Concatenate values', format: '{ op: "concat", args: [a, b, ...] }' },
  'lower': { description: 'Lowercase string', format: '{ op: "lower", args: [value] }' },
  'upper': { description: 'Uppercase string', format: '{ op: "upper", args: [value] }' },

  // Logic operations
  'if': { description: 'Conditional', format: '{ op: "if", args: [condition, thenValue, elseValue] }' },
  'coalesce': { description: 'First non-empty value', format: '{ op: "coalesce", args: [a, b, ...] }' },
  '==': { description: 'Equality', format: '{ op: "==", args: [a, b] }' },
  '!=': { description: 'Inequality', format: '{ op: "!=", args: [a, b] }' },
  'and': { description: 'Logical AND', format: '{ op: "and", args: [a, b] }' },
  'or': { description: 'Logical OR', format: '{ op: "or", args: [a, b] }' },

  // Math operations
  'add': { description: 'Addition', format: '{ op: "add", args: [a, b] }' },
  'sub': { description: 'Subtraction', format: '{ op: "sub", args: [a, b] }' },
  'mul': { description: 'Multiplication', format: '{ op: "mul", args: [a, b] }' },
  'div': { description: 'Division', format: '{ op: "div", args: [a, b] }' },

  // Color operations
  'paletteHash': { 
    description: 'Hash a key to select from palette',
    format: '{ op: "paletteHash", args: [keyExpr, paletteExpr] }',
    example: { op: 'paletteHash', args: [{ op: 'var', name: 'colorKey' }, { op: 'var', name: 'palette' }] }
  },

  // Formatting
  'formatTimeUs': { description: 'Format microseconds as time', format: '{ op: "formatTimeUs", args: [value] }' },
  'formatDurationUs': { description: 'Format duration', format: '{ op: "formatDurationUs", args: [value] }' }
};

/**
 * Widget API Reference
 * 
 * Methods available on the `api` object in widget handlers.
 */
export const WIDGET_API_REFERENCE = {
  getGanttConfig: {
    description: 'Get the current gantt configuration object',
    returns: 'GanttConfig object',
    usage: 'const config = api.getGanttConfig();'
  },
  setGanttConfig: {
    description: 'Set the entire gantt configuration',
    params: ['nextConfig: GanttConfig'],
    usage: 'api.setGanttConfig(newConfig);'
  },
  applyGanttConfigPatch: {
    description: 'Deep merge a patch into a base config',
    params: ['baseConfig: GanttConfig', 'patch: Partial<GanttConfig>'],
    returns: 'Merged GanttConfig',
    usage: 'const newConfig = api.applyGanttConfigPatch(api.getGanttConfig(), { color: { fixedColor: "#000" } });'
  },
  setProcessSortMode: {
    description: 'Set process sorting mode',
    params: ['mode: "fork" | "default"'],
    usage: 'api.setProcessSortMode("fork");'
  },
  setViewRange: {
    description: 'Set the visible time range',
    params: ['range: { start: number, end: number }'],
    usage: 'api.setViewRange({ start: 0, end: 1000000 });'
  },
  setYAxisWidth: {
    description: 'Set Y-axis label width',
    params: ['pixels: number'],
    usage: 'api.setYAxisWidth(200);'
  },
  getTracksConfig: {
    description: 'Get current tracks configuration',
    returns: 'TracksConfig object'
  },
  setTracksConfig: {
    description: 'Set tracks configuration',
    params: ['config: TracksConfig']
  },
  setIsDrawingMode: {
    description: 'Enable/disable drawing mode',
    params: ['enabled: boolean']
  },
  setBrushSize: {
    description: 'Set drawing brush size',
    params: ['size: number']
  },
  setBrushColor: {
    description: 'Set drawing brush color',
    params: ['color: string']
  }
};

/**
 * Format the schema as a reference string for the LLM prompt.
 */
export function formatConfigSchemaForPrompt() {
  return `## Gantt Config Schema Reference

### Color Configuration (IMPORTANT)
The color config determines how bars are colored. Use the CORRECT format:

**fixedColor** (string) - Single color for ALL bars:
\`\`\`javascript
api.setGanttConfig(api.applyGanttConfigPatch(api.getGanttConfig(), {
  color: { fixedColor: 'rgba(0,0,0,0.38)' }
}));
\`\`\`

**palette** (array of strings) - Colors for hashing:
\`\`\`javascript
api.setGanttConfig(api.applyGanttConfigPatch(api.getGanttConfig(), {
  color: { palette: ['#2563EB', '#0EA5E9', '#14B8A6'] }
}));
\`\`\`

**keyRule** (expression object, NOT a string) - What to hash for color:
\`\`\`javascript
// Color by category
{ type: 'expr', expr: { op: 'get', path: 'event.cat' } }
// Color by name
{ type: 'expr', expr: { op: 'get', path: 'event.name' } }
\`\`\`

**To reset to default colors:**
\`\`\`javascript
api.setGanttConfig(api.applyGanttConfigPatch(api.getGanttConfig(), {
  color: { fixedColor: null }
}));
\`\`\`

### Y-Axis Process Order
\`\`\`javascript
// Fork tree (parent-child)
{ type: 'transform', name: 'forkTree', params: { includeUnspecified: true } }
// PID ascending
{ type: 'transform', name: 'pidAsc' }
\`\`\`

### View Range
\`\`\`javascript
api.setViewRange({ start: 0, end: 1000000 }); // microseconds
\`\`\`

### Expression DSL
Available operations: get, var, concat, if, coalesce, ==, !=, and, or, add, sub, mul, div, paletteHash, formatTimeUs, formatDurationUs

Context variables: pid, tid, level, colorKey, palette, startUs, durationUs, trackKey`;
}

/**
 * Format the API reference for the LLM prompt.
 */
export function formatWidgetApiForPrompt() {
  return `## Widget API Reference

The \`api\` object provides these methods:

| Method | Description |
|--------|-------------|
| \`api.getGanttConfig()\` | Get current config |
| \`api.setGanttConfig(config)\` | Set entire config |
| \`api.applyGanttConfigPatch(base, patch)\` | Merge patch into config, returns new config |
| \`api.setProcessSortMode(mode)\` | Set "fork" or "default" sorting |
| \`api.setViewRange({ start, end })\` | Set visible time range (microseconds) |
| \`api.setYAxisWidth(px)\` | Set Y-axis width |
| \`api.getTracksConfig()\` | Get tracks config |
| \`api.setTracksConfig(config)\` | Set tracks config |
| \`api.setIsDrawingMode(bool)\` | Toggle drawing mode |
| \`api.setBrushSize(n)\` | Set brush size |
| \`api.setBrushColor(color)\` | Set brush color |

**Common Pattern:**
\`\`\`javascript
// Read current config, patch it, then set it back
api.setGanttConfig(
  api.applyGanttConfigPatch(
    api.getGanttConfig(),
    { color: { fixedColor: 'rgba(0,0,0,0.38)' } }
  )
);
\`\`\``;
}

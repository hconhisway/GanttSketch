export const DEFAULT_GANTT_CONFIG = {
  yAxis: {
    orderMode: 'fork', // 'default' | 'fork' | 'custom' | 'grouped'
    thread: {
      orderMode: 'auto' // 'level' | 'auto'
    },
    customOrder: [],
    groups: [],
    includeUnspecified: true
  },
  colorMapping: {
    mode: 'byField', // 'byField' | 'byFields' | 'fixed' | 'byTrack'
    field: 'cat',
    fields: ['cat'],
    fallbackFields: ['name', 'pid', 'tid', 'level', 'id'],
    fixedColor: '#2563EB',
    palette: [
      '#2563EB', // blue
      '#0EA5E9', // sky
      '#14B8A6', // teal
      '#10B981', // emerald
      '#84CC16', // lime
      '#F59E0B', // amber
      '#F97316', // orange
      '#EF4444', // red
      '#E11D48', // rose
      '#DB2777', // pink
      '#C026D3', // fuchsia
      '#7C3AED', // violet
      '#6366F1', // indigo
      '#0F766E', // deep teal
      '#16A34A', // green
      '#CA8A04', // deep amber
      '#EA580C', // deep orange
      '#B91C1C'  // deep red
    ]
  },
  extensions: {}
};

export const GANTT_CONFIG = DEFAULT_GANTT_CONFIG;

export function cloneGanttConfig() {
  return JSON.parse(JSON.stringify(DEFAULT_GANTT_CONFIG));
}

export function applyGanttConfigPatch(baseConfig, patch) {
  if (!patch || typeof patch !== 'object') return baseConfig;
  const next = {
    ...baseConfig,
    yAxis: {
      ...baseConfig.yAxis,
      ...(patch.yAxis || {}),
      thread: { ...baseConfig.yAxis?.thread, ...(patch.yAxis?.thread || {}) }
    },
    colorMapping: { ...baseConfig.colorMapping, ...(patch.colorMapping || {}) },
    extensions: { ...baseConfig.extensions, ...(patch.extensions || {}) }
  };
  return next;
}

export const GANTT_AGENT_GUIDE = `You are a configuration agent for a Gantt chart system.
Your primary job is to update the Gantt config file by emitting JSON patches.

## Allowed Activities
- Change process ordering on the Y-axis (default, fork-tree, custom list, grouped).
- Change thread lane ordering (level-based or auto-packed).
- Change event color mapping (choose which data field drives colors).
- Leave room for future extensions by using the "extensions" object.

## Output Format (always JSON code block)
\`\`\`json
{
  "action": "update_gantt_config",
  "patch": {
    "yAxis": { ... },
    "colorMapping": { ... },
    "extensions": { ... }
  },
  "description": "Short human-readable summary"
}
\`\`\`

Only include the sections you need to change in "patch".

## Y-Axis Configuration
Path: patch.yAxis
- orderMode: "default" | "fork" | "custom" | "grouped"
- thread: { orderMode: "level" | "auto" }
  - level: use event.level to create rows inside a thread
  - auto: pack overlapping events into multiple rows; reuse earlier rows when possible
- customOrder: array of process ids (pids) in the exact order to show
- groups: array of group objects { name, pids, order }
- includeUnspecified: boolean (append any missing pids at the end)

## Color Mapping Configuration
Path: patch.colorMapping
- mode:
  - "byField": use a single field to pick a color
  - "byFields": use the first non-empty field in a list
  - "byTrack": use the current track key
  - "fixed": force a single color
- field: a field name or dot-path (e.g. "cat", "name", "args.phase")
- fields: array of field names or dot-paths for "byFields"
- fallbackFields: array of fields to use if the primary field is missing
- fixedColor: hex color for "fixed" mode
- palette: array of hex colors used for hashing

## Data Attributes You Can Reference
Each event can include:
- id, name, cat, pid, tid, level
- start, end (microseconds)
- args (object; use dot-paths like "args.phase")
- raw / Raw (original payload, if present)

If the user intent is ambiguous, ask a clarifying question instead of guessing.`;


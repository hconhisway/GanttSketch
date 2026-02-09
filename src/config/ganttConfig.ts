import { GanttConfig } from '../types/ganttConfig';

export const DEFAULT_GANTT_CONFIG: GanttConfig = {
  xAxis: {
    mergeGapRatio: 0.002
  },
  layout: {
    margin: { top: 24, right: 24, bottom: 24, left: 16 },
    headerHeight: 24,
    laneHeight: 18,
    lanePadding: 3,
    expandedPadding: 8,
    hierarchy2Gap: 6,
    yAxis: {
      autoWidth: true,
      baseWidth: 180,
      minWidth: 120,
      maxWidth: 240,
      hierarchy1Indent: 16,
      labelPadding: { left: 8, right: 12, hierarchy2Indent: 18 },
      hierarchy1Font: '700 12px system-ui',
      hierarchy2Font: '500 11px system-ui'
    },
    label: {
      minBarLabelPx: 90
    }
  },
  yAxis: {
    hierarchy1OrderRule: {
      type: 'transform',
      name: 'forkTree',
      params: { includeUnspecified: true }
    },
    hierarchy2LaneRule: {
      type: 'transform',
      name: 'autoPack'
    },
    hierarchy1LabelRule: {
      type: 'expr',
      expr: {
        op: 'concat',
        args: [
          { op: 'if', args: [{ op: 'var', name: 'isExpanded' }, '▼ ', '▶ '] },
          'Row ',
          { op: 'var', name: 'pid' }
        ]
      }
    },
    hierarchy2LabelRule: {
      type: 'expr',
      expr: {
        op: 'if',
        args: [
          { op: 'var', name: 'isMainThread' },
          'main',
          { op: 'concat', args: ['L2 ', { op: 'var', name: 'tid' }] }
        ]
      }
    }
  },
  color: {
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
      '#B91C1C' // deep red
    ],
    keyRule: {
      type: 'expr',
      expr: {
        op: 'coalesce',
        args: [
          { op: 'get', path: 'event.cat' },
          { op: 'get', path: 'event.name' },
          { op: 'get', path: 'event.pid' },
          { op: 'get', path: 'event.tid' },
          { op: 'get', path: 'event.level' },
          { op: 'get', path: 'event.id' },
          { op: 'var', name: 'trackKey' }
        ]
      }
    },
    colorRule: {
      type: 'expr',
      expr: {
        op: 'paletteHash',
        args: [
          { op: 'var', name: 'colorKey' },
          { op: 'var', name: 'palette' }
        ]
      }
    }
  },
  tooltip: {
    enabled: true,
    hierarchy1: {
      title: 'Row',
      fields: [
        { label: 'Row', value: { op: 'var', name: 'pid' } },
        {
          label: 'Duration',
          value: { op: 'formatDurationUs', args: [{ op: 'var', name: 'durationUs' }] }
        }
      ]
    },
    event: {
      title: 'Details',
      fields: [
        { label: 'Name', value: { op: 'get', path: 'event.name' } },
        { label: 'Category', value: { op: 'get', path: 'event.cat' } },
        {
          label: 'Start time',
          value: { op: 'formatTimeUsFull', args: [{ op: 'var', name: 'startUs' }] }
        },
        {
          label: 'Duration',
          value: { op: 'formatDurationUs', args: [{ op: 'var', name: 'durationUs' }] }
        },
        { label: 'Thread', value: { op: 'var', name: 'tid' } },
        { label: 'Process', value: { op: 'var', name: 'pid' } },
        { label: 'SQL ID', value: { op: 'var', name: 'sqlId' } }
      ],
      args: {
        enabled: true,
        max: 24,
        sort: 'alpha',
        label: 'Arguments'
      }
    }
  },
  extensions: {}
};

export const GANTT_CONFIG = DEFAULT_GANTT_CONFIG;

export function cloneGanttConfig(): GanttConfig {
  return JSON.parse(JSON.stringify(DEFAULT_GANTT_CONFIG));
}

function getArrayItemKey(item: any): string {
  if (!item || typeof item !== 'object') return '';
  return String(item.id || item.key || item.label || item.name || item.path || '');
}

function mergeObjectArray(baseArray: any, patchArray: any): any[] {
  const baseList = Array.isArray(baseArray) ? baseArray : [];
  const keyFor = (item: any) => {
    const key = getArrayItemKey(item);
    if (key) return key;
    try {
      return JSON.stringify(item);
    } catch {
      return '';
    }
  };

  const baseByKey = new Map();
  baseList.forEach((item: any) => {
    const key = keyFor(item);
    if (key && !baseByKey.has(key)) {
      baseByKey.set(key, item);
    }
  });

  const ordered: any[] = [];
  const usedKeys = new Set();
  const deletedKeys = new Set();

  patchArray.forEach((item: any) => {
    if (!item || typeof item !== 'object') return;
    const key = keyFor(item);
    const shouldDelete = item._delete === true || item.__delete === true;
    if (key) {
      usedKeys.add(key);
      if (shouldDelete) {
        deletedKeys.add(key);
        return;
      }
      ordered.push(item);
      return;
    }
    if (!shouldDelete) {
      ordered.push(item);
    }
  });

  baseList.forEach((item: any) => {
    const key = keyFor(item);
    if (key) {
      if (deletedKeys.has(key)) return;
      if (usedKeys.has(key)) return;
    }
    ordered.push(item);
  });

  return ordered;
}

function mergeDeep(base: any, patch: any): any {
  if (patch === undefined) return base;
  if (Array.isArray(base) && patch && typeof patch === 'object') {
    if (patch.__replace === true) {
      return Array.isArray(patch.items) ? [...patch.items] : [];
    }
  }
  if (Array.isArray(patch)) {
    if (Array.isArray(base) && patch.some((item) => item && typeof item === 'object')) {
      return mergeObjectArray(base, patch);
    }
    return [...patch];
  }
  if (!patch || typeof patch !== 'object') return patch;
  const baseObj = base && typeof base === 'object' && !Array.isArray(base) ? base : {};
  const next: Record<string, any> = { ...baseObj };
  for (const [key, value] of Object.entries(patch)) {
    const baseValue = (baseObj as any)[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      next[key] = mergeDeep(baseValue, value);
    } else {
      next[key] = mergeDeep(baseValue, value);
    }
  }
  return next;
}

/**
 * Normalize config so that new hierarchy1/hierarchy2 keys are set from old process/thread keys
 * when the new keys are missing. Call after merging so old saved configs still work.
 */
export function normalizeGanttConfig(raw: any): GanttConfig {
  if (!raw || typeof raw !== 'object') return raw as GanttConfig;
  const c = { ...raw };
  if (c.yAxis && typeof c.yAxis === 'object') {
    const y = { ...c.yAxis };
    if (y.processOrderRule != null && y.hierarchy1OrderRule == null) y.hierarchy1OrderRule = y.processOrderRule;
    if (y.threadLaneRule != null && y.hierarchy2LaneRule == null) y.hierarchy2LaneRule = y.threadLaneRule;
    if (y.processLabelRule != null && y.hierarchy1LabelRule == null) y.hierarchy1LabelRule = y.processLabelRule;
    if (y.threadLabelRule != null && y.hierarchy2LabelRule == null) y.hierarchy2LabelRule = y.threadLabelRule;
    c.yAxis = y;
  }
  if (c.layout && typeof c.layout === 'object') {
    const layout = { ...c.layout };
    if (layout.threadGap != null && layout.hierarchy2Gap == null) layout.hierarchy2Gap = layout.threadGap;
    if (layout.yAxis && typeof layout.yAxis === 'object') {
      const ly = { ...layout.yAxis };
      if (ly.processIndent != null && ly.hierarchy1Indent == null) ly.hierarchy1Indent = ly.processIndent;
      if (ly.processFont != null && ly.hierarchy1Font == null) ly.hierarchy1Font = ly.processFont;
      if (ly.threadFont != null && ly.hierarchy2Font == null) ly.hierarchy2Font = ly.threadFont;
      if (ly.labelPadding && typeof ly.labelPadding === 'object' && ly.labelPadding.threadIndent != null && (ly.labelPadding as any).hierarchy2Indent == null) {
        ly.labelPadding = { ...ly.labelPadding, hierarchy2Indent: (ly.labelPadding as any).threadIndent };
      }
      layout.yAxis = ly;
    }
    c.layout = layout;
  }
  if (c.tooltip && typeof c.tooltip === 'object' && c.tooltip.process != null && (c.tooltip as any).hierarchy1 == null) {
    c.tooltip = { ...c.tooltip, hierarchy1: (c.tooltip as any).process };
  }
  return c as GanttConfig;
}

export function applyGanttConfigPatch(baseConfig: GanttConfig, patch: any): GanttConfig {
  if (!patch || typeof patch !== 'object') return baseConfig;
  return normalizeGanttConfig(mergeDeep(baseConfig, patch));
}

export const GANTT_AGENT_GUIDE = `You are a configuration agent for a Gantt chart system.
Your job is to update the Gantt config by emitting JSON patches.

## Output Format (always JSON code block)
\`\`\`json
{
  "action": "update_gantt_config",
  "patch": { ... },
  "description": "Short human-readable summary"
}
\`\`\`

Only include the sections you need to change in "patch".

## Core Idea: Rules, not enums
Many settings accept an executable rule instead of fixed options.
Rules are JSON ASTs (no JavaScript). They are evaluated by a safe interpreter.

## Array Merge Rules (to avoid accidental loss)
- Arrays of objects are merged by key (id/key/label/name/path).
- To remove an entry, include it with "_delete": true.
- To fully replace an array, wrap with: { "__replace": true, "items": [ ... ] }
- To reorder items, provide an array in the desired order; missing items are appended.

### Rule Shapes
- Expr rule: { "type": "expr", "expr": { "op": "...", ... } }
- Transform rule: { "type": "transform", "name": "...", "params": { ... } }
- Predicate rule: { "type": "predicate", "when": { "op": "...", ... } }

### Common Expr Ops
- get(path), var(name), coalesce, concat, lower, upper, trim
- ==, !=, >, >=, <, <=, and, or, not, case, if
- add, sub, mul, div, clamp, len
- regexTest, regexCapture
- hash, paletteHash
- formatTimeUs, formatTimeUsFull, formatDurationUs

### Rule Context (available vars)
- event: current event (for color/tooltip)
- pid, tid, level, trackKey
- stats: per-hierarchy1 stats (count, totalDurUs, avgDurUs, maxDurUs, minStart, maxEnd)
- isExpanded, isMainThread

## Data Format (normalized events)
Each event is normalized to this shape before rules run:
{
  pid: "string",
  tid: "string",
  ppid: "string | null",
  level: number,
  start: number, // microseconds
  end: number,   // microseconds
  id: "string | number | null",
  name: "string",
  cat: "string",
  args: { ... }  // free-form metadata
}

Notes:
- start/end are usually relative to trace start (microseconds).
- Use event.args.<field> for custom metadata from the source data.
- Tooltip expressions also have startUs, endUs, durationUs, sqlId in scope.

## Y-Axis (hierarchy1 ordering)
Path: patch.yAxis.hierarchy1OrderRule
Use a transform rule. Supported names:
- "forkTree": build order from fork relations (params.includeUnspecified, params.tieBreak)
- "sortBy": sort hierarchy1 keys by a key expr (params.key, params.order)
- "groupBy": group by a key expr (params.key, params.order)
- "customList": explicit list (params.list, params.includeUnspecified)
- "filter": keep keys matching predicate (params.when)
- "pipeline": run multiple steps (params.steps = [rule...])

## Hierarchy2 lanes (expanded rows)
Path: patch.yAxis.hierarchy2LaneRule. Default: autoPack.
- "autoPack": pack overlapping events into lanes (default).
- "byField": one lane per value of any event attribute. Requires params.field (dot path into event). No fixed field names; link directly to any data attribute, e.g. params: { field: "level" }, params: { field: "args.depth" }, params: { field: "cat" }. If params.field is omitted, falls back to autoPack.

## Labels (rules)
Path: patch.yAxis.hierarchy1LabelRule / patch.yAxis.hierarchy2LabelRule

## Layout (optional)
Path: patch.layout
- margin: { top, right, bottom, left }
- headerHeight, laneHeight, lanePadding, expandedPadding, hierarchy2Gap
- yAxis: { autoWidth, baseWidth, minWidth, maxWidth, hierarchy1Indent, labelPadding, hierarchy1Font, hierarchy2Font }
- label: { minBarLabelPx }

## Color (rules)
Path: patch.color
- keyRule: expr to compute a color key
- colorRule: expr that returns a hex color (often via paletteHash)
- palette: array of hex colors

## Tooltip (rules)
Path: patch.tooltip
Use rules to control which fields display and how they format.

### Example: Remove a tooltip field by label
\`\`\`json
{
  "action": "update_gantt_config",
  "patch": {
    "tooltip": {
      "event": {
        "fields": [
          { "label": "SQL ID", "_delete": true }
        ]
      }
    }
  },
  "description": "Remove SQL ID from tooltip fields"
}
\`\`\`

### Example: Reorder tooltip fields (no replacement)
\`\`\`json
{
  "action": "update_gantt_config",
  "patch": {
    "tooltip": {
      "event": {
        "fields": [
          { "label": "Start time" },
          { "label": "End time" },
          { "label": "Duration" }
        ]
      }
    }
  },
  "description": "Move start/end next to each other"
}
\`\`\`

## Examples (copy these patterns)
Example 1: Fork-tree with duration tie-break (longer first)
\`\`\`json
{
  "action": "update_gantt_config",
  "patch": {
    "yAxis": {
      "hierarchy1OrderRule": {
        "type": "transform",
        "name": "forkTree",
        "params": {
          "includeUnspecified": true,
          "tieBreak": { "op": "sub", "args": [0, { "op": "get", "path": "stats.totalDurUs" }] }
        }
      }
    }
  },
  "description": "Fork order with longest processes first"
}
\`\`\`

Example 2: Pipeline = filter + sort
\`\`\`json
{
  "action": "update_gantt_config",
  "patch": {
    "yAxis": {
      "hierarchy1OrderRule": {
        "type": "transform",
        "name": "pipeline",
        "params": {
          "steps": [
            { "name": "filter", "params": { "when": { "op": ">", "args": [{ "op": "get", "path": "stats.totalDurUs" }, 1000000] } } },
            { "name": "sortBy", "params": { "key": { "op": "get", "path": "stats.avgDurUs" }, "order": "desc" } }
          ]
        }
      }
    }
  },
  "description": "Keep only heavy processes, then sort by avg duration desc"
}
\`\`\`

Example 3: Thread lanes by any data attribute (byField, link to any field)
\`\`\`json
{
  "action": "update_gantt_config",
  "patch": {
    "yAxis": { "hierarchy2LaneRule": { "type": "transform", "name": "byField", "params": { "field": "cat" } } }
  },
  "description": "One row per event.cat; params.field can be any path, e.g. level, args.depth, cat"
}
\`\`\`

Example 4: Color rule with explicit cases + palette hash fallback
\`\`\`json
{
  "action": "update_gantt_config",
  "patch": {
    "color": {
      "keyRule": { "type": "expr", "expr": { "op": "coalesce", "args": [
        { "op": "get", "path": "event.args.phase" },
        { "op": "get", "path": "event.cat" },
        { "op": "get", "path": "event.name" }
      ] } },
      "colorRule": { "type": "expr", "expr": { "op": "case", "cases": [
        [ { "op": "==", "args": [ { "op": "var", "name": "colorKey" }, "io_wait" ] }, "#F97316" ],
        [ { "op": "==", "args": [ { "op": "var", "name": "colorKey" }, "compute" ] }, "#2563EB" ]
      ], "else": { "op": "paletteHash", "args": [ { "op": "var", "name": "colorKey" }, { "op": "var", "name": "palette" } ] } } }
    }
  },
  "description": "Phase-aware colors with fallback palette"
}
\`\`\`

Example 5: Tooltip fields + hide args
\`\`\`json
{
  "action": "update_gantt_config",
  "patch": {
    "tooltip": {
      "event": {
        "fields": [
          { "label": "Name", "value": { "op": "get", "path": "event.name" } },
          { "label": "Phase", "value": { "op": "get", "path": "event.args.phase" } },
          { "label": "Duration", "value": { "op": "formatDurationUs", "args": [{ "op": "var", "name": "durationUs" }] } }
        ],
        "args": { "enabled": false }
      }
    }
  },
  "description": "Simple tooltip with key fields only"
}
\`\`\`

Example 6: Compact layout
\`\`\`json
{
  "action": "update_gantt_config",
  "patch": {
    "layout": {
      "headerHeight": 20,
      "laneHeight": 14,
      "hierarchy2Gap": 4,
      "yAxis": { "baseWidth": 160, "minWidth": 100, "maxWidth": 220 }
    }
  },
  "description": "Smaller rows and narrower y-axis"
}
\`\`\`

## Data Attributes You Can Reference
Each event can include:
- id, name, cat, pid, tid, level
- start, end (microseconds)
- args (object; use dot-paths like "args.phase")
- raw / Raw (original payload, if present)

See src/GANTT_CONFIG_SPEC.json for the full spec.

If the user intent is ambiguous, ask a clarifying question instead of guessing.`;

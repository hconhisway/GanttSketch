import { GanttConfig } from '../types/ganttConfig';

export const DEFAULT_GANTT_CONFIG: GanttConfig = {
  xAxis: {
    timeFormat: 'short',
    timeScaleMode: 'physical',
    logarithmic: {
      base: Math.E
    },
    fisheye: {
      distortion: 3,
      focusTime: null
    }
  },
  layout: {
    margin: { top: 24, right: 24, bottom: 24, left: 16 },
    headerHeight: 24,
    laneHeight: 18,
    lanePadding: 3,
    expandedPadding: 8,
    hierarchy2Gap: 6,
    nestedRowHeight: 36,
    nestedLevelInset: 3,
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
    hierarchyDisplayMode: 'rows',
    hierarchy1AggregationRule: {
      type: 'mergeGap',
      mergeGapRatio: 0.002
    },
    hierarchy2AggregationRule: {
      type: 'mergeGap',
      mergeGapRatio: 0.002
    },
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
          { op: 'var', name: 'hierarchy1Field' },
          ': ',
          { op: 'var', name: 'hierarchy1' }
        ]
      }
    },
    hierarchy2LabelRule: {
      type: 'expr',
      expr: {
        op: 'concat',
        args: [{ op: 'var', name: 'hierarchy2Field' }, ': ', { op: 'var', name: 'hierarchy2' }]
      }
    }
  },
  color: {
    palette: [
      '#4C78A8', // tableau20
      '#9ECAE9',
      '#F58518',
      '#FFBF79',
      '#54A24B',
      '#88D27A',
      '#B79A20',
      '#F2CF5B',
      '#439894',
      '#83BCB6',
      '#E45756',
      '#FF9D98',
      '#79706E',
      '#BAB0AC',
      '#D67195',
      '#FCBFD2',
      '#B279A2',
      '#D6A5C9',
      '#9E765F',
      '#D8B5A5'
    ],
    keyRule: {
      type: 'expr',
      expr: {
        op: 'coalesce',
        args: [
          { op: 'get', path: 'event.cat' },
          { op: 'get', path: 'event.name' },
          { op: 'get', path: 'event.hierarchy1' },
          { op: 'get', path: 'event.hierarchy2' },
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
        { label: 'Row', value: { op: 'var', name: 'hierarchy1' } },
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
        { label: 'Thread', value: { op: 'var', name: 'hierarchy2' } },
        { label: 'Process', value: { op: 'var', name: 'hierarchy1' } },
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
  dependencies: {
    maxEdges: 200,
    connector: 'arrow',
    amount: '1hop',
    persistence: 'onClick',
    drawingStyle: 'spline',
    strokeColor: 'rgba(59,130,246,0.45)',
    strokeWidth: 1.5,
    arrowSize: 6
  },
  performance: {
    showOverlay: false,
    webglEnabled: false,
    streamingEnabled: false,
    streamingMaxReqPerSec: 1,
    streamingBufferFactor: 0.5,
    streamingSimulate: false,
    hierarchy1LOD: {
      mergeUtilGap: 0.002
    },
    hierarchy2LOD: {
      pixelWindow: 1
    }
  },
  extensions: {
    auxCharts: {
      enabled: true,
      overview: {
        kind: 'utilizationArea' as const,
        entityLevel: 1,
        bins: { mode: 'auto' as const, min: 300, max: 900 },
        count: { binSize: 1 },
        stacked: {
          mode: 'groupBy' as const,
          groupBy: { op: 'coalesce', args: [{ op: 'get', path: 'event.cat' }, { op: 'get', path: 'event.name' }, { op: 'var', name: 'hierarchy1' }] },
          topK: 8,
          includeOther: true
        }
      }
    }
  }
};

export const GANTT_CONFIG = DEFAULT_GANTT_CONFIG;

export function cloneGanttConfig(): GanttConfig {
  return JSON.parse(JSON.stringify(DEFAULT_GANTT_CONFIG));
}

function isVarNode(node: any, name: string): boolean {
  return Boolean(node && typeof node === 'object' && node.op === 'var' && node.name === name);
}

function buildDefaultHierarchy1LabelRule() {
  return {
    type: 'expr',
    expr: {
      op: 'concat',
      args: [
        { op: 'if', args: [{ op: 'var', name: 'isExpanded' }, '▼ ', '▶ '] },
        { op: 'var', name: 'hierarchy1Field' },
        ': ',
        { op: 'var', name: 'hierarchy1' }
      ]
    }
  };
}

function buildDefaultHierarchy2LabelRule() {
  return {
    type: 'expr',
    expr: {
      op: 'concat',
      args: [{ op: 'var', name: 'hierarchy2Field' }, ': ', { op: 'var', name: 'hierarchy2' }]
    }
  };
}

function buildDefaultHierarchyLabelRule(level: number) {
  if (level <= 1) return buildDefaultHierarchy1LabelRule();
  return {
    type: 'expr',
    expr: {
      op: 'concat',
      args: [
        { op: 'var', name: `hierarchy${level}Field` },
        ': ',
        { op: 'var', name: `hierarchy${level}` }
      ]
    }
  };
}

function buildDefaultHierarchyAggregationRule() {
  return {
    type: 'mergeGap',
    mergeGapRatio: 0.002
  };
}

function normalizeHierarchy1LabelRule(rule: any): any {
  const expr = rule?.type === 'expr' ? rule.expr : rule;
  if (!expr || typeof expr !== 'object' || expr.op !== 'concat' || !Array.isArray(expr.args)) {
    return rule;
  }
  const args = expr.args;
  const hasH1Field = args.some((a: any) => isVarNode(a, 'hierarchy1Field'));
  const hasH1Value = args.some((a: any) => isVarNode(a, 'hierarchy1'));
  const last = args[args.length - 1];
  const endsWithColonString = typeof last === 'string' && /:\s*$/.test(last);
  const colonAtTail = last === ': ';
  // Fix malformed historical orders like:
  // [if, var(hierarchy1), "pid: "] or [if, var(hierarchy1Field), var(hierarchy1), ": "]
  if ((hasH1Value && endsWithColonString) || (hasH1Field && hasH1Value && colonAtTail)) {
    return buildDefaultHierarchy1LabelRule();
  }
  return rule;
}

function normalizeHierarchy2LabelRule(rule: any): any {
  const expr = rule?.type === 'expr' ? rule.expr : rule;
  if (!expr || typeof expr !== 'object') return rule;
  if (expr.op === 'if' && Array.isArray(expr.args)) {
    const args = expr.args;
    const hasMainThreadCond = isVarNode(args[0], 'isMainThread');
    if (hasMainThreadCond) {
      return buildDefaultHierarchy2LabelRule();
    }
  }
  // Keep custom rules; only fix very specific malformed suffix forms if seen.
  if (expr.op === 'concat' && Array.isArray(expr.args)) {
    const args = expr.args;
    const hasH2Field = args.some((a: any) => isVarNode(a, 'hierarchy2Field'));
    const hasH2Value = args.some((a: any) => isVarNode(a, 'hierarchy2'));
    const last = args[args.length - 1];
    const colonAtTail = last === ': ';
    if (hasH2Field && hasH2Value && colonAtTail) {
      return buildDefaultHierarchy2LabelRule();
    }
    const idxField = args.findIndex((a: any) => isVarNode(a, 'hierarchy2Field'));
    const idxValue = args.findIndex((a: any) => isVarNode(a, 'hierarchy2'));
    const idxColon = args.findIndex((a: any) => a === ': ');
    if (idxField >= 0 && idxValue >= 0 && idxColon >= 0 && !(idxField < idxColon && idxColon < idxValue)) {
      return buildDefaultHierarchy2LabelRule();
    }
  }
  return rule;
}

/** Normalize hierarchy N (N>=3) label rule so format is always "fieldName: value". */
function normalizeHierarchyNLabelRule(level: number, rule: any): any {
  if (level < 3) return rule;
  const expr = rule?.type === 'expr' ? rule.expr : rule;
  if (!expr || typeof expr !== 'object' || expr.op !== 'concat' || !Array.isArray(expr.args)) {
    return rule;
  }
  const args = expr.args;
  const fieldVar = `hierarchy${level}Field`;
  const valueVar = `hierarchy${level}`;
  const hasField = args.some((a: any) => isVarNode(a, fieldVar));
  const hasValue = args.some((a: any) => isVarNode(a, valueVar));
  if (!hasField || !hasValue) return rule;
  const idxField = args.findIndex((a: any) => isVarNode(a, fieldVar));
  const idxValue = args.findIndex((a: any) => isVarNode(a, valueVar));
  const idxColon = args.findIndex((a: any) => a === ': ');
  // Correct order: field, ': ', value. If not, replace with default.
  if (idxField >= 0 && idxValue >= 0 && idxColon >= 0 && idxField < idxColon && idxColon < idxValue) {
    return rule;
  }
  return buildDefaultHierarchyLabelRule(level);
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

export function mergeDeep(base: any, patch: any): any {
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
    if (y.hierarchy1AggregationRule == null) {
      y.hierarchy1AggregationRule = buildDefaultHierarchyAggregationRule();
    }
    if (y.hierarchy2AggregationRule == null) {
      y.hierarchy2AggregationRule = buildDefaultHierarchyAggregationRule();
    }
    y.hierarchy1LabelRule = normalizeHierarchy1LabelRule(y.hierarchy1LabelRule);
    if (y.hierarchy2LabelRule != null) {
      y.hierarchy2LabelRule = normalizeHierarchy2LabelRule(y.hierarchy2LabelRule);
    }
    if (y.hierarchy2Field != null && y.hierarchy2Field !== '' && y.hierarchy2LabelRule == null) {
      y.hierarchy2LabelRule = buildDefaultHierarchy2LabelRule();
    }
    Object.keys(y).forEach((key) => {
      const match = key.match(/^hierarchy(\d+)Field$/);
      if (!match) return;
      const level = Number(match[1]);
      if (!Number.isFinite(level) || level < 3) return;
      const fieldValue = (y as any)[key];
      if (fieldValue == null || String(fieldValue).trim() === '') return;
      const labelKey = `hierarchy${level}LabelRule`;
      const existingRule = (y as any)[labelKey];
      if (existingRule != null) {
        (y as any)[labelKey] = normalizeHierarchyNLabelRule(level, existingRule);
      } else {
        (y as any)[labelKey] = buildDefaultHierarchyLabelRule(level);
      }
      const aggregationKey = `hierarchy${level}AggregationRule`;
      if ((y as any)[aggregationKey] == null) {
        (y as any)[aggregationKey] = buildDefaultHierarchyAggregationRule();
      }
    });
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
  const defaultXAxis = DEFAULT_GANTT_CONFIG.xAxis || {};
  const xAxis = c.xAxis && typeof c.xAxis === 'object' ? { ...c.xAxis } : {};
  if (xAxis.timeFormat == null) xAxis.timeFormat = defaultXAxis.timeFormat ?? 'short';
  if (xAxis.timeScaleMode == null) xAxis.timeScaleMode = defaultXAxis.timeScaleMode ?? 'physical';
  const xAxisLog =
    xAxis.logarithmic && typeof xAxis.logarithmic === 'object' ? { ...xAxis.logarithmic } : {};
  if (xAxisLog.base == null) xAxisLog.base = defaultXAxis.logarithmic?.base ?? Math.E;
  xAxis.logarithmic = xAxisLog;
  const xAxisFisheye =
    xAxis.fisheye && typeof xAxis.fisheye === 'object' ? { ...xAxis.fisheye } : {};
  if (xAxisFisheye.distortion == null) {
    xAxisFisheye.distortion = defaultXAxis.fisheye?.distortion ?? 3;
  }
  if (xAxisFisheye.focusTime === undefined) {
    xAxisFisheye.focusTime = defaultXAxis.fisheye?.focusTime ?? null;
  }
  xAxis.fisheye = xAxisFisheye;
  c.xAxis = xAxis;
  if (c.tooltip && typeof c.tooltip === 'object' && c.tooltip.process != null && (c.tooltip as any).hierarchy1 == null) {
    c.tooltip = { ...c.tooltip, hierarchy1: (c.tooltip as any).process };
  }
  const defaultPerf = DEFAULT_GANTT_CONFIG.performance || {};
  const perf = c.performance && typeof c.performance === 'object' ? { ...c.performance } : {};
  if (perf.streamingEnabled == null) perf.streamingEnabled = defaultPerf.streamingEnabled ?? false;
  if (perf.streamingMaxReqPerSec == null) perf.streamingMaxReqPerSec = defaultPerf.streamingMaxReqPerSec ?? 1;
  if (perf.streamingBufferFactor == null) perf.streamingBufferFactor = defaultPerf.streamingBufferFactor ?? 0.5;
  if (perf.streamingSimulate == null) perf.streamingSimulate = defaultPerf.streamingSimulate ?? false;
  c.performance = perf;
  const defaultExt = DEFAULT_GANTT_CONFIG.extensions || {};
  const ext = c.extensions && typeof c.extensions === 'object' ? { ...c.extensions } : {};
  if (ext.auxCharts == null) ext.auxCharts = defaultExt.auxCharts;
  else if (typeof ext.auxCharts === 'object') {
    const defAux = defaultExt.auxCharts;
    if (defAux && typeof defAux === 'object') {
      if (ext.auxCharts.enabled == null) ext.auxCharts.enabled = defAux.enabled;
      if (ext.auxCharts.overview == null) ext.auxCharts.overview = defAux.overview;
      else if (typeof ext.auxCharts.overview === 'object' && defAux.overview) {
        const o = ext.auxCharts.overview as Record<string, any>;
        const doo = defAux.overview as Record<string, any>;
        if (o.kind == null) o.kind = doo.kind;
        if (o.entityLevel == null) o.entityLevel = doo.entityLevel;
        if (o.bins == null) o.bins = doo.bins;
        if (o.count == null) o.count = doo.count;
        if (o.stacked == null) o.stacked = doo.stacked;
      }
    }
  }
  c.extensions = ext;
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
- hierarchy1, hierarchy2, level, trackKey
- stats: per-hierarchy1 stats (count, totalDurUs, avgDurUs, maxDurUs, minStart, maxEnd)
- isExpanded, isMainThread

## Data Format (normalized events)
Each event is normalized to this shape before rules run:
{
  hierarchy1: "string",
  hierarchy2: "string",
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

## Hierarchy display mode
Path: patch.yAxis.hierarchyDisplayMode. Default: "rows".
- "rows": expanded hierarchies render as separate rows (current default).
- "nested": expanded hierarchies render as vertically nested rectangles in a single detail row. Vertical inset only applies on the Y axis; the X axis remains faithful to real event times.

## Hierarchy aggregation
Path: patch.yAxis.hierarchyNAggregationRule
- Every hierarchy level can define its own parent-segment aggregation rule.
- Default: { "type": "mergeGap", "mergeGapRatio": 0.002 }
- Supported fields:
  - type: "mergeGap"
  - mergeGapRatio: fraction of the visible time window used to merge nearby child events
  - minGapUs: absolute minimum merge gap in microseconds
- In "rows" mode, expanded parents stay visible as aggregate rows above their children.
- In "nested" mode, expanded parents stay visible as aggregate containers and children render inside them.

## Labels (rules)
Path: patch.yAxis.hierarchy1LabelRule / patch.yAxis.hierarchy2LabelRule

## Layout (optional)
Path: patch.layout
- margin: { top, right, bottom, left }
- headerHeight, laneHeight, lanePadding, expandedPadding, hierarchy2Gap
- nestedRowHeight, nestedLevelInset
- yAxis: { autoWidth, baseWidth, minWidth, maxWidth, hierarchy1Indent, labelPadding, hierarchy1Font, hierarchy2Font }
- label: { minBarLabelPx }

## X-Axis
Path: patch.xAxis
- timeFormat: "short" | "full"
- timeScaleMode: "physical" | "logarithmic" | "fisheye" | "logical"
- logarithmic.base: number > 1; higher values compress later time more strongly
- fisheye.distortion: number from 0 to 10; larger values magnify the focus region more
- fisheye.focusTime: fixed focus time in the current domain; null or omitted lets the chart track the pointer
- Logical time requires dependency data (dataMapping.features.dependencyField) and falls back to physical time when dependencies are unavailable

## Dependencies
Path: patch.dependencies
- connector: "line" | "arrow"
- amount: "all" | "paths" | "1hop"
- persistence: "always" | "toggle" | "onClick"
- drawingStyle: "straight" | "orthogonal" | "spline" | "bundled"
- strokeColor, strokeWidth, arrowSize, maxEdges
- Dependency sources come from dataMapping.features.dependencyField and can point at any event field such as "children", "deps", or "args.dependencies"

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

Example 7: Show all dependency arrows with orthogonal routing
\`\`\`json
{
  "action": "update_gantt_config",
  "patch": {
    "dependencies": {
      "connector": "arrow",
      "amount": "all",
      "persistence": "always",
      "drawingStyle": "orthogonal"
    }
  },
  "description": "Show all dependency arrows with orthogonal routing"
}
\`\`\`

## Data Attributes You Can Reference
Each event can include:
- id, name, cat, hierarchy1, hierarchy2, level
- start, end (microseconds)
- args (object; use dot-paths like "args.phase")
- raw / Raw (original payload, if present)

See src/GANTT_CONFIG_SPEC.json for the full spec.

If the user intent is ambiguous, ask a clarifying question instead of guessing.`;

export type ExprValue = string | number | boolean | null | undefined | ExprObject | ExprValue[];

export interface ExprObject {
  type?: 'expr';
  op?: string;
  args?: ExprValue[];
  [key: string]: any;
}

export interface TransformRule {
  type: 'transform';
  name: string;
  params?: Record<string, any>;
}

export interface PredicateRule {
  type: 'predicate';
  when: ExprValue;
}

export type RuleExpr = ExprValue;
export type Rule = TransformRule | PredicateRule | ExprObject;

export interface HierarchyAggregationRule {
  type?: 'mergeGap';
  mergeGapRatio?: number;
  minGapUs?: number;
}

export interface LayoutConfig {
  margin: { top: number; right: number; bottom: number; left: number };
  headerHeight: number;
  laneHeight: number;
  lanePadding: number;
  expandedPadding: number;
  hierarchy2Gap: number;
  nestedRowHeight?: number;
  nestedLevelInset?: number;
  yAxis: {
    autoWidth: boolean;
    baseWidth: number;
    minWidth: number;
    maxWidth: number;
    hierarchy1Indent: number;
    labelPadding: { left: number; right: number; hierarchy2Indent: number };
    hierarchy1Font: string;
    hierarchy2Font: string;
  };
  label: { minBarLabelPx: number };
}

export interface YAxisConfig {
  hierarchyDisplayMode?: 'rows' | 'nested';
  hierarchy1OrderRule?: Rule;
  hierarchy2LaneRule?: Rule;
  hierarchy1LabelRule?: Rule;
  hierarchy2LabelRule?: Rule;
  hierarchy1AggregationRule?: HierarchyAggregationRule;
  hierarchy2AggregationRule?: HierarchyAggregationRule;
  hierarchyFields?: string[];
  [key: `hierarchy${number}Field`]: any;
  [key: `hierarchy${number}OrderRule`]: any;
  [key: `hierarchy${number}LaneRule`]: any;
  [key: `hierarchy${number}LabelRule`]: any;
  [key: `hierarchy${number}AggregationRule`]: any;
  orderMode?: string;
  includeUnspecified?: boolean;
  customOrder?: string[];
  groups?: Array<{ order?: number; pids?: string[]; tracks?: string[]; items?: string[] }>;
}

export interface ColorConfig {
  palette?: string[];
  keyRule?: Rule;
  colorRule?: Rule;
  fixedColor?: string | null;
  mode?: string;
  field?: string;
  fields?: string[];
  fallbackFields?: string[];
}

export interface TooltipField {
  label?: string | RuleExpr;
  name?: string;
  path?: string;
  value?: RuleExpr;
  when?: RuleExpr;
  showEmpty?: boolean;
}

export interface TooltipConfig {
  enabled?: boolean;
  hierarchy1?: { title?: string; fields?: TooltipField[] };
  event?: {
    title?: string;
    fields?: TooltipField[];
    args?: {
      enabled?: boolean;
      max?: number;
      sort?: string;
      label?: string;
      filter?: RuleExpr;
      value?: RuleExpr;
    };
  };
}

export type ProcessSortMode = 'default' | 'fork';

export type TimeScaleMode = 'physical' | 'logarithmic' | 'fisheye' | 'logical';

export interface LogarithmicTimeScaleConfig {
  /** Controls curvature for logarithmic compression. Higher values emphasize earlier times more strongly. */
  base?: number;
}

export interface FisheyeTimeScaleConfig {
  /** Distortion strength for focus+context scaling. Zero disables the distortion. */
  distortion?: number;
  /** Fixed focus time in the current domain. Null/undefined means track pointer position. */
  focusTime?: number | null;
}

export interface XAxisConfig {
  /** Merge gap as fraction of time window (0–1). Gaps larger than this split hierarchy1 bars. Default 0.002. */
  mergeGapRatio?: number;
  /** Time label format on the x-axis. */
  timeFormat?: 'short' | 'full';
  /** Strategy used to map time onto the x-axis. */
  timeScaleMode?: TimeScaleMode;
  /** Parameters for logarithmic time compression. */
  logarithmic?: LogarithmicTimeScaleConfig;
  /** Parameters for fisheye focus+context distortion. */
  fisheye?: FisheyeTimeScaleConfig;
}

export interface GanttConfig {
  layout: LayoutConfig;
  xAxis?: XAxisConfig;
  yAxis: YAxisConfig;
  color: ColorConfig;
  colorMapping?: any;
  tooltip: TooltipConfig;
  extensions: Record<string, any>;
  dependencies?: {
    maxEdges?: number;
    connector?: 'line' | 'arrow';
    amount?: 'all' | 'paths' | '1hop';
    persistence?: 'always' | 'toggle' | 'onClick';
    drawingStyle?: 'straight' | 'orthogonal' | 'spline' | 'bundled';
    strokeColor?: string;
    strokeWidth?: number;
    arrowSize?: number;
  };
  performance?: {
    showOverlay?: boolean;
    webglEnabled?: boolean;
    streamingEnabled?: boolean;
    streamingMaxReqPerSec?: number;
    streamingBufferFactor?: number;
    streamingSimulate?: boolean;
    hierarchy1LOD?: {
      pixelWindow?: number;
      mergeUtilGap?: number;
    };
    hierarchy2LOD?: {
      pixelWindow?: number;
      mergeUtilGap?: number;
    };
    [key: `hierarchy${number}LOD`]: {
      pixelWindow?: number;
      mergeUtilGap?: number;
    } | any;
  };
}

export interface ConfigEntry {
  id: string;
  path: string;
  kind: 'value' | 'rule';
  schema?: any;
  default?: any;
  description?: string;
}

export interface ConfigSection {
  id: string;
  description?: string;
  entries: ConfigEntry[];
}

export interface ConfigSpec {
  name: string;
  version: string;
  description?: string;
  ruleDsl?: any;
  sections: ConfigSection[];
  examples?: any[];
}

export type ConfigPatch = Record<string, any>;

/**
 * Universal data mapping that describes how arbitrary data fields
 * map to every visual aspect of the Gantt chart.
 * Produced by the data analysis agent and editable by the user.
 */
export interface GanttDataMapping {
  /** Time axis (X): which fields represent event timing */
  xAxis: {
    startField: string | null;
    endField: string | null;
    durationField: string | null;
    timeUnit: 'us' | 'ms' | 's' | 'ns';
  };
  /** Hierarchy1/hierarchy2 grouping (Y-axis rows) */
  yAxis: {
    hierarchyFields: string[];
    parentField: string | null;
  };
  /** Event identity and classification */
  identity: {
    nameField: string | null;
    categoryField: string | null;
    idField: string | null;
  };
  /** Color grouping */
  color: {
    keyField: string | null;
  };
  /** Text displayed on event bars */
  barLabel: {
    field: string | null;
  };
  /** Tooltip configuration: which data fields to show on hover */
  tooltip: {
    fields: Array<{
      sourceField: string;
      label: string;
      format?: 'time' | 'duration' | 'none';
    }>;
    showArgs: boolean;
    argsField: string | null;
  };
  /** Schema metadata discovered from the data */
  schema: {
    dataFormat: string;
    allFields: Array<{
      path: string;
      type: string;
      sampleValues?: any[];
    }>;
    notes: string;
  };

  /**
   * Feature flags and intelligent defaults inferred by the data analysis agent.
   * These control which chart capabilities are enabled and how the default
   * config should be derived, without directly patching the GanttConfig.
   */
  features: {
    /**
     * Number of hierarchy levels detected in the data (e.g. 2 = process/thread).
     * Currently the renderer supports up to 2; future expansion will use this value.
     */
    hierarchyLevels: number;
    /**
     * Mapping from hierarchy depth (1-based) to the data field that provides
     * values for that level. Length should equal hierarchyLevels.
     * e.g. ["pid", "tid"] for a 2-level hierarchy.
     */
    hierarchyFields: string[];
    /**
     * Whether to enable fork-tree (parent-child) ordering on the Y-axis.
     * True when a parentField is present and meaningful.
     */
    forkTree: boolean;
    /**
     * Whether to show dependency / flow lines between events.
     * (Not yet supported — reserved for future implementation.)
     */
    dependencyLines: boolean;
    /**
     * Field path used for dependency source, if dependencyLines is true.
     * null when not applicable.
     */
    dependencyField: string | null;
    /**
     * How events within a hierarchy2 lane should be packed.
     * "autoPack" (default) | "stack" | "flat"
     */
    lanePacking: 'autoPack' | 'stack' | 'flat';
    /**
     * Whether the data represents a flame-chart style (nested levels within a single thread).
     */
    flameChart: boolean;
    /**
     * Suggested color strategy detected from the data.
     * "category" = color by category/type field
     * "hierarchy1" = color by top-level grouping
     * "name" = color by event name
     * "field" = color by a specific field (see color.keyField)
     */
    colorStrategy: 'category' | 'hierarchy1' | 'name' | 'field';
  };
}

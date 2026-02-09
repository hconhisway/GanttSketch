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

export interface LayoutConfig {
  margin: { top: number; right: number; bottom: number; left: number };
  headerHeight: number;
  laneHeight: number;
  lanePadding: number;
  expandedPadding: number;
  hierarchy2Gap: number;
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
  hierarchy1OrderRule?: Rule;
  hierarchy2LaneRule?: Rule;
  hierarchy1LabelRule?: Rule;
  hierarchy2LabelRule?: Rule;
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

export interface XAxisConfig {
  /** Merge gap as fraction of time window (0–1). Gaps larger than this split hierarchy1 bars. Default 0.002. */
  mergeGapRatio?: number;
}

export interface GanttConfig {
  layout: LayoutConfig;
  xAxis?: XAxisConfig;
  yAxis: YAxisConfig;
  color: ColorConfig;
  colorMapping?: any;
  tooltip: TooltipConfig;
  extensions: Record<string, any>;
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
    hierarchy1Field: string | null;
    hierarchy2Field: string | null;
    parentField: string | null;
    levelField: string | null;
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
}

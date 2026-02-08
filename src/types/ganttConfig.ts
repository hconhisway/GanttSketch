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
  threadGap: number;
  yAxis: {
    autoWidth: boolean;
    baseWidth: number;
    minWidth: number;
    maxWidth: number;
    processIndent: number;
    labelPadding: { left: number; right: number; threadIndent: number };
    processFont: string;
    threadFont: string;
  };
  label: { minBarLabelPx: number };
}

export interface YAxisConfig {
  processOrderRule?: Rule;
  threadLaneRule?: Rule;
  processLabelRule?: Rule;
  threadLabelRule?: Rule;
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
  process?: { title?: string; fields?: TooltipField[] };
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

export interface GanttConfig {
  layout: LayoutConfig;
  yAxis: YAxisConfig;
  color: ColorConfig;
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

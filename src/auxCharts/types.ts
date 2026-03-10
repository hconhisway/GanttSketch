/**
 * Types for the auxiliary overview chart (minimap) module.
 */

export type OverviewChartKind = 'utilizationArea' | 'utilizationCount' | 'stackedArea';

export interface AuxBinsConfig {
  mode: 'auto' | 'fixed';
  fixed?: number;
  min?: number;
  max?: number;
}

export interface AuxCountConfig {
  binSize?: number;
}

export interface AuxStackedConfig {
  mode: 'groupBy' | 'series';
  groupBy?: any; // Expr
  topK?: number;
  includeOther?: boolean;
  series?: Array<{
    id: string;
    label?: string;
    when: any; // PredicateExpr
    color?: string;
  }>;
}

export interface AuxOverviewConfig {
  kind: OverviewChartKind;
  entityLevel?: number;
  bins?: AuxBinsConfig;
  count?: AuxCountConfig;
  stacked?: AuxStackedConfig;
}

export interface AuxChartsConfig {
  enabled?: boolean;
  overview?: AuxOverviewConfig;
}

/** Single series: value per bin (index = bin index). */
export interface BinnedSeries {
  id: string;
  label?: string;
  values: number[];
  color?: string;
}

/** Result of overview computation: one series for area/count, or multiple for stacked. */
export interface OverviewModel {
  kind: OverviewChartKind;
  binCount: number;
  t0: number;
  t1: number;
  binWidthUs: number;
  /** For utilizationArea: one series with % (0-1) per bin. For utilizationCount: one series with count per bin. For stackedArea: multiple series. */
  series: BinnedSeries[];
  /** For utilizationArea/count: total entity count used for normalization. */
  entityCount?: number;
}

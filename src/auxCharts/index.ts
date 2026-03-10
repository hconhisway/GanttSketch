/**
 * Auxiliary charts module: overview (minimap) computation and rendering.
 */

export type {
  AuxChartsConfig,
  AuxOverviewConfig,
  AuxBinsConfig,
  AuxCountConfig,
  AuxStackedConfig,
  OverviewChartKind,
  BinnedSeries,
  OverviewModel
} from './types';

export {
  getEntityKey,
  mergeIntervals,
  buildUnionIntervalsByEntity,
  computeUtilizationArea,
  computeUtilizationCount,
  computeStacked,
  resolveBinCount,
  computeOverviewModel
} from './compute';

export { drawOverviewChart } from './render';
export type { RenderOptions } from './render';

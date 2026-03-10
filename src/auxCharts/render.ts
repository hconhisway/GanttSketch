/**
 * Render the overview model to a 2D canvas context.
 */

import type { BinnedSeries, OverviewModel } from './types';

export interface RenderOptions {
  width: number;
  height: number;
  marginLeft?: number;
  marginRight?: number;
  marginTop?: number;
  marginBottom?: number;
  fillStyle?: string;
  strokeStyle?: string;
  palette?: string[];
}

const DEFAULT_PALETTE = [
  '#4C78A8', '#9ECAE9', '#F58518', '#FFBF79', '#54A24B', '#88D27A', '#B79A20', '#F2CF5B',
  '#439894', '#83BCB6'
];

function getMaxValue(series: BinnedSeries[]): number {
  let max = 0;
  for (const s of series) {
    for (const v of s.values) {
      if (Number.isFinite(v)) max = Math.max(max, v);
    }
  }
  return max || 1;
}

/** For stacked: max of per-bin sum. */
function getStackedMax(series: BinnedSeries[]): number {
  const binCount = series[0]?.values.length ?? 0;
  let max = 0;
  for (let i = 0; i < binCount; i++) {
    let sum = 0;
    for (const s of series) sum += s.values[i] ?? 0;
    max = Math.max(max, sum);
  }
  return max || 1;
}

/** Draw single area (utilizationArea or single series). */
function drawArea(
  ctx: CanvasRenderingContext2D,
  values: number[],
  x0: number,
  y0: number,
  w: number,
  h: number,
  maxVal: number,
  fillStyle: string
) {
  if (values.length === 0) return;
  const step = w / values.length;
  ctx.beginPath();
  ctx.moveTo(x0, y0 + h);
  for (let i = 0; i < values.length; i++) {
    const x = x0 + (i + 0.5) * step;
    const v = Math.max(0, Math.min(1, (values[i] ?? 0) / maxVal));
    const y = y0 + h - v * h;
    ctx.lineTo(x, y);
  }
  ctx.lineTo(x0 + w, y0 + h);
  ctx.closePath();
  ctx.fillStyle = fillStyle;
  ctx.fill();
}

/** Draw step/area (utilizationCount). */
function drawStepArea(
  ctx: CanvasRenderingContext2D,
  values: number[],
  x0: number,
  y0: number,
  w: number,
  h: number,
  maxVal: number,
  fillStyle: string
) {
  if (values.length === 0) return;
  const step = w / values.length;
  ctx.beginPath();
  ctx.moveTo(x0, y0 + h);
  for (let i = 0; i < values.length; i++) {
    const xLeft = x0 + i * step;
    const xRight = x0 + (i + 1) * step;
    const v = (values[i] ?? 0) / maxVal;
    const y = y0 + h - Math.max(0, Math.min(1, v)) * h;
    ctx.lineTo(xLeft, y);
    ctx.lineTo(xRight, y);
  }
  ctx.lineTo(x0 + w, y0 + h);
  ctx.closePath();
  ctx.fillStyle = fillStyle;
  ctx.fill();
}

/** Draw stacked areas (stackedArea). */
function drawStackedAreas(
  ctx: CanvasRenderingContext2D,
  series: BinnedSeries[],
  x0: number,
  y0: number,
  w: number,
  h: number,
  maxVal: number,
  palette: string[]
) {
  const binCount = series[0]?.values.length ?? 0;
  if (binCount === 0) return;
  const step = w / binCount;

  for (let sIdx = 0; sIdx < series.length; sIdx++) {
    const s = series[sIdx];
    const color = s.color ?? palette[sIdx % palette.length];
    ctx.beginPath();
    const prevTop = new Array(binCount).fill(0);
    if (sIdx > 0) {
      for (let i = 0; i < binCount; i++) {
        for (let j = 0; j < sIdx; j++) prevTop[i] += series[j].values[i] ?? 0;
      }
    }
    ctx.moveTo(x0, y0 + h - ((prevTop[0] ?? 0) / maxVal) * h);
    for (let i = 0; i < binCount; i++) {
      const x = x0 + (i + 0.5) * step;
      const top = prevTop[i] + (s.values[i] ?? 0);
      const y = y0 + h - Math.min(1, top / maxVal) * h;
      ctx.lineTo(x, y);
    }
    for (let i = binCount - 1; i >= 0; i--) {
      const x = x0 + (i + 0.5) * step;
      const base = prevTop[i] / maxVal;
      const y = y0 + h - Math.min(1, base) * h;
      ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.85;
    ctx.fill();
    ctx.globalAlpha = 1;
  }
}

/**
 * Render the overview model into the canvas context.
 * Assumes ctx is already set up (e.g. transform for device pixel ratio applied by caller).
 */
export function drawOverviewChart(
  ctx: CanvasRenderingContext2D,
  model: OverviewModel,
  options: RenderOptions
): void {
  const {
    width,
    height,
    marginLeft = 0,
    marginRight = 0,
    marginTop = 0,
    marginBottom = 0,
    fillStyle = 'rgba(76, 120, 168, 0.6)',
    palette = DEFAULT_PALETTE
  } = options;

  const chartWidth = Math.max(0, width - marginLeft - marginRight);
  const chartHeight = Math.max(0, height - marginTop - marginBottom);
  const x0 = marginLeft;
  const y0 = marginTop;

  if (model.kind === 'utilizationArea' && model.series.length > 0) {
    const values = model.series[0].values;
    const maxVal = 1;
    drawArea(ctx, values, x0, y0, chartWidth, chartHeight, maxVal, fillStyle);
    return;
  }

  if (model.kind === 'utilizationCount' && model.series.length > 0) {
    const values = model.series[0].values;
    const maxVal = getMaxValue(model.series);
    drawStepArea(ctx, values, x0, y0, chartWidth, chartHeight, maxVal, fillStyle);
    return;
  }

  if (model.kind === 'stackedArea' && model.series.length > 0) {
    const maxVal = getStackedMax(model.series);
    drawStackedAreas(ctx, model.series, x0, y0, chartWidth, chartHeight, maxVal, palette);
  }
}

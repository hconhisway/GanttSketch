import * as d3 from 'd3';
import type {
  FisheyeTimeScaleConfig,
  LogarithmicTimeScaleConfig,
  TimeScaleMode
} from '../types/ganttConfig';
import { clampNumber } from '../utils/formatting';

export interface TimeScaleViewParams {
  vs: number;
  ve: number;
  span: number;
  k: number;
}

export interface TimeAxisScale {
  (value: number): number;
  domain(): number[];
  range(): number[];
  copy(): TimeAxisScale;
  ticks(count?: number): number[];
  invert(x: number): number;
}

export interface TimeScaleFns {
  mode: TimeScaleMode;
  xOf(value: number, p: TimeScaleViewParams): number;
  tOf(x: number, p: TimeScaleViewParams): number;
  d3Scale(p: TimeScaleViewParams): TimeAxisScale;
  ticks(p: TimeScaleViewParams, count: number): number[];
}

export interface CreateTimeScaleOptions {
  mode?: TimeScaleMode;
  left: number;
  width: number;
  fisheye?: FisheyeTimeScaleConfig;
  logarithmic?: LogarithmicTimeScaleConfig;
  getFisheyeFocus?: () => number | null | undefined;
}

const EPSILON = 1e-9;
const DEFAULT_LOG_BASE = Math.E;
const DEFAULT_FISHEYE_DISTORTION = 3;

function clampUnit(value: number): number {
  return clampNumber(value, 0, 1);
}

function toUnit(value: number, p: TimeScaleViewParams): number {
  if (!Number.isFinite(value) || p.span <= 0) return 0;
  return clampUnit((value - p.vs) / p.span);
}

function fromUnit(unitValue: number, p: TimeScaleViewParams): number {
  const u = clampUnit(unitValue);
  return p.vs + u * p.span;
}

function normalizedTicks(start: number, end: number, count: number): number[] {
  const safeCount = Math.max(2, Math.floor(count || 0));
  return dedupeSorted(d3.ticks(start, end, safeCount));
}

function integerTicks(start: number, end: number, count: number): number[] {
  const lo = Math.floor(Math.min(start, end));
  const hi = Math.ceil(Math.max(start, end));
  if (hi <= lo) return [lo];
  const span = hi - lo;
  const safeCount = Math.max(2, Math.floor(count || 0));
  if (span <= safeCount) {
    const values: number[] = [];
    for (let value = lo; value <= hi; value += 1) values.push(value);
    return values;
  }
  const step = Math.max(1, Math.ceil(span / safeCount));
  const values: number[] = [];
  for (let value = lo; value <= hi; value += step) values.push(value);
  if (values[values.length - 1] !== hi) values.push(hi);
  return dedupeSorted(values);
}

function dedupeSorted(values: number[]): number[] {
  const result: number[] = [];
  for (const raw of values) {
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    if (result.length === 0 || Math.abs(result[result.length - 1] - value) > EPSILON) {
      result.push(value);
    }
  }
  return result;
}

function createAxisScale(
  domain: [number, number],
  range: [number, number],
  forward: (value: number) => number,
  inverse: (x: number) => number,
  tickFactory: (count: number) => number[]
): TimeAxisScale {
  const scale = ((value: number) => forward(value)) as TimeAxisScale;
  scale.domain = () => [domain[0], domain[1]];
  scale.range = () => [range[0], range[1]];
  scale.copy = () => createAxisScale(domain, range, forward, inverse, tickFactory);
  scale.ticks = (count = 10) => tickFactory(count);
  scale.invert = (x: number) => inverse(x);
  return scale;
}

function resolveLogStrength(config?: LogarithmicTimeScaleConfig): number {
  const base = Number(config?.base ?? DEFAULT_LOG_BASE);
  if (!Number.isFinite(base) || base <= 1 + EPSILON) return 0;
  return Math.max(0, base - 1);
}

function applyLogCompression(unitValue: number, strength: number): number {
  const u = clampUnit(unitValue);
  if (strength <= EPSILON) return u;
  return Math.log1p(strength * u) / Math.log1p(strength);
}

function invertLogCompression(unitValue: number, strength: number): number {
  const u = clampUnit(unitValue);
  if (strength <= EPSILON) return u;
  return Math.expm1(u * Math.log1p(strength)) / strength;
}

function resolveFisheyeFocus(
  p: TimeScaleViewParams,
  config: FisheyeTimeScaleConfig | undefined,
  getFisheyeFocus?: () => number | null | undefined
): number {
  const explicitFocus = config?.focusTime;
  const trackedFocus = getFisheyeFocus?.();
  const candidate =
    explicitFocus != null && Number.isFinite(Number(explicitFocus))
      ? Number(explicitFocus)
      : trackedFocus != null && Number.isFinite(Number(trackedFocus))
        ? Number(trackedFocus)
        : p.vs + p.span / 2;
  return clampNumber(candidate, p.vs, p.ve);
}

function fisheyeForward(unitValue: number, focusUnit: number, distortion: number): number {
  const u = clampUnit(unitValue);
  const f = clampUnit(focusUnit);
  if (distortion <= EPSILON) return u;
  if (Math.abs(u - f) <= EPSILON) return u;
  const isLeft = u < f;
  const extent = isLeft ? f : 1 - f;
  if (extent <= EPSILON) return u;
  const delta = Math.abs(u - f);
  const warped = (extent * (distortion + 1) * delta) / (distortion * delta + extent);
  return clampUnit(f + (isLeft ? -warped : warped));
}

function fisheyeInverse(unitValue: number, focusUnit: number, distortion: number): number {
  const u = clampUnit(unitValue);
  const f = clampUnit(focusUnit);
  if (distortion <= EPSILON) return u;
  if (Math.abs(u - f) <= EPSILON) return u;
  const isLeft = u < f;
  const extent = isLeft ? f : 1 - f;
  if (extent <= EPSILON) return u;
  const delta = Math.abs(u - f);
  const denom = extent * (distortion + 1) - delta * distortion;
  if (denom <= EPSILON) return isLeft ? 0 : 1;
  const original = (delta * extent) / denom;
  return clampUnit(f + (isLeft ? -original : original));
}

function buildPhysicalTicks(p: TimeScaleViewParams, count: number): number[] {
  return normalizedTicks(p.vs, p.ve, count);
}

function buildLogicalTicks(p: TimeScaleViewParams, count: number): number[] {
  return integerTicks(p.vs, p.ve, count);
}

function buildLogTicks(p: TimeScaleViewParams, count: number): number[] {
  if (p.span <= 1) return buildPhysicalTicks(p, count);
  const shifted = d3
    .scaleLog()
    .domain([1, Math.max(2, p.span + 1)]);
  const ticks = shifted
    .ticks(Math.max(2, Math.floor(count || 0)))
    .map((value) => p.vs + Number(value) - 1)
    .filter((value) => value >= p.vs - EPSILON && value <= p.ve + EPSILON);
  if (ticks.length >= 2) return dedupeSorted(ticks);
  return buildPhysicalTicks(p, count);
}

export function createTimeScale(options: CreateTimeScaleOptions): TimeScaleFns {
  const mode = options.mode ?? 'physical';
  const left = Number(options.left) || 0;
  const width = Math.max(1, Number(options.width) || 1);
  const right = left + width;
  const logStrength = resolveLogStrength(options.logarithmic);
  const fisheyeDistortion = Math.max(
    0,
    Number(options.fisheye?.distortion ?? DEFAULT_FISHEYE_DISTORTION)
  );

  const forward = (value: number, p: TimeScaleViewParams): number => {
    if (!Number.isFinite(value)) return left;
    const unitValue = toUnit(value, p);
    switch (mode) {
      case 'logarithmic':
        return left + applyLogCompression(unitValue, logStrength) * width;
      case 'fisheye': {
        const focusValue = resolveFisheyeFocus(p, options.fisheye, options.getFisheyeFocus);
        const focusUnit = toUnit(focusValue, p);
        return left + fisheyeForward(unitValue, focusUnit, fisheyeDistortion) * width;
      }
      case 'logical':
      case 'physical':
      default:
        return left + unitValue * width;
    }
  };

  const inverse = (x: number, p: TimeScaleViewParams): number => {
    const unitValue = clampUnit((Number(x) - left) / width);
    switch (mode) {
      case 'logarithmic':
        return fromUnit(invertLogCompression(unitValue, logStrength), p);
      case 'fisheye': {
        const focusValue = resolveFisheyeFocus(p, options.fisheye, options.getFisheyeFocus);
        const focusUnit = toUnit(focusValue, p);
        return fromUnit(fisheyeInverse(unitValue, focusUnit, fisheyeDistortion), p);
      }
      case 'logical':
      case 'physical':
      default:
        return fromUnit(unitValue, p);
    }
  };

  const tickFactory = (p: TimeScaleViewParams, count: number): number[] => {
    switch (mode) {
      case 'logical':
        return buildLogicalTicks(p, count);
      case 'logarithmic':
        return buildLogTicks(p, count);
      case 'fisheye':
      case 'physical':
      default:
        return buildPhysicalTicks(p, count);
    }
  };

  return {
    mode,
    xOf: (value, p) => forward(value, p),
    tOf: (x, p) => inverse(x, p),
    d3Scale: (p) =>
      createAxisScale(
        [p.vs, p.ve],
        [left, right],
        (value) => forward(value, p),
        (x) => inverse(x, p),
        (count) => tickFactory(p, count)
      ),
    ticks: (p, count) => tickFactory(p, count)
  };
}

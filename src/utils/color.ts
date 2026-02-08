import { evalExpr, hashStringToInt, isEmptyValue, pickFirstFieldValue } from './expression';

export function pickTextColor(hexColor: unknown): string {
  // Accept #rgb/#rrggbb; fall back to white for unknown formats
  if (typeof hexColor !== 'string') return '#fff';
  const hex = hexColor.trim().replace('#', '');
  const full =
    hex.length === 3
      ? hex
          .split('')
          .map((ch) => ch + ch)
          .join('')
      : hex;
  if (full.length !== 6) return '#fff';
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  if (![r, g, b].every(Number.isFinite)) return '#fff';
  // Relative luminance
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return luminance > 0.6 ? '#111' : '#fff';
}

export function resolveColorKeyLegacy(
  item: any,
  trackKey: string,
  trackMeta: any,
  colorConfig: any
): string {
  const mode = colorConfig?.mode || 'byField';
  let keyValue;

  if (mode === 'byTrack') {
    keyValue = trackKey;
  } else if (mode === 'byField') {
    keyValue = pickFirstFieldValue(item, [colorConfig?.field]);
  } else if (mode === 'byFields') {
    keyValue = pickFirstFieldValue(item, colorConfig?.fields);
  }

  if (isEmptyValue(keyValue)) {
    keyValue = pickFirstFieldValue(item, colorConfig?.fallbackFields);
  }

  if (isEmptyValue(keyValue)) {
    const fallbackKey =
      trackMeta?.type === 'process'
        ? (item?.pid ?? trackMeta?.pid ?? trackKey ?? '')
        : `${item?.tid ?? trackMeta?.tid ?? trackKey}-${item?.level ?? trackMeta?.level ?? 0}`;
    keyValue = fallbackKey;
  }

  return String(keyValue ?? '');
}

export function resolveColorKey(
  item: any,
  trackKey: string,
  trackMeta: any,
  colorConfig: any,
  legacyColorConfig: any
): string {
  if (colorConfig?.keyRule) {
    const key = evalExpr(colorConfig.keyRule, {
      event: item,
      trackKey,
      trackMeta,
      pid: item?.pid ?? trackMeta?.pid,
      tid: item?.tid ?? trackMeta?.tid,
      level: item?.level ?? trackMeta?.level
    });
    if (!isEmptyValue(key)) return String(key);
  }
  if (legacyColorConfig) {
    return resolveColorKeyLegacy(item, trackKey, trackMeta, legacyColorConfig);
  }
  const fallbackKey =
    trackMeta?.type === 'process'
      ? (item?.pid ?? trackMeta?.pid ?? trackKey ?? '')
      : `${item?.tid ?? trackMeta?.tid ?? trackKey}-${item?.level ?? trackMeta?.level ?? 0}`;
  return String(fallbackKey ?? '');
}

export function resolveColor(
  item: any,
  trackKey: string,
  trackMeta: any,
  colorConfig: any,
  defaultPalette: string[],
  legacyColorConfig: any,
  processStats?: Map<string, any>
): string {
  const palette =
    Array.isArray(colorConfig?.palette) && colorConfig.palette.length > 0
      ? colorConfig.palette
      : defaultPalette;
  const colorKey = resolveColorKey(item, trackKey, trackMeta, colorConfig, legacyColorConfig);
  if (colorConfig?.fixedColor) {
    return colorConfig.fixedColor;
  }
  if (colorConfig?.colorRule) {
    const stats = processStats?.get(String(item?.pid ?? trackMeta?.pid)) || {};
    const resolved = evalExpr(colorConfig.colorRule, {
      event: item,
      trackKey,
      trackMeta,
      pid: item?.pid ?? trackMeta?.pid,
      tid: item?.tid ?? trackMeta?.tid,
      level: item?.level ?? trackMeta?.level,
      stats,
      colorKey,
      palette,
      vars: { colorKey, palette }
    });
    if (!isEmptyValue(resolved)) return String(resolved);
  }
  const hash = hashStringToInt(colorKey);
  return palette[hash % palette.length];
}

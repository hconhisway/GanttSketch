import { evalExpr, hashStringToInt, isEmptyValue, pickFirstFieldValue } from './expression';
import { getHierarchyValuesFromEvent, getHierarchyVarName } from './hierarchy';

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

function hasHierarchyInfo(source: any): boolean {
  if (!source || typeof source !== 'object') return false;
  if (Array.isArray(source.hierarchyValues) && source.hierarchyValues.length > 0) return true;
  if (source.hierarchy1 != null || source.hierarchy2 != null) return true;
  return Object.keys(source).some((key) => /^hierarchy\d+$/.test(key));
}

function getHierarchyValuesForColor(item: any, trackMeta: any): string[] {
  if (hasHierarchyInfo(item)) return getHierarchyValuesFromEvent(item);
  if (hasHierarchyInfo(trackMeta)) return getHierarchyValuesFromEvent(trackMeta);
  return ['unknown', 'unknown'];
}

function buildHierarchyVars(values: string[]): Record<string, string> {
  const vars: Record<string, string> = {};
  values.forEach((value, index) => {
    vars[getHierarchyVarName(index + 1)] = value;
  });
  return vars;
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
    const hierarchyValues = getHierarchyValuesForColor(item, trackMeta);
    const hierarchy1 = hierarchyValues[0] ?? 'unknown';
    const hierarchyPath = hierarchyValues.join('|');
    const hierarchy2Path =
      hierarchyValues.length > 1 ? hierarchyValues.slice(1).join('|') : hierarchy1;
    const fallbackKey =
      trackMeta?.type === 'process'
        ? hierarchy1
        : `${hierarchyPath || hierarchy2Path || trackKey}-${
            item?.level ?? trackMeta?.level ?? 0
          }`;
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
  const hierarchyValues = getHierarchyValuesForColor(item, trackMeta);
  const hierarchy1 = hierarchyValues[0] ?? 'unknown';
  const hierarchy2Path =
    hierarchyValues.length > 1 ? hierarchyValues.slice(1).join('|') : hierarchy1;
  const hierarchyPath = hierarchyValues.join('|');
  const hierarchyVars = buildHierarchyVars(hierarchyValues);

  if (!isEmptyValue(item?.colorKey)) {
    return String(item.colorKey);
  }
  if (colorConfig?.keyRule) {
    const key = evalExpr(colorConfig.keyRule, {
      event: item,
      trackKey,
      trackMeta,
      hierarchy1,
      hierarchy2: hierarchy2Path,
      hierarchyValues,
      level: item?.level ?? trackMeta?.level,
      ...hierarchyVars
    });
    if (!isEmptyValue(key)) return String(key);
  }
  if (legacyColorConfig) {
    return resolveColorKeyLegacy(item, trackKey, trackMeta, legacyColorConfig);
  }
  const fallbackKey =
    trackMeta?.type === 'process'
      ? hierarchy1
      : `${hierarchyPath || hierarchy2Path || trackKey}-${item?.level ?? trackMeta?.level ?? 0}`;
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
  const hierarchyValues = getHierarchyValuesForColor(item, trackMeta);
  const hierarchy1 = hierarchyValues[0] ?? 'unknown';
  const hierarchy2Path =
    hierarchyValues.length > 1 ? hierarchyValues.slice(1).join('|') : hierarchy1;
  const hierarchyVars = buildHierarchyVars(hierarchyValues);
  const palette =
    Array.isArray(colorConfig?.palette) && colorConfig.palette.length > 0
      ? colorConfig.palette
      : defaultPalette;
  const colorKey = resolveColorKey(item, trackKey, trackMeta, colorConfig, legacyColorConfig);
  if (colorConfig?.fixedColor) {
    return colorConfig.fixedColor;
  }
  if (colorConfig?.colorRule) {
    const stats = processStats?.get(String(hierarchy1)) || {};
    const resolved = evalExpr(colorConfig.colorRule, {
      event: item,
      trackKey,
      trackMeta,
      hierarchy1,
      hierarchy2: hierarchy2Path,
      hierarchyValues,
      level: item?.level ?? trackMeta?.level,
      stats,
      colorKey,
      palette,
      ...hierarchyVars,
      vars: { colorKey, palette, hierarchyValues, ...hierarchyVars }
    });
    if (!isEmptyValue(resolved)) return String(resolved);
  }
  const hash = hashStringToInt(colorKey);
  return palette[hash % palette.length];
}

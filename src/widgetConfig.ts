import { WidgetConfig } from './types/widget';

export const DEFAULT_WIDGET_CONFIG: WidgetConfig = {
  layout: {
    placement: 'top-left',
    direction: 'row',
    wrap: 'wrap',
    gap: 0,
    maxWidth: '100%',
    alignItems: 'center'
  },
  style: {
    container: {
      background: 'transparent',
      padding: '0',
      borderRadius: 0,
      boxShadow: 'none'
    },
    widgetCard: {
      background: 'transparent',
      border: 'none',
      borderRadius: 0,
      padding: '0'
    },
    widgetTitle: {
      fontSize: 12,
      fontWeight: 500,
      color: '#64748b'
    }
  }
};

export const WIDGET_CONFIG = DEFAULT_WIDGET_CONFIG;

export function cloneWidgetConfig(): WidgetConfig {
  return JSON.parse(JSON.stringify(DEFAULT_WIDGET_CONFIG));
}

function mergeWidgetSection(base: any, patch: any): any {
  if (!patch || typeof patch !== 'object') return base;
  const next = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      next[key] = mergeWidgetSection((base as any)?.[key] || {}, value);
    } else {
      (next as any)[key] = value;
    }
  }
  return next;
}

export function applyWidgetConfigPatch(baseConfig: WidgetConfig, patch: any): WidgetConfig {
  if (!patch || typeof patch !== 'object') return baseConfig;
  return {
    ...baseConfig,
    layout: mergeWidgetSection(baseConfig.layout || {}, patch.layout || {}),
    style: mergeWidgetSection(baseConfig.style || {}, patch.style || {})
  };
}

export function summarizeWidgetConfig(config: WidgetConfig): string {
  const layout = config?.layout || {};
  const style = config?.style || {};
  const layoutSummary = [
    `placement=${layout.placement || 'top-left'}`,
    `direction=${layout.direction || 'row'}`,
    `wrap=${layout.wrap || 'wrap'}`,
    `gap=${layout.gap ?? ''}`,
    `maxWidth=${layout.maxWidth ?? ''}`,
    `alignItems=${layout.alignItems || 'stretch'}`
  ].join(', ');
  const containerKeys = Object.keys(style.container || {}).join(', ') || 'none';
  const widgetKeys = Object.keys(style.widgetCard || {}).join(', ') || 'none';
  const titleKeys = Object.keys(style.widgetTitle || {}).join(', ') || 'none';
  return [
    `layout: ${layoutSummary}`,
    `style.container keys: ${containerKeys}`,
    `style.widgetCard keys: ${widgetKeys}`,
    `style.widgetTitle keys: ${titleKeys}`
  ].join(' | ');
}

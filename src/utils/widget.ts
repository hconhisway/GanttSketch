import { stripScriptTags } from './formatting';
import { FLAT_CONFIG_ITEMS } from './configPatch';
import { getValueAtPath } from './expression';

export function findConfigItemForPatch(patch: any): any | null {
  if (!patch || typeof patch !== 'object') return null;
  const matches = FLAT_CONFIG_ITEMS.map((item) => ({
    item,
    value: getValueAtPath(patch, item.path)
  })).filter((entry) => entry.value !== undefined);
  if (matches.length === 0) return null;
  matches.sort((a, b) => b.item.path.split('.').length - a.item.path.split('.').length);
  return matches[0].item;
}

export function normalizeWidget(rawWidget: any): {
  id: string;
  name: string;
  html: string;
  listeners: Array<{ selector: string; event: string; handler: string }>;
  description: string;
} {
  const base = rawWidget && typeof rawWidget === 'object' ? rawWidget : {};
  const fallbackId = `widget-${Date.now()}`;
  const id = String(base.id || fallbackId);
  const name = String(base.name || base.title || id);
  const html = stripScriptTags(String(base.html || ''));
  const rawListeners = Array.isArray(base.listeners) ? base.listeners : [];
  const listeners = rawListeners
    .map((listener: any) => ({
      selector: typeof listener.selector === 'string' ? listener.selector : '',
      event: typeof listener.event === 'string' ? listener.event : 'change',
      handler: typeof listener.handler === 'string' ? listener.handler : ''
    }))
    .filter((listener: any) => listener.handler);
  return {
    id,
    name,
    html,
    listeners,
    description: base.description ? String(base.description) : ''
  };
}

export function buildWidgetHandler(
  source: unknown
): ((payload: any, api: any, widget: any) => any) | null {
  if (!source || typeof source !== 'string') return null;
  const trimmed = source.trim();
  try {
    if (trimmed.startsWith('function') || trimmed.startsWith('(')) {
      const factory = new Function(`return (${source});`);
      return factory();
    }
    return new Function('payload', 'api', 'widget', source) as any;
  } catch (error) {
    console.warn('Failed to compile widget handler:', error);
    return null;
  }
}

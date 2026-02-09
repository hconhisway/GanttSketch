import ganttConfigSpec from './GANTT_CONFIG_SPEC.json';

function toTitle(value: unknown): string {
  if (!value) return '';
  return String(value)
    .replace(/([A-Z])/g, ' $1')
    .replace(/[_-]+/g, ' ')
    .replace(/\./g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\w/, (c) => c.toUpperCase());
}

function exampleFromEntry(entry: any): string {
  if (entry?.example !== undefined) return entry.example;
  if (entry?.default !== undefined) {
    return JSON.stringify(entry.default, null, 2);
  }
  const schemaType = entry?.schema?.type;
  if (schemaType === 'array') return '[]';
  if (schemaType === 'object') return '{}';
  if (schemaType === 'boolean') return 'true';
  if (schemaType === 'number') return '0';
  if (schemaType === 'string') return '"..."';
  return '';
}

function buildItems(
  entries: any[]
): Array<{ id: string; label: string; path: string; description: string; example: string }> {
  return (entries || [])
    .map((entry) => {
      const path = entry.path || entry.id;
      const labelSource = entry?.ui?.label || entry?.label || path?.split('.').slice(-1)[0];
      return {
        id: entry.id || path,
        label: toTitle(labelSource),
        path,
        description: entry.description || '',
        example: exampleFromEntry(entry)
      };
    })
    .filter((item) => item.path);
}

export const GANTT_CONFIG_UI_SPEC = (ganttConfigSpec?.sections || []).map((section: any) => ({
  id: section.id,
  title: toTitle(section.title || section.id),
  description: section.description || '',
  items: buildItems(section.entries)
}));

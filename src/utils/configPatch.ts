import { GANTT_CONFIG_UI_SPEC } from '../config/ganttConfigUiSpec';

export type ConfigItem = {
  id: string;
  label: string;
  path: string;
  description?: string;
  example?: string;
};

type ConfigDomain = { items: ConfigItem[] };

const CONFIG_SPEC = GANTT_CONFIG_UI_SPEC as ConfigDomain[];

export const FLAT_CONFIG_ITEMS: ConfigItem[] = CONFIG_SPEC.flatMap((domain) => domain.items);

export function parseMessageSegments(
  content: unknown
): Array<{ type: 'text' | 'code'; content: string; language?: string }> {
  const text = String(content ?? '');
  if (!text.includes('```')) {
    return [{ type: 'text', content: text }];
  }
  const segments: Array<{ type: 'text' | 'code'; content: string; language?: string }> = [];
  const fenceRegex = /```([a-zA-Z0-9_-]+)?\n?([\s\S]*?)```/g;
  let lastIndex = 0;
  let match;
  while ((match = fenceRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({
        type: 'text',
        content: text.slice(lastIndex, match.index)
      });
    }
    const rawCode = match[2] ?? '';
    const code = rawCode.replace(/^\n/, '').replace(/\n$/, '');
    segments.push({
      type: 'code',
      language: match[1] || '',
      content: code
    });
    lastIndex = fenceRegex.lastIndex;
  }
  if (lastIndex < text.length) {
    segments.push({ type: 'text', content: text.slice(lastIndex) });
  }
  return segments;
}

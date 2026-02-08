import { GANTT_CONFIG_UI_SPEC } from '../ganttConfigUiSpec';

export const FLAT_CONFIG_ITEMS = GANTT_CONFIG_UI_SPEC.flatMap((domain) => domain.items);

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

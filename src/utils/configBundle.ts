import type { GanttDataMapping } from '../types/ganttConfig';

export interface ConfigBundle {
  version: 1;
  generatedAt: string;
  sourceLabel?: string;
  dataMapping: GanttDataMapping;
  ganttConfigPatch?: any;
}

function sanitizeFilePart(value: string): string {
  return value
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[^a-z0-9-_]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
}

export function buildConfigBundle(
  dataMapping: GanttDataMapping,
  ganttConfigPatch?: any,
  sourceLabel?: string
): ConfigBundle {
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    sourceLabel,
    dataMapping,
    ganttConfigPatch: ganttConfigPatch && Object.keys(ganttConfigPatch).length > 0 ? ganttConfigPatch : undefined
  };
}

export function downloadConfigBundle(bundle: ConfigBundle, filename?: string) {
  const safeLabel = bundle.sourceLabel ? sanitizeFilePart(bundle.sourceLabel) : 'gantt_config';
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fallbackName = `${safeLabel || 'gantt_config'}_${timestamp}.json`;
  const fileName = filename && filename.trim().length > 0 ? filename : fallbackName;
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function formatTimeUs(us: unknown): string {
  const safe = Number(us);
  if (!Number.isFinite(safe)) return '';
  const totalMs = Math.max(0, Math.round(safe / 1000));
  const minutes = Math.floor(totalMs / 60000);
  const seconds = Math.floor((totalMs % 60000) / 1000);
  const millis = totalMs % 1000;
  return `${minutes}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

export function formatTimeUsFull(us: unknown): string {
  const safe = Number(us);
  if (!Number.isFinite(safe)) return '';
  const totalUs = Math.max(0, Math.floor(safe));
  const totalSec = Math.floor(totalUs / 1_000_000);
  const usRemainder = totalUs % 1_000_000;
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  const nanos = usRemainder * 1000; // keep 9 digits after decimal
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(nanos).padStart(9, '0')}`;
}

export function formatDurationUs(us: unknown): string {
  const safe = Number(us);
  if (!Number.isFinite(safe)) return '';
  let remaining = Math.max(0, Math.floor(safe));
  const minutes = Math.floor(remaining / 60_000_000);
  remaining %= 60_000_000;
  const seconds = Math.floor(remaining / 1_000_000);
  remaining %= 1_000_000;
  const ms = Math.floor(remaining / 1000);
  const micros = remaining % 1000;

  const parts: string[] = [];
  if (minutes) parts.push(`${minutes}m`);
  if (seconds) parts.push(`${seconds}s`);
  if (ms) parts.push(`${ms}ms`);
  if (micros || parts.length === 0) parts.push(`${micros}µs`);
  return parts.join(' ');
}

export function formatArgValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function stripScriptTags(html: unknown): string {
  if (!html || typeof html !== 'string') return '';
  return html.replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '');
}

export function toCssSize(value: unknown, fallback: string): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'number') return `${value}px`;
  return String(value);
}

export function clampNumber(value: unknown, min: unknown, max: unknown): number {
  const v = Number(value);
  const lo = Number(min);
  const hi = Number(max);
  if (!Number.isFinite(v) || !Number.isFinite(lo) || !Number.isFinite(hi)) return lo;
  return Math.min(hi, Math.max(lo, v));
}

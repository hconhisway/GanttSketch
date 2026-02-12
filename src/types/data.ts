export interface RawEvent {
  [key: string]: any;
}

export interface NormalizedEvent extends RawEvent {
  hierarchy1: string;
  hierarchy2: string;
  ppid?: string | null;
  level?: number;
  hierarchyValues?: string[];
  start: number;
  end: number;
  id?: string | number | null;
  name?: string;
  cat?: string;
  args?: Record<string, any>;
}

export interface SummarySpan extends Partial<NormalizedEvent> {
  kind: 'summary';
  lane: string;
  start: number;
  end: number;
  count: number;
  attrSummary: { topCategories: string[]; avgDuration: number };
  colorKey?: string;
}

export type RenderPrimitive = (NormalizedEvent & { kind: 'raw' }) | SummarySpan;

export interface DataSchema {
  [key: string]: any;
}

export interface FieldMapping {
  [key: string]: string;
}

export interface ProcessAggregate {
  hierarchy1: string;
  count: number;
  totalDurUs: number;
  maxDurUs: number;
  minStart: number;
  maxEnd: number;
  avgDurUs?: number;
}

export interface TracksConfig {
  sortMode?: string;
  customSort?: (a: string, b: string) => number;
  groups?: Array<{ name: string; tracks: string[]; order?: number }>;
  filter?: (track: string) => boolean;
  trackList?: string[];
}

export interface TrackDef {
  name: string;
  tracks: string[];
}

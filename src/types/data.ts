export interface RawEvent {
  [key: string]: any;
}

export interface NormalizedEvent extends RawEvent {
  pid: string;
  tid: string;
  ppid?: string | null;
  level?: number;
  start: number;
  end: number;
  id?: string | number | null;
  name?: string;
  cat?: string;
  args?: Record<string, any>;
}

export interface DataSchema {
  [key: string]: any;
}

export interface FieldMapping {
  [key: string]: string;
}

export interface ProcessAggregate {
  pid: string;
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

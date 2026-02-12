import { streamLLMResponse } from '../config/llmConfig';
import type { GanttDataMapping } from '../types/ganttConfig';
import {
  buildHierarchyValues,
  getHierarchyFieldVarName,
  getHierarchyFieldsFromMapping,
  getHierarchyLodKey,
  getHierarchyVarName,
  getHierarchyKeysFromHierarchyValues,
  normalizeHierarchyFeatures
} from '../utils/hierarchy';

/**
 * Data Analysis Agent (v2)
 *
 * Analyzes arbitrary data and produces a universal GanttDataMapping
 * that covers every visual aspect of the Gantt chart.
 * Designed for generality — works with any trace / profiling / timeline data.
 */

// ────────────────────────────────────────────────────────────────
// LLM Prompt
// ────────────────────────────────────────────────────────────────

export const DATA_MAPPING_PROMPT = `You are a data analysis agent for a Gantt chart visualization tool.
Given sample events from an arbitrary dataset, figure out how to map each field to the chart's visual elements.

A Gantt chart needs:
1. **X-Axis (Time)**: Each event needs a start time, and either an end time or a duration.
2. **Y-Axis (Rows)**: Events are grouped into rows by hierarchy fields (e.g. process → thread).
3. **Event Identity**: Each event has a name/label, and optionally a category and unique ID.
4. **Color**: Events are colored by a grouping field (category, name, type, etc.).
5. **Bar Label**: Text shown on each event bar (usually the event name).
6. **Tooltip**: Fields shown when hovering over an event.
7. **Metadata**: An object field containing extra arguments/properties.
8. **Features**: Intelligent defaults — hierarchy depth, fork tree, dependency lines, packing, etc.

## Sample Events
{sampleEvents}

## Task
Analyze the sample data and output the mapping configuration.
Use the EXACT field paths as they appear in the data (e.g., "ts", "Raw.pid", "enter.Timestamp", "args.phase").
Use null for fields not present in the data.

For timeUnit, prefer explicit hints in field names first, then estimate from magnitude:
- If field name contains "(ns)" or "_ns" → use "ns"
- If field name contains "(us)" or "(μs)" or "_us" → use "us"
- If field name contains "(ms)" or "_ms" → use "ms"
- Else by magnitude: > 1e15 → "ns", > 1e9 → "us", > 1e6 → "ms", < 1e6 → "s"

For Enter/Leave event pairs: if startField has "Timestamp (ns)" and the event has "_matching_timestamp",
use endField: "_matching_timestamp" (end time from the matching Leave event).

For tooltip fields, include the most informative fields with appropriate format hints:
- "time" for timestamp fields
- "duration" for duration fields
- "none" for everything else

For allFields in schema, list ALL fields found in the data (including nested paths like "args.phase").

### Features section
The "features" object captures high-level chart behavior that the renderer derives from.
Analyze the data carefully and set each flag:
- **hierarchyLevels**: How many grouping levels are present? (1 = flat list, 2 = group+subgroup, etc.)
- **hierarchyFields**: Array of field paths, one per level, ordered from outermost to innermost.
  Must have length == hierarchyLevels. e.g. ["pid", "tid"] for 2 levels.
- **forkTree**: true if there is a parent-child relationship between hierarchy1 rows (a parentField exists).
- **dependencyLines**: true if events have fields linking to predecessor/successor events (causal chains, flow IDs). Currently reserved for future use.
- **dependencyField**: The field path used for dependency, or null.
- **lanePacking**: How events in the same sub-row should be packed: "autoPack" (overlap-free bin packing, default), "stack" (one event per row, stacked), or "flat" (single row).
- **flameChart**: true if events have a level/depth field indicating nested call stacks.
- **colorStrategy**: Best color grouping for this data: "category", "hierarchy1", "name", or "field".

Output JSON:
\`\`\`json
{
  "xAxis": {
    "startField": "field path for start time",
    "endField": "field path for end time, or null",
    "durationField": "field path for duration, or null",
    "timeUnit": "us"
  },
  "yAxis": {
    "hierarchyFields": ["outermost hierarchy field", "next hierarchy field"],
    "parentField": "field for parent process (fork tree), or null"
  },
  "identity": {
    "nameField": "field for event name/label",
    "categoryField": "field for category/type, or null",
    "idField": "field for unique ID, or null"
  },
  "color": {
    "keyField": "field for color grouping (prefer hierarchy1, then category, then name)"
  },
  "barLabel": {
    "field": "field for bar text (usually same as nameField)"
  },
  "tooltip": {
    "fields": [
      { "sourceField": "name", "label": "Name", "format": "none" },
      { "sourceField": "cat",  "label": "Category", "format": "none" },
      { "sourceField": "ts",   "label": "Start", "format": "time" },
      { "sourceField": "dur",  "label": "Duration", "format": "duration" },
      { "sourceField": "pid",  "label": "Process", "format": "none" },
      { "sourceField": "tid",  "label": "Thread", "format": "none" }
    ],
    "showArgs": true,
    "argsField": "args"
  },
  "schema": {
    "dataFormat": "description of the data format",
    "allFields": [
      { "path": "fieldName", "type": "string|number|boolean|object|array" }
    ],
    "notes": "observations about the data"
  },
  "features": {
    "hierarchyLevels": 2,
    "hierarchyFields": ["pid", "tid"],
    "forkTree": true,
    "dependencyLines": false,
    "dependencyField": null,
    "lanePacking": "autoPack",
    "flameChart": false,
    "colorStrategy": "category"
  }
}
\`\`\`

Guidelines:
- Handle nested structures (e.g., "Raw.pid", "enter.Timestamp")
- If the data has both start+end timestamps, use both; if only start+duration, set endField to null
- Include ALL fields you find in schema.allFields (flatten nested objects with dot paths)
- For tooltip, include at least: name, start time, duration, hierarchy1 key, hierarchy2 key (when available)
- For color.keyField, prefer hierarchy1 if available, then category, then name
- ALWAYS provide timeUnit based on timestamp value magnitude analysis
- Set features.hierarchyLevels to match how many distinct grouping levels the data has
- Set features.hierarchyFields to list the field for each level (outermost first)
- Also set yAxis.hierarchyFields to the same ordered list
- Set features.forkTree = true only when a meaningful parent field exists
- Set features.flameChart = true when a depth/level field is present and events nest within a thread
- Set features.colorStrategy based on what makes the most visual sense for this data`;

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

/** Max chars per event when sent to LLM; avoids huge payloads (e.g. _children with 9k items) */
const MAX_EVENT_JSON_CHARS = 2000;

function isEventTooLong(ev: any): boolean {
  if (ev == null) return true;
  // Skip events with very large arrays (e.g. _children)
  for (const key of Object.keys(ev)) {
    const v = ev[key];
    if (Array.isArray(v) && v.length > 100) return true;
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      const str = JSON.stringify(v);
      if (str.length > MAX_EVENT_JSON_CHARS) return true;
    }
  }
  if (JSON.stringify(ev).length > MAX_EVENT_JSON_CHARS) return true;
  return false;
}

/**
 * Pick up to `count` sample events for the LLM. Skips events that are too long
 * (e.g. _children with thousands of items). Tries step-spread indices first,
 * then "next" index when an event is skipped.
 */
function sampleEventsForLLM(events: any[], count = 3): any[] {
  if (!Array.isArray(events) || events.length === 0) return [];
  const need = Math.min(count, events.length);
  const step = Math.max(1, Math.floor(events.length / need));
  const samples: any[] = [];
  for (let i = 0; i < need; i++) {
    let idx = Math.min(i * step, events.length - 1);
    while (idx < events.length) {
      if (!isEventTooLong(events[idx])) {
        samples.push(events[idx]);
        break;
      }
      idx++;
    }
  }
  return samples;
}

function sampleEvents(events: any[], count = 20): any[] {
  if (!Array.isArray(events) || events.length === 0) return [];
  const step = Math.max(1, Math.floor(events.length / count));
  const samples: any[] = [];
  for (let i = 0; i < Math.min(count, events.length); i++) {
    const index = Math.min(i * step, events.length - 1);
    samples.push(events[index]);
  }
  return samples;
}

/** Get a value from an event using a dot-separated field path */
export function getFieldValue(event: any, fieldName: string | null): any {
  if (!event || !fieldName) return undefined;
  if (fieldName.includes('.')) {
    const parts = fieldName.split('.');
    let value = event;
    for (const part of parts) {
      if (value === undefined || value === null) return undefined;
      value = value[part];
    }
    return value;
  }
  return event[fieldName];
}

/** Convert timeUnit to a multiplier that normalizes to microseconds */
export function getTimeMultiplier(timeUnit: string): number {
  switch (timeUnit) {
    case 'ns':
      return 0.001;
    case 'us':
      return 1;
    case 'ms':
      return 1000;
    case 's':
      return 1_000_000;
    default:
      return 1;
  }
}

// ────────────────────────────────────────────────────────────────
// Backward-compatibility conversion helpers
// ────────────────────────────────────────────────────────────────

/** Extract flat { hierarchy1Field, hierarchy2Field, start, ... } mapping from GanttDataMapping */
export function dataMappingToFlatFieldMapping(
  mapping: GanttDataMapping
): Record<string, string | null> {
  const hierarchyFields = getHierarchyFieldsFromMapping(mapping);
  const dynamicHierarchyFields = hierarchyFields.length > 0 ? hierarchyFields : ['hierarchy1', 'hierarchy2'];

  const flatMapping: Record<string, string | null> = {
    hierarchy1Field: dynamicHierarchyFields[0] || 'hierarchy1',
    hierarchy2Field:
      dynamicHierarchyFields[1] ||
      dynamicHierarchyFields[0] ||
      'hierarchy2',
    ppid: mapping.yAxis.parentField || null,
    start: mapping.xAxis.startField || 'ts',
    end: mapping.xAxis.endField || null,
    duration: mapping.xAxis.durationField || 'dur',
    name: mapping.identity.nameField || 'name',
    cat: mapping.identity.categoryField || null,
    args: mapping.tooltip.argsField || 'args',
    level: null,
    id: mapping.identity.idField || null
  };

  dynamicHierarchyFields.forEach((field, index) => {
    if (!field) return;
    flatMapping[`hierarchy${index + 1}Field`] = field;
  });

  return flatMapping;
}

/** Build legacy schema format for agent backward compatibility */
export function dataMappingToLegacySchema(mapping: GanttDataMapping) {
  const fieldToSemantic: Record<string, string> = {};
  const hierarchyFields = getHierarchyFieldsFromMapping(mapping);
  if (mapping.xAxis.startField) fieldToSemantic[mapping.xAxis.startField] = 'start_time';
  if (mapping.xAxis.endField) fieldToSemantic[mapping.xAxis.endField] = 'end_time';
  if (mapping.xAxis.durationField) fieldToSemantic[mapping.xAxis.durationField] = 'duration';
  if (hierarchyFields[0]) fieldToSemantic[hierarchyFields[0]] = 'process_id';
  if (hierarchyFields[1]) fieldToSemantic[hierarchyFields[1]] = 'thread_id';
  if (mapping.yAxis.parentField) fieldToSemantic[mapping.yAxis.parentField] = 'parent_id';
  if (mapping.identity.nameField) fieldToSemantic[mapping.identity.nameField] = 'name';
  if (mapping.identity.categoryField) fieldToSemantic[mapping.identity.categoryField] = 'category';
  if (mapping.identity.idField) fieldToSemantic[mapping.identity.idField] = 'id';
  if (mapping.tooltip.argsField) fieldToSemantic[mapping.tooltip.argsField] = 'args';

  const fields = mapping.schema.allFields.map((f) => ({
    originalName: f.path,
    semantic: fieldToSemantic[f.path] || 'unknown',
    type: f.type,
    confidence: fieldToSemantic[f.path] ? 1.0 : 0.5,
    reason: fieldToSemantic[f.path] ? 'Mapped by data analysis' : 'Not mapped to a chart element'
  }));

  return {
    fields,
    dataFormat: mapping.schema.dataFormat,
    notes: mapping.schema.notes
  };
}

// ────────────────────────────────────────────────────────────────
// Default mapping (fallback for standard trace format)
// ────────────────────────────────────────────────────────────────

export function createDefaultMapping(): GanttDataMapping {
  return {
    xAxis: { startField: 'ts', endField: null, durationField: 'dur', timeUnit: 'us' },
    yAxis: {
      hierarchyFields: ['pid', 'tid'],
      parentField: 'ppid'
    },
    identity: { nameField: 'name', categoryField: 'cat', idField: 'id' },
    color: { keyField: 'pid' },
    barLabel: { field: 'name' },
    tooltip: {
      fields: [
        { sourceField: 'name', label: 'Name', format: 'none' },
        { sourceField: 'cat', label: 'Category', format: 'none' },
        { sourceField: 'ts', label: 'Start', format: 'time' },
        { sourceField: 'dur', label: 'Duration', format: 'duration' },
        { sourceField: 'tid', label: 'Thread', format: 'none' },
        { sourceField: 'pid', label: 'Process', format: 'none' }
      ],
      showArgs: true,
      argsField: 'args'
    },
    schema: { dataFormat: 'standard trace format', allFields: [], notes: '' },
    features: {
      hierarchyLevels: 2,
      hierarchyFields: ['pid', 'tid'],
      forkTree: true,
      dependencyLines: false,
      dependencyField: null,
      lanePacking: 'autoPack',
      flameChart: false,
      colorStrategy: 'hierarchy1'
    }
  };
}

// ────────────────────────────────────────────────────────────────
// LLM-based mapping detection
// ────────────────────────────────────────────────────────────────

export async function detectDataMappingWithLLM(events: any[]): Promise<GanttDataMapping> {
  const samples = sampleEventsForLLM(events, 5);

  if (samples.length === 0) {
    return createDefaultMapping();
  }

  const prompt = DATA_MAPPING_PROMPT.replace(
    '{sampleEvents}',
    JSON.stringify(samples, null, 2)
  );

  return new Promise((resolve, reject) => {
    let accumulated = '';

    streamLLMResponse(
      [{ role: 'user', content: prompt }],
      (chunk) => {
        accumulated += chunk;
      },
      () => {
        try {
          const jsonMatch = accumulated.match(/```json\s*([\s\S]*?)\s*```/);
          const raw = jsonMatch ? JSON.parse(jsonMatch[1]) : JSON.parse(accumulated);

          // Validate and fill defaults
          const mapping = validateAndFillMapping(raw);
          console.log('[DataAnalysisAgent] LLM mapping parsed successfully:', {
            startField: mapping.xAxis?.startField,
            endField: mapping.xAxis?.endField,
            durationField: mapping.xAxis?.durationField,
            timeUnit: mapping.xAxis?.timeUnit,
            hierarchyFields: mapping.yAxis?.hierarchyFields,
            nameField: mapping.identity?.nameField
          });
          resolve(mapping);
        } catch (error) {
          console.error('Error parsing data mapping response:', error);
          console.log('Raw response:', accumulated);
          reject(new Error('Failed to parse data mapping response'));
        }
      },
      (error) => {
        console.error('Error in data mapping detection:', error);
        reject(error);
      }
    );
  });
}

/** Infer timeUnit from field name when it contains (ns), (us), (ms), etc. */
function inferTimeUnitFromFieldName(fieldName: string | null | undefined): string | null {
  if (!fieldName || typeof fieldName !== 'string') return null;
  const lower = fieldName.toLowerCase();
  if (lower.includes('(ns)') || lower.includes('_ns')) return 'ns';
  if (lower.includes('(us)') || lower.includes('(μs)') || lower.includes('_us')) return 'us';
  if (lower.includes('(ms)') || lower.includes('_ms')) return 'ms';
  if (lower.includes('(s)') || lower.includes('_s')) return 's';
  return null;
}

/** Validate LLM output and fill any missing fields with defaults */
function validateAndFillMapping(raw: any): GanttDataMapping {
  const defaults = createDefaultMapping();

  const startField = raw?.xAxis?.startField ?? defaults.xAxis.startField;
  const endField = raw?.xAxis?.endField ?? defaults.xAxis.endField;
  const durationField = raw?.xAxis?.durationField ?? defaults.xAxis.durationField;
  // Prefer timeUnit from field name (e.g. "Timestamp (ns)") over LLM guess
  const inferredUnit = inferTimeUnitFromFieldName(startField) ?? inferTimeUnitFromFieldName(endField);
  const llmUnit = ['us', 'ms', 's', 'ns'].includes(raw?.xAxis?.timeUnit)
    ? raw.xAxis.timeUnit
    : defaults.xAxis.timeUnit;
  const timeUnit = inferredUnit ?? llmUnit;
  const yAxisHierarchyFields =
    Array.isArray(raw?.yAxis?.hierarchyFields) && raw.yAxis.hierarchyFields.length > 0
      ? raw.yAxis.hierarchyFields.map(String)
      : [raw?.yAxis?.hierarchy1Field ?? raw?.yAxis?.processField, raw?.yAxis?.hierarchy2Field ?? raw?.yAxis?.threadField]
          .map((value: any) => (value == null ? '' : String(value).trim()))
          .filter((value: string) => value.length > 0);

  const normalizedMapping: GanttDataMapping = {
    xAxis: {
      startField,
      endField,
      durationField,
      timeUnit
    },
    yAxis: {
      hierarchyFields: yAxisHierarchyFields.length > 0 ? yAxisHierarchyFields : defaults.yAxis.hierarchyFields,
      parentField: raw?.yAxis?.parentField ?? defaults.yAxis.parentField
    },
    identity: {
      nameField: raw?.identity?.nameField ?? defaults.identity.nameField,
      categoryField: raw?.identity?.categoryField ?? defaults.identity.categoryField,
      idField: raw?.identity?.idField ?? defaults.identity.idField
    },
    color: {
      keyField: raw?.color?.keyField ?? defaults.color.keyField
    },
    barLabel: {
      field: raw?.barLabel?.field ?? defaults.barLabel.field
    },
    tooltip: {
      fields:
        Array.isArray(raw?.tooltip?.fields) && raw.tooltip.fields.length > 0
          ? raw.tooltip.fields.map((f: any) => ({
              sourceField: String(f.sourceField || ''),
              label: String(f.label || ''),
              format: ['time', 'duration', 'none'].includes(f.format) ? f.format : 'none'
            }))
          : defaults.tooltip.fields,
      showArgs:
        typeof raw?.tooltip?.showArgs === 'boolean'
          ? raw.tooltip.showArgs
          : defaults.tooltip.showArgs,
      argsField: raw?.tooltip?.argsField ?? defaults.tooltip.argsField
    },
    schema: {
      dataFormat: String(raw?.schema?.dataFormat || defaults.schema.dataFormat),
      allFields: Array.isArray(raw?.schema?.allFields)
        ? raw.schema.allFields.map((f: any) => ({
            path: String(f.path || ''),
            type: String(f.type || 'unknown'),
            ...(f.sampleValues ? { sampleValues: f.sampleValues } : {})
          }))
        : defaults.schema.allFields,
      notes: String(raw?.schema?.notes || defaults.schema.notes)
    },
    features: {
      hierarchyLevels:
        typeof raw?.features?.hierarchyLevels === 'number' && raw.features.hierarchyLevels >= 1
          ? raw.features.hierarchyLevels
          : defaults.features.hierarchyLevels,
      hierarchyFields:
        Array.isArray(raw?.features?.hierarchyFields) && raw.features.hierarchyFields.length > 0
          ? raw.features.hierarchyFields.map(String)
          : defaults.features.hierarchyFields,
      forkTree:
        typeof raw?.features?.forkTree === 'boolean'
          ? raw.features.forkTree
          : defaults.features.forkTree,
      dependencyLines:
        typeof raw?.features?.dependencyLines === 'boolean'
          ? raw.features.dependencyLines
          : defaults.features.dependencyLines,
      dependencyField:
        raw?.features?.dependencyField != null
          ? String(raw.features.dependencyField)
          : defaults.features.dependencyField,
      lanePacking:
        ['autoPack', 'stack', 'flat'].includes(raw?.features?.lanePacking)
          ? raw.features.lanePacking
          : defaults.features.lanePacking,
      flameChart:
        typeof raw?.features?.flameChart === 'boolean'
          ? raw.features.flameChart
          : defaults.features.flameChart,
      colorStrategy:
        ['category', 'hierarchy1', 'name', 'field'].includes(raw?.features?.colorStrategy)
          ? raw.features.colorStrategy
          : defaults.features.colorStrategy
    }
  };
  return normalizeHierarchyFeatures(normalizedMapping);
}

// ────────────────────────────────────────────────────────────────
// Event processing
// ────────────────────────────────────────────────────────────────

/**
 * Process raw events using a flat field mapping.
 * Preserves all original fields AND adds normalized internal fields
 * (start, end, hierarchy1, hierarchy2, ppid, level, name, cat, args, id).
 *
 * @param rawEvents     Raw events from the data source
 * @param flatMapping   { hierarchy1Field, hierarchy2Field, ppid, start, end, duration, name, cat, args, level, id }
 * @param timeMultiplier  Multiplier to convert source time unit to microseconds (default 1)
 */
export function processEventsMinimal(
  rawEvents: any[],
  flatMapping: Record<string, string | null>,
  timeMultiplier = 1,
  hierarchyFields?: string[]
): any[] {
  if (!Array.isArray(rawEvents) || rawEvents.length === 0) return [];

  console.log(
    '[DataAnalysisAgent] Processing events with mapping:',
    flatMapping,
    'timeMultiplier:',
    timeMultiplier
  );

  const mappingHierarchyFields = Object.keys(flatMapping)
    .filter((key) => /^hierarchy\d+Field$/.test(key))
    .sort((a, b) => {
      const ai = Number(a.match(/^hierarchy(\d+)Field$/)?.[1] ?? 0);
      const bi = Number(b.match(/^hierarchy(\d+)Field$/)?.[1] ?? 0);
      return ai - bi;
    })
    .map((key) => flatMapping[key])
    .filter((value): value is string => Boolean(value));

  const events = rawEvents
    .map((ev) => {
      const raw = ev.Raw ?? ev.raw ?? ev;

      // Start time
      let startValue =
        getFieldValue(raw, flatMapping.start) ??
        getFieldValue(ev, flatMapping.start) ??
        ev.enter?.Timestamp ??
        ev.Timestamp;

      // End time or calculate from duration
      let endValue = flatMapping.end
        ? (getFieldValue(raw, flatMapping.end) ?? getFieldValue(ev, flatMapping.end))
        : null;

      if (endValue === null || endValue === undefined) {
        const durValue =
          getFieldValue(raw, flatMapping.duration) ??
          getFieldValue(ev, flatMapping.duration) ??
          0;
        endValue = Number(startValue) + Number(durValue);
      }
      // Keep events with missing end: use start + 1 (in source units) so they still render
      if (endValue === null || endValue === undefined || !Number.isFinite(Number(endValue))) {
        endValue = Number(startValue) + 1;
      }

      let start = Number(startValue) * timeMultiplier;
      let end = Number(endValue) * timeMultiplier;
      if (!Number.isFinite(start) && Number.isFinite(end)) {
        // Preserve events that only provide an end timestamp.
        start = end - 1;
      }
      if (!Number.isFinite(end) && Number.isFinite(start)) {
        // Preserve events that only provide a start timestamp.
        end = start + 1;
      }
      // Enter/Leave pairs: Leave has start=leaveTime, end=enterTime so end < start. Use min/max so both show.
      if (Number.isFinite(start) && Number.isFinite(end) && end < start) {
        [start, end] = [end, start];
      }
      // Preserve instantaneous events instead of dropping them. Some datasets encode
      // valid point-events with start === end, and removing them can collapse lanes.
      if (Number.isFinite(start) && Number.isFinite(end) && end === start) {
        end = start + 1;
      }

      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;

      const hierarchyFieldList =
        Array.isArray(hierarchyFields) && hierarchyFields.length > 0
          ? hierarchyFields
          : mappingHierarchyFields;
      const hierarchyValues = buildHierarchyValues(ev, raw, hierarchyFieldList, 'unknown', '<N/A>');
      const hierarchyAliases = getHierarchyKeysFromHierarchyValues(hierarchyValues);
      const ppidRaw = getFieldValue(raw, flatMapping.ppid) ?? getFieldValue(ev, flatMapping.ppid);
      const ppid = ppidRaw == null ? null : String(ppidRaw);

      const levelRaw =
        (flatMapping.level
          ? getFieldValue(raw, flatMapping.level) ?? getFieldValue(ev, flatMapping.level)
          : undefined) ??
        raw?.level ??
        ev?.level ??
        raw?.depth ??
        ev?.depth ??
        raw?.args?.level ??
        ev?.args?.level ??
        raw?.args?.depth ??
        ev?.args?.depth;
      let level: any = undefined;
      if (levelRaw !== undefined && levelRaw !== null) {
        const levelNum = Number(levelRaw);
        level = Number.isFinite(levelNum) ? levelNum : levelRaw;
      }

      const name =
        getFieldValue(raw, flatMapping.name) ?? getFieldValue(ev, flatMapping.name) ?? '';
      const cat = getFieldValue(raw, flatMapping.cat) ?? getFieldValue(ev, flatMapping.cat) ?? '';
      const args =
        getFieldValue(raw, flatMapping.args) ?? getFieldValue(ev, flatMapping.args) ?? {};
      const id = raw.id ?? ev.id ?? ev.GUID ?? ev.intervalId ?? null;

      return {
        ...raw,
        ...ev,
        kind: 'raw',
        start,
        end,
        ...hierarchyAliases,
        hierarchyValues: hierarchyAliases.hierarchyValues,
        ppid,
        level,
        name,
        cat,
        args,
        id
      };
    })
    .filter(Boolean);

  // Adjust timeline to start at 0 if using epoch timestamps
  let minStart = 0;
  if (events.length > 0) {
    let min = Number.POSITIVE_INFINITY;
    for (const e of events) {
      const v = Number(e?.start);
      if (Number.isFinite(v) && v < min) min = v;
    }
    minStart = Number.isFinite(min) ? min : 0;
  }
  if (minStart > 1e12) {
    events.forEach((e: any) => {
      e.start -= minStart;
      e.end -= minStart;
      if (typeof e.ts === 'number') e.ts -= minStart;
      if (typeof e.timestamp === 'number') e.timestamp -= minStart;
    });
  }

  events.sort((a: any, b: any) => a.start - b.start);
  return events;
}

// ────────────────────────────────────────────────────────────────
// Deterministic config derivation from mapping + features
// ────────────────────────────────────────────────────────────────

/**
 * Derive a GanttConfig patch deterministically from the DataMapping.
 *
 * This is NOT generated by the LLM — it reads the `features` flags and
 * field mappings and produces the corresponding config rules so the
 * default config "just works" for the dataset.
 *
 * The LLM only produces the DataMapping (including features); this
 * function translates those declarative settings into the rule AST
 * that the chart engine understands.
 */
export function deriveConfigFromMapping(mapping: GanttDataMapping): any {
  const normalized = normalizeHierarchyFeatures(mapping);
  const config: any = {};
  const features = normalized.features;
  const hierarchyFields = features.hierarchyFields;
  const hierarchyLevels = Math.max(
    1,
    Number(features.hierarchyLevels || hierarchyFields.length || 1)
  );

  // ── X-Axis (time) ──
  config.xAxis = { timeFormat: 'short' };
  config.performance = {
    ...(config.performance || {}),
    hierarchy1LOD: { mergeUtilGap: 0.002 }
  };
  for (let level = 2; level <= hierarchyLevels; level += 1) {
    config.performance[getHierarchyLodKey(level)] = { pixelWindow: 1 };
  }

  // ── Color ──
  const colorField = normalized.color.keyField;
  if (colorField) {
    config.color = {
      keyRule: {
        type: 'expr',
        expr: { op: 'get', path: `event.${colorField}` }
      }
    };
  }

  // ── Y-Axis ──
  // Fork tree ordering when features.forkTree is enabled
  if (features.forkTree && normalized.yAxis.parentField) {
    config.yAxis = {
      ...config.yAxis,
      hierarchy1OrderRule: {
        type: 'transform',
        name: 'forkTree',
        params: { includeUnspecified: true }
      }
    };
  }

  // Hierarchy1 label: prefix with actual field name from mapping
  const hierarchy1Field = hierarchyFields[0];
  if (hierarchy1Field) {
    config.yAxis = {
      ...config.yAxis,
      hierarchyFields,
      hierarchy1Field,
      hierarchy1LabelRule: {
        type: 'expr',
        expr: {
          op: 'concat',
          args: [
            { op: 'if', args: [{ op: 'var', name: 'isExpanded' }, '\u25BC ', '\u25B6 '] },
            { op: 'var', name: 'hierarchy1Field' },
            ': ',
            { op: 'var', name: 'hierarchy1' }
          ]
        }
      }
    };
  }

  // Hierarchy2 label: prefix with actual field name from mapping
  const hierarchy2Field = hierarchyFields[1];
  if (hierarchy2Field && hierarchyLevels >= 2) {
    config.yAxis = {
      ...config.yAxis,
      hierarchy2Field,
      hierarchy2LabelRule: {
        type: 'expr',
        expr: {
          op: 'concat',
          args: [
            { op: 'var', name: 'hierarchy2Field' },
            ': ',
            { op: 'var', name: 'hierarchy2' }
          ]
        }
      }
    };
  }
  for (let level = 3; level <= hierarchyLevels; level += 1) {
    const field = hierarchyFields[level - 1];
    if (!field) continue;
    const fieldKey = getHierarchyFieldVarName(level);
    const valueKey = getHierarchyVarName(level);
    config.yAxis = {
      ...config.yAxis,
      [fieldKey]: field,
      [`hierarchy${level}LabelRule`]: {
        type: 'expr',
        expr: {
          op: 'concat',
          args: [{ op: 'var', name: fieldKey }, ': ', { op: 'var', name: valueKey }]
        }
      }
    };
  }

  // Lane packing defaults for hierarchy2+.
  if (hierarchyLevels >= 2) {
    const lanePackingName = features.lanePacking || 'autoPack';
    config.yAxis = {
      ...config.yAxis,
      hierarchy2LaneRule: {
        type: 'transform',
        name: lanePackingName
      }
    };
    for (let level = 3; level <= hierarchyLevels; level += 1) {
      config.yAxis[`hierarchy${level}LaneRule`] = {
        type: 'transform',
        name: lanePackingName
      };
    }
  }

  // ── Tooltip ──
  const tooltipFields: any[] = [];
  for (const tf of normalized.tooltip.fields) {
    if (!tf.sourceField) continue;

    let valueExpr: any;
    if (tf.format === 'time') {
      valueExpr = {
        op: 'formatTimeUsFull',
        args: [{ op: 'get', path: `event.${tf.sourceField}` }]
      };
    } else if (tf.format === 'duration') {
      valueExpr = {
        op: 'formatDurationUs',
        args: [{ op: 'get', path: `event.${tf.sourceField}` }]
      };
    } else {
      valueExpr = { op: 'get', path: `event.${tf.sourceField}` };
    }

    tooltipFields.push({ label: tf.label, value: valueExpr });
  }

  if (tooltipFields.length > 0) {
    config.tooltip = {
      event: {
        fields: tooltipFields,
        args:
          normalized.tooltip.showArgs !== false
            ? { enabled: true, max: 24, sort: 'alpha', label: 'Arguments' }
            : { enabled: false }
      }
    };
  }

  return config;
}

/**
 * @deprecated Use deriveConfigFromMapping instead.
 * Kept temporarily for backward compatibility with config bundles.
 */
export const generateInitialConfig = deriveConfigFromMapping;

// ────────────────────────────────────────────────────────────────
// Main entry point
// ────────────────────────────────────────────────────────────────

export async function analyzeAndInitialize(rawEvents: any[]) {
  console.log('Starting data analysis with LLM (v2 – universal mapping)...');

  try {
    // 1. Detect mapping (including features) using LLM
    const dataMapping = await detectDataMappingWithLLM(rawEvents);
    console.log('Data mapping detected:', dataMapping);
    console.log('Feature flags:', dataMapping.features);

    // 2. Extract flat field mapping for event processing
    const flatMapping = dataMappingToFlatFieldMapping(dataMapping);
    const hierarchyFields = getHierarchyFieldsFromMapping(dataMapping);
    const timeMultiplier = getTimeMultiplier(dataMapping.xAxis.timeUnit);

    // 3. Process events
    const processedEvents = processEventsMinimal(
      rawEvents,
      flatMapping,
      timeMultiplier,
      hierarchyFields
    );
    console.log(`Processed ${processedEvents.length} events`);
    if (processedEvents.length === 0) {
      console.warn('[DataAnalysisAgent] Mapping produced 0 events.', {
        mapping: dataMapping,
        flatMapping,
        timeMultiplier
      });
    }

    // 4. Derive config deterministically from mapping + features
    //    The LLM does NOT produce config rules — it only produces the DataMapping.
    //    This function translates features into the rule AST the renderer expects.
    const derivedConfig = deriveConfigFromMapping(dataMapping);
    console.log('Derived config from mapping features:', derivedConfig);

    return {
      events: processedEvents,
      config: derivedConfig,
      dataMapping,
      // Backward-compat aliases used by config / widget agents
      schema: dataMappingToLegacySchema(dataMapping),
      fieldMapping: flatMapping,
      usedFallback: false
    };
  } catch (error: any) {
    console.error('Error in data analysis:', error);

    const fallbackMapping = createDefaultMapping();
    const flatMapping = dataMappingToFlatFieldMapping(fallbackMapping);
    const processedEvents = processEventsMinimal(
      rawEvents,
      flatMapping,
      1,
      getHierarchyFieldsFromMapping(fallbackMapping)
    );

    return {
      events: processedEvents,
      config: deriveConfigFromMapping(fallbackMapping),
      dataMapping: fallbackMapping,
      schema: dataMappingToLegacySchema(fallbackMapping),
      fieldMapping: flatMapping,
      usedFallback: true,
      error: error?.message || 'LLM mapping failed'
    };
  }
}

// Export for testing
export const _test = {
  sampleEvents,
  sampleEventsForLLM,
  isEventTooLong,
  getFieldValue,
  getTimeMultiplier,
  createDefaultMapping,
  validateAndFillMapping,
  inferTimeUnitFromFieldName,
  dataMappingToFlatFieldMapping,
  dataMappingToLegacySchema,
  processEventsMinimal,
  deriveConfigFromMapping,
  generateInitialConfig
};

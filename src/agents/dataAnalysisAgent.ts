import { streamLLMResponse } from '../llmConfig';

/**
 * Data Analysis Agent
 *
 * Uses LLM to detect schema from arbitrary data formats, transform events,
 * and generate intelligent initial configuration.
 */

// Schema detection prompt template
export const SCHEMA_DETECTION_PROMPT = `You are a data schema analyzer for trace/profiling data.

Analyze the sample events and identify the semantic meaning of each field.

## Sample Events
{sampleEvents}

## Task
For each field found in the data, determine its semantic role:
- process_id: Identifier for a process (e.g., pid, processId, proc_id, rank, device, Location, gpu_id)
- thread_id: Identifier for a thread within a process (e.g., tid, threadId, thread)
- parent_id: Parent process identifier for fork relationships (e.g., ppid, parentPid, parent_process_id)
- name: Event/operation name (e.g., name, label, Primitive, op_name, kernel, function)
- category: Event category or type (e.g., cat, category, type, kind, phase)
- start_time: Event start timestamp (e.g., ts, timestamp, start, begin, Timestamp in enter)
- end_time: Event end timestamp (e.g., end, finish, Timestamp in leave)
- duration: Event duration (e.g., dur, duration, elapsed)
- level: Nesting level or lane (e.g., level, depth, lane)
- args: Additional arguments/metadata object (e.g., args, metadata, properties)

Output JSON:
\`\`\`json
{
  "fields": [
    {
      "originalName": "the field name as it appears in data",
      "semantic": "one of the semantic roles above, or 'unknown'",
      "type": "string|number|boolean|object|array",
      "confidence": 0.0-1.0,
      "reason": "brief explanation"
    }
  ],
  "dataFormat": "description of the overall data format",
  "notes": "any observations about the data structure"
}
\`\`\`

Be flexible with naming - many different field names can map to the same semantic role.
Look for patterns in nested structures (e.g., Raw.pid, enter.Timestamp).`;

// Sample events for LLM analysis
function sampleEvents(events: any[], count = 20) {
  if (!Array.isArray(events) || events.length === 0) {
    return [];
  }

  // Take events from different positions to get variety
  const step = Math.max(1, Math.floor(events.length / count));
  const samples: any[] = [];

  for (let i = 0; i < Math.min(count, events.length); i++) {
    const index = Math.min(i * step, events.length - 1);
    samples.push(events[index]);
  }

  return samples;
}

// Detect schema using LLM
export async function detectSchemaWithLLM(events: any[]) {
  const samples = sampleEvents(events, 20);

  if (samples.length === 0) {
    return {
      fields: [],
      dataFormat: 'empty',
      notes: 'No events to analyze'
    };
  }

  const prompt = SCHEMA_DETECTION_PROMPT.replace(
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
        // Parse the accumulated response
        try {
          const jsonMatch = accumulated.match(/```json\s*([\s\S]*?)\s*```/);
          if (jsonMatch) {
            const schema = JSON.parse(jsonMatch[1]);
            resolve(schema);
          } else {
            // Try parsing the whole response as JSON
            const schema = JSON.parse(accumulated);
            resolve(schema);
          }
        } catch (error) {
          console.error('Error parsing schema detection response:', error);
          console.log('Raw response:', accumulated);
          reject(new Error('Failed to parse schema detection response'));
        }
      },
      (error) => {
        console.error('Error in schema detection:', error);
        reject(error);
      }
    );
  });
}

/**
 * Build field mapping from detected schema
 * Maps semantic roles to original field names
 * @returns { process_id: 'pid', start_time: 'ts', ... }
 */
export function buildFieldMapping(schema: any) {
  if (!schema || !schema.fields || schema.fields.length === 0) {
    return {};
  }

  const fieldMap: Record<string, string> = {};
  schema.fields.forEach((field: any) => {
    if (field.semantic && field.semantic !== 'unknown' && field.confidence > 0.5) {
      fieldMap[field.semantic] = field.originalName;
    }
  });

  return fieldMap;
}

/**
 * Get a value from an event using a field path
 * Handles nested paths like "Raw.pid" or "args.value"
 */
export function getFieldValue(event: any, fieldName: string) {
  if (!event || !fieldName) return undefined;

  // Handle nested paths
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

/**
 * Create a field mapping config for the chart to use
 * This tells the chart which original field names correspond to which semantic roles
 */
export function createFieldMappingConfig(schema: any) {
  const fieldMap = buildFieldMapping(schema);

  // Default mapping (for data that already uses standard names)
  const defaultMapping = {
    pid: 'pid',
    tid: 'tid',
    ppid: 'ppid',
    start: 'ts', // Most common: ts for start
    end: null, // Will be calculated if not present
    duration: 'dur', // Most common: dur for duration
    name: 'name',
    cat: 'cat',
    args: 'args',
    level: 'level',
    id: 'id'
  };

  // Override with detected fields
  return {
    pid: fieldMap.process_id || defaultMapping.pid,
    tid: fieldMap.thread_id || defaultMapping.tid,
    ppid: fieldMap.parent_id || defaultMapping.ppid,
    start: fieldMap.start_time || defaultMapping.start,
    end: fieldMap.end_time || defaultMapping.end,
    duration: fieldMap.duration || defaultMapping.duration,
    name: fieldMap.name || defaultMapping.name,
    cat: fieldMap.category || defaultMapping.cat,
    args: fieldMap.args || defaultMapping.args,
    level: fieldMap.level || defaultMapping.level,
    id: fieldMap.id || defaultMapping.id
  };
}

/**
 * Minimal event processing - preserves original fields AND adds internal fields for chart
 *
 * The output events have:
 * - All original fields preserved (ts, dur, name, cat, etc.)
 * - Standard internal fields added for chart rendering: start, end, pid, tid, ppid, level
 * - Config expressions can use original field names (event.ts) or internal names (event.start)
 */
export function processEventsMinimal(rawEvents: any[], fieldMapping: any) {
  if (!Array.isArray(rawEvents) || rawEvents.length === 0) {
    return [];
  }

  console.log('[DataAnalysisAgent] Processing events with field mapping:', fieldMapping);

  const events = rawEvents
    .map((ev) => {
      const raw = ev.Raw ?? ev.raw ?? ev;

      // Get start time using field mapping
      let startValue =
        getFieldValue(raw, fieldMapping.start) ??
        getFieldValue(ev, fieldMapping.start) ??
        ev.enter?.Timestamp ??
        ev.Timestamp;

      // Get end time or calculate from duration
      let endValue = fieldMapping.end
        ? (getFieldValue(raw, fieldMapping.end) ?? getFieldValue(ev, fieldMapping.end))
        : null;

      if (endValue === null || endValue === undefined) {
        const durValue =
          getFieldValue(raw, fieldMapping.duration) ??
          getFieldValue(ev, fieldMapping.duration) ??
          0;
        endValue = Number(startValue) + Number(durValue);
      }

      const start = Number(startValue);
      const end = Number(endValue);

      // Filter invalid events
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
        return null;
      }

      // Extract other fields using mapping
      const pid = String(
        getFieldValue(raw, fieldMapping.pid) ??
          getFieldValue(ev, fieldMapping.pid) ??
          ev.Location ??
          'unknown'
      );
      const tid = String(
        getFieldValue(raw, fieldMapping.tid) ?? getFieldValue(ev, fieldMapping.tid) ?? pid
      );
      const ppidRaw = getFieldValue(raw, fieldMapping.ppid) ?? getFieldValue(ev, fieldMapping.ppid);
      const ppid = ppidRaw === undefined || ppidRaw === null ? null : String(ppidRaw);

      const levelRaw =
        getFieldValue(raw, fieldMapping.level) ?? getFieldValue(ev, fieldMapping.level) ?? 0;
      const level = Number.isFinite(Number(levelRaw)) ? Number(levelRaw) : 0;

      const name =
        getFieldValue(raw, fieldMapping.name) ?? getFieldValue(ev, fieldMapping.name) ?? '';
      const cat = getFieldValue(raw, fieldMapping.cat) ?? getFieldValue(ev, fieldMapping.cat) ?? '';
      const args =
        getFieldValue(raw, fieldMapping.args) ?? getFieldValue(ev, fieldMapping.args) ?? {};
      const id = raw.id ?? ev.id ?? ev.GUID ?? ev.intervalId ?? null;

      // Return event with BOTH original fields AND internal fields for chart
      // Original fields come first (from spread), then internal fields are added/override
      return {
        ...raw, // Preserve all original fields
        ...ev, // Preserve wrapper fields if any
        // Internal fields for chart rendering (these are always present with consistent names)
        start,
        end,
        pid,
        tid,
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
  const minStart = events.length > 0 ? Math.min(...events.map((e: any) => e.start)) : 0;
  if (minStart > 1e12) {
    events.forEach((e: any) => {
      e.start -= minStart;
      e.end -= minStart;
      // Also adjust original time fields if they exist (to maintain consistency)
      if (typeof e.ts === 'number') e.ts -= minStart;
      if (typeof e.timestamp === 'number') e.timestamp -= minStart;
    });
  }

  events.sort((a: any, b: any) => a.start - b.start);
  return events;
}

// Helper: Convert field name to human-readable label
function humanize(fieldName: string) {
  if (!fieldName) return '';

  return fieldName
    .replace(/([A-Z])/g, ' $1')
    .replace(/[_-]/g, ' ')
    .trim()
    .split(' ')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

/**
 * Generate initial config based on detected schema
 * Uses ORIGINAL field names from the data (no normalization)
 */
export function generateInitialConfig(schema: any, fieldMapping: any) {
  if (!schema || !schema.fields) {
    return {};
  }

  const config: any = {};
  const fieldMap = buildFieldMapping(schema);

  // Color rule: prefer category, fallback to name - use ORIGINAL field names
  const catField = fieldMap.category || fieldMapping?.cat;
  const nameField = fieldMap.name || fieldMapping?.name;

  if (catField) {
    config.color = {
      keyRule: {
        type: 'expr',
        expr: { op: 'get', path: `event.${catField}` } // Original field name
      }
    };
  } else if (nameField) {
    config.color = {
      keyRule: {
        type: 'expr',
        expr: { op: 'get', path: `event.${nameField}` } // Original field name
      }
    };
  }

  // Process order: use forkTree if parent_id exists
  if (fieldMap.parent_id) {
    config.yAxis = {
      processOrderRule: {
        type: 'transform',
        name: 'forkTree',
        params: { includeUnspecified: true }
      }
    };
  }

  // Tooltip: use ORIGINAL field names
  const tooltipFields: any[] = [];

  // Build tooltip with original field names
  const tooltipConfig = [
    { semantic: 'name', label: 'Name' },
    { semantic: 'category', label: 'Category' },
    { semantic: 'start_time', label: 'Start', formatter: 'formatTimeUsFull' },
    { semantic: 'duration', label: 'Duration', formatter: 'formatDurationUs' },
    { semantic: 'thread_id', label: 'Thread' },
    { semantic: 'process_id', label: 'Process' }
  ];

  for (const item of tooltipConfig) {
    const originalFieldName = fieldMap[item.semantic];
    if (!originalFieldName) continue;

    let valueExpr: any;

    if (item.formatter === 'formatTimeUsFull') {
      valueExpr = {
        op: 'formatTimeUsFull',
        args: [{ op: 'get', path: `event.${originalFieldName}` }]
      };
    } else if (item.formatter === 'formatDurationUs') {
      valueExpr = {
        op: 'formatDurationUs',
        args: [{ op: 'get', path: `event.${originalFieldName}` }]
      };
    } else {
      valueExpr = { op: 'get', path: `event.${originalFieldName}` };
    }

    tooltipFields.push({
      label: item.label,
      value: valueExpr
    });
  }

  if (tooltipFields.length > 0) {
    config.tooltip = {
      event: {
        fields: tooltipFields
      }
    };
  }

  return config;
}

// Main entry point: Analyze and initialize
export async function analyzeAndInitialize(rawEvents: any[]) {
  console.log('Starting data analysis with LLM...');

  try {
    // 1. Detect schema using LLM
    const schema = await detectSchemaWithLLM(rawEvents);
    console.log('Schema detected:', schema);

    // 2. Create field mapping config (tells chart which fields are which)
    const fieldMapping = createFieldMappingConfig(schema);
    console.log('Field mapping created:', fieldMapping);

    // 3. Process events minimally - NO field renaming, just filter invalid and add internal fields
    const processedEvents = processEventsMinimal(rawEvents, fieldMapping);
    console.log(`Processed ${processedEvents.length} events (original field names preserved)`);

    // 4. Generate initial config using ORIGINAL field names
    const initialConfig = generateInitialConfig(schema, fieldMapping);
    console.log('Initial config generated:', initialConfig);

    return {
      events: processedEvents,
      config: initialConfig,
      schema,
      fieldMapping // Chart uses this to know which fields are start/end/etc.
    };
  } catch (error: any) {
    console.error('Error in data analysis:', error);

    // Fallback: process events with default field mapping
    const fallbackMapping = createFieldMappingConfig({ fields: [] });
    const processedEvents = processEventsMinimal(rawEvents, fallbackMapping);

    // Return processed events if analysis fails
    return {
      events: processedEvents,
      config: {},
      schema: {
        fields: [],
        dataFormat: 'analysis failed',
        notes: error.message
      },
      fieldMapping: fallbackMapping
    };
  }
}

// Export for testing
export const _test = {
  sampleEvents,
  humanize,
  buildFieldMapping,
  createFieldMappingConfig,
  processEventsMinimal,
  getFieldValue,
  generateInitialConfig
};

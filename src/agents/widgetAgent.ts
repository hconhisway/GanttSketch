import { summarizeWidgetConfig } from '../widgetConfig';
import { formatConfigSchemaForPrompt } from '../ganttConfigSchema';

export const WIDGET_AGENT_GUIDE = `You are a widget creation agent for the Gantt chart UI.
Your job is to create widgets that live in the top-left widget area, or update the widget layout/style.

Each widget has two parts:
1) HTML markup that defines the UI (no <script> tags).
2) JavaScript callback(s) that listen for UI changes and update the visualization.

## STRICT OUTPUT FORMAT (always JSON code block)
\`\`\`json
{
  "action": "create_widget",
  "widget": {
    "id": "kebab-case-id",
    "name": "Short Widget Title",
    "html": "<HTML_TEMPLATE>",
    "listeners": [
      {
        "selector": "<CSS_SELECTOR>",
        "event": "<EVENT_TYPE>",
        "handler": "<JS_HANDLER_TEMPLATE>"
      }
    ],
    "description": "Short explanation of what the widget does."
  }
}
\`\`\`

## HTML Templates (DynaVis-style compact inline)
IMPORTANT: Keep HTML minimal and compact. The widget "name" is already shown as a label, so avoid duplicating it in HTML.

**Dropdown/Select (no label - name serves as label):**
\`\`\`html
<select id="widget-id"><option value="val1">Option 1</option><option value="val2">Option 2</option></select>
\`\`\`

**Dropdown with inline label (when extra context needed):**
\`\`\`html
<select id="widget-id"><option value="" disabled>Choose...</option><option value="val1">Option 1</option></select>
\`\`\`

**Checkbox (compact inline):**
\`\`\`html
<input type="checkbox" id="widget-id" />
\`\`\`

**Range Slider (with value display):**
\`\`\`html
<input type="range" id="widget-id" min="0" max="100" value="50" /><span id="widget-id-val">50</span>
\`\`\`

**Button:**
\`\`\`html
<button type="button" id="widget-id">Action</button>
\`\`\`

**Text Input (use placeholder instead of label):**
\`\`\`html
<input type="text" id="widget-id" placeholder="Enter value..." />
\`\`\`

**Multiple controls (use spans for grouping):**
\`\`\`html
<button id="btn-a">A</button><button id="btn-b">B</button>
\`\`\`

## JavaScript Handler Templates
Handlers receive: (payload, api, widget)
- payload: { event, target, value, widgetRoot }
- api: chart control methods
- widget: the widget DOM container

**Apply Fixed Color (single color for all bars):**
\`\`\`javascript
api.setGanttConfig(api.applyGanttConfigPatch(api.getGanttConfig(), {
  color: { fixedColor: 'rgba(0,0,0,0.38)' }
}));
\`\`\`

**Reset to Default Colors:**
\`\`\`javascript
api.setGanttConfig(api.applyGanttConfigPatch(api.getGanttConfig(), {
  color: { fixedColor: null }
}));
\`\`\`

**Set Palette (array of color strings):**
\`\`\`javascript
api.setGanttConfig(api.applyGanttConfigPatch(api.getGanttConfig(), {
  color: { palette: ['#2563EB', '#0EA5E9', '#14B8A6', '#10B981'] }
}));
\`\`\`

**Set Color Key Rule (expression object, NOT string):**
\`\`\`javascript
api.setGanttConfig(api.applyGanttConfigPatch(api.getGanttConfig(), {
  color: { keyRule: { type: 'expr', expr: { op: 'get', path: 'event.cat' } } }
}));
\`\`\`

**Set Process Order:**
\`\`\`javascript
const mode = payload.value;
api.setProcessSortMode(mode);
const rule = mode === 'fork'
  ? { type: 'transform', name: 'forkTree', params: { includeUnspecified: true } }
  : { type: 'transform', name: 'pidAsc' };
api.setGanttConfig(api.applyGanttConfigPatch(api.getGanttConfig(), { yAxis: { processOrderRule: rule } }));
\`\`\`

**Toggle Between Two States:**
\`\`\`javascript
const isChecked = payload.target.checked;
if (isChecked) {
  // Apply state A
  api.setGanttConfig(api.applyGanttConfigPatch(api.getGanttConfig(), { color: { fixedColor: '#000' } }));
} else {
  // Apply state B (reset)
  api.setGanttConfig(api.applyGanttConfigPatch(api.getGanttConfig(), { color: { fixedColor: null } }));
}
\`\`\`

If the user intent is ambiguous, ask a clarifying question instead of guessing.`;

interface WidgetAgentDataContext {
  dataSchema?: any;
  fieldMapping?: Record<string, string>;
  eventFields?: string[];
  sampleEvents?: any[];
}

interface WidgetAgentChartContext {
  totalTracks?: number;
  trackNames?: string[];
  timeRange?: string;
  dataPointCount?: number;
  configSummary?: string;
}

function summarizeWidgets(widgets: any[]) {
  if (!Array.isArray(widgets) || widgets.length === 0) {
    return 'none';
  }
  return widgets.map((widget) => `${widget.id}: ${widget.name}`).join(', ');
}

function serializeWidgets(widgets: any[]) {
  if (!Array.isArray(widgets) || widgets.length === 0) {
    return '[]';
  }
  const safe = widgets.map((widget) => ({
    id: widget.id,
    name: widget.name,
    html: widget.html,
    listeners: widget.listeners,
    description: widget.description
  }));
  return JSON.stringify(safe, null, 2);
}

/**
 * Format data schema for the prompt
 */
function formatDataSchema(dataSchema: any) {
  if (!dataSchema) return 'Not available';

  const lines = ['Fields in the data:'];

  if (dataSchema.pid) lines.push(`- pid: ${dataSchema.pid} (process ID field)`);
  if (dataSchema.tid) lines.push(`- tid: ${dataSchema.tid} (thread ID field)`);
  if (dataSchema.ppid) lines.push(`- ppid: ${dataSchema.ppid} (parent process ID)`);
  if (dataSchema.name) lines.push(`- name: ${dataSchema.name} (event name field)`);
  if (dataSchema.cat) lines.push(`- cat: ${dataSchema.cat} (category field)`);
  if (dataSchema.ts) lines.push(`- ts: ${dataSchema.ts} (timestamp field)`);
  if (dataSchema.dur) lines.push(`- dur: ${dataSchema.dur} (duration field)`);
  if (dataSchema.ph) lines.push(`- ph: ${dataSchema.ph} (phase field)`);
  if (dataSchema.args) lines.push(`- args: ${dataSchema.args} (arguments/metadata)`);

  return lines.join('\n');
}

/**
 * Format field mapping for the prompt
 */
function formatFieldMapping(fieldMapping: Record<string, string> | undefined) {
  if (!fieldMapping) return 'Not available';

  const lines = ['Field Mappings (raw field → normalized field):'];
  for (const [normalized, raw] of Object.entries(fieldMapping)) {
    if (raw) lines.push(`- ${raw} → ${normalized}`);
  }
  return lines.join('\n');
}

/**
 * Format event fields for the prompt
 */
function formatEventFields(eventFields: string[] | undefined) {
  if (!Array.isArray(eventFields) || eventFields.length === 0) {
    return 'Not available';
  }

  // Group by top-level field
  const grouped: Record<string, string[]> = {};
  for (const field of eventFields) {
    const parts = field.split('.');
    const topLevel = parts[0];
    if (!grouped[topLevel]) grouped[topLevel] = [];
    grouped[topLevel].push(field);
  }

  const lines = ['Available event fields:'];
  for (const [group, fields] of Object.entries(grouped)) {
    if (fields.length === 1 && fields[0] === group) {
      lines.push(`- ${group}`);
    } else {
      lines.push(`- ${group}: ${fields.join(', ')}`);
    }
  }
  return lines.join('\n');
}

/**
 * Format sample events for the prompt
 */
function formatSampleEvents(sampleEvents: any[] | undefined) {
  if (!Array.isArray(sampleEvents) || sampleEvents.length === 0) {
    return 'No samples available';
  }

  // Take up to 3 samples, trim to essential fields
  const samples = sampleEvents.slice(0, 3).map((event) => {
    const trimmed: any = {
      pid: event.pid,
      tid: event.tid,
      name: event.name,
      cat: event.cat
    };
    // Include args if present and not too large
    if (event.args && Object.keys(event.args).length > 0 && Object.keys(event.args).length <= 5) {
      trimmed.args = event.args;
    }
    return trimmed;
  });

  return JSON.stringify(samples, null, 2);
}

/**
 * Get unique categories from sample events
 */
function getUniqueCategories(sampleEvents: any[] | undefined) {
  if (!Array.isArray(sampleEvents) || sampleEvents.length === 0) {
    return 'Not available';
  }

  const categories = new Set<string>();
  for (const event of sampleEvents) {
    if (event.cat) categories.add(event.cat);
  }

  const catArray = Array.from(categories).slice(0, 10);
  if (categories.size > 10) {
    return catArray.join(', ') + ` ... (${categories.size} total)`;
  }
  return catArray.join(', ') || 'none';
}

/**
 * Get unique event names from sample events
 */
function getUniqueEventNames(sampleEvents: any[] | undefined) {
  if (!Array.isArray(sampleEvents) || sampleEvents.length === 0) {
    return 'Not available';
  }

  const names = new Set<string>();
  for (const event of sampleEvents) {
    if (event.name) names.add(event.name);
  }

  const nameArray = Array.from(names).slice(0, 10);
  if (names.size > 10) {
    return nameArray.join(', ') + ` ... (${names.size} total)`;
  }
  return nameArray.join(', ') || 'none';
}

/**
 * Build the widget system prompt with data context
 */
export function getWidgetSystemPrompt(
  chartContext: WidgetAgentChartContext,
  widgetConfig: any,
  widgets: any[],
  dataContext: WidgetAgentDataContext = {}
) {
  const { dataSchema, fieldMapping, eventFields, sampleEvents } = dataContext;
  const trackNames = Array.isArray(chartContext.trackNames) ? chartContext.trackNames : [];

  // Data summary section
  const dataSummary = `

## Data Summary
This data helps you understand what fields are available for filtering, coloring, and display.

### Schema
${formatDataSchema(dataSchema)}

### Field Mapping
${formatFieldMapping(fieldMapping)}

### Available Event Fields
${formatEventFields(eventFields)}

### Categories in Data
${getUniqueCategories(sampleEvents)}

### Event Names in Data
${getUniqueEventNames(sampleEvents)}

### Sample Events (normalized)
\`\`\`json
${formatSampleEvents(sampleEvents)}
\`\`\`
`;

  const contextInfo = `

## Current Chart Context

- Total tracks: ${chartContext.totalTracks || 'unknown'}
- Track names: ${trackNames.slice(0, 10).join(', ') || 'loading...'}${trackNames.length > 10 ? '...' : ''}
- Time range: ${chartContext.timeRange || 'unknown'}
- Data points: ${chartContext.dataPointCount || 'unknown'}
- Current gantt config: ${chartContext.configSummary || 'unknown'}

## Current Widget Config
- ${summarizeWidgetConfig(widgetConfig)}

## Current Widgets
- ${summarizeWidgets(widgets)}

## Current Widgets Sheet (JSON)
${serializeWidgets(widgets)}
`;

  // Build full prompt: Guide + Schema Reference + Data Summary + Current Context
  return WIDGET_AGENT_GUIDE + '\n\n' + formatConfigSchemaForPrompt() + dataSummary + contextInfo;
}

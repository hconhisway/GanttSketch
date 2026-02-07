import { WIDGET_AGENT_GUIDE, summarizeWidgetConfig } from './widgetConfig';
import { formatConfigSchemaForPrompt, formatWidgetApiForPrompt } from './ganttConfigSchema';

function summarizeWidgets(widgets) {
  if (!Array.isArray(widgets) || widgets.length === 0) {
    return 'none';
  }
  return widgets
    .map(widget => `${widget.id}: ${widget.name}`)
    .join(', ');
}

function serializeWidgets(widgets) {
  if (!Array.isArray(widgets) || widgets.length === 0) {
    return '[]';
  }
  const safe = widgets.map(widget => ({
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
 * @param {Object} dataSchema - The detected data schema
 * @returns {string}
 */
function formatDataSchema(dataSchema) {
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
 * @param {Object} fieldMapping - The field mapping configuration
 * @returns {string}
 */
function formatFieldMapping(fieldMapping) {
  if (!fieldMapping) return 'Not available';
  
  const lines = ['Field Mappings (raw field → normalized field):'];
  for (const [normalized, raw] of Object.entries(fieldMapping)) {
    if (raw) lines.push(`- ${raw} → ${normalized}`);
  }
  return lines.join('\n');
}

/**
 * Format event fields for the prompt
 * @param {Array} eventFields - Array of field paths in events
 * @returns {string}
 */
function formatEventFields(eventFields) {
  if (!Array.isArray(eventFields) || eventFields.length === 0) {
    return 'Not available';
  }
  
  // Group by top-level field
  const grouped = {};
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
 * @param {Array} sampleEvents - Array of sample normalized events
 * @returns {string}
 */
function formatSampleEvents(sampleEvents) {
  if (!Array.isArray(sampleEvents) || sampleEvents.length === 0) {
    return 'No samples available';
  }
  
  // Take up to 3 samples, trim to essential fields
  const samples = sampleEvents.slice(0, 3).map(event => {
    const trimmed = {
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
 * @param {Array} sampleEvents 
 * @returns {string}
 */
function getUniqueCategories(sampleEvents) {
  if (!Array.isArray(sampleEvents) || sampleEvents.length === 0) {
    return 'Not available';
  }
  
  const categories = new Set();
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
 * @param {Array} sampleEvents 
 * @returns {string}
 */
function getUniqueEventNames(sampleEvents) {
  if (!Array.isArray(sampleEvents) || sampleEvents.length === 0) {
    return 'Not available';
  }
  
  const names = new Set();
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
 * 
 * @param {Object} chartContext - Basic chart context info
 * @param {Object} widgetConfig - Current widget config
 * @param {Array} widgets - Current widgets
 * @param {Object} dataContext - Data context from the system
 * @param {Object} dataContext.dataSchema - Detected schema
 * @param {Object} dataContext.fieldMapping - Field mapping config
 * @param {Array} dataContext.eventFields - Available field paths
 * @param {Array} dataContext.sampleEvents - Sample normalized events
 * @returns {string}
 */
export function getWidgetSystemPrompt(chartContext, widgetConfig, widgets, dataContext = {}) {
  const { dataSchema, fieldMapping, eventFields, sampleEvents } = dataContext;
  
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
- Track names: ${chartContext.trackNames?.slice(0, 10).join(', ') || 'loading...'}${chartContext.trackNames?.length > 10 ? '...' : ''}
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

import { CONFIG_INDEX, formatConfigIndexForPrompt, findMatchingConfigs } from './configIndex';
import ganttConfigSpec from '../config/GANTT_CONFIG_SPEC.json';

/**
 * Config Agent
 *
 * Handles user configuration modification requests with semantic understanding.
 * Uses the comprehensive Config Index and current data schema for context.
 */

// Build Rule DSL reference from spec
function buildRuleDslReference() {
  if (!ganttConfigSpec.ruleDsl) {
    return 'No rule DSL information available.';
  }

  const dsl = ganttConfigSpec.ruleDsl;
  const sections: string[] = [];

  // Expression operations
  if (dsl.exprOps && dsl.exprOps.length > 0) {
    sections.push(`Expression operations: ${dsl.exprOps.join(', ')}`);
  }

  // Transform names
  if (dsl.transformNames && dsl.transformNames.length > 0) {
    sections.push(`Transform types: ${dsl.transformNames.join(', ')}`);
  }

  // Context variables
  if (dsl.context) {
    const contextLines = Object.entries(dsl.context).map(([key, desc]) => `  - ${key}: ${desc}`);
    sections.push(`Context variables:\n${contextLines.join('\n')}`);
  }

  return sections.join('\n\n');
}

export interface ConfigAgentOptions {
  schema?: any;
  eventFields?: string[];
  sampleEvents?: any[];
  currentConfig?: any;
  dataMapping?: any;
  activeConfigItem?: {
    path: string;
    label: string;
    description?: string;
    currentValue?: any;
    example?: string;
  } | null;
  fieldMapping?: Record<string, string>;
}

function isDynamicHierarchyPath(path: string): boolean {
  if (!path || typeof path !== 'string') return false;
  return (
    /^yAxis\.hierarchy\d+(Field|OrderRule|LaneRule|LabelRule)$/.test(path) ||
    /^performance\.hierarchy\d+LOD\.(pixelWindow|mergeUtilGap)$/.test(path) ||
    /^performance\.hierarchy\d+LOD$/.test(path)
  );
}

/**
 * Build the system prompt dynamically - NO static placeholders, all real data
 */
export function buildConfigAgentPrompt(options: ConfigAgentOptions) {
  const { schema, eventFields, sampleEvents, currentConfig, dataMapping, activeConfigItem, fieldMapping } =
    options;

  // Schema info - show original detected fields
  const schemaStr =
    schema && schema.fields
      ? JSON.stringify(
          {
            detectedFields: schema.fields.map((f: any) => ({
              originalName: f.originalName,
              semantic: f.semantic,
              type: f.type
            })),
            fieldMapping: fieldMapping || {},
            format: schema.dataFormat,
            note: 'Events have BOTH original fields AND standard internal fields (start, end, hierarchy1, hierarchy2, etc.)'
          },
          null,
          2
        )
      : 'No schema information available';

  // Format current config
  const configStr = currentConfig ? JSON.stringify(currentConfig, null, 2) : '{}';

  // Format current data mapping (compact to keep prompts small)
  const mappingStr = dataMapping
    ? JSON.stringify(
        {
          xAxis: dataMapping?.xAxis,
          yAxis: dataMapping?.yAxis,
          identity: dataMapping?.identity,
          color: dataMapping?.color,
          barLabel: dataMapping?.barLabel,
          tooltip: {
            ...dataMapping?.tooltip,
            fields: Array.isArray(dataMapping?.tooltip?.fields)
              ? dataMapping.tooltip.fields.slice(0, 14)
              : dataMapping?.tooltip?.fields
          },
          features: dataMapping?.features,
          schema: dataMapping?.schema
            ? {
                dataFormat: dataMapping.schema.dataFormat,
                notes: dataMapping.schema.notes
              }
            : undefined
        },
        null,
        2
      )
    : 'No data mapping loaded.';

  // Format event fields - ONLY from real data, NO hardcoded fields
  const fieldsArray = Array.isArray(eventFields) ? eventFields : [];
  const eventFieldsStr =
    fieldsArray.length > 0
      ? fieldsArray.map((f) => `event.${f}`).join(', ')
      : 'No event fields detected';

  // Format sample events - show real data to the LLM
  const sampleStr =
    Array.isArray(sampleEvents) && sampleEvents.length > 0
      ? JSON.stringify(sampleEvents.slice(0, 3), null, 2)
      : 'No sample events available';

  // Format active config target
  const activeTargetStr = activeConfigItem
    ? [
        `Path: ${activeConfigItem.path}`,
        `Label: ${activeConfigItem.label}`,
        `Description: ${activeConfigItem.description || 'n/a'}`,
        `Current value (JSON): ${JSON.stringify(activeConfigItem.currentValue ?? null)}`,
        `Example: ${activeConfigItem.example || 'n/a'}`,
        'Only update this path. If the user asks for changes outside this path, ask them to select the correct config button.'
      ].join('\n')
    : 'None';

  // Build prompt using template literal - direct string, no placeholders
  const prompt = `You are a Gantt chart configuration assistant.

## Data Schema (detected from loaded data)
${schemaStr}

## Available Event Fields
All fields available on each event:
${eventFieldsStr}

Sample events from the actual data:
${sampleStr}

IMPORTANT: Use the field names EXACTLY as shown in the sample events above.
When writing { "op": "get", "path": "event.XXX" }, XXX must be one of the field names from the sample.

## Available Configuration Items
${formatConfigIndexForPrompt()}

## Current Configuration
${configStr}

## Current Data Mapping (controls hierarchy/time/identity fields)
${mappingStr}

Dependency edges are enabled by dataMapping.features.dependencyLines and sourced from
dataMapping.features.dependencyField. Visual behavior for dependency edges lives under
ganttConfig.dependencies.*.

## Active Config Target (optional)
${activeTargetStr}

## Rule DSL Reference
${buildRuleDslReference()}

Common expression patterns:
- Get field: { "op": "get", "path": "event.FIELDNAME" } - use actual field names from the list above
- Get variable: { "op": "var", "name": "varName" } (hierarchy1, hierarchy2, level, startUs, durationUs, etc.)
- Coalesce: { "op": "coalesce", "args": [expr1, expr2, ...] }
- Concatenate: { "op": "concat", "args": ["string", expr, ...] }
- Conditional: { "op": "if", "args": [condition, thenValue, elseValue] }
- Comparisons: { "op": "==", "args": [left, right] } (also: !=, >, <, >=, <=)
- Logic: { "op": "and", "args": [expr1, expr2] } (also: or, not)
- Math: { "op": "add", "args": [expr1, expr2] } (also: sub, mul, div)
- Hash color: { "op": "paletteHash", "args": [keyExpr, paletteVar] }
- Format time: { "op": "formatTimeUs", "args": [timeExpr] }
- Format duration: { "op": "formatDurationUs", "args": [durationExpr] }

Common transform patterns:
- Fork tree: { "type": "transform", "name": "forkTree", "params": { "includeUnspecified": true } }
- Sort by: { "type": "transform", "name": "sortBy", "params": { "key": "stats.totalDurUs", "desc": true } }
- Auto pack: { "type": "transform", "name": "autoPack" }
- By field (any attribute): { "type": "transform", "name": "byField", "params": { "field": "eventAttrPath" } }
- Hierarchy display mode: { "yAxis": { "hierarchyDisplayMode": "nested" } } to show expanded hierarchies as vertically nested rectangles instead of separate rows. Use "rows" for the default row-based mode.
- Nested hierarchy layout tuning: { "layout": { "nestedRowHeight": 36, "nestedLevelInset": 3 } } where inset applies only on the Y axis; the time axis remains faithful to the data.
- Per-level hierarchy aggregation: { "yAxis": { "hierarchy3AggregationRule": { "type": "mergeGap", "mergeGapRatio": 0.002 } } } to control how a hierarchy level rolls child events into parent segments. In "rows" mode, expanded parents stay visible above children; in "nested" mode, the parent container stays visible and children render inside it.
- Dynamic hierarchy paths are allowed even when not listed statically:
  - yAxis.hierarchyNField
  - yAxis.hierarchyNLabelRule
  - yAxis.hierarchyNLaneRule
  - yAxis.hierarchyNAggregationRule
  - performance.hierarchyNLOD.pixelWindow
  - performance.hierarchyNLOD.mergeUtilGap

## Task
Based on the user's request, output EITHER a Gantt config patch OR a data mapping patch.

### When to update Data Mapping vs Gantt Config
- Use **update_data_mapping** when the user is changing how raw data fields map to the chart (time fields, hierarchy fields/levels, identity fields like name/category/id, etc.).
  - To add/replace hierarchy levels, update: yAxis.hierarchyFields (outermost to innermost). The app will normalize features.hierarchyLevels and features.hierarchyFields automatically.
- Use **update_gantt_config** when the user is changing visual rules/styling (ordering rules, lane packing, label rules, tooltip formatting rules, colors, layout, performance knobs, dependency edge display).

IMPORTANT:
1. Only modify the specific config items relevant to the request
2. Use the correct path from the Available Configuration Items
3. For rule-type configs, use the Rule DSL format exactly as shown above
4. Keep patches minimal and focused
5. CRITICAL: For event field paths, use ONLY the fields listed in "Available Event Fields" above
6. If an Active Config Target is provided, you MUST ONLY update that path
7. Output ONLY a single JSON block. Do NOT include any extra text

Output formats (choose ONE):

### A) Update Data Mapping
\`\`\`json
{
  "action": "update_data_mapping",
  "patch": { ... },
  "explanation": "Brief explanation of what this change does"
}
\`\`\`

### B) Update Gantt Config
\`\`\`json
{
  "action": "update_gantt_config",
  "patch": {
    "section": {
      "configItem": value
    }
  },
  "targetPath": "the.config.path.being.modified",
  "explanation": "Brief explanation of what this change does"
}
\`\`\`

If the user's request is ambiguous or you need more information, output:
\`\`\`json
{
  "action": "clarification_needed",
  "question": "What specific aspect would you like to configure?",
  "suggestions": ["suggestion1", "suggestion2"]
}
\`\`\`

Return ONLY the JSON block above. No commentary.`;

  return prompt;
}

// Pre-process user message to find likely config targets
export function preprocessUserMessage(message: string) {
  const matches = findMatchingConfigs(message, 5);

  return {
    originalMessage: message,
    likelyTargets: matches.map((m) => ({
      path: m.path,
      score: m.score,
      description: m.config.description
    })),
    hints:
      matches.length > 0
        ? `Likely config targets: ${matches.map((m) => m.path).join(', ')}`
        : 'No clear config target identified'
  };
}

// Validate config patch against schema
export function validatePatch(patch: any, schema: any) {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!patch || typeof patch !== 'object') {
    errors.push('Patch must be an object');
    return { valid: false, errors, warnings };
  }

  // Recursively check paths
  function checkPath(obj: any, currentPath = '') {
    for (const [key, value] of Object.entries(obj)) {
      const fullPath = currentPath ? `${currentPath}.${key}` : key;

      // Check if path exists in CONFIG_INDEX
      const configItem = (CONFIG_INDEX as any)[fullPath];
      const dynamicHierarchy = isDynamicHierarchyPath(fullPath);

      if (configItem || dynamicHierarchy) {
        // Validate against schema
        if (configItem?.kind === 'rule' || /Rule$/.test(fullPath)) {
          if (typeof value !== 'object' || !(value as any).type) {
            warnings.push(`${fullPath}: Expected a rule object with 'type' field`);
          }
        }

        if (configItem?.schema) {
          // Type checking
          const schemaType = configItem.schema.type;
          if (schemaType === 'number' && typeof value !== 'number') {
            warnings.push(`${fullPath}: Expected number, got ${typeof value}`);
          } else if (schemaType === 'boolean' && typeof value !== 'boolean') {
            warnings.push(`${fullPath}: Expected boolean, got ${typeof value}`);
          } else if (schemaType === 'string' && typeof value !== 'string') {
            warnings.push(`${fullPath}: Expected string, got ${typeof value}`);
          } else if (schemaType === 'array' && !Array.isArray(value)) {
            warnings.push(`${fullPath}: Expected array, got ${typeof value}`);
          } else if (
            schemaType === 'object' &&
            (typeof value !== 'object' || Array.isArray(value))
          ) {
            warnings.push(`${fullPath}: Expected object, got ${typeof value}`);
          }
        }
      } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        // Recurse into nested objects
        checkPath(value, fullPath);
      }
    }
  }

  checkPath(patch);

  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}

// Extract target path from patch
export function extractTargetPath(patch: any) {
  if (!patch || typeof patch !== 'object') return null;

  // Try to find the deepest path that exists in CONFIG_INDEX
  const paths: string[] = [];

  function collectPaths(obj: any, currentPath = '') {
    for (const [key, value] of Object.entries(obj)) {
      const fullPath = currentPath ? `${currentPath}.${key}` : key;

      if ((CONFIG_INDEX as any)[fullPath] || isDynamicHierarchyPath(fullPath)) {
        paths.push(fullPath);
      }

      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        collectPaths(value, fullPath);
      }
    }
  }

  collectPaths(patch);

  // Return the deepest path (longest path string)
  if (paths.length === 0) return null;

  return paths.sort((a, b) => b.split('.').length - a.split('.').length)[0];
}

// Build enhanced system prompt for chat
export function buildSystemPrompt(chartContext: any) {
  const prompt = buildConfigAgentPrompt({
    schema: chartContext.schema,
    eventFields: chartContext.eventFields,
    sampleEvents: chartContext.sampleEvents,
    currentConfig: chartContext.currentConfig,
    dataMapping: chartContext.dataMapping,
    activeConfigItem: chartContext.activeConfigItem,
    fieldMapping: chartContext.fieldMapping
  });

  // Debug: log what fields are in the prompt
  console.log('[Config Agent] Building prompt with:');
  console.log('  - eventFields:', chartContext.eventFields);
  console.log('  - sampleEvents count:', chartContext.sampleEvents?.length || 0);
  console.log('  - fieldMapping:', chartContext.fieldMapping);

  return prompt;
}

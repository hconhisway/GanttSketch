import { GANTT_AGENT_GUIDE } from './ganttConfig';

/**
 * Gantt Configuration System Prompt
 *
 * This module provides specialized prompts for the LLM to update the gantt config
 * and (optionally) legacy track configuration outputs.
 */
export const TRACKS_CONFIG_SYSTEM_PROMPT = `${GANTT_AGENT_GUIDE}

## Legacy Track Configuration (optional)
If the user explicitly asks to filter, sort, or group tracks for a one-off view,
you may respond with the legacy format:

\`\`\`json
{
  "action": "configure_tracks",
  "config": {
    "sortMode": "asc" | "desc" | "custom" | "grouped",
    "filter": {
      "type": "range" | "list" | "pattern" | "function",
      "value": <depends on type>
    },
    "groups": [
      {
        "name": "Group Name",
        "tracks": ["track1", "track2"],
        "order": 0
      }
    ],
    "description": "Brief explanation of what this configuration does"
  }
}
\`\`\`

Use the legacy format only when the user specifically asks for track filtering
or grouping, not for general chart configuration.`;

export const PREDEFINED_FILTER_FUNCTIONS = {
  numeric_only: (track) => !isNaN(parseFloat(track)),
  even_only: (track) => {
    const num = parseFloat(track);
    return !isNaN(num) && num % 2 === 0;
  },
  odd_only: (track) => {
    const num = parseFloat(track);
    return !isNaN(num) && num % 2 === 1;
  },
  // This will be handled specially in the application logic
  top_n_utilization: null
};

/**
 * Parse LLM response and extract configuration if present
 * @param {string} responseText - The full text response from LLM
 * @returns {Object|null} - Parsed configuration or null if not a config response
 */
export function parseTrackConfigFromResponse(responseText) {
  try {
    const text = String(responseText ?? '').trim();

    const tryParse = (raw) => {
      if (!raw) return null;
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    };

    // Look for JSON code blocks first
    const jsonBlockRegex = /```json\s*([\s\S]*?)\s*```/;
    const match = text.match(jsonBlockRegex);
    let parsed = null;

    if (match) {
      parsed = tryParse(match[1]);
    }

    // If no JSON block, try to parse the entire response as JSON
    if (!parsed && (text.startsWith('{') || text.startsWith('['))) {
      parsed = tryParse(text);
    }

    // Fallback: try to extract the first JSON object from the response
    if (!parsed) {
      const objectMatch = text.match(/\{[\s\S]*\}/);
      if (objectMatch) {
        parsed = tryParse(objectMatch[0]);
      }
    }

    if (!parsed) {
      return null;
    }

    if (parsed.action === 'configure_tracks' && parsed.config) {
      return parsed;
    }

    if (parsed.action === 'update_gantt_config' && parsed.patch) {
      return parsed;
    }

    if (parsed.action === 'create_widget' && parsed.widget) {
      return parsed;
    }

    if (parsed.action === 'update_widget_config' && parsed.patch) {
      return parsed;
    }

    if (parsed.action === 'clarification_needed') {
      return parsed;
    }

    return null;
  } catch (error) {
    console.error('Error parsing track config from LLM response:', error);
    return null;
  }
}

/**
 * Convert LLM configuration to internal tracksConfig format
 * @param {Object} llmConfig - Configuration from LLM
 * @param {Array} data - Current chart data
 * @returns {Object|null} - Internal tracksConfig object or null if not applicable
 */
export function convertLLMConfigToTracksConfig(llmConfig, data) {
  if (!llmConfig || llmConfig.action !== 'configure_tracks') return null;
  const config = llmConfig.config;
  const result = {
    sortMode: config.sortMode || 'asc',
    customSort: null,
    groups: null,
    filter: null,
    trackList: null
  };

  // Handle filtering
  if (config.filter) {
    const filterDef = config.filter;

    switch (filterDef.type) {
      case 'range':
        result.filter = (track) => {
          const num = parseFloat(track);
          if (isNaN(num)) return false;
          return num >= filterDef.value.min && num <= filterDef.value.max;
        };
        break;

      case 'list':
        result.trackList = filterDef.value;
        break;

      case 'pattern':
        {
          const regex = new RegExp(filterDef.value);
          result.filter = (track) => regex.test(track.toString());
        }
        break;

      case 'function':
        {
          const funcName = filterDef.value;
          if (funcName === 'top_n_utilization') {
            // Special handling for top N by utilization
            const n = filterDef.params?.n || 5;
            const trackStats = {};

            data.forEach((d) => {
              if (!trackStats[d.track]) {
                trackStats[d.track] = { sum: 0, count: 0 };
              }
              trackStats[d.track].sum += d.utilValue;
              trackStats[d.track].count++;
            });

            const trackAverages = Object.keys(trackStats).map((track) => ({
              track,
              avg: trackStats[track].sum / trackStats[track].count
            }));

            trackAverages.sort((a, b) => b.avg - a.avg);
            result.trackList = trackAverages.slice(0, n).map((t) => t.track);
          } else if (PREDEFINED_FILTER_FUNCTIONS[funcName]) {
            result.filter = PREDEFINED_FILTER_FUNCTIONS[funcName];
          }
        }
        break;
      default:
        break;
    }
  }

  // Handle grouping
  if (config.groups && Array.isArray(config.groups)) {
    result.sortMode = 'grouped';
    result.groups = config.groups;
  }

  return result;
}

/**
 * Get the enhanced system prompt for gantt configuration
 * @param {Object} chartContext - Current chart context
 * @returns {string} - Complete system prompt
 */
export function getEnhancedSystemPrompt(chartContext) {
  const basePrompt = TRACKS_CONFIG_SYSTEM_PROMPT;

  const contextInfo = chartContext.activeConfigItem
    ? `

## Current Chart Context

- Current config: ${chartContext.configSummary || 'unknown'}
`
    : `

## Current Chart Context

- Total tracks: ${chartContext.totalTracks || 'unknown'}
- Track names: ${chartContext.trackNames?.slice(0, 10).join(', ') || 'loading...'}${chartContext.trackNames?.length > 10 ? '...' : ''}
- Time range: ${chartContext.timeRange || 'unknown'}
- Data points: ${chartContext.dataPointCount || 'unknown'}
- Current config: ${chartContext.configSummary || 'unknown'}
`;

  const activeItem = chartContext.activeConfigItem;
  const activeInfo = activeItem
    ? `

## Active Config Target (STRICT)

You MUST ONLY update this path:
- Path: ${activeItem.path}
- Label: ${activeItem.label}
- Description: ${activeItem.description || 'n/a'}
- Current value (JSON): ${JSON.stringify(activeItem.currentValue ?? null)}
- Example: ${activeItem.example || 'n/a'}

If the user asks for changes outside this path, ask them to select the correct config button.
Only emit a patch that updates the active path.
Do not output configure_tracks or widget actions while a target is active.
`
    : '';

  return basePrompt + contextInfo + activeInfo;
}

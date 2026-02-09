/**
 * Agent System Entry Point
 *
 * Exports all agents and utilities for the Gantt chart configuration system.
 */

// Data Analysis Agent (v2 – universal mapping)
export {
  analyzeAndInitialize,
  detectDataMappingWithLLM,
  generateInitialConfig,
  createDefaultMapping,
  dataMappingToFlatFieldMapping,
  dataMappingToLegacySchema,
  processEventsMinimal,
  getFieldValue,
  getTimeMultiplier,
  DATA_MAPPING_PROMPT
} from './dataAnalysisAgent';

// Config Agent
export {
  buildConfigAgentPrompt,
  preprocessUserMessage,
  validatePatch,
  extractTargetPath,
  buildSystemPrompt
} from './configAgent';

// Config Index
export {
  CONFIG_INDEX,
  findMatchingConfigs,
  formatConfigIndexForPrompt,
  getConfigInfo,
  getConfigPathsBySection,
  getConfigById
} from './configIndex';

// Widget Agent
export { WIDGET_AGENT_GUIDE, getWidgetSystemPrompt } from './widgetAgent';

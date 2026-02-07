/**
 * Agent System Entry Point
 * 
 * Exports all agents and utilities for the Gantt chart configuration system.
 */

// Data Analysis Agent
export {
  analyzeAndInitialize,
  detectSchemaWithLLM,
  generateInitialConfig,
  buildFieldMapping,
  createFieldMappingConfig,
  processEventsMinimal,
  getFieldValue,
  SCHEMA_DETECTION_PROMPT
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

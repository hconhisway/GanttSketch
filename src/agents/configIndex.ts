import ganttConfigSpec from '../config/GANTT_CONFIG_SPEC.json';
import { ConfigSpec } from '../types/ganttConfig';

/**
 * Config Index - Semantic metadata for all config items
 * Auto-generated from GANTT_CONFIG_SPEC.json with added semantic richness
 */

// Extract keywords from path, description, and schema
function extractKeywords(entry: any) {
  const words = new Set<string>();

  // From path: "yAxis.hierarchy1OrderRule" -> ["yaxis", "hierarchy1", "order", "rule"]
  entry.path.split('.').forEach((segment: string) => {
    // Split camelCase
    const parts = segment.split(/(?=[A-Z])/);
    parts.forEach((w) => {
      if (w) words.add(w.toLowerCase());
    });
  });

  // From description
  if (entry.description) {
    entry.description.split(/\W+/).forEach((w: string) => {
      if (w.length > 2) words.add(w.toLowerCase());
    });
  }

  // From ID
  if (entry.id) {
    entry.id.split(/[._-]/).forEach((w: string) => {
      if (w.length > 2) words.add(w.toLowerCase());
    });
  }

  return Array.from(words);
}

// Infer related concepts based on config type
function inferRelatedConcepts(entry: any) {
  const concepts: string[] = [];
  const path = entry.path.toLowerCase();
  const desc = (entry.description || '').toLowerCase();

  if (path.includes('color') || desc.includes('color')) {
    concepts.push('coloring', 'palette', 'hue', 'tint', 'shade', 'colorize', 'colorscheme');
  }
  if (
    path.includes('order') ||
    path.includes('sort') ||
    desc.includes('order') ||
    desc.includes('sort')
  ) {
    concepts.push('sorting', 'arrangement', 'sequence', 'organize', 'arrange');
  }
  if (path.includes('label') || desc.includes('label')) {
    concepts.push('text', 'display', 'naming', 'caption', 'title');
  }
  if (path.includes('tooltip') || desc.includes('tooltip')) {
    concepts.push('hover', 'popup', 'info', 'details', 'hint', 'mouseover');
  }
  if (path.includes('layout') || desc.includes('layout')) {
    concepts.push('size', 'spacing', 'margin', 'padding', 'dimensions');
  }
  if (path.includes('lane') || desc.includes('lane')) {
    concepts.push('row', 'track', 'swimlane', 'thread', 'level');
  }
  if (path.includes('axis') || desc.includes('axis')) {
    concepts.push('y-axis', 'x-axis', 'scale', 'axis');
  }
  if (path.includes('dependenc') || desc.includes('dependenc') || desc.includes('edge')) {
    concepts.push(
      'dependency',
      'dependencies',
      'edge',
      'arrow',
      'connection',
      'link',
      'flow',
      'predecessor',
      'successor',
      'children',
      'parent'
    );
  }
  if (path.includes('hierarchy1') || path.includes('process') || desc.includes('process')) {
    concepts.push('processes', 'pid', 'proc', 'hierarchy1', 'root');
  }
  if (path.includes('hierarchy2') || path.includes('thread') || desc.includes('thread')) {
    concepts.push('threads', 'tid', 'threading', 'hierarchy2');
  }
  if (/hierarchy\d+/.test(path) || path.includes('hierarchydisplay')) {
    concepts.push('hierarchy', 'nested', 'level', 'subgroup');
  }
  if (path.includes('hierarchydisplay') || desc.includes('nested rectangles')) {
    concepts.push(
      'nested rectangles',
      'stacked',
      'overlapping',
      'inline',
      'display mode',
      'rows'
    );
  }
  if (path.includes('aggregation') || desc.includes('aggregate') || desc.includes('parent segments')) {
    concepts.push('aggregation', 'aggregate', 'rollup', 'parent segments', 'merge gap');
  }
  if (path.includes('height') || path.includes('width')) {
    concepts.push('size', 'dimension');
  }
  if (path.includes('margin') || path.includes('padding') || path.includes('gap')) {
    concepts.push('spacing', 'whitespace');
  }

  return concepts;
}

// Common operations for each config type
function inferCommonOperations(entry: any) {
  const ops: string[] = [];
  const schemaType = entry.schema?.type;

  if (entry.kind === 'rule') {
    if (schemaType === 'transform' || entry.schema?.names) {
      ops.push('sort by', 'order by', 'group by', 'arrange', 'organize');
    }
    if (schemaType === 'expr') {
      ops.push('set to', 'use', 'display', 'show', 'calculate', 'derive');
    }
  }

  if (entry.kind === 'value') {
    if (schemaType === 'number') {
      ops.push('increase', 'decrease', 'set', 'change', 'adjust');
    }
    if (schemaType === 'boolean') {
      ops.push('enable', 'disable', 'turn on', 'turn off', 'toggle');
    }
    if (schemaType === 'array') {
      ops.push('add', 'remove', 'replace', 'reorder', 'update');
    }
    if (schemaType === 'object') {
      ops.push('configure', 'set', 'update', 'modify');
    }
    if (schemaType === 'string') {
      ops.push('set', 'change', 'update');
    }
  }

  return ops;
}

// Build complete index from spec
export function buildConfigIndex(spec: ConfigSpec) {
  const index: Record<string, any> = {};

  if (!spec || !spec.sections) {
    console.warn('Invalid config spec provided to buildConfigIndex');
    return index;
  }

  for (const section of spec.sections) {
    for (const entry of section.entries || []) {
      if (!entry.path) continue;

      index[entry.path] = {
        id: entry.id || entry.path,
        path: entry.path,
        section: section.id,
        sectionDescription: section.description || '',
        kind: entry.kind, // 'value' or 'rule'
        schema: entry.schema,
        default: entry.default,
        description: entry.description || '',

        // Semantic metadata for LLM matching
        keywords: extractKeywords(entry),
        relatedConcepts: inferRelatedConcepts(entry),
        commonOperations: inferCommonOperations(entry)
      };
    }
  }

  return index;
}

// Export the complete index
export const CONFIG_INDEX = buildConfigIndex(ganttConfigSpec as unknown as ConfigSpec);

// Helper: Find best matching config items for a query
export function findMatchingConfigs(query: string, topK = 5) {
  const queryLower = query.toLowerCase();
  const scores: Array<{ path: string; config: any; score: number }> = [];

  for (const [path, config] of Object.entries(CONFIG_INDEX)) {
    let score = 0;

    // Exact path match (highest priority)
    if (queryLower.includes(path.toLowerCase())) {
      score += 10;
    }

    // Keyword match
    for (const kw of config.keywords) {
      if (queryLower.includes(kw)) {
        score += 2;
      }
    }

    // Related concept match
    for (const concept of config.relatedConcepts) {
      if (queryLower.includes(concept)) {
        score += 1.5;
      }
    }

    // Operation match
    for (const op of config.commonOperations) {
      if (queryLower.includes(op)) {
        score += 1;
      }
    }

    // Description match
    if (
      config.description &&
      queryLower
        .split(/\s+/)
        .some((word: string) => word.length > 3 && config.description.toLowerCase().includes(word))
    ) {
      score += 0.5;
    }

    if (score > 0) {
      scores.push({ path, config, score });
    }
  }

  return scores.sort((a, b) => b.score - a.score).slice(0, topK);
}

// Format index for LLM prompt (compact format)
export function formatConfigIndexForPrompt() {
  const sections: Record<string, any> = {};

  for (const [path, config] of Object.entries(CONFIG_INDEX)) {
    if (!sections[config.section]) {
      sections[config.section] = {
        description: config.sectionDescription,
        items: []
      };
    }
    sections[config.section].items.push({
      path,
      kind: config.kind,
      description: config.description,
      keywords: config.keywords.slice(0, 5).join(', ')
    });
  }

  return Object.entries(sections)
    .map(([section, data]) => {
      const header = data.description ? `### ${section} - ${data.description}` : `### ${section}`;
      const itemsStr = data.items
        .map((i: any) => `  - ${i.path} (${i.kind}): ${i.description || 'No description'}`)
        .join('\n');
      return `${header}\n${itemsStr}`;
    })
    .join('\n\n');
}

// Get detailed info for a specific config path
export function getConfigInfo(path: string) {
  return (CONFIG_INDEX as any)[path] || null;
}

// Get all config paths in a section
export function getConfigPathsBySection(sectionId: string) {
  return Object.entries(CONFIG_INDEX)
    .filter(([_, config]) => (config as any).section === sectionId)
    .map(([path]) => path);
}

// Get config item by ID
export function getConfigById(id: string) {
  return Object.values(CONFIG_INDEX).find((config: any) => config.id === id) || null;
}

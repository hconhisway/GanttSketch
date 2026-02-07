/**
 * Widget Validator
 * 
 * Post-processing validation and auto-fixing for LLM-generated widgets.
 * Inspired by DynaVis's approach to ensure reliable widget generation.
 */

/**
 * Validate and potentially fix a widget object
 * @param {Object} widget - The widget object to validate
 * @param {Array} existingWidgets - Array of existing widgets (for ID conflict check)
 * @returns {{ valid: boolean, widget: Object, errors: string[], warnings: string[], fixes: string[] }}
 */
export function validateWidget(widget, existingWidgets = []) {
  const errors = [];
  const warnings = [];
  const fixes = [];
  let fixedWidget = { ...widget };

  // 1. Check required fields
  if (!widget) {
    return { valid: false, widget: null, errors: ['Widget object is null or undefined'], warnings: [], fixes: [] };
  }

  if (!widget.id) {
    // Auto-fix: Generate an ID
    fixedWidget.id = `widget-${Date.now()}`;
    fixes.push(`Generated widget ID: ${fixedWidget.id}`);
  }

  if (!widget.name) {
    // Auto-fix: Use ID as name
    fixedWidget.name = fixedWidget.id || 'Unnamed Widget';
    fixes.push(`Set widget name to: ${fixedWidget.name}`);
  }

  if (!widget.html || typeof widget.html !== 'string') {
    errors.push('Widget HTML is missing or not a string');
  }

  // 2. Check for ID conflicts with existing widgets
  const existingIds = new Set(existingWidgets.map(w => w.id));
  if (existingIds.has(fixedWidget.id)) {
    // Auto-fix: Append timestamp to make unique
    const originalId = fixedWidget.id;
    fixedWidget.id = `${originalId}-${Date.now()}`;
    fixes.push(`Renamed widget ID from "${originalId}" to "${fixedWidget.id}" to avoid conflict`);
  }

  // 3. Validate HTML (basic checks)
  if (fixedWidget.html) {
    const htmlValidation = validateHtml(fixedWidget.html);
    errors.push(...htmlValidation.errors);
    warnings.push(...htmlValidation.warnings);
    
    if (htmlValidation.fixedHtml !== fixedWidget.html) {
      fixedWidget.html = htmlValidation.fixedHtml;
      fixes.push(...htmlValidation.fixes);
    }
  }

  // 4. Validate listeners
  if (fixedWidget.listeners) {
    if (!Array.isArray(fixedWidget.listeners)) {
      errors.push('Widget listeners must be an array');
      fixedWidget.listeners = [];
    } else {
      const listenersValidation = validateListeners(fixedWidget.listeners);
      errors.push(...listenersValidation.errors);
      warnings.push(...listenersValidation.warnings);
      fixes.push(...listenersValidation.fixes);
      fixedWidget.listeners = listenersValidation.fixedListeners;
    }
  } else {
    fixedWidget.listeners = [];
    warnings.push('Widget has no listeners - it will be display-only');
  }

  // 5. Check for HTML ID conflicts within the widget
  if (fixedWidget.html && fixedWidget.listeners && fixedWidget.listeners.length > 0) {
    const idConflictValidation = checkHtmlIdConflicts(fixedWidget.html, existingWidgets);
    if (idConflictValidation.hasConflicts) {
      fixedWidget.html = idConflictValidation.fixedHtml;
      fixedWidget.listeners = updateListenerSelectors(
        fixedWidget.listeners, 
        idConflictValidation.idMap
      );
      fixes.push(...idConflictValidation.fixes);
    }
  }

  return {
    valid: errors.length === 0,
    widget: fixedWidget,
    errors,
    warnings,
    fixes
  };
}

/**
 * Validate HTML content
 */
function validateHtml(html) {
  const errors = [];
  const warnings = [];
  const fixes = [];
  let fixedHtml = html;

  // Check for script tags (security)
  if (/<script[\s\S]*?>[\s\S]*?<\/script>/gi.test(html)) {
    fixedHtml = fixedHtml.replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '');
    fixes.push('Removed script tags from HTML');
    warnings.push('Script tags are not allowed and were removed');
  }

  // Check for onclick/onerror handlers (XSS prevention)
  const inlineHandlers = /\bon\w+\s*=/gi;
  if (inlineHandlers.test(html)) {
    warnings.push('Inline event handlers (onclick, etc.) detected - use listeners instead');
  }

  // Check for empty HTML
  if (!fixedHtml.trim()) {
    errors.push('HTML content is empty');
  }

  // Basic structure check - should have at least one element
  const hasElement = /<\w+[^>]*>/i.test(fixedHtml);
  if (!hasElement) {
    warnings.push('HTML does not contain any elements');
  }

  return { errors, warnings, fixes, fixedHtml };
}

/**
 * Validate listener array
 */
function validateListeners(listeners) {
  const errors = [];
  const warnings = [];
  const fixes = [];
  const fixedListeners = [];

  for (let i = 0; i < listeners.length; i++) {
    const listener = listeners[i];
    const fixedListener = { ...listener };
    let isValid = true;

    // Check selector
    if (!listener.selector || typeof listener.selector !== 'string') {
      warnings.push(`Listener ${i}: Missing or invalid selector, will attach to widget root`);
      fixedListener.selector = '';
    }

    // Check event
    if (!listener.event || typeof listener.event !== 'string') {
      fixedListener.event = 'change';
      fixes.push(`Listener ${i}: Set default event type to "change"`);
    }

    // Check handler
    if (!listener.handler || typeof listener.handler !== 'string') {
      errors.push(`Listener ${i}: Handler is missing or not a string`);
      isValid = false;
    } else {
      // Try to validate JS syntax
      const jsValidation = validateJsHandler(listener.handler);
      if (!jsValidation.valid) {
        errors.push(`Listener ${i}: JavaScript syntax error - ${jsValidation.error}`);
        isValid = false;
      }
    }

    if (isValid || fixedListener.handler) {
      fixedListeners.push(fixedListener);
    }
  }

  return { errors, warnings, fixes, fixedListeners };
}

/**
 * Validate JavaScript handler syntax
 */
function validateJsHandler(handler) {
  try {
    // Try to create a function from the handler to check syntax
    // eslint-disable-next-line no-new-func
    new Function('payload', 'api', 'widget', handler);
    return { valid: true };
  } catch (error) {
    return { valid: false, error: error.message };
  }
}

/**
 * Check for HTML ID conflicts with existing widgets
 */
function checkHtmlIdConflicts(html, existingWidgets) {
  const fixes = [];
  const idMap = {};
  let fixedHtml = html;
  let hasConflicts = false;

  // Extract all existing IDs from other widgets
  const existingIds = new Set();
  for (const widget of existingWidgets) {
    if (widget.html) {
      const idMatches = widget.html.matchAll(/id\s*=\s*["']([^"']+)["']/gi);
      for (const match of idMatches) {
        existingIds.add(match[1]);
      }
    }
  }

  // Find IDs in the new widget HTML
  const newIdMatches = [...html.matchAll(/id\s*=\s*["']([^"']+)["']/gi)];
  
  for (const match of newIdMatches) {
    const originalId = match[1];
    if (existingIds.has(originalId)) {
      hasConflicts = true;
      const newId = `${originalId}-${Date.now()}`;
      idMap[originalId] = newId;
      
      // Replace in HTML (both with quotes types)
      fixedHtml = fixedHtml.replace(
        new RegExp(`id\\s*=\\s*["']${escapeRegex(originalId)}["']`, 'g'),
        `id="${newId}"`
      );
      
      fixes.push(`Renamed HTML element ID from "${originalId}" to "${newId}" to avoid conflict`);
    }
  }

  return { hasConflicts, fixedHtml, idMap, fixes };
}

/**
 * Update listener selectors based on ID map
 */
function updateListenerSelectors(listeners, idMap) {
  return listeners.map(listener => {
    let updatedSelector = listener.selector;
    
    for (const [oldId, newId] of Object.entries(idMap)) {
      // Update #id selectors
      updatedSelector = updatedSelector.replace(
        new RegExp(`#${escapeRegex(oldId)}\\b`, 'g'),
        `#${newId}`
      );
    }
    
    // Also update handler if it references IDs
    let updatedHandler = listener.handler;
    for (const [oldId, newId] of Object.entries(idMap)) {
      updatedHandler = updatedHandler.replace(
        new RegExp(`["']#${escapeRegex(oldId)}["']`, 'g'),
        `"#${newId}"`
      );
      updatedHandler = updatedHandler.replace(
        new RegExp(`getElementById\\(["']${escapeRegex(oldId)}["']\\)`, 'g'),
        `getElementById("${newId}")`
      );
    }
    
    return {
      ...listener,
      selector: updatedSelector,
      handler: updatedHandler
    };
  });
}

/**
 * Escape special regex characters in a string
 */
function escapeRegex(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Validate a config patch to ensure it uses valid formats
 */
export function validateConfigPatch(patch) {
  const errors = [];
  const warnings = [];

  if (!patch || typeof patch !== 'object') {
    return { valid: true, errors: [], warnings: [] };
  }

  // Check color config
  if (patch.color) {
    const colorErrors = validateColorConfig(patch.color);
    errors.push(...colorErrors);
  }

  // Check yAxis config
  if (patch.yAxis) {
    const yAxisErrors = validateYAxisConfig(patch.yAxis);
    errors.push(...yAxisErrors);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}

/**
 * Validate color configuration
 */
function validateColorConfig(colorConfig) {
  const errors = [];

  // Check fixedColor
  if (colorConfig.fixedColor !== undefined && colorConfig.fixedColor !== null) {
    if (typeof colorConfig.fixedColor !== 'string') {
      errors.push('color.fixedColor must be a string (e.g., "rgba(0,0,0,0.38)" or "#2563EB")');
    }
  }

  // Check palette
  if (colorConfig.palette !== undefined) {
    if (!Array.isArray(colorConfig.palette)) {
      errors.push('color.palette must be an array of color strings (e.g., ["#ff0000", "#00ff00"])');
    } else {
      for (let i = 0; i < colorConfig.palette.length; i++) {
        if (typeof colorConfig.palette[i] !== 'string') {
          errors.push(`color.palette[${i}] must be a string`);
        }
      }
    }
  }

  // Check keyRule
  if (colorConfig.keyRule !== undefined) {
    if (typeof colorConfig.keyRule === 'string') {
      errors.push('color.keyRule must be an expression object, NOT a string. Use: { type: "expr", expr: { op: "get", path: "event.cat" } }');
    } else if (typeof colorConfig.keyRule === 'object') {
      if (!colorConfig.keyRule.type && !colorConfig.keyRule.op) {
        errors.push('color.keyRule must have type:"expr" and expr property, or be a direct expression with "op"');
      }
    }
  }

  // Check colorRule
  if (colorConfig.colorRule !== undefined) {
    if (typeof colorConfig.colorRule === 'string') {
      errors.push('color.colorRule must be an expression object, NOT a string');
    }
  }

  return errors;
}

/**
 * Validate yAxis configuration
 */
function validateYAxisConfig(yAxisConfig) {
  const errors = [];

  if (yAxisConfig.processOrderRule !== undefined) {
    if (typeof yAxisConfig.processOrderRule !== 'object') {
      errors.push('yAxis.processOrderRule must be an object with type and name');
    }
  }

  if (yAxisConfig.threadLaneRule !== undefined) {
    if (typeof yAxisConfig.threadLaneRule !== 'object') {
      errors.push('yAxis.threadLaneRule must be an object with type and name');
    }
  }

  return errors;
}

/**
 * Try to extract and validate config patches from handler code
 * This helps catch invalid configs before they're applied
 */
export function analyzeHandlerForConfigPatches(handler) {
  const warnings = [];
  
  // Look for applyGanttConfigPatch calls
  const patchPattern = /applyGanttConfigPatch\s*\([^,]+,\s*(\{[\s\S]*?\})\s*\)/g;
  let match;
  
  while ((match = patchPattern.exec(handler)) !== null) {
    try {
      // Try to parse the patch object (this is approximate)
      const patchStr = match[1];
      
      // Check for common mistakes
      if (/keyRule\s*:\s*['"][^'"]+['"]/.test(patchStr)) {
        warnings.push('Detected keyRule as a string - it should be an expression object');
      }
      
      if (/palette\s*:\s*\[\s*\{/.test(patchStr)) {
        warnings.push('Detected palette as array of objects - it should be an array of color strings');
      }
      
    } catch (e) {
      // Parsing failed, can't validate
    }
  }
  
  return { warnings };
}

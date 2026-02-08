# Agent System Testing Guide

## Pre-Testing Verification

✅ **Code Quality**:

- No linter errors in agent modules
- All imports/exports correctly connected
- Type consistency maintained

✅ **Integration Points**:

- Agent modules created and exported
- App.js imports agents correctly
- State management updated (dataSchema added)
- Data loading flow integrated
- Message handling flow updated

## Manual Testing Checklist

### 1. Data Analysis Agent Testing

**Test Case 1.1**: Load data with standard field names

- [ ] Upload trace file with fields: `pid`, `tid`, `name`, `cat`, `ts`, `dur`
- [ ] Verify schema detection runs automatically
- [ ] Check console for "Schema detected" message
- [ ] Verify system message shows "Data schema auto-detected with X fields"
- [ ] Check that initial config is applied (color by category, tooltip fields)

**Test Case 1.2**: Load data with non-standard field names

- [ ] Upload trace file with fields like: `Location`, `Primitive`, `Timestamp`
- [ ] Verify LLM correctly identifies semantics (Location → process_id, Primitive → name)
- [ ] Check generated initial config uses correct field names

**Test Case 1.3**: Load data with nested structures

- [ ] Upload data with nested fields: `Raw.pid`, `enter.Timestamp`
- [ ] Verify schema detection handles nested structure
- [ ] Check field mapping is correct

**Test Case 1.4**: Schema detection failure handling

- [ ] Simulate LLM error (disconnect network, invalid API key)
- [ ] Verify data still loads successfully
- [ ] Check system message shows "Auto-analysis skipped" warning
- [ ] Verify app remains functional with default config

### 2. Config Agent Testing

**Test Case 2.1**: Color configuration

- [ ] Send message: "Color events by category"
- [ ] Verify LLM generates patch with `color.keyRule`
- [ ] Check patch references correct field from detected schema
- [ ] Verify config button highlights correctly
- [ ] Verify config is applied to chart

**Test Case 2.2**: Process ordering

- [ ] Send message: "Sort processes by fork tree"
- [ ] Verify patch contains `yAxis.processOrderRule` with forkTree transform
- [ ] Check correct config button is highlighted
- [ ] Verify process order changes in chart

**Test Case 2.3**: Tooltip customization

- [ ] Send message: "Show only name and duration in tooltip"
- [ ] Verify patch updates `tooltip.event.fields`
- [ ] Check tooltip displays correctly on hover

**Test Case 2.4**: Layout adjustments

- [ ] Send message: "Increase lane height to 24"
- [ ] Verify patch contains `layout.laneHeight: 24`
- [ ] Check lane height changes visually

**Test Case 2.5**: Using detected field names

- [ ] After loading data with field "Primitive" (detected as name)
- [ ] Send message: "Color by Primitive"
- [ ] Verify LLM uses correct field name from schema
- [ ] Check patch: `color.keyRule.expr.path = "event.Primitive"`

**Test Case 2.6**: Target path extraction

- [ ] Send any config modification request
- [ ] Verify response includes `targetPath` field
- [ ] Check correct config button is highlighted in UI
- [ ] Verify auto-scroll to highlighted button works

### 3. Config Index Testing

**Test Case 3.1**: Semantic search

- [ ] Test various queries: "change color", "sort order", "tooltip settings"
- [ ] Verify `findMatchingConfigs()` returns relevant items
- [ ] Check scoring prioritizes exact path matches

**Test Case 3.2**: Completeness

- [ ] Verify CONFIG_INDEX includes all items from GANTT_CONFIG_SPEC.json
- [ ] Check each section: layout, yAxis, color, tooltip, extensions
- [ ] Verify keywords extracted correctly
- [ ] Check related concepts are logical

**Test Case 3.3**: LLM prompt formatting

- [ ] Call `formatConfigIndexForPrompt()`
- [ ] Verify output is readable and well-structured
- [ ] Check all sections are included
- [ ] Verify descriptions are clear

### 4. UI Preservation Testing

**Test Case 4.1**: Config panel

- [ ] Verify all config domain sections visible
- [ ] Check all config buttons are clickable
- [ ] Verify hover tooltips show descriptions

**Test Case 4.2**: Config editor modal

- [ ] Click any config button
- [ ] Verify modal opens correctly
- [ ] Check current value displays
- [ ] Verify example is shown
- [ ] Test manual editing and saving

**Test Case 4.3**: Highlighting behavior

- [ ] Trigger config change via LLM
- [ ] Verify correct button highlights
- [ ] Check auto-scroll to highlighted button
- [ ] Verify highlight animation works

**Test Case 4.4**: Active config item mode

- [ ] Click a config button to activate it
- [ ] Send LLM message about that config
- [ ] Verify LLM only updates the active path
- [ ] Check validation rejects updates to other paths

### 5. Error Handling Testing

**Test Case 5.1**: LLM connection failure

- [ ] Disconnect network or use invalid API key
- [ ] Try data loading (schema detection)
- [ ] Verify graceful fallback with warning message
- [ ] Confirm data still loads

**Test Case 5.2**: Invalid config patch

- [ ] Send ambiguous request to LLM
- [ ] If patch is invalid, verify validation catches it
- [ ] Check error message is user-friendly

**Test Case 5.3**: Schema detection timeout

- [ ] Use very large dataset (>1000 events)
- [ ] Verify sampling works (only 20 events sent to LLM)
- [ ] Check timeout doesn't block data loading

### 6. Performance Testing

**Test Case 6.1**: Large dataset

- [ ] Load trace with 10,000+ events
- [ ] Measure schema detection time
- [ ] Verify UI remains responsive during analysis
- [ ] Check memory usage is reasonable

**Test Case 6.2**: Config index build time

- [ ] Verify CONFIG_INDEX builds at import time
- [ ] Check no noticeable delay in app startup

**Test Case 6.3**: Multiple config changes

- [ ] Send 5+ config modification requests in sequence
- [ ] Verify each applies correctly
- [ ] Check no state conflicts or race conditions

## Integration Testing

### End-to-End Flow 1: New User Experience

1. [ ] Start with empty chart
2. [ ] Upload trace file with arbitrary field names
3. [ ] Verify auto-analysis runs and shows message
4. [ ] Check chart displays with generated initial config
5. [ ] Send chat message to modify color
6. [ ] Verify config updates and button highlights
7. [ ] Manually edit config via button
8. [ ] Verify manual edit persists

### End-to-End Flow 2: Power User Workflow

1. [ ] Load data (schema detected)
2. [ ] Click config button to activate specific item
3. [ ] Send focused LLM request for that item
4. [ ] Verify only that item updates
5. [ ] Deactivate by clicking button again
6. [ ] Send general LLM request
7. [ ] Verify broader config changes now work

### End-to-End Flow 3: Data Format Variations

1. [ ] Test with Chrome trace JSON format
2. [ ] Test with custom nested format
3. [ ] Test with flat event array
4. [ ] Verify schema detection handles all formats
5. [ ] Check initial configs are appropriate for each

## Regression Testing

- [ ] Existing features still work: zoom, pan, drawing mode
- [ ] File upload still functions
- [ ] API backend integration (if available) still works
- [ ] Widget creation (legacy) still works
- [ ] Export functionality still works

## Known Limitations

1. **Schema detection requires LLM**: Falls back gracefully if unavailable
2. **One-time analysis**: Schema not re-analyzed on new data loads (by design)
3. **Sample size**: Only 20 events sent to LLM for analysis
4. **No caching**: Schema detection runs fresh each time

## Debugging Tips

### Enable verbose logging:

```javascript
// In App.js, after schema detection
console.log('Full schema:', JSON.stringify(dataSchema, null, 2));
console.log('Generated config:', JSON.stringify(analysisResult.config, null, 2));
```

### Check config index:

```javascript
// In browser console
import { CONFIG_INDEX } from './agents';
console.table(
  Object.entries(CONFIG_INDEX).map(([path, config]) => ({
    path,
    keywords: config.keywords.join(', '),
    operations: config.commonOperations.join(', ')
  }))
);
```

### Test semantic search:

```javascript
import { findMatchingConfigs } from './agents';
console.log(findMatchingConfigs('change the color'));
```

## Success Criteria

The implementation is successful if:

✅ Data loads successfully with auto-schema detection  
✅ Initial config is intelligently generated from detected schema  
✅ Config Agent uses detected schema in prompts  
✅ LLM references correct field names from schema  
✅ Config buttons highlight correctly after LLM changes  
✅ All existing UI functionality is preserved  
✅ Error handling is graceful (no crashes)  
✅ Performance is acceptable (<2s for schema detection)

## Next Steps After Testing

1. Gather user feedback on auto-generated configs
2. Refine schema detection prompt based on edge cases
3. Add config templates for common use cases
4. Consider caching schema results
5. Add user confirmation step for auto-applied configs (optional)

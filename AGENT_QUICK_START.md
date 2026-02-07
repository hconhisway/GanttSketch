# Agent System Quick Start

## What's New

The Gantt chart now features intelligent agents that:
1. **Auto-detect data schema** - Works with any field naming convention
2. **Generate initial config** - Smart defaults based on your data
3. **Understand context** - Config changes reference actual field names from your data

## How to Use

### 1. Load Your Data

When you load a trace file, the system automatically:
- Analyzes your data fields (using LLM)
- Detects semantic meanings (e.g., "Location" → process ID)
- Generates an appropriate initial configuration
- Shows a message: "✨ Data schema auto-detected with X fields"

Example fields it recognizes:
- **Process ID**: `pid`, `processId`, `Location`, `rank`, `device`, `gpu_id`
- **Thread ID**: `tid`, `threadId`, `thread`
- **Event name**: `name`, `Primitive`, `op_name`, `kernel`, `function`
- **Category**: `cat`, `category`, `type`, `kind`
- **Timestamps**: `ts`, `Timestamp`, `start`, `end`

### 2. Chat to Modify Configuration

Simply describe what you want in natural language:

**Color by category:**
```
"Color events by category"
```
→ Generates: `color.keyRule` using your actual category field name

**Sort processes:**
```
"Sort processes by fork tree"
```
→ Generates: `yAxis.processOrderRule` with forkTree transform

**Customize tooltip:**
```
"Show only name and duration in tooltip"
```
→ Generates: `tooltip.event.fields` with selected fields

**Adjust layout:**
```
"Make lanes taller"
or
"Set lane height to 24 pixels"
```
→ Generates: `layout.laneHeight` update

### 3. Use Config Buttons (Existing Feature)

The config panel at the top still works exactly as before:
- Click any config button to open the editor
- Edit JSON directly
- Save to apply changes

**New enhancement**: When you click a config button, chat requests focus on that specific config item.

### 4. Review Auto-Applied Config

After data loads with auto-detection:
1. Check the console for detected schema
2. Look at the system message in chat
3. Use config buttons to inspect what was configured
4. Modify any setting you want via chat or manual edit

## Examples

### Example 1: GPU Trace

**Your data:**
```json
{
  "gpu_id": 0,
  "kernel": "matmul",
  "start_time": 1000,
  "duration": 500
}
```

**Auto-detected:**
- `gpu_id` → process_id
- `kernel` → name
- `start_time` → start_time
- `duration` → duration

**Auto-generated config:**
- Color by kernel name
- Tooltip shows: kernel, duration, gpu_id

### Example 2: Nested Format

**Your data:**
```json
{
  "Raw": {
    "pid": 1234,
    "name": "computation"
  },
  "enter": { "Timestamp": 50000 },
  "leave": { "Timestamp": 51000 }
}
```

**Auto-detected:**
- `Raw.pid` → process_id
- `Raw.name` → name
- `enter.Timestamp` → start_time
- `leave.Timestamp` → end_time

**Auto-generated config:**
- Color by name
- Tooltip shows detected fields

### Example 3: Custom Format

**Your data:**
```json
{
  "Location": "rank_0",
  "Primitive": "AllReduce",
  "Category": "communication",
  "ts": 100000,
  "dur": 2000
}
```

**Auto-detected:**
- `Location` → process_id
- `Primitive` → name
- `Category` → category
- `ts` → start_time
- `dur` → duration

**Auto-generated config:**
- Color by Category
- Tooltip shows all fields

## Configuration Tips

### Get Better Results

1. **Be specific**: "Color by operation type" vs "change colors"
2. **Use field names**: "Sort by Duration" (if you see Duration in your data)
3. **Mention what you see**: "The category field" or "those Primitive names"

### If Schema Detection Fails

Don't worry! The app continues to work:
- Data loads normally with default config
- You can still use chat to modify config
- Manual config editing works as before
- You'll see: "⚠️ Auto-analysis skipped"

## Architecture

```
┌─────────────────────────────────────┐
│        Load Your Data               │
│         ↓                           │
│  Data Analysis Agent (LLM)          │
│  - Detects field semantics          │
│  - Generates initial config         │
│         ↓                           │
│  Config Auto-Applied                │
└─────────────────────────────────────┘

┌─────────────────────────────────────┐
│    Chat: "Color by category"        │
│         ↓                           │
│  Config Agent (LLM)                 │
│  - Uses detected schema             │
│  - References actual field names    │
│  - Generates precise config patch   │
│         ↓                           │
│  Config Applied + Button Highlights │
└─────────────────────────────────────┘
```

## What's Preserved

All existing functionality remains intact:
- ✅ Manual file upload
- ✅ Zoom and pan
- ✅ Drawing mode
- ✅ Config panel and buttons
- ✅ Manual JSON editing
- ✅ Widget creation
- ✅ Export features

## Troubleshooting

**Schema detection not running?**
- Check console for errors
- Verify LLM API key is configured
- Check network connection

**Initial config not ideal?**
- No problem! Use chat or manual edit to change it
- Schema detection is a starting point, not final

**Config changes not applying?**
- Check for system error messages in chat
- Verify LLM response in console
- Try manual edit as fallback

**Wrong field detected?**
- Schema detection is best-effort
- Use config buttons to manually fix any issues
- Report common misdetections for prompt improvements

## Advanced Usage

### Access Detected Schema

In browser console:
```javascript
// View detected schema
console.log(window.appState?.dataSchema);
```

### Manual Schema Override

If needed, you can always use manual config editing to reference any field:
```json
{
  "color": {
    "keyRule": {
      "type": "expr",
      "expr": { "op": "get", "path": "event.YourActualFieldName" }
    }
  }
}
```

## Next Steps

1. Load your trace data
2. Check the auto-detected schema in console
3. Review the initial config
4. Try some chat commands to modify config
5. Explore the config panel buttons
6. Enjoy your perfectly configured chart!

# LLM-Powered Track Configuration

## Overview

OSFAT now features an intelligent LLM-powered system that can understand your natural language requests and visual annotations (sketches) to automatically configure track display. Simply describe what you want to see or draw on the chart, and the AI will generate the appropriate track configuration.

## How It Works

### 1. **Understanding User Intent**

The LLM analyzes:

- **Natural language**: Your text description of what you want
- **Visual context**: Annotations and drawings on the chart (when using vision-capable models)
- **Chart context**: Current tracks, time ranges, and data

### 2. **Generating Configuration**

Based on your input, the LLM generates a structured JSON configuration that specifies:

- Sorting preferences
- Filter criteria
- Grouping arrangements

### 3. **Automatic Application**

The system automatically:

- Parses the LLM's response
- Converts it to internal configuration format
- Applies the configuration to the chart
- Shows a confirmation message

## Usage Examples

### Example 1: Simple Filtering

**You type:**

```
Show only tracks 5 to 15
```

**LLM responds with:**

```json
{
  "action": "configure_tracks",
  "config": {
    "sortMode": "asc",
    "filter": {
      "type": "range",
      "value": { "min": 5, "max": 15 }
    },
    "description": "Showing only tracks 5-15"
  }
}
```

**Result:** Chart updates to show only tracks 5-15, sorted in ascending order.

---

### Example 2: Pattern Matching

**You type:**

```
Show me all CPU tracks
```

**LLM responds with:**

```json
{
  "action": "configure_tracks",
  "config": {
    "sortMode": "asc",
    "filter": {
      "type": "pattern",
      "value": "CPU.*"
    },
    "description": "Filtering to show tracks matching pattern 'CPU.*'"
  }
}
```

**Result:** Chart shows only tracks whose names contain "CPU".

---

### Example 3: Top Performers

**You type:**

```
Show me the 5 busiest tracks
```

**LLM responds with:**

```json
{
  "action": "configure_tracks",
  "config": {
    "sortMode": "custom",
    "filter": {
      "type": "function",
      "value": "top_n_utilization",
      "params": { "n": 5 }
    },
    "description": "Showing the 5 tracks with highest utilization"
  }
}
```

**Result:** Chart analyzes utilization and displays the top 5 most active tracks.

---

### Example 4: Grouping

**You type:**

```
Group tracks into High (0-5), Medium (6-10), and Low priority (11-15)
```

**LLM responds with:**

```json
{
  "action": "configure_tracks",
  "config": {
    "sortMode": "grouped",
    "groups": [
      {
        "name": "High Priority",
        "tracks": ["0", "1", "2", "3", "4", "5"],
        "order": 0
      },
      {
        "name": "Medium Priority",
        "tracks": ["6", "7", "8", "9", "10"],
        "order": 1
      },
      {
        "name": "Low Priority",
        "tracks": ["11", "12", "13", "14", "15"],
        "order": 2
      }
    ],
    "description": "Grouped tracks into High, Medium, and Low priority"
  }
}
```

**Result:** Chart displays tracks in three distinct groups with:

- Bold colored group labels on the left ("High Priority", "Medium Priority", "Low Priority")
- Alternating background colors for each group region
- Dashed separator lines between groups

---

### Example 5: Visual Annotation (Vision Models)

**You do:**

1. Enable drawing mode
2. Circle tracks 3, 7, and 12 on the chart
3. Capture the image
4. Send message: "Show only these tracks"

**LLM analyzes the image and responds:**

```json
{
  "action": "configure_tracks",
  "config": {
    "sortMode": "asc",
    "filter": {
      "type": "list",
      "value": ["3", "7", "12"]
    },
    "description": "Showing only the tracks you highlighted: 3, 7, and 12"
  }
}
```

**Result:** Chart shows only the three tracks you circled.

---

## Supported Configuration Types

### Filter Types

#### 1. **Range Filter**

Show tracks within a numeric range.

```json
{
  "type": "range",
  "value": { "min": 0, "max": 10 }
}
```

**Natural language examples:**

- "Show tracks 0 to 10"
- "Display tracks between 5 and 15"
- "Filter to tracks in range 20-30"

#### 2. **List Filter**

Show specific tracks by name.

```json
{
  "type": "list",
  "value": ["track1", "track5", "track9"]
}
```

**Natural language examples:**

- "Show only tracks 1, 5, and 9"
- "Display tracks A, B, and C"
- "Filter to tracks: CPU_0, CPU_1, GPU_0"

#### 3. **Pattern Filter**

Show tracks matching a regex pattern.

```json
{
  "type": "pattern",
  "value": "CPU.*"
}
```

**Natural language examples:**

- "Show all CPU tracks"
- "Display tracks starting with GPU"
- "Filter to tracks containing 'memory'"

#### 4. **Function Filter**

Apply predefined filter functions.

```json
{
  "type": "function",
  "value": "even_only"
}
```

**Available functions:**

- `numeric_only`: Show only numerically-named tracks
- `even_only`: Show only even-numbered tracks
- `odd_only`: Show only odd-numbered tracks
- `top_n_utilization`: Show N tracks with highest utilization

**Natural language examples:**

- "Show only even tracks"
- "Display numeric tracks only"
- "Show the 10 most active tracks"

### Sort Modes

#### 1. **Ascending (asc)**

Sort tracks from smallest to largest, A-Z.

```json
{ "sortMode": "asc" }
```

**Natural language examples:**

- "Sort tracks ascending"
- "Order tracks from low to high"
- "Sort alphabetically"

#### 2. **Descending (desc)**

Sort tracks from largest to smallest, Z-A.

```json
{ "sortMode": "desc" }
```

**Natural language examples:**

- "Sort tracks descending"
- "Order tracks from high to low"
- "Reverse sort"

#### 3. **Grouped**

Organize tracks into named groups with rich visual indicators.

```json
{
  "sortMode": "grouped",
  "groups": [...]
}
```

**Visual Effects:**

- Bold, colored group labels on the left side of Y-axis
- Alternating subtle background colors (light gray/white)
- Dashed separator lines between groups
- Increased left margin to accommodate labels

**Natural language examples:**

- "Group tracks by priority"
- "Organize into categories"
- "Split into high and low groups"
- "Create groups: critical (0-5) and normal (6-10)"

**Group Naming:**

- Use descriptive names when context is clear: "High Priority", "CPU Resources"
- Use numbered defaults when no context: "Group 1", "Group 2"

## Tips for Best Results

### 1. **Be Specific**

❌ Bad: "Filter the chart"
✅ Good: "Show only tracks 5-10"

### 2. **Use Track Names**

If you know the exact track identifiers:

- "Show tracks CPU_0, CPU_1, and GPU_0"
- "Display tracks 5, 7, and 9"

### 3. **Describe Patterns**

For pattern-based filtering:

- "Show all tracks starting with GPU"
- "Display tracks containing 'memory'"

### 4. **Specify Quantities**

When asking for top/bottom:

- "Show the 5 busiest tracks"
- "Display the top 10 tracks by utilization"

### 5. **Group Clearly**

When creating groups:

- "Group tracks 0-5 as 'High Priority' and 6-10 as 'Low Priority'"
- "Organize into CPU group (tracks A, B) and GPU group (tracks X, Y)"

### 6. **Use Visual Annotations**

With vision-capable models:

1. Draw circles around tracks of interest
2. Use different colors for different groups
3. Draw arrows to highlight relationships
4. Capture and send the image with your request

## Technical Details

### System Architecture

```
User Input (text + optional image)
    ↓
Enhanced System Prompt (with chart context)
    ↓
LLM Processing
    ↓
Structured JSON Response
    ↓
Parser (parseTrackConfigFromResponse)
    ↓
Converter (convertLLMConfigToTracksConfig)
    ↓
Apply to Chart (setTracksConfig)
    ↓
Confirmation Message
```

### Configuration File

The system uses `src/tracksConfigPrompt.js` which contains:

1. **TRACKS_CONFIG_SYSTEM_PROMPT**: The comprehensive prompt that teaches the LLM how to generate configurations
2. **parseTrackConfigFromResponse()**: Extracts JSON configuration from LLM response
3. **convertLLMConfigToTracksConfig()**: Converts LLM format to internal format
4. **getEnhancedSystemPrompt()**: Adds current chart context to the prompt

### Internal Format

LLM output format:

```json
{
  "action": "configure_tracks",
  "config": { ... }
}
```

Internal format (React state):

```javascript
{
  sortMode: 'asc' | 'desc' | 'custom' | 'grouped',
  customSort: Function | null,
  groups: Array | null,
  filter: Function | null,
  trackList: Array | null
}
```

## LLM Provider Requirements

### Basic Functionality

Works with any LLM that can:

- Follow instructions
- Generate JSON
- Understand natural language

**Supported models:**

- GPT-4, GPT-3.5 (OpenAI)
- Claude 3 (Anthropic)
- Local models via Ollama

### Vision Capabilities

For sketch/annotation understanding:

- GPT-4 Vision (OpenAI)
- Claude 3 Opus/Sonnet (Anthropic)

**Note:** Vision capabilities require:

1. Drawing module enabled
2. Image capture functionality
3. Vision-capable LLM configured
4. Image data passed to LLM API

## Troubleshooting

### Configuration Not Applied

**Problem:** LLM responds but chart doesn't update

**Solutions:**

1. Check browser console for errors
2. Verify LLM response contains valid JSON
3. Ensure track names in config match actual tracks
4. Look for confirmation message in chat

### Incorrect Filtering

**Problem:** Wrong tracks are shown

**Solutions:**

1. Be more specific in your request
2. Check track names/numbers match your data
3. Review the configuration in console logs
4. Try rephrasing your request

### LLM Doesn't Understand

**Problem:** LLM gives general answer instead of configuration

**Solutions:**

1. Use clearer language: "Configure tracks to show..."
2. Explicitly mention filtering, sorting, or grouping
3. Provide specific track names or numbers
4. Try: "Generate a track configuration that..."

### Vision Not Working

**Problem:** LLM doesn't understand your sketch

**Solutions:**

1. Ensure you're using a vision-capable model
2. Verify image is captured correctly
3. Make annotations clear and obvious
4. Describe your annotations in text as well

## Examples of Powerful Queries

### Complex Filtering

```
"Show tracks 0-10 excluding 5 and 7, sorted descending"
```

### Multi-Group Organization

```
"Group tracks into: Critical (0-3), Important (4-7), Normal (8-15), and Low (16+)"
```

### Dynamic Analysis

```
"Show me the top 5 tracks with the most activity in the current time range"
```

### Pattern + Range

```
"Show CPU tracks numbered between 0 and 10"
```

### Conditional Grouping

```
"Group even tracks as Group A and odd tracks as Group B"
```

## Best Practices

1. **Start Simple**: Begin with basic requests before complex configurations
2. **Iterate**: Refine your configuration through conversation
3. **Verify**: Check the confirmation message and visual result
4. **Reset**: Use "show all tracks" to reset filters
5. **Combine**: Use both text and visual annotations for best results
6. **Document**: Save successful queries for reuse

## Security & Privacy

- All LLM communication uses your configured API
- No data is sent to third parties beyond your LLM provider
- Track configurations are ephemeral (not saved)
- Chart data context is included in LLM requests
- Review your LLM provider's privacy policy

## Future Enhancements

Planned features:

- [ ] Save and name configurations
- [ ] Configuration presets library
- [ ] Multi-step configuration workflows
- [ ] Undo/redo for configurations
- [ ] Export/import configurations
- [ ] Configuration history
- [ ] Voice commands support

## Support

For issues or questions:

1. Check the console logs for detailed errors
2. Review the LLM's full response in chat
3. Try rephrasing your request
4. Refer to [TRACKS_CONFIG_GUIDE.md](./TRACKS_CONFIG_GUIDE.md) for manual configuration
5. Check [LLM_SETUP.md](./LLM_SETUP.md) for API configuration

---

**Enjoy intelligent, conversational chart configuration! 🤖✨**

# Tracks Configuration Guide

## Overview

The GanttSketch application now includes a powerful tracks configuration system that allows you to sort, filter, and group tracks in your Gantt chart. This guide explains how to use these features both through the UI and programmatically.

## Features

### 1. **Sorting**
Control the order in which tracks appear in your chart.

#### Sort Modes:
- **Ascending (Default)**: Sorts tracks from smallest to largest (numerically) or A-Z (alphabetically)
- **Descending**: Sorts tracks from largest to smallest or Z-A
- **Grouped**: Organizes tracks into custom groups
- **Custom**: Use a custom sorting function

### 2. **Filtering**
Control which tracks are displayed in the chart.

#### Filter Options:
- **Show All**: Display all tracks (default)
- **Numeric Only**: Show only tracks that can be parsed as numbers
- **First 5**: Display only the first 5 tracks (after sorting)
- **Custom Filter**: Use a custom filter function

### 3. **Grouping**
Organize tracks into logical groups with rich visual indicators.

#### Visual Effects:
- **Group Labels**: Bold, colored labels appear on the left side of the Y-axis
- **Background Colors**: Alternating subtle backgrounds for each group region
- **Separator Lines**: Dashed lines between groups for clear boundaries
- **Increased Margin**: Extra left margin to accommodate group labels

#### Example Grouping:
- **Group A/B**: Automatically splits numeric tracks into two groups
- **Custom Names**: Use meaningful names like "High Priority", "CPU Resources"
- **Default Names**: "Group 1", "Group 2", "Group 3" when no context is provided

## UI Usage

### Using the Control Panel

1. **Sort Mode Dropdown**
   - Located in the "Track Configuration" section
   - Select from: Ascending, Descending, or Grouped

2. **Quick Filter Buttons**
   - **Show All**: Reset to display all tracks
   - **Numeric Only**: Filter to show only numeric tracks
   - **First 5**: Show only the first 5 tracks
   - **Group A/B**: Split tracks into two groups

## Programmatic Usage

### Configuration Object

The `tracksConfig` state object supports the following properties:

```javascript
{
  sortMode: 'asc',      // 'asc' | 'desc' | 'custom' | 'grouped'
  customSort: null,     // Function: (track1, track2) => number
  groups: null,         // Array: [{ name, tracks, order }]
  filter: null,         // Function: (track) => boolean
  trackList: null       // Array: ['track1', 'track2', ...]
}
```

### Examples

#### Example 1: Custom Sorting
Sort tracks in reverse alphabetical order:

```javascript
setTracksConfig({
  sortMode: 'custom',
  customSort: (a, b) => b.localeCompare(a)
});
```

#### Example 2: Custom Filtering
Show only even-numbered tracks:

```javascript
setTracksConfig({
  filter: (track) => {
    const num = parseFloat(track);
    return !isNaN(num) && num % 2 === 0;
  }
});
```

#### Example 3: Explicit Track List
Display only specific tracks:

```javascript
setTracksConfig({
  trackList: ['track1', 'track3', 'track5']
});
```

#### Example 4: Advanced Grouping
Create custom groups with specific tracks:

```javascript
setTracksConfig({
  sortMode: 'grouped',
  groups: [
    {
      name: 'High Priority',
      tracks: ['track1', 'track2', 'track3'],
      order: 0
    },
    {
      name: 'Medium Priority',
      tracks: ['track4', 'track5'],
      order: 1
    },
    {
      name: 'Low Priority',
      tracks: ['track6', 'track7', 'track8'],
      order: 2
    }
  ]
});
```

#### Example 5: Dynamic Grouping by Value
Group tracks based on utilization:

```javascript
// First, analyze your data to determine which tracks belong in which group
const highUtilTracks = [...]; // tracks with high utilization
const medUtilTracks = [...];  // tracks with medium utilization
const lowUtilTracks = [...];  // tracks with low utilization

setTracksConfig({
  sortMode: 'grouped',
  groups: [
    { name: 'High Utilization', tracks: highUtilTracks, order: 0 },
    { name: 'Medium Utilization', tracks: medUtilTracks, order: 1 },
    { name: 'Low Utilization', tracks: lowUtilTracks, order: 2 }
  ]
});
```

## Implementation Details

### processTracksConfig Function

The core function that handles all track processing:

```javascript
function processTracksConfig(data, config = {})
```

**Parameters:**
- `data`: Array of chart data objects
- `config`: Configuration object (see above)

**Returns:**
```javascript
{
  processedData: [...],  // Filtered data
  trackOrder: [...],     // Ordered array of track names
  trackGroups: [...]     // Group information (if in grouped mode)
}
```

### Processing Order

1. **Extract unique tracks** from data
2. **Apply filtering** (trackList or filter function)
3. **Apply sorting/grouping**:
   - If `sortMode === 'grouped'` and groups exist: organize into groups
   - If `sortMode === 'custom'` and customSort exists: apply custom function
   - If `sortMode === 'desc'`: sort descending
   - Otherwise: sort ascending (default)
4. **Filter data** to only include selected tracks
5. **Return processed data** with track order

### Visual Group Separators

When using grouped mode, the chart automatically adds dashed horizontal lines between groups for better visual separation.

## Best Practices

1. **Start Simple**: Use the built-in sort modes and quick filters before creating custom functions
2. **Performance**: For large datasets, filtering reduces the amount of data rendered, improving performance
3. **Group Size**: Keep groups balanced for better visualization (avoid very small or very large groups)
4. **Dynamic Updates**: The chart updates automatically when you change the configuration
5. **Ungrouped Tracks**: In grouped mode, any tracks not assigned to a group are automatically placed in an "Other" group at the end

## Troubleshooting

### Chart is Empty
- Check if your filter is too restrictive
- Verify that the tracks in your `trackList` or `groups` actually exist in the data
- Use "Show All" to reset filters

### Sorting Not Working
- Ensure `sortMode` is set correctly
- For custom sorting, verify your `customSort` function returns a number

### Groups Not Showing
- Set `sortMode` to `'grouped'`
- Ensure `groups` array is properly formatted
- Each group must have: `name`, `tracks` (array), and optionally `order` (number)

## API Integration

The tracks configuration works seamlessly with the existing API. The filtering and sorting happens client-side after data is fetched, so no changes to the backend API are required.

## Future Enhancements

Potential future additions:
- Save/load track configurations
- Preset configurations for common use cases
- Interactive drag-and-drop track reordering
- Search and multi-select track filtering UI
- Export configuration as JSON

## Support

For issues or questions, please refer to the main README.md or open an issue in the project repository.


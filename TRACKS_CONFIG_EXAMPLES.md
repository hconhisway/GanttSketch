# Advanced Track Configuration Examples

This document provides advanced examples for configuring tracks in GanttSketch.

## Example 1: Range-Based Filtering

Show only tracks within a specific range:

```javascript
// Show tracks 10-20
setTracksConfig({
  filter: (track) => {
    const num = parseFloat(track);
    return !isNaN(num) && num >= 10 && num <= 20;
  }
});
```

## Example 2: Pattern-Based Filtering

Filter tracks by name pattern:

```javascript
// Show only tracks that contain "GPU"
setTracksConfig({
  filter: (track) => track.toString().includes('GPU')
});

// Show only tracks that start with "CPU"
setTracksConfig({
  filter: (track) => track.toString().startsWith('CPU')
});

// Show tracks matching a regex pattern
setTracksConfig({
  filter: (track) => /^(GPU|CPU)_\d+$/.test(track.toString())
});
```

## Example 3: Multi-Level Grouping

Create hierarchical grouping based on track characteristics:

```javascript
// Assuming tracks are named like: "CPU_0", "CPU_1", "GPU_0", "GPU_1", "MEM_0"
const uniqueTracks = [...new Set(data.map(d => d.track))];

const cpuTracks = uniqueTracks.filter(t => t.toString().startsWith('CPU'));
const gpuTracks = uniqueTracks.filter(t => t.toString().startsWith('GPU'));
const memTracks = uniqueTracks.filter(t => t.toString().startsWith('MEM'));
const otherTracks = uniqueTracks.filter(t => 
  !t.toString().startsWith('CPU') && 
  !t.toString().startsWith('GPU') && 
  !t.toString().startsWith('MEM')
);

setTracksConfig({
  sortMode: 'grouped',
  groups: [
    { name: 'CPU Resources', tracks: cpuTracks.sort(), order: 0 },
    { name: 'GPU Resources', tracks: gpuTracks.sort(), order: 1 },
    { name: 'Memory Resources', tracks: memTracks.sort(), order: 2 },
    { name: 'Other Resources', tracks: otherTracks.sort(), order: 3 }
  ]
});
```

## Example 4: Dynamic Grouping by Data Characteristics

Group tracks based on their utilization patterns:

```javascript
// Calculate average utilization per track
const trackStats = {};
data.forEach(d => {
  if (!trackStats[d.track]) {
    trackStats[d.track] = { sum: 0, count: 0 };
  }
  trackStats[d.track].sum += d.utilValue;
  trackStats[d.track].count++;
});

// Categorize tracks by average utilization
const highUtil = [];
const mediumUtil = [];
const lowUtil = [];

Object.keys(trackStats).forEach(track => {
  const avg = trackStats[track].sum / trackStats[track].count;
  if (avg >= 0.8) {
    highUtil.push(track);
  } else if (avg >= 0.4) {
    mediumUtil.push(track);
  } else {
    lowUtil.push(track);
  }
});

setTracksConfig({
  sortMode: 'grouped',
  groups: [
    { name: 'High Utilization (≥80%)', tracks: highUtil, order: 0 },
    { name: 'Medium Utilization (40-80%)', tracks: mediumUtil, order: 1 },
    { name: 'Low Utilization (<40%)', tracks: lowUtil, order: 2 }
  ]
});
```

## Example 5: Custom Sort by Utilization

Sort tracks by their total utilization (most active first):

```javascript
// Calculate total utilization per track
const trackTotals = {};
data.forEach(d => {
  if (!trackTotals[d.track]) {
    trackTotals[d.track] = 0;
  }
  trackTotals[d.track] += d.utilValue;
});

setTracksConfig({
  sortMode: 'custom',
  customSort: (a, b) => {
    const totalA = trackTotals[a] || 0;
    const totalB = trackTotals[b] || 0;
    return totalB - totalA; // Sort by highest utilization first
  }
});
```

## Example 6: Combining Multiple Filters

Apply multiple filter conditions:

```javascript
setTracksConfig({
  filter: (track) => {
    const num = parseFloat(track);
    const isNumeric = !isNaN(num);
    const isEven = num % 2 === 0;
    const inRange = num >= 0 && num <= 50;
    
    // Only show numeric, even tracks between 0-50
    return isNumeric && isEven && inRange;
  }
});
```

## Example 7: Top N Most Active Tracks

Show only the N most active tracks:

```javascript
function showTopNTracks(n) {
  // Calculate activity per track (count of data points)
  const trackActivity = {};
  data.forEach(d => {
    trackActivity[d.track] = (trackActivity[d.track] || 0) + 1;
  });
  
  // Sort tracks by activity
  const sortedTracks = Object.keys(trackActivity).sort((a, b) => 
    trackActivity[b] - trackActivity[a]
  );
  
  // Take top N
  const topN = sortedTracks.slice(0, n);
  
  setTracksConfig({
    trackList: topN
  });
}

// Show top 10 most active tracks
showTopNTracks(10);
```

## Example 8: Exclude Specific Tracks

Hide certain tracks while showing all others:

```javascript
const excludeList = ['track5', 'track12', 'track23'];

setTracksConfig({
  filter: (track) => !excludeList.includes(track)
});
```

## Example 9: Alternating Group Pattern

Create alternating groups for visual distinction:

```javascript
const uniqueTracks = [...new Set(data.map(d => d.track))].sort();
const evenTracks = uniqueTracks.filter((_, idx) => idx % 2 === 0);
const oddTracks = uniqueTracks.filter((_, idx) => idx % 2 === 1);

setTracksConfig({
  sortMode: 'grouped',
  groups: [
    { name: 'Group 1', tracks: evenTracks, order: 0 },
    { name: 'Group 2', tracks: oddTracks, order: 1 }
  ]
});
```

## Example 10: Smart Auto-Grouping

Automatically detect and group tracks by common prefixes:

```javascript
function autoGroupByPrefix() {
  const uniqueTracks = [...new Set(data.map(d => d.track))];
  const prefixMap = {};
  
  uniqueTracks.forEach(track => {
    const trackStr = track.toString();
    const match = trackStr.match(/^([A-Za-z]+)/);
    const prefix = match ? match[1] : 'Other';
    
    if (!prefixMap[prefix]) {
      prefixMap[prefix] = [];
    }
    prefixMap[prefix].push(track);
  });
  
  const groups = Object.keys(prefixMap)
    .sort()
    .map((prefix, idx) => ({
      name: prefix,
      tracks: prefixMap[prefix].sort(),
      order: idx
    }));
  
  setTracksConfig({
    sortMode: 'grouped',
    groups: groups
  });
}

autoGroupByPrefix();
```

## Example 11: Temporal Filtering

Show tracks that have activity in a specific time range:

```javascript
function showTracksActiveInTimeRange(startTime, endTime) {
  const activeTracks = new Set();
  
  data.forEach(d => {
    const dataStart = d.timeStart.getTime();
    const dataEnd = d.timeEnd.getTime();
    
    // Check if this data point overlaps with our time range
    if (dataStart <= endTime && dataEnd >= startTime) {
      activeTracks.add(d.track);
    }
  });
  
  setTracksConfig({
    trackList: Array.from(activeTracks).sort()
  });
}

// Show tracks active between two timestamps
const start = new Date('2024-01-01').getTime();
const end = new Date('2024-01-02').getTime();
showTracksActiveInTimeRange(start, end);
```

## Example 12: Composite Configuration

Combine multiple configuration options:

```javascript
// Show only numeric tracks, sorted by value, in groups of 10
const uniqueTracks = [...new Set(data.map(d => d.track))];
const numericTracks = uniqueTracks
  .filter(t => !isNaN(parseFloat(t)))
  .sort((a, b) => parseFloat(a) - parseFloat(b));

const groupSize = 10;
const groups = [];
for (let i = 0; i < numericTracks.length; i += groupSize) {
  const groupTracks = numericTracks.slice(i, i + groupSize);
  groups.push({
    name: `Tracks ${i + 1}-${i + groupTracks.length}`,
    tracks: groupTracks,
    order: i / groupSize
  });
}

setTracksConfig({
  sortMode: 'grouped',
  groups: groups,
  filter: (track) => !isNaN(parseFloat(track))
});
```

## Integration with React State

Here's how to integrate these examples into a React component:

```javascript
// Add a button to apply a configuration
const applyHighUtilizationFilter = () => {
  const trackStats = {};
  data.forEach(d => {
    if (!trackStats[d.track]) {
      trackStats[d.track] = { sum: 0, count: 0 };
    }
    trackStats[d.track].sum += d.utilValue;
    trackStats[d.track].count++;
  });

  setTracksConfig({
    filter: (track) => {
      const stats = trackStats[track];
      if (!stats) return false;
      const avg = stats.sum / stats.count;
      return avg >= 0.7; // Show only tracks with >70% average utilization
    }
  });
};

// In your JSX:
<button onClick={applyHighUtilizationFilter}>
  Show High Utilization Only
</button>
```

## Performance Tips

1. **Memoize expensive calculations**: If you're doing complex filtering or grouping, consider using `useMemo` to avoid recalculating on every render.

```javascript
const tracksConfig = useMemo(() => {
  // Expensive calculations here
  return {
    sortMode: 'grouped',
    groups: calculateGroups(data)
  };
}, [data]);
```

2. **Debounce filter updates**: If allowing user input for filtering, debounce the updates:

```javascript
const [filterText, setFilterText] = useState('');

useEffect(() => {
  const timer = setTimeout(() => {
    setTracksConfig({
      filter: (track) => track.toString().includes(filterText)
    });
  }, 300);
  
  return () => clearTimeout(timer);
}, [filterText]);
```

3. **Limit group size**: Very large groups or many small groups can impact performance. Aim for 5-20 tracks per group.

## Troubleshooting Advanced Configurations

### Issue: Custom sort not working as expected
**Solution**: Ensure your sort function returns a number (not boolean). Use subtraction for numbers, `.localeCompare()` for strings.

### Issue: Grouped mode not showing separators
**Solution**: Verify that `sortMode` is set to `'grouped'` and that each group has at least one track that exists in the data.

### Issue: Filter removing all tracks
**Solution**: Log the filter function's results to debug:
```javascript
filter: (track) => {
  const result = /* your filter logic */;
  console.log(`Track ${track}: ${result}`);
  return result;
}
```

## Conclusion

These examples demonstrate the flexibility of the tracks configuration system. You can combine sorting, filtering, and grouping to create exactly the view you need for your Gantt chart data. Experiment with these patterns and adapt them to your specific use case!


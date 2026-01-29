# Visual Grouping Guide

## Overview

The enhanced visual grouping feature provides rich visual indicators when tracks are organized into groups, making it easy to understand the structure of your data at a glance.

## Visual Elements

### 1. **Group Labels** 📍
- **Location**: Left side of the Y-axis
- **Style**: 12px bold text in purple (#667eea)
- **Position**: Centered vertically within each group
- **Content**: Custom names or default "Group 1", "Group 2", etc.

### 2. **Background Colors** 🎨
- **Pattern**: Alternating subtle backgrounds
- **Colors**: 
  - Even groups (0, 2, 4...): Light gray (#f8f9fa)
  - Odd groups (1, 3, 5...): White (#ffffff)
- **Opacity**: 50% for subtle distinction
- **Purpose**: Visual separation without distraction

### 3. **Separator Lines** ➖
- **Style**: Dashed lines (4px dash, 4px gap)
- **Color**: Medium gray (#999)
- **Width**: 2px
- **Location**: Between groups (horizontal lines)
- **Purpose**: Clear boundaries between group regions

### 4. **Dynamic Layout** 📐
- **Left Margin**: Automatically expands from 80px to 120px
- **Y-Axis Label**: Hidden in grouped mode to reduce clutter
- **Height**: Adjusts based on number of tracks and groups

## Examples

### Example 1: Two Groups with Default Names

```javascript
setTracksConfig({
  sortMode: 'grouped',
  groups: [
    { name: 'Group 1', tracks: ['0', '1', '2', '3', '4'], order: 0 },
    { name: 'Group 2', tracks: ['5', '6', '7', '8', '9'], order: 1 }
  ]
});
```

**Visual Result:**
```
        Group 1 ┐
                │ ← Light gray background
                ├─ Track 0 ■■■■■
                ├─ Track 1 ■■■
                ├─ Track 2 ■■■■
                ├─ Track 3 ■■
                └─ Track 4 ■■■■■
        ─ ─ ─ ─ ─ ─ ─ ─ ─  ← Dashed separator
        Group 2 ┐
                │ ← White background
                ├─ Track 5 ■■
                ├─ Track 6 ■■■■
                ├─ Track 7 ■■
                ├─ Track 8 ■■■
                └─ Track 9 ■■■■■
```

### Example 2: Named Priority Groups

```javascript
setTracksConfig({
  sortMode: 'grouped',
  groups: [
    { name: 'Critical', tracks: ['0', '1', '2'], order: 0 },
    { name: 'Important', tracks: ['3', '4', '5', '6'], order: 1 },
    { name: 'Normal', tracks: ['7', '8', '9'], order: 2 }
  ]
});
```

**Visual Result:**
```
        Critical ┐
                 │ ← Light gray background
                 ├─ Track 0 ■■■■■
                 ├─ Track 1 ■■■
                 └─ Track 2 ■■■■
        ─ ─ ─ ─ ─ ─ ─ ─ ─  
        Important ┐
                  │ ← White background
                  ├─ Track 3 ■■
                  ├─ Track 4 ■■■■■
                  ├─ Track 5 ■■
                  └─ Track 6 ■■■
        ─ ─ ─ ─ ─ ─ ─ ─ ─  
        Normal ┐
               │ ← Light gray background
               ├─ Track 7 ■■■■
               ├─ Track 8 ■■
               └─ Track 9 ■■■■■
```

### Example 3: Resource Type Grouping

```javascript
setTracksConfig({
  sortMode: 'grouped',
  groups: [
    { name: 'CPU Resources', tracks: ['CPU_0', 'CPU_1', 'CPU_2'], order: 0 },
    { name: 'GPU Resources', tracks: ['GPU_0', 'GPU_1'], order: 1 },
    { name: 'Memory', tracks: ['MEM_0', 'MEM_1', 'MEM_2', 'MEM_3'], order: 2 }
  ]
});
```

## LLM Integration

The visual grouping works seamlessly with LLM-powered configuration:

### Natural Language Examples

**User:** "Split tracks into high priority (0-5) and low priority (6-10)"

**Result:** Two groups with custom names and visual indicators

---

**User:** "Group tracks into 3 equal groups"

**Result:** Three groups named "Group 1", "Group 2", "Group 3" with visual indicators

---

**User:** "Organize CPU and GPU tracks separately"

**Result:** Two groups with descriptive names and visual indicators

## Technical Implementation

### Rendering Order

1. **Background rectangles** (bottom layer)
   - Spans the full width of chart
   - Covers all tracks in the group
   - Subtle opacity for non-intrusive effect

2. **Data bars** (middle layer)
   - Track utilization rectangles
   - Displayed on top of backgrounds
   - Full interactivity maintained

3. **Separator lines** (middle layer)
   - Horizontal lines at group boundaries
   - Dashed style for visual distinction

4. **Group labels** (top layer)
   - Text marks positioned on the left
   - Bold styling for emphasis
   - Color matched to theme

### Layout Calculations

```javascript
// Calculate label position (centered in group)
const firstTrackIndex = trackOrder.indexOf(group.tracks[0]);
const lastTrackIndex = trackOrder.indexOf(group.tracks[group.tracks.length - 1]);
const middlePosition = (firstTrackIndex + lastTrackIndex) / 2;

// Position label at the middle track
groupLabels.push({
  groupName: group.name,
  trackPosition: trackOrder[Math.round(middlePosition)],
  time: timeExtent[0]  // Left edge of chart
});
```

## Best Practices

### 1. **Group Naming**
- ✅ Use descriptive names when context is clear
- ✅ Use default numbers when splitting generically
- ✅ Keep names concise (15 characters or less)
- ❌ Avoid very long names that might overflow

### 2. **Group Size**
- ✅ Aim for 3-10 tracks per group for optimal readability
- ✅ Balance group sizes when possible
- ⚠️ Very small groups (1-2 tracks) work but may look sparse
- ⚠️ Very large groups (20+) may make labels harder to read

### 3. **Number of Groups**
- ✅ 2-5 groups provide excellent visual distinction
- ✅ Up to 8 groups is reasonable
- ⚠️ 10+ groups may become visually cluttered

### 4. **Color Contrast**
- The alternating backgrounds work best with:
  - Light-colored chart backgrounds
  - Standard theme colors
  - Not overlapping with data color schemes

## Customization Options

### Current Implementation
- Background colors: Fixed alternating pattern
- Label color: Purple (#667eea)
- Label font: 12px bold
- Separator style: 2px dashed

### Future Enhancements (Planned)
- [ ] Custom background colors per group
- [ ] Custom label colors
- [ ] Adjustable label font size
- [ ] Different separator styles
- [ ] Group collapse/expand functionality
- [ ] Drag-and-drop group reordering

## Accessibility

- **Color Independence**: Groups are distinguished by both color AND separators
- **Text Labels**: Clear text labels for screen readers
- **High Contrast**: Bold labels with good contrast ratio
- **Predictable Pattern**: Consistent alternating pattern

## Browser Compatibility

Tested and working on:
- ✅ Chrome 90+
- ✅ Firefox 88+
- ✅ Safari 14+
- ✅ Edge 90+

## Troubleshooting

### Issue: Labels are cut off

**Cause:** Window is too narrow or zoom level is very high

**Solution:** 
- Expand the window width
- Reduce browser zoom level
- The 120px left margin should accommodate most labels

### Issue: Backgrounds are too prominent

**Cause:** High opacity may distract from data

**Solution:** 
- Background opacity is set to 0.5 (50%)
- Can be adjusted in `App.js` by changing `fillOpacity` value

### Issue: Group names overlap

**Cause:** Too many groups in small vertical space

**Solution:**
- Reduce number of groups
- Increase chart height
- Use shorter group names

## Performance

- **Rendering**: No performance impact (SVG-based)
- **Memory**: Minimal additional data structures
- **Scalability**: Works with 100+ tracks and 10+ groups

## Summary

The enhanced visual grouping system provides:
- 🎯 Clear visual hierarchy
- 📊 Better data organization
- 🎨 Professional appearance
- 💬 Seamless LLM integration
- ⚡ Zero performance overhead

Perfect for:
- Resource management dashboards
- Task prioritization views
- Multi-category analysis
- Team or department tracking
- Any scenario requiring logical track grouping

---

**Version:** 1.3.1  
**Last Updated:** 2025-11-06








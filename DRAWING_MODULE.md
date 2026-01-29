# Gantt Chart Drawing Module

## Overview

The Gantt Chart Drawing Module allows users to draw annotations directly on top of the Gantt chart visualization and export the annotated chart as a PNG image. This feature is useful for presentations, documentation, and collaborative discussions.

## Features

### 1. **Drawing Mode**
- Toggle between normal chart interaction and drawing mode
- Freehand drawing directly on the chart
- Visual indicator when drawing mode is active

### 2. **Drawing Tools**
- **Brush Color**: Choose from 10 preset colors
- **Brush Size**: Adjustable from 1 to 20 pixels
- **Color Picker**: Visual palette for quick color selection

### 3. **Drawing Controls**
- **Draw Button**: Toggle drawing mode on/off
- **Color Button**: Open color palette selector
- **Size Slider**: Adjust brush thickness
- **Clear Button**: Remove all drawings
- **Export Button**: Save annotated chart as PNG

### 4. **Export Functionality**
- Exports chart with all annotations as a high-quality PNG
- Automatic download with timestamp
- Confirms export with chat message
- Preserves chart quality and colors

## Usage

### Basic Drawing

1. **Enter Drawing Mode**
   - Click the "🖊️ Draw" button in the top-right corner of the chart
   - Button changes to "✏️ Drawing" when active
   - Chart overlay activates with crosshair cursor

2. **Draw Annotations**
   - Click and drag on the chart to draw
   - Drawings appear in real-time
   - Release mouse to complete a stroke

3. **Change Colors**
   - Click the color button (🎨)
   - Select from 10 preset colors
   - Current color shown on button

4. **Adjust Brush Size**
   - Use the size slider (1-20 pixels)
   - Current size displayed above slider
   - Affects new strokes only

5. **Clear Drawings**
   - Click "🗑️ Clear" button
   - Removes all annotations
   - Does not affect the underlying chart

6. **Export Annotated Chart**
   - Click "📥 Export" button
   - PNG file automatically downloads
   - Filename includes timestamp
   - Confirmation appears in chat

7. **Exit Drawing Mode**
   - Click the "✏️ Drawing" button
   - Returns to normal chart interaction
   - Drawings remain visible

## Technical Details

### File Structure

```
src/
├── GanttDrawingOverlay.js      # Main drawing component
├── GanttDrawingOverlay.css     # Drawing module styles
└── App.js                      # Integration with main app
```

### Component Architecture

#### GanttDrawingOverlay Component

**Props:**
- `isActive` (boolean): Controls drawing mode state
- `onToggle` (function): Callback to toggle drawing mode
- `onExport` (function): Callback when export is triggered

**Ref Methods:**
- `exportAnnotatedImage()`: Returns PNG blob of annotated chart
- `clearCanvas()`: Removes all drawings

**State Management:**
- `paths`: Array of completed drawing paths
- `currentPath`: SVG path data for active stroke
- `brushSize`: Current brush thickness (1-20)
- `brushColor`: Current drawing color (hex)
- `isDrawing`: Boolean flag for active drawing

### Drawing Implementation

The module uses SVG overlay technology:

1. **SVG Overlay Layer**
   - Transparent SVG positioned over chart
   - Captures mouse events when active
   - Renders drawing paths in real-time

2. **Path Tracking**
   - Mouse movements converted to SVG coordinates
   - Paths constructed using SVG path commands (M, L)
   - Completed paths saved with color/size metadata

3. **Export Process**
   - Clones original chart SVG
   - Appends drawing paths to clone
   - Converts to PNG via Canvas API
   - Downloads automatically

### Integration with App.js

```javascript
// Import component
import { GanttDrawingOverlay } from './GanttDrawingOverlay';

// Add state
const [isDrawingMode, setIsDrawingMode] = useState(false);

// Add ref
const drawingOverlayRef = useRef();

// Render in chart container
<div className="chart-container" style={{ position: 'relative' }}>
  <div ref={chartRef} className="chart"></div>
  <GanttDrawingOverlay
    ref={drawingOverlayRef}
    isActive={isDrawingMode}
    onToggle={setIsDrawingMode}
    onExport={handleExport}
  />
</div>
```

## Styling

The drawing module includes responsive styles:

### Desktop (> 900px)
- Controls positioned in top-right corner
- Full-size buttons and controls
- Horizontal layout

### Tablet (600-900px)
- Controls move to bottom
- Centered layout
- Slightly smaller controls

### Mobile (< 600px)
- Compact button sizes
- Smaller color palette
- Touch-friendly sizing

## Color Palette

The module includes 10 preset colors:
- 🔴 Red (#ff0000)
- 🟢 Green (#00ff00)
- 🔵 Blue (#0000ff)
- 🟡 Yellow (#ffff00)
- 🟣 Magenta (#ff00ff)
- 🔵 Cyan (#00ffff)
- ⚫ Black (#000000)
- ⚪ White (#ffffff)
- 🟠 Orange (#ffa500)
- 🟣 Purple (#800080)

## Browser Compatibility

- ✅ Chrome/Edge (latest)
- ✅ Firefox (latest)
- ✅ Safari (latest)
- ✅ Mobile browsers

## Performance Considerations

1. **Smooth Drawing**
   - Mouse events processed efficiently
   - Minimal re-renders during drawing
   - Optimized SVG path generation

2. **Export Quality**
   - High-resolution PNG output
   - Preserves chart dimensions
   - White background for clarity

3. **Memory Management**
   - URLs revoked after export
   - Canvas cleaned up properly
   - Efficient path storage

## Future Enhancements

Potential improvements:
- [ ] Undo/Redo functionality
- [ ] Text annotations
- [ ] Shape tools (rectangles, circles, arrows)
- [ ] Eraser tool
- [ ] Drawing layers
- [ ] Save/load annotations
- [ ] Custom color picker
- [ ] Line styles (dashed, dotted)
- [ ] Touch gesture support
- [ ] Collaborative drawing

## Troubleshooting

### Issue: Drawings not appearing
**Solution**: Ensure drawing mode is active (button shows "✏️ Drawing")

### Issue: Export produces blank image
**Solution**: Check that chart is rendered before exporting

### Issue: Can't click chart elements
**Solution**: Exit drawing mode to interact with chart

### Issue: Color picker not closing
**Solution**: Click a color or click outside the palette

### Issue: Drawings disappear on chart update
**Solution**: Drawings are preserved during data updates

## API Reference

### GanttDrawingOverlay

#### Props

| Prop | Type | Required | Description |
|------|------|----------|-------------|
| isActive | boolean | Yes | Controls drawing mode |
| onToggle | function | Yes | Callback to toggle mode |
| onExport | function | Yes | Callback on export |

#### Ref Methods

| Method | Returns | Description |
|--------|---------|-------------|
| exportAnnotatedImage() | Promise\<Blob\> | Exports chart as PNG |
| clearCanvas() | void | Clears all drawings |

#### Events

- **Mouse Down**: Starts new drawing stroke
- **Mouse Move**: Continues active stroke
- **Mouse Up**: Completes current stroke
- **Mouse Leave**: Completes stroke if active

## Examples

### Programmatic Export

```javascript
// Export from parent component
const exportChart = async () => {
  if (drawingOverlayRef.current) {
    const blob = await drawingOverlayRef.current.exportAnnotatedImage();
    // Handle blob (upload, display, etc.)
  }
};
```

### Programmatic Clear

```javascript
// Clear drawings from parent component
const clearDrawings = () => {
  if (drawingOverlayRef.current) {
    drawingOverlayRef.current.clearCanvas();
  }
};
```

### Custom Export Handler

```javascript
const handleExport = (blob) => {
  if (blob) {
    // Upload to server
    const formData = new FormData();
    formData.append('chart', blob, 'chart.png');
    
    fetch('/api/upload', {
      method: 'POST',
      body: formData
    });
  }
};
```

## License

This module is part of the GanttSketch project and follows the same license.

## Support

For issues or questions:
1. Check this documentation
2. Review the code comments
3. Test in different browsers
4. Check browser console for errors

---

**Version**: 1.0.0  
**Last Updated**: November 2025  
**Author**: GanttSketch Team


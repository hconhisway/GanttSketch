# Changelog

All notable changes to the GanttSketch project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.1] - 2025-11-06

### Added

#### Enhanced Visual Grouping for Tracks ✨

- **Group Labels on Y-Axis**: Bold, colored labels appear on the left side showing group names
- **Alternating Background Colors**: Each group has a subtle background (alternating light gray/white)
- **Enhanced Separator Lines**: Thicker, more visible dashed lines between groups
- **Dynamic Left Margin**: Chart automatically expands left margin when groups are present
- **Default Group Names**: Support for "Group 1", "Group 2", etc. when no custom names provided
- **Custom Group Names**: Fully customizable names like "High Priority", "CPU Resources"

### Changed

#### Modified Files

- `src/App.js`:
  - Added `groupLabels` calculation for positioned group labels
  - Implemented alternating background rectangles for group regions
  - Added `Plot.text()` marks for group labels on Y-axis
  - Increased left margin to 120px in grouped mode (from 80px)
  - Removed Y-axis label in grouped mode to avoid clutter
  - Reordered marks: backgrounds first, data second, labels last
  - Enhanced separator line visibility (strokeWidth: 2, color: #999)

- `src/tracksConfigPrompt.js`:
  - Enhanced group documentation with visual effect descriptions
  - Added guidance for default vs custom group names
  - Added Example 2b showing default numbered groups
  - Updated group schema documentation

- `TRACKS_CONFIG_GUIDE.md`:
  - Added "Visual Effects" section for grouping
  - Listed all visual indicators (labels, backgrounds, separators)
  - Added examples of default and custom names

- `LLM_TRACKS_CONFIG.md`:
  - Enhanced Example 4 result description
  - Added "Visual Effects" subsection to Grouped sort mode
  - Added "Group Naming" guidelines

- `README.md`:
  - Updated Track Configuration feature description
  - Added "Rich visual grouping" and "Group customization" items
  - Added VISUAL_GROUPING_GUIDE.md to project structure

#### New Files

- `VISUAL_GROUPING_GUIDE.md` - Comprehensive visual grouping documentation (300+ lines)

### Technical Details

#### Visual Layering

Marks are rendered in this order:

1. **Background rectangles** (bottom) - Subtle alternating colors
2. **Data rectangles** (middle) - Track utilization bars
3. **Separator lines** (middle) - Dashed lines between groups
4. **Group labels** (top) - Text labels on the left

#### Layout Calculations

- Group label position: Centered vertically within each group
- Label offset: -85px from Y-axis (dx property)
- Background spans: From first to last track in each group
- Time extent: Full width of the chart data

#### Styling

- Label font: 12px bold
- Label color: #667eea (purple)
- Background opacity: 0.5
- Background colors: #f8f9fa (even groups), #ffffff (odd groups)
- Separator: #999, 2px width, 4-4 dash pattern

---

## [1.3.0] - 2025-11-06

### Added

#### LLM-Powered Track Configuration System ✨

- **Natural language understanding**: LLM can interpret user requests like "show only tracks 5-10"
- **Structured output generation**: LLM generates JSON configurations automatically
- **Automatic application**: Configurations are parsed and applied to the chart instantly
- **Visual sketch understanding**: With vision-capable models, LLM can analyze drawings and annotations
- **Intent detection**: System understands filtering, sorting, and grouping requests
- **Confirmation messages**: System messages show when configurations are applied
- **Enhanced system prompt**: Specialized prompt teaches LLM about track configuration
- **Multiple filter types**: Range, list, pattern, and function-based filters
- **Smart parsing**: Robust JSON extraction and validation
- **Context awareness**: LLM receives current chart context (tracks, time range, data points)

#### New Files

- `src/tracksConfigPrompt.js` - LLM track configuration system (250+ lines)
  - `TRACKS_CONFIG_SYSTEM_PROMPT` - Comprehensive LLM instruction prompt
  - `parseTrackConfigFromResponse()` - JSON extraction from LLM responses
  - `convertLLMConfigToTracksConfig()` - Format conversion logic
  - `getEnhancedSystemPrompt()` - Context-aware prompt generation
  - `PREDEFINED_FILTER_FUNCTIONS` - Built-in filter functions
- `LLM_TRACKS_QUICK_START.md` - 5-minute quick start guide (300+ lines)
- `LLM_TRACKS_CONFIG.md` - Complete LLM tracks configuration guide (600+ lines)

### Changed

#### Modified Files

- `src/App.js`:
  - Imported tracks configuration prompt system
  - Enhanced `handleSendMessage()` to use context-aware system prompt
  - Added automatic parsing of LLM responses for track configurations
  - Added automatic application of parsed configurations
  - Added system message confirmation when config is applied
  - Improved chart context generation (tracks, time range, data points)

- `src/App.css`:
  - Added `.message.system` styles for system confirmation messages
  - Green gradient background for system messages
  - Centered alignment for system notifications
  - Added shadow and styling for better visibility

- `README.md`:
  - Added "Intelligent track configuration" to AI Chat Assistant features
  - Added vision support mention
  - Added example track configuration commands
  - Updated project structure to include new files
  - Added link to LLM_TRACKS_CONFIG.md

### Technical Details

#### Architecture

- **LLM Integration**: Seamless integration with existing chat system
- **Format Conversion**: Bidirectional conversion between LLM and internal formats
- **Error Handling**: Graceful handling of invalid configurations
- **Type Safety**: Robust parsing and validation

#### Supported Configurations

**Filter Types:**

- `range`: Numeric range filtering (e.g., tracks 5-10)
- `list`: Explicit track list (e.g., ["track1", "track5"])
- `pattern`: Regex pattern matching (e.g., "CPU.\*")
- `function`: Predefined functions (numeric_only, even_only, odd_only, top_n_utilization)

**Sort Modes:**

- `asc`: Ascending order
- `desc`: Descending order
- `grouped`: Custom groups with visual separators
- `custom`: Custom sorting functions

**Advanced Features:**

- Top N by utilization
- Multi-group organization
- Pattern-based filtering
- Conditional filtering

#### Example LLM Interactions

**User:** "Show only tracks 5 to 10"
**LLM:** Generates range filter configuration
**System:** Applies configuration and confirms

**User:** "Show me the 5 busiest tracks"
**LLM:** Generates top_n_utilization filter
**System:** Calculates utilization, applies filter, confirms

**User:** "Group into CPU (0-5) and GPU (6-10)"
**LLM:** Generates grouped configuration with two groups
**System:** Applies grouping with visual separators, confirms

#### Performance

- Lightweight JSON parsing
- Efficient filter function execution
- No performance impact on chart rendering
- Real-time configuration application

#### Browser Compatibility

- Chrome/Edge 90+ ✅
- Firefox 88+ ✅
- Safari 14+ ✅
- Mobile browsers ✅

### Documentation

- Complete LLM tracks configuration guide
- 5+ detailed usage examples with LLM interactions
- Filter type reference
- Sort mode reference
- Troubleshooting guide for LLM configurations
- Best practices for natural language requests
- Tips for visual annotation with vision models

---

## [1.2.0] - 2025-11-06

### Added

#### Track Configuration System

- **Flexible sorting** with multiple modes:
  - Ascending (default): alphabetical/numerical A-Z, 0-9
  - Descending: reverse order Z-A, 9-0
  - Custom: user-defined sorting functions
  - Grouped: organize tracks into logical groups
- **Smart filtering** capabilities:
  - Filter by custom functions
  - Explicit track list selection
  - Pre-built quick filters
- **Track grouping** with visual separators:
  - Create custom groups with names and order
  - Visual dashed lines between groups
  - Automatic "Other" group for ungrouped tracks
- **UI controls** in control panel:
  - Sort mode dropdown selector
  - Quick filter buttons (Show All, Numeric Only, First 5, Group A/B)
  - Responsive and intuitive design
- **Programmatic API** for advanced use:
  - `processTracksConfig()` function for data processing
  - `tracksConfig` state for configuration management
  - Full access to sorting, filtering, and grouping logic

#### New Files

- `TRACKS_CONFIG_GUIDE.md` - Complete guide for track configuration (400+ lines)
- `TRACKS_CONFIG_EXAMPLES.md` - Advanced usage examples (500+ lines)

### Changed

#### Modified Files

- `src/App.js`:
  - Added `processTracksConfig()` function for track processing
  - Added `tracksConfig` state with full configuration options
  - Updated chart rendering to apply track configuration
  - Added tracks configuration UI section
  - Updated plot configuration to use `trackOrder` domain
  - Added group separator marks in grouped mode
  - Added empty state handling for filtered tracks

- `src/App.css`:
  - Added `.tracks-config-section` styles
  - Added `.config-row` styles for configuration controls
  - Added button and select styling for config controls
  - Added hover and focus states
  - Added responsive design considerations

- `README.md`:
  - Added "Track Configuration" section in Features
  - Added track configuration usage tips
  - Updated project structure to include new documentation
  - Added links to configuration guides

### Technical Details

#### Architecture

- Non-destructive filtering (preserves original data)
- Flexible configuration object pattern
- Separation of data processing and rendering
- Reactive updates with React hooks

#### Features Detail

**Sorting Modes:**

- Ascending: Smart sorting (numeric-aware)
- Descending: Reverse sorting (numeric-aware)
- Custom: User-defined comparator function
- Grouped: Multi-group organization with order control

**Filtering Options:**

- Function-based filtering: `(track) => boolean`
- Explicit track lists: Array of track names
- Chainable with sorting and grouping

**Grouping System:**

- Groups defined with: name, tracks array, order
- Automatic handling of ungrouped tracks
- Visual separators between groups
- Preserves track order within groups

#### Performance

- Efficient Set operations for unique track extraction
- Optimized sorting algorithms
- Minimal re-renders with proper React dependency arrays
- Scales well with large track counts (100+)

#### Browser Compatibility

- Chrome/Edge 90+ ✅
- Firefox 88+ ✅
- Safari 14+ ✅
- Mobile browsers ✅

### Documentation

- Complete API reference for `processTracksConfig()`
- 12+ detailed usage examples
- Best practices and performance tips
- Troubleshooting guide
- Integration examples with React state
- Advanced patterns (dynamic grouping, temporal filtering, etc.)

---

## [1.1.0] - 2025-11-05

### Added

#### Drawing & Annotation Module

- **Freehand drawing** capability directly on Gantt chart
- **Drawing mode toggle** button to switch between normal and drawing mode
- **Color picker** with 10 preset colors for annotations
- **Brush size control** (1-20 pixels) with visual slider
- **Clear function** to remove all annotations
- **Export functionality** to save annotated charts as PNG images
- **Automatic download** of exported images with timestamp
- **Chat confirmation** message when export completes
- **Responsive design** for drawing controls (desktop, tablet, mobile)
- **Visual feedback** with cursor changes and button states

#### New Files

- `src/GanttDrawingOverlay.js` - Main drawing component (356 lines)
- `src/GanttDrawingOverlay.css` - Drawing module styles (197 lines)
- `DRAWING_MODULE.md` - Comprehensive technical documentation (500+ lines)
- `DRAWING_QUICK_START.md` - 5-minute tutorial guide (200+ lines)
- `DRAWING_EXAMPLES.md` - Practical usage examples and patterns (500+ lines)
- `IMPLEMENTATION_SUMMARY.md` - Complete implementation overview (500+ lines)
- `CHANGELOG.md` - This changelog file

### Changed

#### Modified Files

- `src/App.js`:
  - Added `GanttDrawingOverlay` import
  - Added `drawingOverlayRef` ref for component access
  - Added `isDrawingMode` state for drawing mode tracking
  - Added `handleExport` function for PNG download
  - Integrated overlay component in chart container
  - Made chart-container position relative for overlay placement

- `README.md`:
  - Added "Drawing & Annotation Module" section in Features
  - Updated project structure to include new files
  - Added drawing usage tips section
  - Added troubleshooting for drawing issues
  - Added links to drawing documentation
  - Updated Technology stack section

### Technical Details

#### Architecture

- SVG overlay system for non-destructive annotations
- React hooks for state management (useState, useRef, useCallback)
- Mouse event handling for drawing input
- Canvas API for high-quality PNG export
- Blob API for file downloads

#### Performance

- Optimized mouse event handlers with useCallback
- Efficient path storage and rendering
- Memory cleanup after exports
- Smooth 60 FPS drawing performance

#### Browser Compatibility

- Chrome/Edge 90+ ✅
- Firefox 88+ ✅
- Safari 14+ ✅
- Mobile browsers ✅

### Documentation

- Complete API reference for GanttDrawingOverlay component
- Step-by-step usage tutorials
- Common use cases and examples
- Best practices and tips
- Troubleshooting guide
- Future enhancement roadmap

---

## [1.0.0] - 2025-11-04

### Initial Release

#### Features

- Interactive Gantt chart visualization using Observable Plot
- Real-time data fetching from local service
- Three adjustable sliders:
  - Start Time control
  - End Time control
  - Bins parameter (10-2000)
- LLM-powered chat assistant
- Streaming responses for smooth UX
- Context-aware AI assistance
- Support for multiple LLM providers:
  - OpenAI (GPT-4, GPT-3.5)
  - Anthropic (Claude)
  - Ollama (local models)
  - Custom API endpoints

#### Project Structure

- React 18 application
- Observable Plot for visualizations
- D3.js for data manipulation
- Modern CSS3 layout
- Environment variable configuration

#### Documentation

- README.md with setup instructions
- LLM_SETUP.md for AI configuration
- QUICK_START.md for getting started
- env.example for environment setup

---

## Version History Summary

- **v1.3.1** (2025-11-06): Enhanced Visual Grouping for Tracks
- **v1.3.0** (2025-11-06): Added LLM-Powered Track Configuration System
- **v1.2.0** (2025-11-06): Added Track Configuration System
- **v1.1.0** (2025-11-05): Added Drawing & Annotation Module
- **v1.0.0** (2025-11-04): Initial release with Gantt chart and LLM chat

---

## Upcoming Features (Planned)

### v1.3.0 (Future)

- [ ] Save/load track configurations
- [ ] Preset track configurations for common use cases
- [ ] Interactive drag-and-drop track reordering
- [ ] Search UI for track filtering
- [ ] Multi-select track filter interface
- [ ] Export/import track configuration as JSON
- [ ] Undo/Redo functionality for drawings
- [ ] Text annotation tool
- [ ] Shape tools (rectangles, circles, arrows)

### v1.4.0 (Future)

- [ ] Track statistics dashboard
- [ ] Heatmap visualization mode
- [ ] Track comparison tools
- [ ] Eraser tool for selective removal
- [ ] Drawing layers management
- [ ] Save/load annotation data
- [ ] Export to SVG format

### v2.0.0 (Future)

- [ ] Real-time collaborative drawing
- [ ] User authentication
- [ ] Cloud storage for annotations and configurations
- [ ] Drawing history and versions
- [ ] Advanced export options (PDF, multiple formats)
- [ ] Track configuration presets library
- [ ] Advanced filtering with boolean logic

---

## Notes

### General

- Compatible with all modern browsers
- No additional dependencies required
- All processing is client-side only

### Drawing Module

- All exports are client-side only (no server uploads)
- Drawings are ephemeral (cleared on refresh unless saved)
- PNG exports preserve chart quality and resolution

### Track Configuration

- Configuration is client-side and ephemeral (resets on refresh)
- No performance impact with filtering (reduces rendered data)
- Works seamlessly with existing data API
- Supports tracks with any naming convention
- Numeric-aware sorting for mixed track names

### LLM Track Configuration

- Natural language processing for track configuration
- No training or setup required (uses existing LLM API)
- JSON-based structured output for reliability
- Automatic parsing and validation
- Works with any instruction-following LLM
- Vision support requires GPT-4 Vision or Claude 3
- All processing happens via your configured LLM API

---

## Contributors

- GanttSketch Development Team

## License

This project is provided as-is for demonstration purposes.

---

For detailed information about any version, please refer to:

- README.md for general usage
- DRAWING_MODULE.md for drawing features
- TRACKS_CONFIG_GUIDE.md for track configuration
- TRACKS_CONFIG_EXAMPLES.md for advanced configuration examples
- LLM_TRACKS_CONFIG.md for LLM-powered track configuration
- IMPLEMENTATION_SUMMARY.md for technical details

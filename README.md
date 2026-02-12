# OSFAT

A React application featuring an interactive Gantt chart built with Observable Plot, with an integrated LLM-powered chat assistant to help analyze and understand your data.

## Features

### Chart Visualization

- Interactive Gantt chart visualization from Observable notebook (https://observablehq.com/d/1e0e85adb79032c8)
- Real-time data fetching from local service
- Three adjustable sliders to control:
  - **Start Time**: Adjust the start time for data aggregation
  - **End Time**: Adjust the end time for data aggregation
  - **Bins**: Adjust the pixel window for data aggregation (10-2000)

### Track Configuration ✨ NEW

- **Flexible sorting**: Sort tracks ascending, descending, or with custom functions
- **Smart filtering**: Show only specific tracks or apply filter conditions
- **Rich visual grouping**: Organize tracks into groups with colored labels, backgrounds, and separators
- **Group customization**: Use default names (Group 1, Group 2) or custom names (High Priority, CPU Resources)
- **Quick filters**: Pre-built filters for common use cases
- Programmatic API for advanced customization
- See [TRACKS_CONFIG_GUIDE.md](./TRACKS_CONFIG_GUIDE.md) for detailed documentation
- See [TRACKS_CONFIG_EXAMPLES.md](./TRACKS_CONFIG_EXAMPLES.md) for advanced examples

### Drawing & Annotation Module ✨ NEW

- **Draw directly on the chart** with freehand annotations
- **Color picker** with 10 preset colors
- **Adjustable brush size** (1-20 pixels)
- **Export annotated charts** as high-quality PNG images
- **Clear drawings** with one click
- **Responsive controls** that work on all devices
- Perfect for presentations, documentation, and collaborative discussions
- See [DRAWING_MODULE.md](./DRAWING_MODULE.md) for detailed documentation

### AI Chat Assistant

- **LLM-powered chat panel** on the right side for real-time assistance
- **Streaming responses** for a smooth conversational experience
- Context-aware: The assistant knows about your current chart data
- **Intelligent track configuration** ✨ NEW: LLM understands natural language and visual sketches to automatically configure tracks
- Supports multiple LLM providers:
  - OpenAI (GPT-4, GPT-3.5)
  - Anthropic (Claude)
  - Ollama (local models)
  - Custom API endpoints
- Vision support for analyzing sketches and annotations (GPT-4 Vision, Claude 3)
- See [LLM_TRACKS_QUICK_START.md](./LLM_TRACKS_QUICK_START.md) for 5-minute quick start
- See [LLM_TRACKS_CONFIG.md](./LLM_TRACKS_CONFIG.md) for complete intelligent configuration guide

## Jupyter AnyWidget Module (Single File)

This repo includes a single-file `anywidget` wrapper that embeds the built React app into an iframe, hiding the right-side chat/controls so only the Gantt chart is shown.

**Key files**

- `scripts/build_anywidget_singlefile.py`: Generates the widget module from the build output.
- `gantt_anywidget.py`: Auto-generated widget module to import in Jupyter.

**How it works**

- Reads `build/static/js` and `build/static/css` bundles, base64-encodes them, and embeds them in `gantt_anywidget.py`.
- The widget `_esm` creates an iframe and loads the bundles via `data:` URLs.
- CSS overrides hide `.right-panel` and `.controls` so only the chart remains.

**Quick use**

```python
from gantt_anywidget import GanttWidget
GanttWidget(width="100%", height="600px")
```

## Prerequisites

Make sure your local data service is running and accessible. By default, the app expects data at:

```
http://127.0.0.1:8080/get-data-in-range
```

### API Endpoints

The application expects the following API endpoint:

**GET** `/get-data-in-range?bins={bins}&begin={begin}&end={end}`

Response format:

```json
{
  "metadata": {
    "begin": 1234567890000,
    "end": 1234567900000,
    "bins": 1000
  },
  "data": [
    {
      "track": "Track Name",
      "utils": [0.0, 0.5, 1.0, ...]
    }
  ]
}
```

### Data Format

- `metadata.begin`: Start timestamp (milliseconds)
- `metadata.end`: End timestamp (milliseconds)
- `metadata.bins`: Number of bins
- `data[].track`: Track identifier
- `data[].utils`: Array of utilization values (0.0 to 1.0+)

## Configuration

### Data Service Configuration

To change the data endpoint, edit the `API_URL` constant in `src/App.js`:

```javascript
const API_URL = 'http://127.0.0.1:8080/get-data-in-range';
```

### LLM Chat Assistant Configuration

To enable the AI chat assistant, you need to configure an LLM provider:

1. **Copy the example environment file:**

   ```bash
   cp env.example .env
   ```

2. **Add your API key to `.env`:**

   ```bash
   # For OpenAI
   REACT_APP_LLM_API_KEY=sk-your-openai-api-key-here

   # For Anthropic
   REACT_APP_LLM_API_KEY=sk-ant-your-anthropic-key-here

   # For Ollama (local) - no key needed
   REACT_APP_LLM_API_KEY=
   ```

3. **Configure the provider in `src/llmConfig.ts`:**
   - Set your preferred `apiEndpoint`
   - Choose your `model`
   - Adjust `temperature`, `maxTokens`, and other parameters
   - Customize the `systemPrompt` for your use case

For detailed setup instructions, see [LLM_SETUP.md](./LLM_SETUP.md).

## Installation

```bash
npm install
```

## Running the Application

```bash
npm start
```

The application will open in your browser at `http://localhost:3000` or `http://127.0.0.1:3000`.

**Note:** After setting up your `.env` file, restart the development server to load the new environment variables.

## Technologies Used

- React 18
- Observable Plot (for chart visualization)
- D3.js (for data manipulation)
- LLM Integration (OpenAI/Anthropic/Ollama)
- Server-Sent Events (SSE) for streaming responses
- CSS3 with modern flexbox layout

## Project Structure

```
OSFAT/
├── public/
│   └── index.html
├── src/
│   ├── App.js                     # Main application component with chart and chat
│   ├── App.css                    # Styling for layout and chat interface
│   ├── GanttDrawingOverlay.js     # Drawing module component
│   ├── GanttDrawingOverlay.css    # Drawing module styles
│   ├── llmConfig.ts               # LLM API configuration and streaming logic
│   ├── tracksConfigPrompt.js      # LLM tracks configuration system (NEW)
│   ├── index.js                   # Entry point
│   └── index.css                  # Global styles
├── env.example                    # Example environment variables file
├── LLM_SETUP.md                   # Detailed LLM setup guide
├── LLM_TRACKS_QUICK_START.md      # LLM tracks config quick start guide (NEW)
├── LLM_TRACKS_CONFIG.md           # LLM intelligent tracks configuration guide (NEW)
├── DRAWING_MODULE.md              # Drawing module documentation
├── TRACKS_CONFIG_GUIDE.md         # Track configuration guide
├── TRACKS_CONFIG_EXAMPLES.md      # Advanced track configuration examples
├── VISUAL_GROUPING_GUIDE.md       # Visual grouping guide (NEW)
├── package.json
└── README.md
```

## Usage Tips

### Using Track Configuration

The track configuration panel allows you to customize how tracks are displayed:

1. **Sort Mode Dropdown**: Choose how tracks are ordered:
   - **Ascending**: Default alphabetical/numerical order (A-Z, 0-9)
   - **Descending**: Reverse order (Z-A, 9-0)
   - **Grouped**: Organize tracks into custom groups

2. **Quick Filter Buttons**:
   - **Show All**: Display all tracks (reset filters)
   - **Numeric Only**: Show only numerically-named tracks
   - **First 5**: Display only the first 5 tracks
   - **Group A/B**: Split numeric tracks into two groups

3. **Programmatic Control**: Use the API for advanced configurations:
   ```javascript
   // Example: Show only tracks 0-10
   setTracksConfig({
     filter: (track) => {
       const num = parseFloat(track);
       return !isNaN(num) && num >= 0 && num <= 10;
     }
   });
   ```

For detailed documentation and advanced examples, see:

- [TRACKS_CONFIG_GUIDE.md](./TRACKS_CONFIG_GUIDE.md) - Complete guide
- [TRACKS_CONFIG_EXAMPLES.md](./TRACKS_CONFIG_EXAMPLES.md) - Advanced examples

### Using the Drawing Module

The drawing overlay allows you to annotate the chart:

1. **Enter Drawing Mode**: Click the "🖊️ Draw" button in the top-right of the chart
2. **Draw**: Click and drag on the chart to draw freehand annotations
3. **Change Color**: Click the 🎨 button and select from 10 colors
4. **Adjust Size**: Use the slider to change brush thickness (1-20 pixels)
5. **Clear**: Click 🗑️ Clear to remove all annotations
6. **Export**: Click 📥 Export to download the annotated chart as PNG
7. **Exit**: Click the "✏️ Drawing" button to return to normal mode

For detailed documentation, see [DRAWING_MODULE.md](./DRAWING_MODULE.md).

### Using the Chat Assistant

The chat assistant on the right panel is context-aware and can help you:

- **Understand the chart**: "What does this visualization show?"
- **Analyze data**: "Which track has the highest utilization?"
- **Get insights**: "What patterns do you see in the data?"
- **Learn about features**: "How do I adjust the time range?"
- **Configure tracks intelligently** ✨ NEW: "Show only tracks 5-10", "Group CPU and GPU tracks", "Display the 5 busiest tracks"

Example questions:

- "Explain what I'm looking at"
- "Which time period shows the most activity?"
- "How many tracks are displayed?"
- "What does the 'bins' parameter control?"

Example track configuration commands:

- "Show only tracks 0 to 10"
- "Display tracks containing CPU"
- "Show me the 5 busiest tracks"
- "Group tracks into high and low priority"
- "Filter to even numbered tracks only"

For detailed examples and capabilities, see [LLM_TRACKS_CONFIG.md](./LLM_TRACKS_CONFIG.md).

### Keyboard Shortcuts

- **Enter**: Send message (in chat input)
- **Shift+Enter**: New line (in chat input)

## Troubleshooting

### Chart Issues

**Problem**: "Error loading data" message

- Ensure your data service is running at `http://127.0.0.1:8080`
- Check the browser console for specific error messages
- Verify the API endpoint returns data in the expected format

**Problem**: Chart appears empty

- Check that the data service is returning non-zero utilization values
- Verify the time range contains data
- Adjust the bins parameter

### Drawing Module Issues

**Problem**: Drawings not appearing

- Ensure drawing mode is active (button shows "✏️ Drawing")
- Check that you're clicking and dragging within the chart area

**Problem**: Can't interact with chart

- Exit drawing mode by clicking the "✏️ Drawing" button
- Drawing mode blocks normal chart interactions

**Problem**: Export produces blank or partial image

- Wait for chart to fully render before exporting
- Try toggling drawing mode off and on again
- Check browser console for errors

**Problem**: Drawings disappear

- Drawings are preserved during data updates
- If they disappear, it may be a browser rendering issue - try refreshing

### Chat Assistant Issues

**Problem**: Chat not responding

- Check your `.env` file has the correct API key
- Verify your API key is valid and has available credits
- Check browser console for error messages
- See [LLM_SETUP.md](./LLM_SETUP.md) for detailed troubleshooting

**Problem**: "API key not found" error

- Create a `.env` file based on `env.example`
- Add your API key: `REACT_APP_LLM_API_KEY=your-key-here`
- Restart the development server

**Problem**: Slow responses

- Try switching to a faster model (e.g., `gpt-3.5-turbo`)
- Consider using Ollama for local, instant responses
- Check your internet connection

## Security Notes

⚠️ **Important**: Never commit your `.env` file or expose your API keys!

- The `.env` file contains sensitive API keys
- Add `.env` to your `.gitignore`
- Use environment variables for all sensitive data
- Rotate API keys regularly
- Set usage limits in your API provider dashboard

## Contributing

Feel free to submit issues and enhancement requests!

## License

This project is provided as-is for demonstration purposes.

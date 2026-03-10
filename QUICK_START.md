# Quick Start Guide - LLM Chat Panel

## What's New?

Your OSFAT application now has an **AI-powered chat assistant** on the right side! The assistant can help you understand and analyze your Gantt chart data in real-time with streaming responses.

## Get Started in 3 Steps

### Step 1: Choose Your LLM Provider

**Default: Server (proxy)** — No setup needed if the site is deployed with the LLM proxy (see [DEPLOY.md](./DEPLOY.md)). The app uses the server’s key; you never enter it in the browser.

**Or use your own key (BYOK):** In the app, open **API Configuration**, switch provider to OpenAI/Anthropic/etc., and enter your API key.

**Local dev with a built-in key (optional):**

#### Option A: OpenAI

```bash
# 1. Get API key from https://platform.openai.com/api-keys
# 2. Create .env file (local dev only; do NOT use for production build):
echo "REACT_APP_LLM_API_KEY=sk-your-openai-key-here" > .env
echo "REACT_APP_LLM_PROVIDER=openai" >> .env
```

#### Option B: Anthropic Claude

```bash
# Create .env and set provider in app or .env (local dev only)
echo "REACT_APP_LLM_PROVIDER=anthropic" > .env
# Then in app: API Configuration → Anthropic, enter your key
```

#### Option C: Ollama (Local, Free, No API Key!)

```bash
# 1. Install Ollama from https://ollama.ai/
# 2. Pull a model: ollama pull llama2
# 3. Start Ollama: ollama serve
# 4. In app: API Configuration → Ollama (no key needed)
```

### Step 2: Start the App

```bash
npm start
```

**Important**: If you just created the `.env` file, restart your dev server!

### Step 3: Try It Out!

Once the app loads, you'll see a chat panel on the right. Try asking:

- "What does this chart show?"
- "Which track has the highest utilization?"
- "Explain the time range I'm looking at"
- "How does the bins parameter work?"

## Layout

```
┌─────────────────────────────────────┬──────────────────┐
│                                     │  Chart Assistant │
│  Controls (Sliders)                 │                  │
│  ┌─────────────┐                    │  💬 Chat        │
│  │ Start Time  │                    │                  │
│  │ End Time    │                    │  [Messages...]  │
│  │ Bins        │                    │                  │
│  └─────────────┘                    │                  │
│                                     │                  │
│  ┌─────────────────────────────┐   │                  │
│  │                             │   │  ┌────────────┐  │
│  │   Gantt Chart               │   │  │ Ask me...  │  │
│  │   Visualization             │   │  └────────────┘  │
│  │                             │   │  [Send Button]   │
│  └─────────────────────────────┘   │                  │
└─────────────────────────────────────┴──────────────────┘
```

## Features

✅ **Streaming Responses** - See the AI's response appear in real-time  
✅ **Context-Aware** - The assistant knows about your current chart data  
✅ **Beautiful UI** - Modern chat interface with smooth animations  
✅ **Keyboard Shortcuts** - Press Enter to send, Shift+Enter for new line  
✅ **Responsive** - Works on different screen sizes

## Configuration Files

- **`src/llmConfig.ts`** - Main configuration (API endpoint, model, parameters)
- **`.env`** - Your API key (never commit this!)
- **`env.example`** - Template for setting up `.env`

## Common Issues

### "API key not found"

→ Create a `.env` file with your API key and restart the server

### "HTTP error! status: 401"

→ Your API key is invalid or expired

### Chat appears but doesn't respond

→ Check browser console for errors  
→ Verify your API endpoint in `src/llmConfig.ts`  
→ Make sure you have API credits (for OpenAI/Anthropic)

### Want to use a local model?

→ Use Ollama! It's free, fast, and runs on your computer

## Next Steps

- Read [LLM_SETUP.md](./LLM_SETUP.md) for detailed configuration
- Customize the system prompt in `src/llmConfig.ts`
- Adjust temperature, maxTokens, and other parameters
- Try different models to find what works best

## Support

- OpenAI Docs: https://platform.openai.com/docs
- Anthropic Docs: https://docs.anthropic.com
- Ollama Docs: https://ollama.ai/docs

Enjoy your new AI-powered chart assistant! 🚀

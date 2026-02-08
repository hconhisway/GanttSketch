# LLM Chat Panel Setup Guide

This guide will help you configure the LLM API for the Chart Assistant panel.

## Quick Start

### 1. Choose Your LLM Provider

The application supports multiple LLM providers:

- **OpenAI** (GPT-4, GPT-3.5-turbo)
- **Anthropic** (Claude)
- **Ollama** (Local models)
- **Custom API endpoints**

### 2. Get Your API Key

#### For OpenAI:

1. Visit [OpenAI Platform](https://platform.openai.com/api-keys)
2. Sign up or log in
3. Navigate to API keys section
4. Create a new API key
5. Copy the key (you won't be able to see it again)

#### For Anthropic:

1. Visit [Anthropic Console](https://console.anthropic.com/)
2. Sign up or log in
3. Navigate to API keys
4. Create a new API key
5. Copy the key

#### For Ollama (Local):

1. Install Ollama from [ollama.ai](https://ollama.ai/)
2. Run `ollama pull llama2` (or any model you prefer)
3. Start Ollama server: `ollama serve`
4. No API key needed!

### 3. Set Up Environment Variables

Create a `.env` file in the root directory of your project:

```bash
# For OpenAI
REACT_APP_LLM_API_KEY=sk-your-actual-openai-api-key-here
REACT_APP_LLM_PROVIDER=openai
REACT_APP_LLM_MODEL=gpt-4

# For Anthropic
REACT_APP_LLM_API_KEY=sk-ant-your-actual-anthropic-key-here
REACT_APP_LLM_PROVIDER=anthropic
REACT_APP_LLM_MODEL=claude-3-opus-20240229

# For Ollama (local)
REACT_APP_LLM_PROVIDER=ollama
REACT_APP_LLM_OLLAMA_ENDPOINT=http://localhost:11434/api/chat
REACT_APP_LLM_OLLAMA_MODEL=llama2
```

Optional overrides (all strings):
- `REACT_APP_LLM_API_ENDPOINT`
- `REACT_APP_LLM_STREAM` (`true` or `false`)
- `REACT_APP_LLM_TIMEOUT` (ms)
- `REACT_APP_LLM_TEMPERATURE`
- `REACT_APP_LLM_MAX_TOKENS`
- `REACT_APP_LLM_SYSTEM_PROMPT`
- `REACT_APP_LLM_ANTHROPIC_VERSION`

### 4. Configure the LLM Settings

Edit `src/llmConfig.ts` to customize your LLM integration:

#### For OpenAI:

```javascript
const LLMConfig = {
  apiEndpoint: 'https://api.openai.com/v1/chat/completions',
  model: 'gpt-4', // or 'gpt-3.5-turbo' for faster/cheaper responses
  provider: {
    name: 'openai'
  }
  // ... other settings
};
```

#### For Anthropic Claude:

```javascript
const LLMConfig = {
  apiEndpoint: 'https://api.anthropic.com/v1/messages',
  model: 'claude-3-opus-20240229', // or 'claude-3-sonnet-20240229'
  provider: {
    name: 'anthropic',
    anthropic: {
      version: '2023-06-01'
    }
  }
  // ... other settings
};
```

#### For Ollama (Local):

```javascript
const LLMConfig = {
  apiEndpoint: 'http://localhost:11434/api/chat',
  model: 'llama2', // or 'mistral', 'codellama', etc.
  provider: {
    name: 'ollama',
    ollama: {
      endpoint: 'http://localhost:11434/api/chat',
      model: 'llama2'
    }
  }
  // ... other settings
};
```

### 5. Customize the System Prompt

The system prompt guides how the LLM responds. Edit it in `src/llmConfig.ts`:

```javascript
systemPrompt: `You are a helpful assistant that helps users understand and analyze Gantt charts and time-series data. 
You can help interpret the visualization, answer questions about the data, and provide insights about task scheduling and resource utilization.`;
```

### 6. Adjust Other Settings

You can customize these parameters in `src/llmConfig.ts`:

- **temperature** (0-2): Controls randomness. Lower = more focused, Higher = more creative
- **maxTokens**: Maximum length of response
- **stream**: Enable/disable streaming responses (keep `true` for better UX)
- **timeout**: Request timeout in milliseconds

### 7. Start the Application

```bash
npm start
```

The chat panel will appear on the right side of the screen. Try asking questions like:

- "What does this chart show?"
- "Which track has the highest utilization?"
- "Explain the time range currently displayed"

## Troubleshooting

### Error: "API key not found"

- Make sure you've created a `.env` file in the project root
- Verify the API key is correctly set: `REACT_APP_LLM_API_KEY=your_key`
- Restart the development server after changing `.env`

### Error: "HTTP error! status: 401"

- Your API key is invalid or expired
- Check that you copied the entire key correctly
- Verify your API key has the necessary permissions

### Error: "HTTP error! status: 429"

- You've exceeded your API rate limit
- Wait a few minutes and try again
- Consider upgrading your API plan

### Streaming not working

- Ensure `stream: true` is set in `llmConfig.ts`
- Check browser console for errors
- Some older browsers may not support streaming responses

### Chat responses are slow

- Try using a faster model (e.g., `gpt-3.5-turbo` instead of `gpt-4`)
- Consider using a local model with Ollama for instant responses
- Check your internet connection

### Ollama connection refused

- Make sure Ollama is running: `ollama serve`
- Verify the endpoint URL is correct: `http://localhost:11434/api/chat`
- Check if the model is downloaded: `ollama list`

## Advanced Configuration

### Using a Custom API Endpoint

If you're using a custom LLM API:

```javascript
const LLMConfig = {
  apiEndpoint: 'https://your-custom-api.com/chat',
  provider: {
    name: 'custom'
  },
  headers: {
    'Content-Type': 'application/json',
    'Custom-Header': 'value'
  }
  // ... other settings
};
```

You may need to modify the `streamLLMResponse` function to match your API's response format.

### Cost Optimization

To reduce API costs:

1. Use `gpt-3.5-turbo` instead of `gpt-4`
2. Reduce `maxTokens` to limit response length
3. Use Ollama for local, free inference
4. Set a lower `temperature` for more concise responses

### Security Best Practices

1. **Never commit your `.env` file** - Add it to `.gitignore`
2. **Use environment variables** - Don't hardcode API keys
3. **Rotate keys regularly** - Generate new API keys periodically
4. **Set usage limits** - Configure spending limits in your API dashboard
5. **Monitor usage** - Regularly check your API usage and costs

## Support

For more information:

- OpenAI API Docs: https://platform.openai.com/docs
- Anthropic API Docs: https://docs.anthropic.com
- Ollama Documentation: https://ollama.ai/docs

For issues with the integration, check the browser console for error messages.

// LLM API Configuration
// This file contains the configuration for the LLM API integration

export interface LLMConfigType {
  apiEndpoint: string;
  apiKey: string;
  model: string;
  stream: boolean;
  timeout: number;
  temperature: number;
  maxTokens: number;
  systemPrompt: string;
  headers: Record<string, string>;
  provider: {
    name: 'openai' | 'anthropic' | 'ollama' | 'custom';
    anthropic: { version: string };
    ollama: { endpoint: string; model: string };
  };
}

const env = process.env as Record<string, string | undefined>;

const parseBool = (value: string | undefined, fallback: boolean) => {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  return fallback;
};

const parseNumber = (value: string | undefined, fallback: number) => {
  if (value === undefined) return fallback;
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
};

const providerName = (env.REACT_APP_LLM_PROVIDER || 'openai') as LLMConfigType['provider']['name'];
const defaultOllamaEndpoint = 'http://localhost:11434/api/chat';
const defaultAnthropicEndpoint = 'https://api.anthropic.com/v1/messages';
const defaultOpenAIEndpoint = 'https://api.openai.com/v1/chat/completions';

const apiEndpoint =
  env.REACT_APP_LLM_API_ENDPOINT ||
  (providerName === 'ollama'
    ? defaultOllamaEndpoint
    : providerName === 'anthropic'
      ? defaultAnthropicEndpoint
      : defaultOpenAIEndpoint);

const model =
  env.REACT_APP_LLM_MODEL ||
  (providerName === 'ollama'
    ? env.REACT_APP_LLM_OLLAMA_MODEL || 'llama2'
    : providerName === 'anthropic'
      ? 'claude-3-opus-20240229'
      : 'gpt-4');

const LLMConfig: LLMConfigType = {
  // API Endpoint - Update this to your LLM API endpoint
  // Examples:
  // - OpenAI: 'https://api.openai.com/v1/chat/completions'
  // - Anthropic: 'https://api.anthropic.com/v1/messages'
  // - Local: 'http://localhost:11434/api/chat' (for Ollama)
  apiEndpoint,

  // API Key - Set this via environment variable for security
  // For development, you can set it here (NOT recommended for production)
  apiKey: env.REACT_APP_LLM_API_KEY || '',

  // Model to use
  model,

  // Enable streaming responses
  stream: parseBool(env.REACT_APP_LLM_STREAM, true),

  // Request timeout in milliseconds
  timeout: parseNumber(env.REACT_APP_LLM_TIMEOUT, 60000),

  // Temperature for response generation (0-2)
  // Lower values make output more focused and deterministic
  temperature: parseNumber(env.REACT_APP_LLM_TEMPERATURE, 0.7),

  // Maximum tokens in response
  maxTokens: parseNumber(env.REACT_APP_LLM_MAX_TOKENS, 2000),

  // System prompt to guide the LLM's behavior
  systemPrompt:
    env.REACT_APP_LLM_SYSTEM_PROMPT ||
    `You are a helpful assistant that helps users understand and analyze Gantt charts and time-series data. 
You can help interpret the visualization, answer questions about the data, and provide insights about task scheduling and resource utilization.`,

  // Additional headers for the API request
  headers: {
    'Content-Type': 'application/json'
  },

  // Provider-specific settings
  provider: {
    // Set to 'openai', 'anthropic', 'ollama', or 'custom'
    name: providerName,

    // Anthropic-specific settings
    anthropic: {
      version: env.REACT_APP_LLM_ANTHROPIC_VERSION || '2023-06-01'
    },

    // Ollama-specific settings
    ollama: {
      endpoint: env.REACT_APP_LLM_OLLAMA_ENDPOINT || defaultOllamaEndpoint,
      model: env.REACT_APP_LLM_OLLAMA_MODEL || 'llama2'
    }
  }
};

export interface ChatMessage {
  role: string;
  content: string;
}

/**
 * Sends a streaming request to the LLM API
 * @param messages - Array of message objects with role and content
 * @param onChunk - Callback function for each chunk of streamed data
 * @param onComplete - Callback function when stream completes
 * @param onError - Callback function for errors
 */
export async function streamLLMResponse(
  messages: ChatMessage[],
  onChunk?: (chunk: string) => void,
  onComplete?: () => void,
  onError?: (error: any) => void
) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), LLMConfig.timeout);

    const requestBody = {
      model: LLMConfig.model,
      messages: [{ role: 'system', content: LLMConfig.systemPrompt }, ...messages],
      stream: true,
      temperature: LLMConfig.temperature,
      max_tokens: LLMConfig.maxTokens
    };

    const headers: Record<string, string> = {
      ...LLMConfig.headers,
      Authorization: `Bearer ${LLMConfig.apiKey}`
    };

    // Handle different providers
    if (LLMConfig.provider.name === 'anthropic') {
      headers['x-api-key'] = LLMConfig.apiKey;
      headers['anthropic-version'] = LLMConfig.provider.anthropic.version;
      delete headers['Authorization'];
    }

    const response = await fetch(LLMConfig.apiEndpoint, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      let details = '';
      try {
        const body = await response.text();
        details = body ? ` ${body}` : '';
      } catch {
        // ignore
      }
      throw new Error(`HTTP error! status: ${response.status}.${details}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('Response body is missing');
    }
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        if (onComplete) onComplete();
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.trim() === '') continue;
        if (line.trim() === 'data: [DONE]') continue;

        if (line.startsWith('data: ')) {
          try {
            const jsonStr = line.slice(6);
            const data = JSON.parse(jsonStr);

            // Handle OpenAI format
            if (data.choices && data.choices[0]?.delta?.content) {
              const content = data.choices[0].delta.content;
              if (onChunk) onChunk(content);
            }

            // Handle Anthropic format
            if (data.type === 'content_block_delta' && data.delta?.text) {
              if (onChunk) onChunk(data.delta.text);
            }
          } catch (e) {
            console.warn('Error parsing SSE data:', e);
          }
        }
      }
    }
  } catch (error) {
    console.error('Error in streamLLMResponse:', error);
    if (onError) onError(error);
  }
}

/**
 * Sends a non-streaming request to the LLM API
 * @param messages - Array of message objects with role and content
 * @returns The complete response text
 */
export async function sendLLMRequest(messages: ChatMessage[]) {
  try {
    const requestBody = {
      model: LLMConfig.model,
      messages: [{ role: 'system', content: LLMConfig.systemPrompt }, ...messages],
      temperature: LLMConfig.temperature,
      max_tokens: LLMConfig.maxTokens
    };

    const headers: Record<string, string> = {
      ...LLMConfig.headers,
      Authorization: `Bearer ${LLMConfig.apiKey}`
    };

    if (LLMConfig.provider.name === 'anthropic') {
      headers['x-api-key'] = LLMConfig.apiKey;
      headers['anthropic-version'] = LLMConfig.provider.anthropic.version;
      delete headers['Authorization'];
    }

    const response = await fetch(LLMConfig.apiEndpoint, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();

    // Handle OpenAI format
    if (data.choices && data.choices[0]?.message?.content) {
      return data.choices[0].message.content;
    }

    // Handle Anthropic format
    if (data.content && data.content[0]?.text) {
      return data.content[0].text;
    }

    throw new Error('Unexpected response format');
  } catch (error) {
    console.error('Error in sendLLMRequest:', error);
    throw error;
  }
}

export default LLMConfig;

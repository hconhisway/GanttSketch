// LLM API Configuration
// This file contains the configuration for the LLM API integration.
// Supports runtime overrides via setLLMConfig (e.g. from API Config modal / session restore).

export type LLMProviderName =
  | 'proxy'
  | 'openai'
  | 'anthropic'
  | 'ollama'
  | 'deepseek'
  | 'zhipu'
  | 'qwen'
  | 'custom';

export interface LLMConfigType {
  apiEndpoint: string;
  apiKey: string;
  model: string;
  stream: boolean;
  timeout: number;
  temperature: number;
  /** Optional. When 0 or unset, not sent in request. */
  maxTokens?: number;
  /** When true, use max_completion instead of max_tokens (some models require this) */
  useMaxCompletionParam?: boolean;
  systemPrompt: string;
  headers: Record<string, string>;
  provider: {
    name: LLMProviderName;
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

const providerName = (env.REACT_APP_LLM_PROVIDER || 'proxy') as LLMProviderName;
const defaultOllamaEndpoint = 'http://localhost:11434/api/chat';
const defaultAnthropicEndpoint = 'https://api.anthropic.com/v1/messages';
const defaultOpenAIEndpoint = 'https://api.openai.com/v1/responses';
const defaultDeepSeekEndpoint = 'https://api.deepseek.com/v1/chat/completions';
const defaultZhipuEndpoint = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
const defaultQwenEndpoint = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';

/** Proxy uses same-origin /api/llm/v1/responses so the server adds the API key. */
const defaultProxyEndpoint = '/api/llm/v1/responses';

export function getDefaultEndpoint(provider: LLMProviderName): string {
  const map: Record<LLMProviderName, string> = {
    proxy: defaultProxyEndpoint,
    openai: defaultOpenAIEndpoint,
    anthropic: defaultAnthropicEndpoint,
    ollama: defaultOllamaEndpoint,
    deepseek: defaultDeepSeekEndpoint,
    zhipu: defaultZhipuEndpoint,
    qwen: defaultQwenEndpoint,
    custom: env.REACT_APP_LLM_API_ENDPOINT || ''
  };
  return map[provider] ?? defaultOpenAIEndpoint;
}

export function getDefaultModel(provider: LLMProviderName): string {
  const map: Record<LLMProviderName, string> = {
    proxy: 'gpt-5.2-codex',
    openai: 'gpt-5.2-codex',
    anthropic: 'claude-3-opus-20240229',
    ollama: env.REACT_APP_LLM_OLLAMA_MODEL || 'llama2',
    deepseek: 'deepseek-chat',
    zhipu: 'glm-4-flash',
    qwen: 'qwen-turbo',
    custom: env.REACT_APP_LLM_MODEL || ''
  };
  return map[provider] ?? 'gpt-4';
}

function buildDefaultConfig(): LLMConfigType {
  const apiEndpoint = env.REACT_APP_LLM_API_ENDPOINT || getDefaultEndpoint(providerName);
  const model = env.REACT_APP_LLM_MODEL || getDefaultModel(providerName);

  return {
    apiEndpoint,
    apiKey: providerName === 'proxy' ? '' : (env.REACT_APP_LLM_API_KEY || ''),
    model,
    stream: parseBool(env.REACT_APP_LLM_STREAM, true),
    timeout: parseNumber(env.REACT_APP_LLM_TIMEOUT, 60000),
    temperature: parseNumber(env.REACT_APP_LLM_TEMPERATURE, 0.3),
    maxTokens: parseNumber(env.REACT_APP_LLM_MAX_TOKENS, 0) || undefined,
    useMaxCompletionParam: parseBool(env.REACT_APP_LLM_USE_MAX_COMPLETION, false),
    systemPrompt:
      env.REACT_APP_LLM_SYSTEM_PROMPT ||
      `You are a helpful assistant that helps users understand and analyze Gantt charts and time-series data. 
You can help interpret the visualization, answer questions about the data, and provide insights about task scheduling and resource utilization.`,
    headers: { 'Content-Type': 'application/json' },
    provider: {
      name: providerName,
      anthropic: {
        version: env.REACT_APP_LLM_ANTHROPIC_VERSION || '2023-06-01'
      },
      ollama: {
        endpoint: env.REACT_APP_LLM_OLLAMA_ENDPOINT || defaultOllamaEndpoint,
        model: env.REACT_APP_LLM_OLLAMA_MODEL || 'llama2'
      }
    }
  };
}

/** Detect whether to use the OpenAI Responses API format based on endpoint URL. */
export function isResponsesApi(endpoint: string): boolean {
  return /\/v1\/responses\b/.test(endpoint);
}

/** Build token limit field for Chat Completions API request body. Omitted when maxTokens is 0 or unset. */
function tokenLimitBody(cfg: LLMConfigType): Record<string, number> | Record<string, never> {
  const limit = Number(cfg.maxTokens);
  if (!Number.isFinite(limit) || limit <= 0) return {};
  const key = cfg.useMaxCompletionParam ? 'max_completion' : 'max_tokens';
  return { [key]: limit };
}

/**
 * Build the request body for the OpenAI Responses API.
 *
 * Key differences from Chat Completions:
 * - System messages are extracted into the top-level `instructions` field
 * - Non-system messages go into `input`
 * - Uses `max_output_tokens` instead of `max_tokens`
 * - `store: false` to avoid persisting conversation state on OpenAI's servers
 */
function buildResponsesApiBody(
  cfg: LLMConfigType,
  messages: ChatMessage[],
  stream: boolean
): Record<string, unknown> {
  // Collect all system messages (including cfg.systemPrompt) into instructions
  const systemParts: string[] = [];
  if (cfg.systemPrompt) systemParts.push(cfg.systemPrompt);
  const inputMessages: ChatMessage[] = [];
  for (const msg of messages) {
    if (msg.role === 'system') {
      if (msg.content) systemParts.push(msg.content);
    } else {
      inputMessages.push(msg);
    }
  }

  const model =
    cfg.model?.trim() || (cfg.provider.name === 'proxy' ? getDefaultModel('proxy') : 'gpt-4o');
  const body: Record<string, unknown> = {
    model,
    input: inputMessages,
    store: false
  };

  if (systemParts.length > 0) {
    body.instructions = systemParts.join('\n\n');
  }

  if (stream) body.stream = true;

  // Do not send temperature for Responses API: many models (e.g. reasoning/o1-style) do not support it and return 400.
  // Chat Completions requests still send temperature below.

  const limit = Number(cfg.maxTokens);
  if (Number.isFinite(limit) && limit > 0) {
    body.max_output_tokens = limit;
  }

  return body;
}

/**
 * Build the request body for the Chat Completions API (used by non-OpenAI providers).
 */
function buildChatCompletionsBody(
  cfg: LLMConfigType,
  messages: ChatMessage[],
  stream: boolean
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages: [{ role: 'system', content: cfg.systemPrompt }, ...messages],
    temperature: cfg.temperature
  };
  if (stream) body.stream = true;
  Object.assign(body, tokenLimitBody(cfg));
  return body;
}

// Mutable runtime config (starts from env defaults)
let runtimeConfig: LLMConfigType = buildDefaultConfig();

/**
 * Get the current LLM config (env defaults + runtime overrides).
 */
export function getLLMConfig(): LLMConfigType {
  return { ...runtimeConfig };
}

/**
 * Merge partial overrides into the runtime LLM config.
 * Call this when user saves API settings or when restoring from session.
 */
export function setLLMConfig(partial: Partial<LLMConfigType>): void {
  if (!partial) return;
  runtimeConfig = {
    ...runtimeConfig,
    ...partial,
    headers: { ...runtimeConfig.headers, ...(partial.headers || {}) },
    provider: {
      ...runtimeConfig.provider,
      ...(partial.provider || {}),
      name: (partial.provider?.name ?? runtimeConfig.provider.name) as LLMProviderName,
      anthropic: { ...runtimeConfig.provider.anthropic, ...(partial.provider?.anthropic || {}) },
      ollama: { ...runtimeConfig.provider.ollama, ...(partial.provider?.ollama || {}) }
    }
  };
}

/**
 * Reset config to build-time defaults (from env).
 */
export function resetLLMConfigToDefaults(): void {
  runtimeConfig = buildDefaultConfig();
}

/**
 * Verify API connection with a minimal request.
 * Uses current config, optionally overridden by params (e.g. from unsaved modal values).
 * Returns { ok: true } on success, { ok: false, error: string } on failure.
 *
 * Automatically selects the correct request format (Responses API vs Chat Completions)
 * based on the endpoint URL.
 */
export async function verifyLLMConnection(overrides?: {
  apiKey?: string;
  apiEndpoint?: string;
  model?: string;
  provider?: { name: LLMProviderName };
  maxTokens?: number;
  useMaxCompletionParam?: boolean;
}): Promise<{ ok: boolean; error?: string }> {
  const cfg = getLLMConfig();
  const key = overrides?.apiKey ?? cfg.apiKey;
  const endpoint = overrides?.apiEndpoint ?? cfg.apiEndpoint;
  const model = overrides?.model ?? cfg.model;
  const provider = overrides?.provider?.name ?? cfg.provider.name;
  const verifyCfg: LLMConfigType = {
    ...cfg,
    maxTokens: overrides?.maxTokens ?? cfg.maxTokens,
    useMaxCompletionParam: overrides?.useMaxCompletionParam ?? cfg.useMaxCompletionParam
  };

  const isProxy = provider === 'proxy';
  if (!isProxy && !key?.trim()) {
    return { ok: false, error: 'API key is required' };
  }
  if (!endpoint?.trim()) {
    return { ok: false, error: 'API endpoint is required' };
  }

  try {
    const headers: Record<string, string> = { ...cfg.headers };
    if (!isProxy) {
      headers['Authorization'] = `Bearer ${key}`;
      if (provider === 'anthropic') {
        headers['x-api-key'] = key!;
        headers['anthropic-version'] = cfg.provider.anthropic.version;
        delete headers['Authorization'];
      }
    }

    const useResponses = isResponsesApi(endpoint);
    let body: Record<string, unknown>;

    if (useResponses) {
      // OpenAI Responses API format
      body = {
        model,
        input: [{ role: 'user', content: 'Hi' }],
        store: false
      };
      const limit = Number(verifyCfg.maxTokens);
      if (Number.isFinite(limit) && limit > 0) {
        body.max_output_tokens = limit;
      }
    } else {
      // Chat Completions API format
      body = {
        model,
        messages: [{ role: 'user', content: 'Hi' }]
      };
      const tokenLimit = tokenLimitBody(verifyCfg);
      if (Object.keys(tokenLimit).length > 0) Object.assign(body, tokenLimit);
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const respBody = await response.text();
      return {
        ok: false,
        error: `HTTP ${response.status}: ${respBody ? respBody.slice(0, 120) : response.statusText}`
      };
    }
    return { ok: true };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
}

export interface ChatMessage {
  role: string;
  content: string;
}

/**
 * Sends a streaming request to the LLM API.
 *
 * Automatically selects the correct request/response format:
 * - OpenAI Responses API (`/v1/responses`): uses `input`, `instructions`, `max_output_tokens`
 * - Chat Completions API (all other providers): uses `messages`, `max_tokens`
 * - Anthropic Messages API: uses Anthropic-specific headers and `content_block_delta` events
 */
export async function streamLLMResponse(
  messages: ChatMessage[],
  onChunk?: (chunk: string) => void,
  onComplete?: () => void,
  onError?: (error: any) => void
) {
  const cfg = getLLMConfig();
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), cfg.timeout);

    const useResponses = isResponsesApi(cfg.apiEndpoint);
    const requestBody = useResponses
      ? buildResponsesApiBody(cfg, messages, true)
      : buildChatCompletionsBody(cfg, messages, true);

    const headers: Record<string, string> = { ...cfg.headers };
    if (cfg.provider.name !== 'proxy') {
      headers['Authorization'] = `Bearer ${cfg.apiKey}`;
      if (cfg.provider.name === 'anthropic') {
        headers['x-api-key'] = cfg.apiKey;
        headers['anthropic-version'] = cfg.provider.anthropic.version;
        delete headers['Authorization'];
      }
    }

    const response = await fetch(cfg.apiEndpoint, {
      method: 'POST',
      headers,
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
        // Responses API sends `event:` lines before `data:` lines; skip them
        if (line.startsWith('event:')) continue;

        if (line.startsWith('data: ')) {
          try {
            const jsonStr = line.slice(6);
            const data = JSON.parse(jsonStr);

            // OpenAI Responses API: text delta events
            if (data.type === 'response.output_text.delta' && data.delta) {
              if (onChunk) onChunk(data.delta);
              continue;
            }

            // Chat Completions API: delta content in choices
            if (data.choices && data.choices[0]?.delta?.content) {
              const content = data.choices[0].delta.content;
              if (onChunk) onChunk(content);
              continue;
            }

            // Anthropic Messages API: content_block_delta events
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
 * Sends a non-streaming request to the LLM API.
 *
 * Handles response parsing for:
 * - OpenAI Responses API: `output_text` or `output[].content[].text`
 * - Chat Completions API: `choices[0].message.content`
 * - Anthropic Messages API: `content[0].text`
 */
export async function sendLLMRequest(messages: ChatMessage[]) {
  const cfg = getLLMConfig();
  const useResponses = isResponsesApi(cfg.apiEndpoint);
  const requestBody = useResponses
    ? buildResponsesApiBody(cfg, messages, false)
    : buildChatCompletionsBody(cfg, messages, false);

  const headers: Record<string, string> = { ...cfg.headers };
  if (cfg.provider.name !== 'proxy') {
    headers['Authorization'] = `Bearer ${cfg.apiKey}`;
    if (cfg.provider.name === 'anthropic') {
      headers['x-api-key'] = cfg.apiKey;
      headers['anthropic-version'] = cfg.provider.anthropic.version;
      delete headers['Authorization'];
    }
  }

  const response = await fetch(cfg.apiEndpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  const data = await response.json();

  // OpenAI Responses API: convenient output_text helper
  if (typeof data.output_text === 'string') {
    return data.output_text;
  }

  // OpenAI Responses API: structured output array
  if (Array.isArray(data.output)) {
    for (const item of data.output) {
      if (item.type === 'message' && Array.isArray(item.content)) {
        for (const part of item.content) {
          if (part.type === 'output_text' && typeof part.text === 'string') {
            return part.text;
          }
        }
      }
    }
  }

  // Chat Completions API
  if (data.choices && data.choices[0]?.message?.content) {
    return data.choices[0].message.content;
  }

  // Anthropic Messages API
  if (data.content && data.content[0]?.text) {
    return data.content[0].text;
  }

  throw new Error('Unexpected response format');
}

// Legacy export for consumers that expect a default LLMConfig object
const llmConfigDefault = { getLLMConfig, setLLMConfig, resetLLMConfigToDefaults };
export default llmConfigDefault;

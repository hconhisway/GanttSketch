// LLM API Configuration
// This file contains the configuration for the LLM API integration

const LLMConfig = {
  // API Endpoint - Update this to your LLM API endpoint
  // Examples:
  // - OpenAI: 'https://api.openai.com/v1/chat/completions'
  // - Anthropic: 'https://api.anthropic.com/v1/messages'
  // - Local: 'http://localhost:11434/api/chat' (for Ollama)
  apiEndpoint: 'https://api.openai.com/v1/chat/completions',
  
  // API Key - Set this via environment variable for security
  // For development, you can set it here (NOT recommended for production)
  apiKey: process.env.REACT_APP_LLM_API_KEY || '',
  
  // Model to use
  model: 'gpt-4',
  
  // Enable streaming responses
  stream: true,
  
  // Request timeout in milliseconds
  timeout: 60000,
  
  // Temperature for response generation (0-2)
  // Lower values make output more focused and deterministic
  temperature: 0.7,
  
  // Maximum tokens in response
  maxTokens: 2000,
  
  // System prompt to guide the LLM's behavior
  systemPrompt: `You are a helpful assistant that helps users understand and analyze Gantt charts and time-series data. 
You can help interpret the visualization, answer questions about the data, and provide insights about task scheduling and resource utilization.`,
  
  // Additional headers for the API request
  headers: {
    'Content-Type': 'application/json',
  },
  
  // Provider-specific settings
  provider: {
    // Set to 'openai', 'anthropic', 'ollama', or 'custom'
    name: 'openai',
    
    // Anthropic-specific settings
    anthropic: {
      version: '2023-06-01',
    },
    
    // Ollama-specific settings
    ollama: {
      endpoint: 'http://localhost:11434/api/chat',
      model: 'llama2',
    },
  },
};

/**
 * Sends a streaming request to the LLM API
 * @param {Array} messages - Array of message objects with role and content
 * @param {Function} onChunk - Callback function for each chunk of streamed data
 * @param {Function} onComplete - Callback function when stream completes
 * @param {Function} onError - Callback function for errors
 */
export async function streamLLMResponse(messages, onChunk, onComplete, onError) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), LLMConfig.timeout);
    
    const requestBody = {
      model: LLMConfig.model,
      messages: [
        { role: 'system', content: LLMConfig.systemPrompt },
        ...messages
      ],
      stream: true,
      temperature: LLMConfig.temperature,
      max_tokens: LLMConfig.maxTokens,
    };
    
    const headers = {
      ...LLMConfig.headers,
      'Authorization': `Bearer ${LLMConfig.apiKey}`,
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
      signal: controller.signal,
    });
    
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const reader = response.body.getReader();
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
 * @param {Array} messages - Array of message objects with role and content
 * @returns {Promise<string>} The complete response text
 */
export async function sendLLMRequest(messages) {
  try {
    const requestBody = {
      model: LLMConfig.model,
      messages: [
        { role: 'system', content: LLMConfig.systemPrompt },
        ...messages
      ],
      temperature: LLMConfig.temperature,
      max_tokens: LLMConfig.maxTokens,
    };
    
    const headers = {
      ...LLMConfig.headers,
      'Authorization': `Bearer ${LLMConfig.apiKey}`,
    };
    
    if (LLMConfig.provider.name === 'anthropic') {
      headers['x-api-key'] = LLMConfig.apiKey;
      headers['anthropic-version'] = LLMConfig.provider.anthropic.version;
      delete headers['Authorization'];
    }
    
    const response = await fetch(LLMConfig.apiEndpoint, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(requestBody),
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


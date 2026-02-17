import React, { useEffect, useState } from 'react';
import {
  getLLMConfig,
  setLLMConfig,
  resetLLMConfigToDefaults,
  verifyLLMConnection,
  getDefaultEndpoint,
  getDefaultModel,
  isResponsesApi
} from '../../config/llmConfig';

const PROVIDERS = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'ollama', label: 'Ollama' },
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'zhipu', label: '智谱 (Zhipu)' },
  { value: 'qwen', label: '通义千问 (Qwen)' },
  { value: 'custom', label: 'Custom' }
] as const;

/** Masked placeholder for saved API key - never display full key in frontend */
const API_KEY_MASKED = '••••••••••••••••';

interface ApiConfigModalProps {
  open: boolean;
  onClose: () => void;
  onSave?: () => void;
}

export const ApiConfigModal = React.memo(function ApiConfigModal({
  open,
  onClose,
  onSave
}: ApiConfigModalProps) {
  const [provider, setProvider] = useState<string>('openai');
  const [apiKey, setApiKey] = useState('');
  const [apiEndpoint, setApiEndpoint] = useState('');
  const [model, setModel] = useState('');
  const [temperature, setTemperature] = useState(0.3);
  const [maxTokens, setMaxTokens] = useState<number | ''>(0);
  const [useMaxCompletionParam, setUseMaxCompletionParam] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<{ ok: boolean; error?: string } | null>(null);

  useEffect(() => {
    if (open) {
      const cfg = getLLMConfig();
      setProvider(cfg.provider.name);
      setApiKey(cfg.apiKey ? API_KEY_MASKED : '');
      setApiEndpoint(cfg.apiEndpoint);
      setModel(cfg.model);
      setTemperature(cfg.temperature);
      setMaxTokens(cfg.maxTokens && cfg.maxTokens > 0 ? cfg.maxTokens : '');
      setUseMaxCompletionParam(Boolean(cfg.useMaxCompletionParam));
      setVerifyResult(null);
    }
  }, [open]);

  const handleProviderChange = (value: string) => {
    setProvider(value);
    setApiEndpoint(getDefaultEndpoint(value as any));
    setModel(getDefaultModel(value as any));
  };

  const handleSave = () => {
    const current = getLLMConfig();
    const limit = typeof maxTokens === 'number' ? maxTokens : parseInt(String(maxTokens), 10);
    const validMaxTokens = Number.isFinite(limit) && limit > 0 ? limit : undefined;
    const update: Record<string, unknown> = {
      provider: { ...current.provider, name: provider as any },
      apiEndpoint,
      model,
      temperature,
      maxTokens: validMaxTokens,
      useMaxCompletionParam
    };
    if (apiKey !== API_KEY_MASKED && apiKey.trim()) {
      update.apiKey = apiKey.trim();
    }
    setLLMConfig(update as any);
    onSave?.();
    onClose();
  };

  const handleReset = () => {
    resetLLMConfigToDefaults();
    const cfg = getLLMConfig();
    setProvider(cfg.provider.name);
    setApiKey(cfg.apiKey ? API_KEY_MASKED : '');
    setApiEndpoint(cfg.apiEndpoint);
    setModel(cfg.model);
    setTemperature(cfg.temperature);
    setMaxTokens(cfg.maxTokens && cfg.maxTokens > 0 ? cfg.maxTokens : '');
    setUseMaxCompletionParam(Boolean(cfg.useMaxCompletionParam));
    setVerifyResult(null);
  };

  const handleVerify = async () => {
    setIsVerifying(true);
    setVerifyResult(null);
    try {
      const limit = typeof maxTokens === 'number' ? maxTokens : parseInt(String(maxTokens), 10);
      const validMax = Number.isFinite(limit) && limit > 0 ? limit : undefined;
      const result = await verifyLLMConnection({
        apiKey: apiKey === API_KEY_MASKED ? undefined : apiKey,
        apiEndpoint,
        model,
        provider: { name: provider as any },
        maxTokens: validMax,
        useMaxCompletionParam
      });
      setVerifyResult(result);
    } finally {
      setIsVerifying(false);
    }
  };

  if (!open) return null;

  return (
    <div className="config-editor-modal api-config-modal" role="dialog" aria-modal="true" aria-labelledby="api-config-title">
      <div className="config-editor config-editor-window api-config-window">
        <h2 id="api-config-title" className="config-editor-title api-config-title">
          API Configuration
        </h2>
        <p className="api-config-description">
          Use your own LLM API key. Settings are stored per session in your browser.
        </p>

        <div className="api-config-field">
          <label htmlFor="api-config-provider">Provider</label>
          <select
            id="api-config-provider"
            value={provider}
            onChange={(e) => handleProviderChange(e.target.value)}
          >
            {PROVIDERS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </div>

        <div className="api-config-field">
          <label htmlFor="api-config-key">API Key</label>
          <input
            id="api-config-key"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-... or enter new key"
            className="api-config-input"
            autoComplete="off"
          />
          <p className="api-config-key-hint">Full key is never shown. Enter new key to replace.</p>
        </div>

        <div className="api-config-field">
          <label htmlFor="api-config-endpoint">API Endpoint</label>
          <input
            id="api-config-endpoint"
            type="url"
            value={apiEndpoint}
            onChange={(e) => setApiEndpoint(e.target.value)}
            placeholder="https://..."
            className="api-config-input"
          />
          <p className="api-config-key-hint">
            {isResponsesApi(apiEndpoint)
              ? 'Using OpenAI Responses API format (recommended)'
              : 'Using Chat Completions API format'}
          </p>
        </div>

        <div className="api-config-field">
          <label htmlFor="api-config-model">Model</label>
          <input
            id="api-config-model"
            type="text"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="gpt-4, claude-3-opus, etc."
            className="api-config-input"
          />
        </div>

        <div className="api-config-field">
          <label htmlFor="api-config-temperature">
            Temperature: {temperature}
          </label>
          <input
            id="api-config-temperature"
            type="range"
            min="0"
            max="2"
            step="0.1"
            value={temperature}
            onChange={(e) => setTemperature(Number(e.target.value))}
            className="api-config-slider"
          />
        </div>

        <div className="api-config-field">
          <label htmlFor="api-config-max-tokens">Max Tokens (optional)</label>
          <input
            id="api-config-max-tokens"
            type="number"
            min="0"
            max="100000"
            value={maxTokens === '' ? '' : maxTokens}
            onChange={(e) => {
              const v = e.target.value;
              if (v === '') setMaxTokens('');
              else setMaxTokens(Math.max(0, parseInt(v, 10) || 0));
            }}
            placeholder="Leave empty for no limit"
            className="api-config-input"
          />
          <label className="api-config-checkbox-label">
            <input
              type="checkbox"
              checked={useMaxCompletionParam}
              onChange={(e) => setUseMaxCompletionParam(e.target.checked)}
            />
            Use <code>max_completion</code> (some models require this instead of max_tokens)
          </label>
        </div>

        {verifyResult && (
          <div
            className={`api-config-verify-result ${verifyResult.ok ? 'success' : 'error'}`}
            role="alert"
          >
            {verifyResult.ok ? '✓ API connection successful' : `✗ ${verifyResult.error}`}
          </div>
        )}

        <div className="config-editor-actions api-config-actions">
          <button
            type="button"
            className="api-config-verify-btn"
            onClick={handleVerify}
            disabled={isVerifying || !apiEndpoint?.trim() || (apiKey !== API_KEY_MASKED && !apiKey.trim())}
            title="Verify API key and endpoint"
          >
            {isVerifying ? 'Verifying...' : 'Verify API'}
          </button>
          <button type="button" className="config-editor-save" onClick={handleSave}>
            Save
          </button>
          <button type="button" className="config-editor-export" onClick={handleReset}>
            Reset to Defaults
          </button>
          <button type="button" className="config-editor-cancel" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
});

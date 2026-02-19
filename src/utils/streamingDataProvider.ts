import type { StreamingRequest } from '../types/viewState';
import type { FetchViewportOptions } from './dataProcessing';
import { fetchData, simulateStreamingFetch } from './dataProcessing';

export type StreamingProviderKind = 'api' | 'simulated';

export type StreamingProviderOptions = {
  apiUrl?: string;
  bins: number;
  filters?: any[];
  signal?: AbortSignal;
  sessionId?: string;
  fullData?: any[];
};

export interface StreamingDataProvider {
  kind: StreamingProviderKind;
  fetch: (request: StreamingRequest, options: StreamingProviderOptions) => Promise<any>;
}

export const createApiStreamingProvider = (): StreamingDataProvider => ({
  kind: 'api',
  fetch: async (request, options) => {
    if (!options.apiUrl) {
      throw new Error('Streaming API provider requires apiUrl.');
    }
    const viewportOptions: FetchViewportOptions & { summary?: number } = {
      signal: options.signal,
      sessionId: options.sessionId,
      lanes: request.laneIds,
      viewportPxWidth: request.viewportPxWidth,
      pixelWindow: request.summaryLevel,
      filters: options.filters,
      summary: request.summaryLevel
    };
    return fetchData(
      request.timeWindow[0],
      request.timeWindow[1],
      options.bins,
      options.apiUrl,
      viewportOptions
    );
  }
});

export const createSimulatedStreamingProvider = (): StreamingDataProvider => ({
  kind: 'simulated',
  fetch: async (request, options) => {
    if (!Array.isArray(options.fullData)) {
      throw new Error('Simulated streaming provider requires fullData.');
    }
    return simulateStreamingFetch(options.fullData, request);
  }
});

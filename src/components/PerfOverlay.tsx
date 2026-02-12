import React, { useEffect, useState } from 'react';
import { perfMetrics } from '../utils/perfMetrics';

type PerfOverlayProps = {
  visible: boolean;
  streamingEnabled?: boolean;
  streamingSimulated?: boolean;
  streamingStats?: {
    lastRequest?: {
      summaryLevel: number;
      timeWindow: [number, number];
      laneIds: string[];
      viewportPxWidth: number;
    } | null;
    pendingRequest?: {
      summaryLevel: number;
    } | null;
    lastSentAt?: number;
    requestCount?: number;
  };
  onToggleStreaming?: (enabled: boolean) => void;
};

export function PerfOverlay({
  visible,
  streamingEnabled,
  streamingSimulated,
  streamingStats,
  onToggleStreaming
}: PerfOverlayProps) {
  const [snapshot, setSnapshot] = useState(() => perfMetrics.getSamples());

  useEffect(() => {
    if (!visible) return;
    const id = window.setInterval(() => {
      setSnapshot(perfMetrics.getSamples());
    }, 500);
    return () => window.clearInterval(id);
  }, [visible]);

  if (!visible) return null;
  const last = snapshot[snapshot.length - 1];
  const p95Fetch = perfMetrics.getP95('fetchMs');
  const p95Render = perfMetrics.getP95('renderMs');
  const lastRequest = streamingStats?.lastRequest || null;
  const pending = Boolean(streamingStats?.pendingRequest);
  const requestCount = streamingStats?.requestCount ?? 0;
  const streamingLabel = streamingSimulated ? 'simulated' : 'live';
  const requestMessage = lastRequest
    ? `summary-${lastRequest.summaryLevel} time=[${Math.round(
        lastRequest.timeWindow[0]
      )}, ${Math.round(lastRequest.timeWindow[1])}] lanes=${lastRequest.laneIds.length} px=${
        lastRequest.viewportPxWidth
      }`
    : '—';

  return (
    <div
      style={{
        position: 'fixed',
        right: 16,
        bottom: 16,
        background: 'rgba(15, 23, 42, 0.85)',
        color: '#e2e8f0',
        padding: '10px 12px',
        borderRadius: 8,
        fontSize: 12,
        fontFamily: 'system-ui',
        zIndex: 2000,
        minWidth: 180
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 6 }}>Performance</div>
      <div>Fetch: {last?.fetchMs?.toFixed?.(1) ?? '—'} ms</div>
      <div>Decode: {last?.decodeMs?.toFixed?.(1) ?? '—'} ms</div>
      <div>Render: {last?.renderMs?.toFixed?.(1) ?? '—'} ms</div>
      <div>GPU: {last?.gpuUploadMs?.toFixed?.(1) ?? '—'} ms</div>
      <div>Renderer: {last?.rendererMode?.toUpperCase?.() ?? '—'}</div>
      <div>GL instances: {last?.webglInstanceCount ?? '—'}</div>
      <div>INP: {last?.interactionMs?.toFixed?.(1) ?? '—'} ms</div>
      <div style={{ marginTop: 6, opacity: 0.8 }}>
        p95 fetch: {p95Fetch?.toFixed?.(1) ?? '—'} ms
      </div>
      <div style={{ opacity: 0.8 }}>p95 render: {p95Render?.toFixed?.(1) ?? '—'} ms</div>
      <div style={{ marginTop: 8, borderTop: '1px solid rgba(148, 163, 184, 0.35)' }} />
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
        <input
          type="checkbox"
          checked={Boolean(streamingEnabled)}
          onChange={(event) => onToggleStreaming?.(event.target.checked)}
        />
        <span>Streaming Mode</span>
      </label>
      <div style={{ opacity: 0.85, marginTop: 4 }}>
        Streaming: {streamingEnabled ? streamingLabel : 'off'}
      </div>
      <div>Summary: {lastRequest?.summaryLevel ?? '—'}</div>
      <div>
        Window: {lastRequest?.timeWindow?.[0]?.toFixed?.(0) ?? '—'} –{' '}
        {lastRequest?.timeWindow?.[1]?.toFixed?.(0) ?? '—'}
      </div>
      <div>Lanes: {lastRequest?.laneIds?.length ?? '—'}</div>
      <div>Pending: {pending ? 'yes' : 'no'}</div>
      <div>Requests: {requestCount}</div>
      {streamingSimulated ? (
        <div style={{ marginTop: 6, opacity: 0.85 }}>Simulated request: {requestMessage}</div>
      ) : null}
    </div>
  );
}

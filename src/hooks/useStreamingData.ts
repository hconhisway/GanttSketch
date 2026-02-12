import { useEffect, useMemo, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import type { StreamingRequest, ViewState } from '../types/viewState';

export type StreamingConfig = {
  enabled: boolean;
  maxRequestsPerSec?: number;
  bufferFactor?: number;
};

type UseStreamingDataArgs = {
  config: StreamingConfig;
  viewStateRef: MutableRefObject<ViewState>;
  timeBounds: { start: number; end: number };
  onRequest: (request: StreamingRequest) => void | Promise<void>;
};

export type StreamingStats = {
  lastRequest: StreamingRequest | null;
  pendingRequest: StreamingRequest | null;
  lastSentAt: number;
  requestCount: number;
};

const DEFAULT_MAX_REQ_PER_SEC = 1;
const DEFAULT_BUFFER_FACTOR = 0.5;
const POLL_MS = 60;

const clampNumber = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

const stringifyArray = (value: string[]) => value.join('\u0000');

const getBufferedLaneIds = (
  laneOrder: string[],
  visibleLaneRange: [number, number] | null | undefined,
  bufferCount: number,
  fallbackVisibleLaneIds: string[]
) => {
  if (!Array.isArray(laneOrder) || laneOrder.length === 0) return fallbackVisibleLaneIds;
  if (!visibleLaneRange) return fallbackVisibleLaneIds;
  const startIndex = Math.max(0, Number(visibleLaneRange[0] ?? 0) - bufferCount);
  const endIndex = Math.min(
    laneOrder.length - 1,
    Number(visibleLaneRange[1] ?? 0) + bufferCount
  );
  if (!Number.isFinite(startIndex) || !Number.isFinite(endIndex) || endIndex < startIndex) {
    return fallbackVisibleLaneIds;
  }
  return laneOrder.slice(startIndex, endIndex + 1).map((lane) => String(lane));
};

export function useStreamingData({
  config,
  viewStateRef,
  timeBounds,
  onRequest
}: UseStreamingDataArgs) {
  const [stats, setStats] = useState<StreamingStats>({
    lastRequest: null,
    pendingRequest: null,
    lastSentAt: 0,
    requestCount: 0
  });

  const onRequestRef = useRef(onRequest);
  useEffect(() => {
    onRequestRef.current = onRequest;
  }, [onRequest]);

  const pendingRef = useRef<StreamingRequest | null>(null);
  const lastSentAtRef = useRef<number>(0);
  const requestCountRef = useRef<number>(0);
  const timerRef = useRef<number | null>(null);
  const lastKeyRef = useRef<string>('');

  const maxRequestsPerSec = useMemo(
    () => Math.max(1, Number(config.maxRequestsPerSec) || DEFAULT_MAX_REQ_PER_SEC),
    [config.maxRequestsPerSec]
  );
  const bufferFactor = useMemo(
    () => clampNumber(Number(config.bufferFactor) || DEFAULT_BUFFER_FACTOR, 0, 1),
    [config.bufferFactor]
  );

  useEffect(() => {
    if (!config.enabled) {
      if (timerRef.current) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      pendingRef.current = null;
      lastKeyRef.current = '';
      return;
    }

    const minInterval = 1000 / maxRequestsPerSec;

    const flushPending = () => {
      timerRef.current = null;
      if (!pendingRef.current) return;
      const request = pendingRef.current;
      pendingRef.current = null;
      lastSentAtRef.current = Date.now();
      requestCountRef.current += 1;
      setStats((prev) => ({
        ...prev,
        lastRequest: request,
        pendingRequest: null,
        lastSentAt: lastSentAtRef.current,
        requestCount: requestCountRef.current
      }));
      void onRequestRef.current(request);
    };

    const scheduleRequest = (request: StreamingRequest) => {
      const now = Date.now();
      const elapsed = now - lastSentAtRef.current;
      if (elapsed >= minInterval) {
        lastSentAtRef.current = now;
        requestCountRef.current += 1;
        setStats((prev) => ({
          ...prev,
          lastRequest: request,
          pendingRequest: null,
          lastSentAt: now,
          requestCount: requestCountRef.current
        }));
        void onRequestRef.current(request);
        return;
      }

      pendingRef.current = request;
      setStats((prev) => ({
        ...prev,
        pendingRequest: request
      }));

      if (!timerRef.current) {
        const delay = Math.max(0, minInterval - elapsed);
        timerRef.current = window.setTimeout(flushPending, delay);
      }
    };

    const computeAndSchedule = () => {
      const snapshot = viewStateRef.current;

      const viewStart = Number(snapshot.timeDomain?.[0]);
      const viewEnd = Number(snapshot.timeDomain?.[1]);
      const span = Math.max(1, viewEnd - viewStart);
      const buffer = span * bufferFactor;
      const timeWindow: [number, number] = [
        clampNumber(viewStart - buffer, timeBounds.start, timeBounds.end),
        clampNumber(viewEnd + buffer, timeBounds.start, timeBounds.end)
      ];

      const visibleLaneIds = Array.isArray(snapshot.visibleLaneIds)
        ? snapshot.visibleLaneIds.map((lane) => String(lane))
        : [];
      const laneOrder = Array.isArray(snapshot.laneOrder)
        ? snapshot.laneOrder.map((lane) => String(lane))
        : [];
      const laneIds = getBufferedLaneIds(
        laneOrder,
        snapshot.visibleLaneRange,
        5,
        visibleLaneIds
      );

      const pixelWindow = Math.max(1, Number(snapshot.pixelWindow) || 1);
      const summaryLevel = Math.max(1, Math.round(pixelWindow));
      const viewportPxWidth = Math.max(1, Number(snapshot.viewportPxWidth) || 1);

      const nextRequest: StreamingRequest = {
        summaryLevel,
        timeWindow,
        laneIds,
        viewportPxWidth
      };

      viewStateRef.current = {
        ...snapshot,
        streamingRequest: nextRequest
      };

      const key = [
        timeWindow[0],
        timeWindow[1],
        summaryLevel,
        viewportPxWidth,
        stringifyArray(laneIds)
      ].join('|');
      if (key === lastKeyRef.current) return;
      lastKeyRef.current = key;

      scheduleRequest(nextRequest);
    };

    computeAndSchedule();
    const intervalId = window.setInterval(computeAndSchedule, POLL_MS);
    return () => {
      window.clearInterval(intervalId);
      if (timerRef.current) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [config.enabled, maxRequestsPerSec, bufferFactor, timeBounds.end, timeBounds.start]);

  return stats;
}

import type { DependencyGraphIndex } from '../utils/dependencyGraph';
import { getHierarchyValuesFromEvent } from '../utils/hierarchy';

export interface LogicalClockEvent {
  id?: string | number | null;
  start?: number;
  end?: number;
  hierarchy1?: string;
  hierarchy2?: string;
  hierarchyValues?: Array<string | number | null | undefined>;
}

export interface LogicalEventSpan {
  start: number;
  end: number;
  lateness: number;
}

export interface LogicalClockResult<T = any> {
  available: boolean;
  eventSpanById: Map<string, LogicalEventSpan>;
  domain: [number, number];
  mapPhysicalToLogical(time: number): number;
  mapLogicalToPhysical(time: number): number;
  dependencyEdgeCount: number;
  eventById: Map<string, T>;
}

interface ClockNode<T> {
  id: string;
  event: T;
  start: number;
  end: number;
  predecessors: Set<string>;
  successors: Set<string>;
}

interface SamplePoint {
  physical: number;
  logical: number;
}

function toEventId(event: { id?: string | number | null } | null | undefined): string | null {
  const value = String(event?.id ?? '').trim();
  return value || null;
}

function getTimePair(event: any): { start: number; end: number } | null {
  const start = Number(event?.start ?? event?.timeStart);
  const end = Number(event?.end ?? event?.timeEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return { start, end };
}

function getSequenceKey(event: any): string {
  const hierarchyValues = getHierarchyValuesFromEvent(event);
  if (hierarchyValues.length > 0) return hierarchyValues.join('|');
  const h1 = String(event?.hierarchy1 ?? 'unknown');
  const h2 = String(event?.hierarchy2 ?? '');
  return h2 ? `${h1}|${h2}` : h1;
}

function addEdge<T>(
  nodes: Map<string, ClockNode<T>>,
  sourceId: string | null | undefined,
  targetId: string | null | undefined
) {
  if (!sourceId || !targetId || sourceId === targetId) return;
  const source = nodes.get(sourceId);
  const target = nodes.get(targetId);
  if (!source || !target) return;
  if (source.successors.has(targetId)) return;
  source.successors.add(targetId);
  target.predecessors.add(sourceId);
}

function buildSamples<T>(
  events: T[],
  eventSpanById: Map<string, LogicalEventSpan>
): SamplePoint[] {
  const samples: SamplePoint[] = [];
  for (const event of events) {
    const id = toEventId(event as any);
    if (!id) continue;
    const logical = eventSpanById.get(id);
    const timePair = getTimePair(event);
    if (!logical || !timePair) continue;
    samples.push({ physical: timePair.start, logical: logical.start });
    samples.push({ physical: timePair.end, logical: logical.end });
  }
  samples.sort((a, b) => a.physical - b.physical || a.logical - b.logical);
  const monotone: SamplePoint[] = [];
  let maxLogical = Number.NEGATIVE_INFINITY;
  for (const sample of samples) {
    maxLogical = Math.max(maxLogical, sample.logical);
    const last = monotone[monotone.length - 1];
    if (last && Math.abs(last.physical - sample.physical) <= 1e-9) {
      last.logical = Math.max(last.logical, maxLogical);
    } else {
      monotone.push({ physical: sample.physical, logical: maxLogical });
    }
  }
  return monotone;
}

function invertSamples(samples: SamplePoint[]): SamplePoint[] {
  const swapped = samples
    .map((sample) => ({ physical: sample.logical, logical: sample.physical }))
    .sort((a, b) => a.physical - b.physical || a.logical - b.logical);
  const monotone: SamplePoint[] = [];
  let maxValue = Number.NEGATIVE_INFINITY;
  for (const sample of swapped) {
    maxValue = Math.max(maxValue, sample.logical);
    const last = monotone[monotone.length - 1];
    if (last && Math.abs(last.physical - sample.physical) <= 1e-9) {
      last.logical = Math.max(last.logical, maxValue);
    } else {
      monotone.push({ physical: sample.physical, logical: maxValue });
    }
  }
  return monotone;
}

function createPiecewiseMapper(samples: SamplePoint[], fallback: [number, number]) {
  if (!Array.isArray(samples) || samples.length === 0) {
    return (value: number) => {
      if (!Number.isFinite(value)) return fallback[0];
      return value <= fallback[0] ? fallback[0] : fallback[1];
    };
  }

  if (samples.length === 1) {
    const only = samples[0];
    return () => only.logical;
  }

  return (value: number) => {
    if (!Number.isFinite(value)) return samples[0].logical;
    if (value <= samples[0].physical) return samples[0].logical;
    const last = samples[samples.length - 1];
    if (value >= last.physical) return last.logical;

    let lo = 0;
    let hi = samples.length - 1;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      const current = samples[mid];
      if (Math.abs(current.physical - value) <= 1e-9) return current.logical;
      if (current.physical < value) lo = mid + 1;
      else hi = mid - 1;
    }

    const left = samples[Math.max(0, hi)];
    const right = samples[Math.min(samples.length - 1, lo)];
    if (!left || !right || Math.abs(right.physical - left.physical) <= 1e-9) {
      return left?.logical ?? right?.logical ?? samples[0].logical;
    }
    const ratio = (value - left.physical) / (right.physical - left.physical);
    return left.logical + ratio * (right.logical - left.logical);
  };
}

export function computeLogicalClock<T extends LogicalClockEvent>(
  events: T[],
  dependencyIndex: DependencyGraphIndex<T>
): LogicalClockResult<T> {
  const nodes = new Map<string, ClockNode<T>>();
  const eventById = new Map<string, T>();

  for (const event of events) {
    const id = toEventId(event);
    const timePair = getTimePair(event);
    if (!id || !timePair) continue;
    nodes.set(id, {
      id,
      event,
      start: timePair.start,
      end: timePair.end,
      predecessors: new Set<string>(),
      successors: new Set<string>()
    });
    eventById.set(id, event);
  }

  if (nodes.size === 0) {
    return {
      available: false,
      eventSpanById: new Map(),
      domain: [0, 1],
      mapPhysicalToLogical: (time: number) => Number(time) || 0,
      mapLogicalToPhysical: (time: number) => Number(time) || 0,
      dependencyEdgeCount: 0,
      eventById
    };
  }

  for (const edge of dependencyIndex.edges) {
    addEdge(nodes, edge.sourceId, edge.targetId);
  }

  const bySequence = new Map<string, ClockNode<T>[]>();
  for (const node of nodes.values()) {
    const key = getSequenceKey(node.event);
    const list = bySequence.get(key);
    if (list) list.push(node);
    else bySequence.set(key, [node]);
  }
  for (const list of bySequence.values()) {
    list.sort((a, b) => a.start - b.start || a.end - b.end);
    for (let index = 1; index < list.length; index += 1) {
      addEdge(nodes, list[index - 1].id, list[index].id);
    }
  }

  const indegree = new Map<string, number>();
  for (const node of nodes.values()) {
    indegree.set(node.id, node.predecessors.size);
  }

  const ready = [...nodes.values()]
    .filter((node) => (indegree.get(node.id) ?? 0) === 0)
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const order: ClockNode<T>[] = [];
  while (ready.length > 0) {
    ready.sort((a, b) => a.start - b.start || a.end - b.end);
    const node = ready.shift()!;
    order.push(node);
    for (const successorId of node.successors) {
      const next = (indegree.get(successorId) ?? 0) - 1;
      indegree.set(successorId, next);
      if (next === 0) {
        const successor = nodes.get(successorId);
        if (successor) ready.push(successor);
      }
    }
  }

  if (order.length < nodes.size) {
    const remaining = [...nodes.values()]
      .filter((node) => !order.includes(node))
      .sort((a, b) => a.start - b.start || a.end - b.end);
    order.push(...remaining);
  }

  const eventSpanById = new Map<string, LogicalEventSpan>();
  for (const node of order) {
    let logicalStart = 0;
    let earliestPhysicalStart = node.start;
    for (const predecessorId of node.predecessors) {
      const predecessorSpan = eventSpanById.get(predecessorId);
      const predecessorNode = nodes.get(predecessorId);
      if (predecessorSpan) {
        logicalStart = Math.max(logicalStart, predecessorSpan.end);
      }
      if (predecessorNode) {
        earliestPhysicalStart = Math.max(earliestPhysicalStart, predecessorNode.end);
      }
    }
    const logicalEnd = logicalStart + 1;
    eventSpanById.set(node.id, {
      start: logicalStart,
      end: logicalEnd,
      lateness: Math.max(0, node.start - earliestPhysicalStart)
    });
  }

  const spans = [...eventSpanById.values()];
  const logicalMin = spans.reduce((min, span) => Math.min(min, span.start), spans[0]?.start ?? 0);
  const logicalMax = spans.reduce((max, span) => Math.max(max, span.end), spans[0]?.end ?? 1);

  const physicalSamples = buildSamples(events, eventSpanById);
  const logicalSamples = invertSamples(physicalSamples);
  const physicalDomain: [number, number] = [
    physicalSamples[0]?.physical ?? 0,
    physicalSamples[physicalSamples.length - 1]?.physical ?? 1
  ];
  const logicalDomain: [number, number] = [
    logicalSamples[0]?.physical ?? logicalMin,
    logicalSamples[logicalSamples.length - 1]?.physical ?? logicalMax
  ];

  return {
    available: dependencyIndex.edges.length > 0 && eventSpanById.size > 0,
    eventSpanById,
    domain: [logicalMin, logicalMax],
    mapPhysicalToLogical: createPiecewiseMapper(physicalSamples, logicalDomain),
    mapLogicalToPhysical: createPiecewiseMapper(logicalSamples, physicalDomain),
    dependencyEdgeCount: dependencyIndex.edges.length,
    eventById
  };
}

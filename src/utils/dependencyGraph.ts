import { getValueAtPath } from './expression';

export type DependencyAmount = 'all' | 'paths' | '1hop';
export type DependencyDrawingStyle = 'straight' | 'orthogonal' | 'spline' | 'bundled';

export interface DependencyEdge {
  sourceId: string;
  targetId: string;
}

export interface DependencyGraphIndex<T = any> {
  edges: DependencyEdge[];
  eventById: Map<string, T>;
  forward: Map<string, string[]>;
  reverse: Map<string, string[]>;
}

function normalizeDependencyIds(rawDeps: unknown): string[] {
  if (Array.isArray(rawDeps)) {
    return rawDeps
      .map((value) => String(value ?? '').trim())
      .filter(Boolean);
  }
  if (typeof rawDeps === 'string') {
    return rawDeps
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
  }
  return [];
}

function readDependencyField(event: any, dependencyField: string): string[] {
  if (!event || !dependencyField) return [];
  const direct = getValueAtPath(event, dependencyField);
  const fallback =
    !dependencyField.includes('.') && event?.args && typeof event.args === 'object'
      ? event.args[dependencyField]
      : undefined;
  return normalizeDependencyIds(direct ?? fallback);
}

function addEdge(map: Map<string, string[]>, sourceId: string, targetId: string) {
  const current = map.get(sourceId);
  if (current) {
    current.push(targetId);
  } else {
    map.set(sourceId, [targetId]);
  }
}

export function buildDependencyIndex<T extends { id?: string | number | null }>(
  events: T[],
  dependencyField: string | null | undefined
): DependencyGraphIndex<T> {
  const eventById = new Map<string, T>();
  const forward = new Map<string, string[]>();
  const reverse = new Map<string, string[]>();
  const edges: DependencyEdge[] = [];

  if (!Array.isArray(events) || !dependencyField) {
    return { edges, eventById, forward, reverse };
  }

  for (const event of events) {
    const eventId = String(event?.id ?? '').trim();
    if (!eventId) continue;
    eventById.set(eventId, event);
  }

  for (const event of events) {
    const sourceId = String(event?.id ?? '').trim();
    if (!sourceId) continue;
    const dependencyIds = Array.from(new Set(readDependencyField(event, dependencyField)));
    for (const targetId of dependencyIds) {
      if (!targetId || !eventById.has(targetId) || targetId === sourceId) continue;
      edges.push({ sourceId, targetId });
      addEdge(forward, sourceId, targetId);
      addEdge(reverse, targetId, sourceId);
    }
  }

  return { edges, eventById, forward, reverse };
}

function collectOneHopEdges(index: DependencyGraphIndex, selectionId: string): DependencyEdge[] {
  return index.edges.filter(
    (edge) => edge.sourceId === selectionId || edge.targetId === selectionId
  );
}

function collectPathEdges(index: DependencyGraphIndex, selectionId: string): DependencyEdge[] {
  const visited = new Set<string>([selectionId]);
  const queue = [selectionId];

  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    const neighbors = [
      ...(index.forward.get(nodeId) || []),
      ...(index.reverse.get(nodeId) || [])
    ];
    for (const neighborId of neighbors) {
      if (visited.has(neighborId)) continue;
      visited.add(neighborId);
      queue.push(neighborId);
    }
  }

  return index.edges.filter(
    (edge) => visited.has(edge.sourceId) && visited.has(edge.targetId)
  );
}

export function getVisibleEdges(
  index: DependencyGraphIndex,
  amount: DependencyAmount,
  selectionId: string | null | undefined,
  maxEdges: number
): DependencyEdge[] {
  const limit = Number.isFinite(maxEdges) ? Math.max(0, Math.floor(maxEdges)) : index.edges.length;
  if (limit === 0) return [];

  let edges: DependencyEdge[] = [];
  if (amount === 'all') {
    edges = index.edges;
  } else if (selectionId) {
    edges = amount === 'paths'
      ? collectPathEdges(index, selectionId)
      : collectOneHopEdges(index, selectionId);
  }

  return edges.slice(0, limit);
}

export function straightPath(sx: number, sy: number, tx: number, ty: number): string {
  return `M${sx},${sy} L${tx},${ty}`;
}

export function orthogonalPath(sx: number, sy: number, tx: number, ty: number): string {
  const mx = sx + (tx - sx) / 2;
  return `M${sx},${sy} L${mx},${sy} L${mx},${ty} L${tx},${ty}`;
}

export function splinePath(sx: number, sy: number, tx: number, ty: number): string {
  const mx = (sx + tx) / 2;
  return `M${sx},${sy} C${mx},${sy} ${mx},${ty} ${tx},${ty}`;
}

export function bundledPath(sx: number, sy: number, tx: number, ty: number): string {
  const dx = tx - sx;
  const dy = ty - sy;
  const bundleStrength = Math.max(18, Math.min(80, Math.abs(dy) * 0.35));
  const cx1 = sx + dx * 0.35;
  const cx2 = sx + dx * 0.65;
  const cy = sy + dy / 2;
  return `M${sx},${sy} C${cx1},${cy - bundleStrength} ${cx2},${cy + bundleStrength} ${tx},${ty}`;
}

export function buildDependencyPath(
  drawingStyle: DependencyDrawingStyle,
  sx: number,
  sy: number,
  tx: number,
  ty: number
): string {
  switch (drawingStyle) {
    case 'straight':
      return straightPath(sx, sy, tx, ty);
    case 'orthogonal':
      return orthogonalPath(sx, sy, tx, ty);
    case 'bundled':
      return bundledPath(sx, sy, tx, ty);
    case 'spline':
    default:
      return splinePath(sx, sy, tx, ty);
  }
}

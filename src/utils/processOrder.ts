import { evalExpr, evalPredicate, isEmptyValue } from './expression';

export function comparePid(a: unknown, b: unknown): number {
  const na = parseFloat(String(a));
  const nb = parseFloat(String(b));
  if (!isNaN(na) && !isNaN(nb)) return na - nb;
  return String(a).localeCompare(String(b));
}

export function normalizeProcessOrderRule(yAxisConfig: any, fallbackMode: string): any {
  if (yAxisConfig?.hierarchy1OrderRule) return yAxisConfig.hierarchy1OrderRule;
  if (yAxisConfig?.processOrderRule) return yAxisConfig.processOrderRule;
  const legacyMode = yAxisConfig?.orderMode || fallbackMode;
  const includeUnspecified = yAxisConfig?.includeUnspecified !== false;
  if (legacyMode === 'fork') {
    return { type: 'transform', name: 'forkTree', params: { includeUnspecified } };
  }
  if (legacyMode === 'custom') {
    return {
      type: 'transform',
      name: 'customList',
      params: { list: yAxisConfig?.customOrder || [], includeUnspecified }
    };
  }
  if (legacyMode === 'grouped') {
    return {
      type: 'transform',
      name: 'groupList',
      params: { groups: yAxisConfig?.groups || [], includeUnspecified }
    };
  }
  return { type: 'transform', name: 'pidAsc' };
}

export function inferProcessSortModeFromRule(rule: any): 'default' | 'fork' {
  if (!rule) return 'default';
  if (rule?.type === 'transform' && rule?.name === 'forkTree') return 'fork';
  if (rule?.type === 'transform' && rule?.name === 'pipeline') {
    const steps = Array.isArray(rule?.params?.steps) ? rule.params.steps : [];
    if (steps.some((step: any) => step?.name === 'forkTree')) return 'fork';
  }
  return 'default';
}

export function resolveThreadLaneMode(rule: any, fallbackMode?: string): 'level' | 'auto' {
  const name =
    typeof rule === 'string'
      ? rule
      : rule?.name ?? rule?.params?.name;
  if (name === 'autoPack') return 'auto';
  if (name === 'byField' || name === 'byLevel') return 'level';
  if (fallbackMode === 'level' || fallbackMode === 'auto') return fallbackMode;
  return 'auto';
}

/**
 * Field path used to group events into hierarchy2 lanes when rule is byField (or legacy byLevel).
 * Links directly to any event attribute (e.g. "level", "args.depth", "cat"). No fixed fields.
 * When params.field is omitted, returns "level" so grouping is still applied (caller may try alternates).
 */
export function getThreadLaneFieldPath(rule: any): string {
  if (!rule || typeof rule !== 'object') return '';
  const name = rule?.name ?? rule?.params?.name;
  if (name !== 'byField' && name !== 'byLevel') return '';
  const field = rule.params?.field ?? rule.field;
  if (typeof field === 'string' && field.trim()) return field.trim();
  return 'level';
}

export function applyProcessOrderRule(
  rule: any,
  ctx: {
    pids: string[];
    processStats?: Map<string, any>;
    fork?: { parentByHierarchy1?: Map<string, string> };
  }
): { orderedHierarchy1Ids: string[]; depthByHierarchy1: Map<string, number> } {
  const baseOrder = ctx?.pids ? ctx.pids.map(String) : [];
  let ordered = [...baseOrder];
  let depthByHierarchy1 = new Map<string, number>(ordered.map((id) => [id, 0]));
  if (!rule) return { orderedHierarchy1Ids: ordered, depthByHierarchy1 };

  const getRuleName = (step: any) => step?.name || step?.op || step?.type;
  const ruleParams = (step: any) => step?.params || {};

  const compareByRule =
    (ruleExpr: any, order = 'asc') =>
    (a: string, b: string) => {
      const ctxA = {
        pid: a,
        hierarchy1: a,
        stats: ctx.processStats?.get(String(a)) || {},
        vars: { pid: a, hierarchy1: a }
      };
      const ctxB = {
        pid: b,
        hierarchy1: b,
        stats: ctx.processStats?.get(String(b)) || {},
        vars: { pid: b, hierarchy1: b }
      };
      const va = evalExpr(ruleExpr, ctxA);
      const vb = evalExpr(ruleExpr, ctxB);
      let cmp = 0;
      if (Number.isFinite(Number(va)) && Number.isFinite(Number(vb))) {
        cmp = Number(va) - Number(vb);
      } else {
        cmp = String(va ?? '').localeCompare(String(vb ?? ''));
      }
      if (cmp === 0) {
        cmp = comparePid(a, b);
      }
      return order === 'desc' ? -cmp : cmp;
    };

  const applyStep = (step: any) => {
    if (!step) return;
    const name = getRuleName(step);
    const params = ruleParams(step);
    if (name === 'pidAsc' || name === 'hierarchy1Asc') {
      ordered = [...ordered].sort(comparePid);
      depthByHierarchy1 = new Map(ordered.map((pid) => [pid, 0]));
      return;
    }
    if (name === 'pidDesc' || name === 'hierarchy1Desc') {
      ordered = [...ordered].sort((a, b) => -comparePid(a, b));
      depthByHierarchy1 = new Map(ordered.map((pid) => [pid, 0]));
      return;
    }
    if (name === 'filter') {
      const when = params.when || step.when;
      ordered = ordered.filter((pid) =>
        evalPredicate(when, {
          pid,
          hierarchy1: pid,
          stats: ctx.processStats?.get(String(pid)) || {},
          vars: { pid, hierarchy1: pid }
        })
      );
      depthByHierarchy1 = new Map(ordered.map((pid) => [pid, 0]));
      return;
    }
    if (name === 'customList') {
      const list = Array.isArray(params.list) ? params.list.map(String) : [];
      const includeUnspecified = params.includeUnspecified !== false;
      const baseSet = new Set(baseOrder);
      const nextOrdered: string[] = [];
      const used = new Set<string>();
      list.forEach((pid: string) => {
        if (baseSet.has(pid) && !used.has(pid)) {
          nextOrdered.push(pid);
          used.add(pid);
        }
      });
      if (includeUnspecified) {
        baseOrder.forEach((pid) => {
          if (!used.has(pid)) {
            nextOrdered.push(pid);
            used.add(pid);
          }
        });
      }
      ordered = nextOrdered.length > 0 ? nextOrdered : baseOrder;
      depthByHierarchy1 = new Map(ordered.map((pid) => [pid, 0]));
      return;
    }
    if (name === 'groupList') {
      const groups = Array.isArray(params.groups) ? params.groups : [];
      const includeUnspecified = params.includeUnspecified !== false;
      const baseSet = new Set(baseOrder);
      const nextOrdered: string[] = [];
      const used = new Set<string>();
      const sortedGroups = [...groups].sort((a, b) => (a.order || 0) - (b.order || 0));
      sortedGroups.forEach((group: any) => {
        const groupPids = group?.pids || group?.tracks || group?.items || [];
        groupPids.forEach((pid: any) => {
          const key = String(pid);
          if (baseSet.has(key) && !used.has(key)) {
            nextOrdered.push(key);
            used.add(key);
          }
        });
      });
      if (includeUnspecified) {
        baseOrder.forEach((pid) => {
          if (!used.has(pid)) {
            nextOrdered.push(pid);
            used.add(pid);
          }
        });
      }
      ordered = nextOrdered.length > 0 ? nextOrdered : baseOrder;
      depthByHierarchy1 = new Map(ordered.map((pid) => [pid, 0]));
      return;
    }
    if (name === 'sortBy') {
      const keyRule = params.key || step.key;
      const order = params.order || 'asc';
      ordered = [...ordered].sort(compareByRule(keyRule, order));
      depthByHierarchy1 = new Map(ordered.map((pid) => [pid, 0]));
      return;
    }
    if (name === 'groupBy') {
      const keyRule = params.key || step.key;
      const order = params.order || 'asc';
      const includeUnspecified = params.includeUnspecified !== false;
      const groupMap = new Map<string, string[]>();
      ordered.forEach((pid) => {
        const key = evalExpr(keyRule, {
          pid,
          hierarchy1: pid,
          stats: ctx.processStats?.get(String(pid)) || {},
          vars: { pid, hierarchy1: pid }
        });
        if (isEmptyValue(key)) {
          if (!includeUnspecified) return;
        }
        const groupKey = isEmptyValue(key) ? '__unspecified__' : String(key);
        if (!groupMap.has(groupKey)) groupMap.set(groupKey, []);
        groupMap.get(groupKey)!.push(pid);
      });
      const groupKeys = Array.from(groupMap.keys());
      groupKeys.sort((a, b) => {
        const cmp = String(a).localeCompare(String(b));
        return order === 'desc' ? -cmp : cmp;
      });
      ordered = groupKeys.flatMap((k) => groupMap.get(k)!);
      depthByHierarchy1 = new Map(ordered.map((pid) => [pid, 0]));
      return;
    }
    if (name === 'forkTree') {
      const includeUnspecified = params.includeUnspecified !== false;
      const tieBreak = params.tieBreak;
      const canonicalIndex = new Map(baseOrder.map((pid, i) => [String(pid), i]));
      const existingPids = new Set(baseOrder.map((pid) => String(pid)));

      const fork = ctx.fork;
      const parentByHierarchy1Existing = new Map<string, string>();
      const childrenByHierarchy1Existing = new Map<string, string[]>();
      if (fork && fork.parentByHierarchy1 instanceof Map) {
        for (const id of existingPids) {
          const parentId = fork.parentByHierarchy1.get(id);
          if (!parentId) continue;
          const parentStr = String(parentId);
          if (!existingPids.has(parentStr)) continue;
          if (parentStr === id) continue;
          parentByHierarchy1Existing.set(id, parentStr);
          if (!childrenByHierarchy1Existing.has(parentStr)) childrenByHierarchy1Existing.set(parentStr, []);
          childrenByHierarchy1Existing.get(parentStr)!.push(id);
        }
      }

      const sortList = (list: string[], parentPid: string | null) => {
        if (!tieBreak) {
          list.sort((a, b) => (canonicalIndex.get(a) ?? 0) - (canonicalIndex.get(b) ?? 0));
          return;
        }
        list.sort((a, b) => {
          const ctxA = {
            pid: a,
            hierarchy1: a,
            parentPid,
            stats: ctx.processStats?.get(String(a)) || {},
            vars: { pid: a, hierarchy1: a, parentPid }
          };
          const ctxB = {
            pid: b,
            hierarchy1: b,
            parentPid,
            stats: ctx.processStats?.get(String(b)) || {},
            vars: { pid: b, hierarchy1: b, parentPid }
          };
          const va = evalExpr(tieBreak, ctxA);
          const vb = evalExpr(tieBreak, ctxB);
          let cmp = 0;
          if (Number.isFinite(Number(va)) && Number.isFinite(Number(vb))) {
            cmp = Number(va) - Number(vb);
          } else {
            cmp = String(va ?? '').localeCompare(String(vb ?? ''));
          }
          if (cmp === 0) cmp = (canonicalIndex.get(a) ?? 0) - (canonicalIndex.get(b) ?? 0);
          return cmp;
        });
      };

      for (const [parentId, kids] of childrenByHierarchy1Existing.entries()) {
        sortList(kids, parentId);
        childrenByHierarchy1Existing.set(parentId, kids);
      }

      const roots = baseOrder.map(String).filter((id) => !parentByHierarchy1Existing.has(id));
      sortList(roots, null);

      const nextOrdered: string[] = [];
      const nextDepth = new Map<string, number>();
      const visited = new Set<string>();
      const dfsIterative = (startIds: string[]) => {
        const stack: Array<{ id: string; depth: number }> = [];
        for (let i = startIds.length - 1; i >= 0; i -= 1) {
          stack.push({ id: startIds[i], depth: 0 });
        }
        while (stack.length > 0) {
          const current = stack.pop();
          if (!current) continue;
          const { id, depth } = current;
          if (!id || visited.has(id)) continue;
          visited.add(id);
          nextOrdered.push(id);
          nextDepth.set(id, depth);
          const kids = childrenByHierarchy1Existing.get(id) || [];
          for (let i = kids.length - 1; i >= 0; i -= 1) {
            const child = kids[i];
            if (!visited.has(child)) {
              stack.push({ id: child, depth: depth + 1 });
            }
          }
        }
      };
      dfsIterative(roots);
      if (includeUnspecified) {
        const remaining = baseOrder.filter((id) => !visited.has(id));
        dfsIterative(remaining);
      }

      ordered = nextOrdered.length > 0 ? nextOrdered : baseOrder;
      depthByHierarchy1 = nextDepth.size > 0 ? nextDepth : new Map(ordered.map((id) => [id, 0]));
      return;
    }
  };

  if (rule?.type === 'transform' && rule?.name === 'pipeline') {
    const steps = Array.isArray(rule?.params?.steps) ? rule.params.steps : [];
    steps.forEach((step: any) => applyStep(step));
  } else {
    applyStep(rule);
  }

  return { orderedHierarchy1Ids: ordered, depthByHierarchy1 };
}

export function buildPatchForPath(path: unknown, value: any): Record<string, any> {
  if (!path) return {};
  const parts = String(path).split('.').filter(Boolean);
  if (parts.length === 0) return {};
  const patch: Record<string, any> = {};
  let cursor: Record<string, any> = patch;
  parts.forEach((part, index) => {
    if (index === parts.length - 1) {
      cursor[part] = value;
    } else {
      cursor[part] = {};
      cursor = cursor[part];
    }
  });
  return patch;
}

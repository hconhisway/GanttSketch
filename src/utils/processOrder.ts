import { evalExpr, evalPredicate, isEmptyValue } from './expression';

export function comparePid(a: unknown, b: unknown): number {
  const na = parseFloat(String(a));
  const nb = parseFloat(String(b));
  if (!isNaN(na) && !isNaN(nb)) return na - nb;
  return String(a).localeCompare(String(b));
}

export function normalizeProcessOrderRule(yAxisConfig: any, fallbackMode: string): any {
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

export function resolveThreadLaneMode(rule: any, fallbackMode: string): 'level' | 'auto' {
  if (rule?.type === 'transform' || rule?.name) {
    if (rule.name === 'byLevel') return 'level';
    if (rule.name === 'autoPack') return 'auto';
  }
  if (fallbackMode === 'level' || fallbackMode === 'auto') return fallbackMode;
  return 'auto';
}

export function applyProcessOrderRule(
  rule: any,
  ctx: {
    pids: string[];
    processStats?: Map<string, any>;
    fork?: { parentByPid?: Map<string, string> };
  }
): { orderedPids: string[]; depthByPid: Map<string, number> } {
  const baseOrder = ctx?.pids ? ctx.pids.map(String) : [];
  let ordered = [...baseOrder];
  let depthByPid = new Map<string, number>(ordered.map((pid) => [pid, 0]));
  if (!rule) return { orderedPids: ordered, depthByPid };

  const getRuleName = (step: any) => step?.name || step?.op || step?.type;
  const ruleParams = (step: any) => step?.params || {};

  const compareByRule =
    (ruleExpr: any, order = 'asc') =>
    (a: string, b: string) => {
      const ctxA = { pid: a, stats: ctx.processStats?.get(String(a)) || {}, vars: { pid: a } };
      const ctxB = { pid: b, stats: ctx.processStats?.get(String(b)) || {}, vars: { pid: b } };
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
    if (name === 'pidAsc') {
      ordered = [...ordered].sort(comparePid);
      depthByPid = new Map(ordered.map((pid) => [pid, 0]));
      return;
    }
    if (name === 'pidDesc') {
      ordered = [...ordered].sort((a, b) => -comparePid(a, b));
      depthByPid = new Map(ordered.map((pid) => [pid, 0]));
      return;
    }
    if (name === 'filter') {
      const when = params.when || step.when;
      ordered = ordered.filter((pid) =>
        evalPredicate(when, {
          pid,
          stats: ctx.processStats?.get(String(pid)) || {},
          vars: { pid }
        })
      );
      depthByPid = new Map(ordered.map((pid) => [pid, 0]));
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
      depthByPid = new Map(ordered.map((pid) => [pid, 0]));
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
      depthByPid = new Map(ordered.map((pid) => [pid, 0]));
      return;
    }
    if (name === 'sortBy') {
      const keyRule = params.key || step.key;
      const order = params.order || 'asc';
      ordered = [...ordered].sort(compareByRule(keyRule, order));
      depthByPid = new Map(ordered.map((pid) => [pid, 0]));
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
          stats: ctx.processStats?.get(String(pid)) || {},
          vars: { pid }
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
      depthByPid = new Map(ordered.map((pid) => [pid, 0]));
      return;
    }
    if (name === 'forkTree') {
      const includeUnspecified = params.includeUnspecified !== false;
      const tieBreak = params.tieBreak;
      const canonicalIndex = new Map(baseOrder.map((pid, i) => [String(pid), i]));
      const existingPids = new Set(baseOrder.map((pid) => String(pid)));

      const fork = ctx.fork;
      const parentByPidExisting = new Map<string, string>();
      const childrenByPidExisting = new Map<string, string[]>();
      if (fork && fork.parentByPid instanceof Map) {
        for (const pid of existingPids) {
          const ppid = fork.parentByPid.get(pid);
          if (!ppid) continue;
          const ppidStr = String(ppid);
          if (!existingPids.has(ppidStr)) continue;
          if (ppidStr === pid) continue;
          parentByPidExisting.set(pid, ppidStr);
          if (!childrenByPidExisting.has(ppidStr)) childrenByPidExisting.set(ppidStr, []);
          childrenByPidExisting.get(ppidStr)!.push(pid);
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
            parentPid,
            stats: ctx.processStats?.get(String(a)) || {},
            vars: { pid: a, parentPid }
          };
          const ctxB = {
            pid: b,
            parentPid,
            stats: ctx.processStats?.get(String(b)) || {},
            vars: { pid: b, parentPid }
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

      for (const [ppid, kids] of childrenByPidExisting.entries()) {
        sortList(kids, ppid);
        childrenByPidExisting.set(ppid, kids);
      }

      const roots = baseOrder.map(String).filter((pid) => !parentByPidExisting.has(pid));
      sortList(roots, null);

      const nextOrdered: string[] = [];
      const nextDepth = new Map<string, number>();
      const visited = new Set<string>();
      const dfs = (pid: string, depth: number) => {
        if (!pid || visited.has(pid)) return;
        visited.add(pid);
        nextOrdered.push(pid);
        nextDepth.set(pid, depth);
        const kids = childrenByPidExisting.get(pid) || [];
        for (const child of kids) dfs(child, depth + 1);
      };
      roots.forEach((pid) => dfs(pid, 0));
      if (includeUnspecified) {
        baseOrder.forEach((pid) => {
          if (!visited.has(pid)) dfs(pid, 0);
        });
      }

      ordered = nextOrdered.length > 0 ? nextOrdered : baseOrder;
      depthByPid = nextDepth.size > 0 ? nextDepth : new Map(ordered.map((pid) => [pid, 0]));
      return;
    }
  };

  if (rule?.type === 'transform' && rule?.name === 'pipeline') {
    const steps = Array.isArray(rule?.params?.steps) ? rule.params.steps : [];
    steps.forEach((step: any) => applyStep(step));
  } else {
    applyStep(rule);
  }

  return { orderedPids: ordered, depthByPid };
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

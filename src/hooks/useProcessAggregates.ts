import { useEffect, useMemo } from 'react';

interface UseProcessAggregatesArgs {
  data: any[];
  obd: any;
  startTime: number;
  endTime: number;
  mergeGapRatio: number;
  setThreadsByPid: (next: Map<any, any>) => void;
  setProcessAggregates: (next: Map<any, any>) => void;
  setExpandedPids: (updater: (prev: string[]) => string[]) => void;
  threadsByPid: Map<any, any>;
  processAggregates: Map<any, any>;
}

export function useProcessAggregates({
  data,
  obd,
  startTime,
  endTime,
  mergeGapRatio,
  setThreadsByPid,
  setProcessAggregates,
  setExpandedPids,
  threadsByPid,
  processAggregates
}: UseProcessAggregatesArgs) {
  const aggregates = useMemo(() => {
    if (!data || data.length === 0 || !obd) {
      return { threadMap: new Map(), processMap: new Map() };
    }

    const windowUs = Math.max(0, Number(endTime) - Number(startTime));
    const mergeGapUs = windowUs * mergeGapRatio;
    const threadMap = new Map();

    data.forEach((ev) => {
      const pid = ev.pid ?? 'unknown';
      const tid = ev.tid ?? pid;
      const level = Number.isFinite(Number(ev.level)) ? Number(ev.level) : 0;
      const start = Number(ev.start);
      const end = Number(ev.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;

      if (!threadMap.has(pid)) threadMap.set(pid, new Map());
      const tidMap = threadMap.get(pid);
      if (!tidMap.has(tid)) tidMap.set(tid, new Map());
      const levelMap = tidMap.get(tid);
      if (!levelMap.has(level)) levelMap.set(level, []);

      levelMap.get(level).push({
        ...ev,
        pid,
        tid,
        level,
        start,
        end,
        count: ev.count ?? 1
      });
    });

    // Sort events within each level
    threadMap.forEach((tidMap: Map<any, Map<any, any[]>>) => {
      tidMap.forEach((levelMap: Map<any, any[]>) => {
        levelMap.forEach((arr: any[]) => {
          arr.sort((a: any, b: any) => a.start - b.start);
        });
      });
    });

    // Build process aggregates by merging close/overlapping events across all threads
    const processMap = new Map();
    threadMap.forEach((tidMap: Map<any, Map<any, any[]>>, pid: any) => {
      const all: any[] = [];
      tidMap.forEach((levelMap: Map<any, any[]>) => {
        levelMap.forEach((arr: any[]) => all.push(...arr));
      });
      all.sort((a, b) => a.start - b.start);

      const merged: any[] = [];
      all.forEach((ev) => {
        if (merged.length === 0) {
          merged.push({ ...ev, count: ev.count ?? 1 });
          return;
        }
        const last = merged[merged.length - 1];
        const gap = ev.start - last.end;
        if (gap <= mergeGapUs) {
          last.end = Math.max(last.end, ev.end);
          last.count = (last.count || 1) + (ev.count || 1);
        } else {
          merged.push({ ...ev, count: ev.count ?? 1 });
        }
      });
      processMap.set(pid, merged);
    });

    return { threadMap, processMap };
  }, [data, obd, startTime, endTime, mergeGapRatio]);

  useEffect(() => {
    setThreadsByPid(aggregates.threadMap);
    setProcessAggregates(aggregates.processMap);
  }, [aggregates, setProcessAggregates, setThreadsByPid]);

  // Drop expanded pids that no longer exist
  useEffect(() => {
    setExpandedPids((prev) =>
      prev.filter((pid) => threadsByPid.has(pid) || processAggregates.has(pid))
    );
  }, [threadsByPid, processAggregates, setExpandedPids]);
}

import {
  getEntityKey,
  mergeIntervals,
  buildUnionIntervalsByEntity,
  computeUtilizationArea,
  computeUtilizationCount,
  resolveBinCount,
  computeOverviewModel
} from './compute';
import type { AuxOverviewConfig } from './types';

describe('auxCharts compute', () => {
  describe('mergeIntervals', () => {
    it('merges overlapping intervals', () => {
      const intervals = [
        { start: 0, end: 10 },
        { start: 5, end: 15 },
        { start: 14, end: 20 }
      ];
      expect(mergeIntervals(intervals)).toEqual([{ start: 0, end: 20 }]);
    });

    it('keeps disjoint intervals separate', () => {
      const intervals = [
        { start: 0, end: 10 },
        { start: 20, end: 30 }
      ];
      expect(mergeIntervals(intervals)).toEqual([
        { start: 0, end: 10 },
        { start: 20, end: 30 }
      ]);
    });

    it('sorts by start then merges', () => {
      const intervals = [
        { start: 20, end: 30 },
        { start: 0, end: 10 },
        { start: 5, end: 15 }
      ];
      expect(mergeIntervals(intervals)).toEqual([
        { start: 0, end: 15 },
        { start: 20, end: 30 }
      ]);
    });
  });

  describe('getEntityKey', () => {
    it('uses hierarchy1 for entityLevel 1', () => {
      expect(getEntityKey({ hierarchyValues: ['p1', 't1'] }, 1)).toBe('p1');
      expect(getEntityKey({ hierarchy1: 'p2' }, 1)).toBe('p2');
    });

    it('uses hierarchy1|hierarchy2 for entityLevel 2', () => {
      expect(getEntityKey({ hierarchyValues: ['p1', 't1'] }, 2)).toBe('p1|t1');
    });
  });

  describe('buildUnionIntervalsByEntity', () => {
    it('merges overlapping events within same process (no double count)', () => {
      const events = [
        { start: 0, end: 100, hierarchy1: 'p1', hierarchyValues: ['p1'] },
        { start: 50, end: 150, hierarchy1: 'p1', hierarchyValues: ['p1'] }
      ];
      const map = buildUnionIntervalsByEntity(events, 1);
      expect(map.size).toBe(1);
      expect(map.get('p1')).toEqual([{ start: 0, end: 150 }]);
    });

    it('two disjoint intervals in same bin count as one process', () => {
      const events = [
        { start: 10, end: 20, hierarchy1: 'p1', hierarchyValues: ['p1'] },
        { start: 50, end: 60, hierarchy1: 'p1', hierarchyValues: ['p1'] }
      ];
      const map = buildUnionIntervalsByEntity(events, 1);
      expect(map.get('p1')).toEqual([
        { start: 10, end: 20 },
        { start: 50, end: 60 }
      ]);
    });
  });

  describe('computeUtilizationArea', () => {
    it('single interval partial-bin overlap gives correct fraction', () => {
      const byEntity = new Map<string, Array<{ start: number; end: number }>>();
      byEntity.set('p1', [{ start: 25, end: 75 }]); // covers middle half of [0,100]
      const values = computeUtilizationArea(4, 0, 100, byEntity);
      expect(values.length).toBe(4);
      // Bins: [0,25), [25,50), [50,75), [75,100]. p1 occupies 25 in bin1, 25 in bin2, 25 in bin3.
      // Per bin fraction for p1: bin0=0, bin1=1, bin2=1, bin3=0. So average (1 entity) = 0, 1, 1, 0.
      expect(values[0]).toBe(0);
      expect(values[1]).toBe(1);
      expect(values[2]).toBe(1);
      expect(values[3]).toBe(0);
    });

    it('overlapping intervals within same process do not double count', () => {
      const byEntity = new Map<string, Array<{ start: number; end: number }>>();
      byEntity.set('p1', [{ start: 0, end: 100 }]); // one merged interval
      const values = computeUtilizationArea(2, 0, 100, byEntity);
      expect(values).toEqual([1, 1]);
    });
  });

  describe('computeUtilizationCount', () => {
    it('counts one active process per bin', () => {
      const byEntity = new Map<string, Array<{ start: number; end: number }>>();
      byEntity.set('p1', [{ start: 10, end: 90 }]);
      byEntity.set('p2', [{ start: 0, end: 50 }]);
      const values = computeUtilizationCount(4, 0, 100, byEntity);
      expect(values.length).toBe(4);
      // Bins [0,25) [25,50) [50,75) [75,100]. p1 in all 4, p2 in first two.
      expect(values[0]).toBe(2);
      expect(values[1]).toBe(2);
      expect(values[2]).toBe(1);
      expect(values[3]).toBe(1);
    });

    it('two disjoint intervals in same bin count as 1 for that process', () => {
      const byEntity = new Map<string, Array<{ start: number; end: number }>>();
      byEntity.set('p1', [
        { start: 5, end: 15 },
        { start: 55, end: 65 }
      ]);
      const values = computeUtilizationCount(4, 0, 100, byEntity);
      expect(values[0]).toBe(1); // p1 in bin 0
      expect(values[2]).toBe(1); // p1 in bin 2
    });
  });

  describe('resolveBinCount', () => {
    it('fixed mode uses fixed count', () => {
      expect(resolveBinCount({ kind: 'utilizationArea', bins: { mode: 'fixed', fixed: 500 } }, 800)).toBe(500);
    });

    it('auto mode clamps to innerWidth and min/max', () => {
      const autoBins = { kind: 'utilizationArea' as const, bins: { mode: 'auto' as const, min: 300, max: 900 } };
      expect(resolveBinCount(autoBins, 400)).toBe(400);
      expect(resolveBinCount(autoBins, 200)).toBe(300);
      expect(resolveBinCount(autoBins, 1000)).toBe(900);
    });
  });

  describe('computeOverviewModel', () => {
    const t0 = 0;
    const t1 = 1000;
    const events = [
      { start: 100, end: 400, hierarchy1: 'p1', hierarchyValues: ['p1'] },
      { start: 200, end: 500, hierarchy1: 'p1', hierarchyValues: ['p1'] },
      { start: 600, end: 900, hierarchy1: 'p2', hierarchyValues: ['p2'] }
    ];

    it('utilizationArea returns one series with 0..1 values', () => {
      const model = computeOverviewModel(
        events,
        t0,
        t1,
        { kind: 'utilizationArea', entityLevel: 1 },
        10
      );
      expect(model.kind).toBe('utilizationArea');
      expect(model.series.length).toBe(1);
      expect(model.series[0].values.length).toBe(10);
      expect(model.entityCount).toBe(2);
      const maxV = Math.max(...model.series[0].values);
      expect(maxV).toBeLessThanOrEqual(1);
      expect(maxV).toBeGreaterThan(0);
    });

    it('utilizationCount returns one series with integer counts', () => {
      const model = computeOverviewModel(
        events,
        t0,
        t1,
        { kind: 'utilizationCount', entityLevel: 1 },
        10
      );
      expect(model.kind).toBe('utilizationCount');
      expect(model.series.length).toBe(1);
      model.series[0].values.forEach((v) => expect(Number.isInteger(v)).toBe(true));
    });

    it('stackedArea with groupBy returns multiple series', () => {
      const eventsWithCat = [
        { start: 0, end: 200, hierarchy1: 'p1', hierarchyValues: ['p1'], cat: 'A' },
        { start: 100, end: 300, hierarchy1: 'p2', hierarchyValues: ['p2'], cat: 'B' },
        { start: 200, end: 400, hierarchy1: 'p3', hierarchyValues: ['p3'], cat: 'A' }
      ];
      const model = computeOverviewModel(
        eventsWithCat,
        t0,
        t1,
        {
          kind: 'stackedArea',
          entityLevel: 1,
          stacked: {
            mode: 'groupBy',
            groupBy: { op: 'get', path: 'event.cat' },
            topK: 5,
            includeOther: false
          }
        },
        5
      );
      expect(model.kind).toBe('stackedArea');
      expect(model.series.length).toBeGreaterThanOrEqual(2);
      const ids = model.series.map((s) => s.id);
      expect(ids).toContain('A');
      expect(ids).toContain('B');
    });

    it('stackedArea with explicit series (predicates) separates by when', () => {
      const eventsWithCat = [
        { start: 0, end: 200, hierarchy1: 'p1', hierarchyValues: ['p1'], cat: 'cpu' },
        { start: 100, end: 300, hierarchy1: 'p2', hierarchyValues: ['p2'], cat: 'io' }
      ];
      const model = computeOverviewModel(
        eventsWithCat,
        t0,
        t1,
        {
          kind: 'stackedArea',
          entityLevel: 1,
          stacked: {
            mode: 'series',
            series: [
              {
                id: 'cpu',
                label: 'CPU',
                when: { op: '==', args: [{ op: 'get', path: 'event.cat' }, 'cpu'] }
              },
              {
                id: 'io',
                label: 'IO',
                when: { op: '==', args: [{ op: 'get', path: 'event.cat' }, 'io'] }
              }
            ]
          }
        },
        5
      );
      expect(model.kind).toBe('stackedArea');
      expect(model.series.length).toBe(2);
      expect(model.series.map((s) => s.id).sort()).toEqual(['cpu', 'io']);
    });
  });
});

import {
  applyProcessOrderRule,
  comparePid,
  inferProcessSortModeFromRule,
  normalizeProcessOrderRule,
  resolveThreadLaneMode
} from './processOrder';

describe('process order utils', () => {
  it('compares pids numerically when possible', () => {
    expect(comparePid(2, 10)).toBeLessThan(0);
    expect(comparePid('b', 'a')).toBeGreaterThan(0);
  });

  it('normalizes legacy process order config', () => {
    const rule = normalizeProcessOrderRule(
      { orderMode: 'custom', customOrder: ['2', '1'] },
      'pidAsc'
    );
    expect(rule).toEqual({
      type: 'transform',
      name: 'customList',
      params: { list: ['2', '1'], includeUnspecified: true }
    });
  });

  it('infers sort and thread lane modes', () => {
    expect(inferProcessSortModeFromRule({ type: 'transform', name: 'forkTree' })).toBe('fork');
    expect(resolveThreadLaneMode({ name: 'byLevel' }, 'auto')).toBe('level');
  });

  it('applies custom list ordering', () => {
    const result = applyProcessOrderRule(
      { type: 'transform', name: 'customList', params: { list: ['b'], includeUnspecified: true } },
      { pids: ['a', 'b', 'c'] }
    );
    expect(result.orderedPids).toEqual(['b', 'a', 'c']);
  });
});

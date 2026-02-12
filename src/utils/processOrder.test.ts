import {
  applyProcessOrderRule,
  comparePid,
  getThreadLaneFieldPath,
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

  it('prefers hierarchy1OrderRule when present', () => {
    const explicit = { type: 'transform', name: 'pidAsc' };
    const rule = normalizeProcessOrderRule(
      { hierarchy1OrderRule: explicit, orderMode: 'custom', customOrder: ['1'] },
      'pidAsc'
    );
    expect(rule).toBe(explicit);
  });

  it('infers sort and thread lane modes', () => {
    expect(inferProcessSortModeFromRule({ type: 'transform', name: 'forkTree' })).toBe('fork');
    expect(resolveThreadLaneMode({ name: 'autoPack' })).toBe('auto');
    expect(resolveThreadLaneMode({ name: 'byField', params: { field: 'cat' } })).toBe('level');
    expect(resolveThreadLaneMode({ name: 'byLevel' })).toBe('level');
    expect(getThreadLaneFieldPath({ name: 'byField', params: { field: 'args.depth' } })).toBe(
      'args.depth'
    );
    expect(getThreadLaneFieldPath({ name: 'byField' })).toBe('level');
    expect(getThreadLaneFieldPath({ name: 'autoPack' })).toBe('');
  });

  it('applies custom list ordering', () => {
    const result = applyProcessOrderRule(
      { type: 'transform', name: 'customList', params: { list: ['b'], includeUnspecified: true } },
      { pids: ['a', 'b', 'c'] }
    );
    expect(result.orderedHierarchy1Ids).toEqual(['b', 'a', 'c']);
  });
});

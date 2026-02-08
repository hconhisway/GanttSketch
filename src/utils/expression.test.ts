import {
  evalExpr,
  evalPredicate,
  getValueAtPath,
  hashStringToInt,
  isEmptyValue,
  pickFirstFieldValue
} from './expression';

describe('expression utils', () => {
  it('reads nested values and picks first non-empty field', () => {
    expect(getValueAtPath({ a: { b: 2 } }, 'a.b')).toBe(2);
    expect(pickFirstFieldValue({ a: '', b: 3 }, ['a', 'b'])).toBe(3);
    expect(isEmptyValue('')).toBe(true);
  });

  it('hashes strings deterministically', () => {
    expect(hashStringToInt('abc')).toBe(99454);
  });

  it('evaluates common expression ops', () => {
    const ctx = { name: 'Alice', vars: { code: 'Z' }, event: { cat: 'cpu' } };
    expect(evalExpr({ op: 'var', name: 'name' }, ctx)).toBe('Alice');
    expect(evalExpr({ op: 'get', path: 'event.cat' }, ctx)).toBe('cpu');
    expect(evalExpr({ op: 'coalesce', args: [null, '', 'ok'] }, ctx)).toBe('ok');
    expect(evalExpr({ op: 'concat', args: ['Hi ', { op: 'var', name: 'name' }] }, ctx)).toBe(
      'Hi Alice'
    );
    expect(evalExpr({ op: 'upper', args: ['hi'] }, ctx)).toBe('HI');
    expect(evalExpr({ op: 'len', args: ['abcd'] }, ctx)).toBe(4);
    expect(evalExpr({ op: 'if', args: [true, 'yes', 'no'] }, ctx)).toBe('yes');
    expect(
      evalExpr({ op: 'case', cases: [[{ op: '==', args: [1, 2] }, 'no']], else: 'fallback' }, ctx)
    ).toBe('fallback');
    expect(evalExpr({ op: 'add', args: [1, 2, 3] }, ctx)).toBe(6);
    expect(evalExpr({ op: 'div', args: [10, 0] }, ctx)).toBe(0);
    expect(evalExpr({ op: 'clamp', args: [5, 0, 3] }, ctx)).toBe(3);
  });

  it('evaluates regex and palette hashing', () => {
    expect(evalExpr({ op: 'regexTest', args: ['abc'], pattern: '^a' }, {})).toBe(true);
    expect(evalExpr({ op: 'regexCapture', args: ['user:42'], pattern: 'user:(\\d+)' }, {})).toBe(
      '42'
    );
    const paletteResult = evalExpr({ op: 'paletteHash', args: ['key', ['red', 'blue']] }, {});
    expect(['red', 'blue']).toContain(paletteResult);
  });

  it('evaluates predicates', () => {
    expect(evalPredicate({ type: 'predicate', when: { op: '==', args: [1, 1] } }, {})).toBe(true);
    expect(evalPredicate({ op: 'and', args: [true, false] }, {})).toBe(false);
  });
});

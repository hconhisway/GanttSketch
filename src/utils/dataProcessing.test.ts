import {
  buildFrontendPayloadFromText,
  buildProcessForkRelationsFromRawEvents,
  buildProcessStats,
  extractEventFieldPaths,
  extractForkFieldsFromRawEvent,
  parseFrontendTraceText
} from './dataProcessing';

describe('data processing utils', () => {
  it('extracts event field paths with bounded depth', () => {
    const fields = extractEventFieldPaths([{ a: 1, b: { c: 2 }, d: { e: { f: 3 } } }]);
    expect(fields).toEqual(expect.arrayContaining(['a', 'b', 'b.c', 'd', 'd.e']));
    expect(fields).not.toContain('d.e.f');
  });

  it('builds process stats from events', () => {
    const stats = buildProcessStats([
      { pid: 1, start: 0, end: 10 },
      { pid: 1, start: 10, end: 25 },
      { pid: 2, start: 5, end: 15 }
    ]);
    expect(stats.get('1')?.count).toBe(2);
    expect(stats.get('1')?.maxDurUs).toBe(15);
    expect(stats.get('2')?.totalDurUs).toBe(10);
  });

  it('parses frontend trace text and builds payload', () => {
    const text = `{"a":1}\n{"b":2},`;
    expect(parseFrontendTraceText(text)).toHaveLength(2);
    expect(() => buildFrontendPayloadFromText('')).toThrow('Trace file is empty or invalid.');
  });

  it('extracts fork fields and builds fork relations', () => {
    const ev = { name: 'start', pid: 2, ppid: 1, args: { foo: 'bar' } };
    const fields = extractForkFieldsFromRawEvent(ev);
    expect(fields.pid).toBe('2');
    expect(fields.ppid).toBe('1');

    const relations = buildProcessForkRelationsFromRawEvents([
      { name: 'start', pid: 2, ppid: 1 },
      { name: 'start', pid: 3, ppid: 1 }
    ]);
    expect(relations.parentByPid.get('2')).toBe('1');
    expect(relations.childrenByPid.get('1')).toEqual(['2', '3']);
    expect(relations.startEventCount).toBe(2);
  });
});

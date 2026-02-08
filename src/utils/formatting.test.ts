import {
  clampNumber,
  escapeHtml,
  formatArgValue,
  formatDurationUs,
  formatTimeUs,
  formatTimeUsFull,
  stripScriptTags,
  toCssSize
} from './formatting';

describe('formatting utils', () => {
  it('formats microseconds into mm:ss.mmm', () => {
    expect(formatTimeUs(1_234_567)).toBe('0:01.235');
    expect(formatTimeUs('not-a-number')).toBe('');
  });

  it('formats microseconds into hh:mm:ss.nnnnnnnnn', () => {
    expect(formatTimeUsFull(1_234_567)).toBe('00:00:01.234567000');
  });

  it('formats durations with mixed units', () => {
    expect(formatDurationUs(61_234_567)).toBe('1m 1s 234ms 567µs');
    expect(formatDurationUs(500)).toBe('500µs');
  });

  it('formats argument values safely', () => {
    expect(formatArgValue(true)).toBe('true');
    expect(formatArgValue(42)).toBe('42');
    expect(formatArgValue({ foo: 'bar' })).toBe('{"foo":"bar"}');
  });

  it('escapes html and strips script tags', () => {
    expect(escapeHtml('<div>"&\'</div>')).toBe('&lt;div&gt;&quot;&amp;&#39;&lt;/div&gt;');
    expect(stripScriptTags('<div>ok</div><script>alert(1)</script>')).toBe('<div>ok</div>');
  });

  it('handles css sizes and numeric clamping', () => {
    expect(toCssSize(12, '100%')).toBe('12px');
    expect(toCssSize('50%', '100%')).toBe('50%');
    expect(toCssSize(null, '100%')).toBe('100%');
    expect(clampNumber(5, 0, 3)).toBe(3);
    expect(clampNumber('bad', 1, 2)).toBe(1);
  });
});

import { pickTextColor, resolveColor, resolveColorKey, resolveColorKeyLegacy } from './color';

describe('color utils', () => {
  it('picks readable text color', () => {
    expect(pickTextColor('#ffffff')).toBe('#111');
    expect(pickTextColor('#000000')).toBe('#fff');
    expect(pickTextColor('not-a-color')).toBe('#fff');
  });

  it('resolves color keys using rules and legacy config', () => {
    const item = { pid: '1', name: 'task' };
    const keyRule = { op: 'get', path: 'event.name' };
    const key = resolveColorKey(item, 'track-1', { type: 'process' }, { keyRule }, null);
    expect(key).toBe('task');

    const legacy = { mode: 'byTrack' };
    expect(resolveColorKeyLegacy(item, 'track-1', { type: 'process' }, legacy)).toBe('track-1');
  });

  it('resolves colors with fixed color overrides', () => {
    const color = resolveColor(
      { pid: '1' },
      'track-1',
      { type: 'process' },
      { fixedColor: '#ff00ff' },
      ['#111', '#222'],
      null
    );
    expect(color).toBe('#ff00ff');
  });
});

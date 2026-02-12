import { DEFAULT_GANTT_CONFIG, applyGanttConfigPatch, cloneGanttConfig } from './ganttConfig';

describe('ganttConfig', () => {
  it('clones default config deeply', () => {
    const clone = cloneGanttConfig();
    clone.layout.margin.left = 999;
    expect(DEFAULT_GANTT_CONFIG.layout.margin.left).not.toBe(999);
  });

  it('applies patch updates without dropping defaults', () => {
    const patched = applyGanttConfigPatch(DEFAULT_GANTT_CONFIG, {
      layout: { headerHeight: 99 }
    });
    expect(patched.layout.headerHeight).toBe(99);
    expect(patched.layout.margin.left).toBe(DEFAULT_GANTT_CONFIG.layout.margin.left);
  });

  it('adds default label rules for dynamic hierarchy fields', () => {
    const patched = applyGanttConfigPatch(DEFAULT_GANTT_CONFIG, {
      yAxis: {
        hierarchy3Field: 'tid',
        hierarchy4Field: 'lane'
      }
    });
    expect(patched.yAxis.hierarchy3LabelRule).toBeDefined();
    expect(patched.yAxis.hierarchy4LabelRule).toBeDefined();
  });
});

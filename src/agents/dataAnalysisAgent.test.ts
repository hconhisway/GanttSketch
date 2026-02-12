import { createDefaultMapping, deriveConfigFromMapping, processEventsMinimal } from './dataAnalysisAgent';

describe('dataAnalysisAgent hierarchy generalization', () => {
  it('derives hierarchyN defaults from hierarchy fields', () => {
    const mapping = createDefaultMapping();
    mapping.features.hierarchyLevels = 4;
    mapping.features.hierarchyFields = ['cluster', 'pid', 'tid', 'lane'];
    mapping.yAxis.hierarchyFields = ['cluster', 'pid', 'tid', 'lane'];

    const derived = deriveConfigFromMapping(mapping);
    expect(derived.yAxis.hierarchy1Field).toBe('cluster');
    expect(derived.yAxis.hierarchy2Field).toBe('pid');
    expect(derived.yAxis.hierarchy3Field).toBe('tid');
    expect(derived.yAxis.hierarchy4Field).toBe('lane');
    expect(derived.yAxis.hierarchy3LabelRule).toBeDefined();
    expect(derived.performance.hierarchy1LOD).toEqual({ mergeUtilGap: 0.002 });
    expect(derived.performance.hierarchy2LOD).toEqual({ pixelWindow: 1 });
    expect(derived.performance.hierarchy3LOD).toEqual({ pixelWindow: 1 });
    expect(derived.performance.hierarchy4LOD).toEqual({ pixelWindow: 1 });
  });

  it('emits hierarchyValues and hierarchy1/hierarchy2', () => {
    const events = processEventsMinimal(
      [
        {
          ts: 10,
          dur: 5,
          cluster: 'a',
          pid: 7,
          tid: 3,
          lane: 2
        }
      ],
      {
        start: 'ts',
        end: null,
        duration: 'dur',
        hierarchy1Field: 'cluster',
        hierarchy2Field: 'pid',
        ppid: null,
        level: 'lane',
        name: null,
        cat: null,
        args: null,
        id: null
      },
      1,
      ['cluster', 'pid', 'tid', 'lane']
    );
    expect(events).toHaveLength(1);
    expect(events[0].hierarchyValues).toEqual(['a', '7', '3', '2']);
    expect(events[0].hierarchy1).toBe('a');
    expect(events[0].hierarchy2).toBe('7');
  });
});


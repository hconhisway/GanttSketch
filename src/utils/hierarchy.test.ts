import {
  buildHierarchyLaneKey,
  getHierarchyFieldsFromMapping,
  getHierarchyKeysFromHierarchyValues,
  normalizeHierarchyFeatures,
  pruneHierarchyConfig
} from './hierarchy';
import { createDefaultMapping } from '../agents/dataAnalysisAgent';

describe('hierarchy utils', () => {
  it('normalizes hierarchy features and yAxis hierarchy fields', () => {
    const base = createDefaultMapping();
    const mapping = normalizeHierarchyFeatures({
      ...base,
      yAxis: {
        ...base.yAxis,
        hierarchyFields: []
      },
      features: {
        ...base.features,
        hierarchyLevels: 4,
        hierarchyFields: ['cluster', 'pid', 'tid']
      }
    });
    expect(mapping.features.hierarchyLevels).toBe(3);
    expect(mapping.features.hierarchyFields).toEqual(['cluster', 'pid', 'tid']);
    expect(mapping.yAxis.hierarchyFields).toEqual(['cluster', 'pid', 'tid']);
  });

  it('builds lane key and hierarchy1/hierarchy2 from hierarchy values', () => {
    const values = ['clusterA', 'process12', 'thread4'];
    expect(getHierarchyKeysFromHierarchyValues(values)).toMatchObject({
      hierarchy1: 'clusterA',
      hierarchy2: 'process12',
      hierarchy3: 'thread4',
      hierarchyValues: ['clusterA', 'process12', 'thread4']
    });
    expect(buildHierarchyLaneKey(values, 2)).toBe('clusterA|process12|thread4|2');
  });

  it('prunes stale hierarchy config keys above level count', () => {
    const config = {
      yAxis: {
        hierarchy1Field: 'cluster',
        hierarchy2Field: 'pid',
        hierarchy3Field: 'tid',
        hierarchy4Field: 'lane'
      },
      performance: {
        hierarchy1LOD: { mergeUtilGap: 0.002 },
        hierarchy2LOD: { pixelWindow: 1 },
        hierarchy3LOD: { pixelWindow: 1 },
        hierarchy4LOD: { pixelWindow: 1 }
      }
    };
    const pruned = pruneHierarchyConfig(config, 2);
    expect(pruned.yAxis.hierarchy3Field).toBeUndefined();
    expect(pruned.yAxis.hierarchy4Field).toBeUndefined();
    expect(pruned.performance.hierarchy3LOD).toBeUndefined();
    expect(pruned.performance.hierarchy4LOD).toBeUndefined();
  });

  it('falls back to generic hierarchy keys when fields are missing', () => {
    const fields = getHierarchyFieldsFromMapping({
      yAxis: { hierarchyFields: [] }
    } as any);
    expect(fields).toEqual(['hierarchy1', 'hierarchy2']);
  });
});


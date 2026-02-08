import { buildConfigIndex, findMatchingConfigs } from './configIndex';

describe('configIndex', () => {
  it('builds an index with keywords', () => {
    const index = buildConfigIndex({
      sections: [
        {
          id: 'layout',
          entries: [
            {
              id: 'layout.height',
              path: 'layout.height',
              kind: 'value',
              schema: { type: 'number' },
              description: 'Chart height in pixels'
            }
          ]
        }
      ]
    } as any);

    expect(index['layout.height']).toBeDefined();
    expect(index['layout.height'].keywords).toEqual(expect.arrayContaining(['layout', 'height']));
  });

  it('finds matching configs from the global index', () => {
    const matches = findMatchingConfigs('color palette');
    expect(matches.length).toBeGreaterThan(0);
  });
});

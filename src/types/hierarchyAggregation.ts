export type HierarchyLevelMap = Map<string | number, any[]>;

export interface HierarchyAggregateSegment {
  kind: 'aggregateSegment';
  id: string;
  start: number;
  end: number;
  count: number;
  depth: number;
  hierarchy1: string;
  hierarchyPath: string[];
  hierarchyValues: string[];
  sourceEvents: any[];
  representativeEvent: any | null;
}

export interface HierarchyAggregateNode {
  key: string;
  segment: string;
  depth: number;
  hierarchy1: string;
  hierarchyPath: string[];
  hierarchyValues: string[];
  sourceEvents: any[];
  aggregateSegments: HierarchyAggregateSegment[];
  children: HierarchyAggregateNode[];
  levelMap?: HierarchyLevelMap;
  representativeEvent: any | null;
}

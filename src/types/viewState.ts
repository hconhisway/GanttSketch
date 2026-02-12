export interface FilterExpr {
  field: string;
  op: string;
  value?: any;
}

export interface StreamingRequest {
  summaryLevel: number;
  timeWindow: [number, number];
  laneIds: string[];
  viewportPxWidth: number;
}

export interface ViewState {
  timeDomain: [number, number];
  viewportPxWidth: number;
  devicePixelRatio: number;
  pixelWindow: number;
  visibleLaneRange: [number, number];
  visibleLaneIds: string[];
  laneOrder: string[];
  filters: FilterExpr[];
  scrollTop: number;
  selection: string | null;
  expandedHierarchy1Ids: string[];
  lastInteractionAt: number;
  streamingRequest?: StreamingRequest;
}

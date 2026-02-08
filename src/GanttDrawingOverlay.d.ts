import * as React from 'react';

export interface DrawingControlsProps {
  isActive: boolean;
  onToggle: (value: boolean) => void;
  onClear: () => void;
  brushSize: number;
  setBrushSize: (value: number) => void;
  brushColor: string;
  setBrushColor: (value: string) => void;
  processSortMode?: string;
  onProcessSortModeChange?: (value: string) => void;
  showSort?: boolean;
}

export const DrawingControls: React.ForwardRefExoticComponent<
  React.PropsWithoutRef<DrawingControlsProps> & React.RefAttributes<any>
>;

export interface GanttDrawingOverlayProps {
  isActive: boolean;
  brushSize: number;
  brushColor: string;
  onPathsChange?: (paths: any[]) => void;
}

export const GanttDrawingOverlay: React.ForwardRefExoticComponent<
  React.PropsWithoutRef<GanttDrawingOverlayProps> & React.RefAttributes<any>
>;

export default GanttDrawingOverlay;

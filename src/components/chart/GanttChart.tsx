import React from 'react';
import { GanttDrawingOverlay } from './GanttDrawingOverlay';

interface GanttChartProps {
  chartRef: React.RefObject<HTMLDivElement>;
  minimapRef: React.RefObject<HTMLDivElement>;
  xAxisRef: React.RefObject<HTMLDivElement>;
  yAxisRef: React.RefObject<HTMLDivElement>;
  drawingOverlayRef: React.RefObject<any>;
  isDrawingMode: boolean;
  brushSize: number;
  brushColor: string;
  yAxisWidth: number;
  isBusy?: boolean;
  busyLabel?: string;
}

export const GanttChart = React.memo(function GanttChart({
  chartRef,
  minimapRef,
  xAxisRef,
  yAxisRef,
  drawingOverlayRef,
  isDrawingMode,
  brushSize,
  brushColor,
  yAxisWidth,
  isBusy = false,
  busyLabel = 'Loading...'
}: GanttChartProps) {
  return (
    <div
      className="chart-container"
      style={
        {
          position: 'relative',
          '--gantt-yaxis-width': `${yAxisWidth}px`
        } as React.CSSProperties
      }
    >
      <div className="gantt-topbar">
        <div ref={minimapRef} className="gantt-minimap" />
        <div ref={xAxisRef} className="gantt-xaxis" />
      </div>
      <div ref={yAxisRef} className="gantt-yaxis" />
      <div ref={chartRef} className="chart gantt-viewport"></div>
      <GanttDrawingOverlay
        ref={drawingOverlayRef}
        isActive={isDrawingMode}
        brushSize={brushSize}
        brushColor={brushColor}
      />
      {isBusy && (
        <div className="gantt-busy-overlay" role="status" aria-live="polite">
          <div className="gantt-busy-label">{busyLabel}</div>
        </div>
      )}
    </div>
  );
});

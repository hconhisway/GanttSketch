import React from 'react';
import { GanttDrawingOverlay } from './GanttDrawingOverlay';

interface GanttChartProps {
  scrollRef: React.RefObject<HTMLDivElement>;
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
  dependencyToggleVisible?: boolean;
  dependencyToggleActive?: boolean;
  onToggleDependencies?: () => void;
}

export const GanttChart = React.memo(function GanttChart({
  scrollRef,
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
  busyLabel = 'Loading...',
  dependencyToggleVisible = false,
  dependencyToggleActive = false,
  onToggleDependencies
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
        {dependencyToggleVisible && (
          <div className="gantt-topbar-controls">
            <button
              type="button"
              className={`gantt-dependency-toggle ${dependencyToggleActive ? 'active' : ''}`}
              onClick={onToggleDependencies}
            >
              {dependencyToggleActive ? 'Hide Dependencies' : 'Show Dependencies'}
            </button>
          </div>
        )}
        <div ref={minimapRef} className="gantt-minimap" />
        <div ref={xAxisRef} className="gantt-xaxis" />
      </div>
      <div ref={scrollRef} className="gantt-scroll-body">
        <div ref={yAxisRef} className="gantt-yaxis" />
        <div ref={chartRef} className="chart gantt-viewport"></div>
      </div>
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

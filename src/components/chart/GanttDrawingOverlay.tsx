import React, {
  useRef,
  useState,
  useImperativeHandle,
  forwardRef,
  useCallback,
  useEffect
} from 'react';
import '../../GanttDrawingOverlay.css';
import { exportDOMToCanvas } from '../../utils/ExportHelper';
import { GANTT_CONFIG } from '../../config/ganttConfig';

interface DrawingPath {
  id?: string;
  path: string;
  color: string;
  width: number;
}

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

export interface GanttDrawingOverlayProps {
  isActive: boolean;
  brushSize: number;
  brushColor: string;
  onPathsChange?: (paths: DrawingPath[]) => void;
}

export interface GanttDrawingOverlayHandle {
  exportAnnotatedImage: () => Promise<Blob | null>;
  clearCanvas: () => void;
}

/**
 * Drawing controls component - displays inline with sliders
 */
export const DrawingControls = forwardRef<HTMLDivElement, DrawingControlsProps>(
  function DrawingControls(
    {
      isActive,
      onToggle,
      onClear,
      brushSize,
      setBrushSize,
      brushColor,
      setBrushColor,
      processSortMode,
      onProcessSortModeChange,
      showSort = true
    },
    ref
  ) {
    const [showColorPicker, setShowColorPicker] = useState(false);
    const colors = [...(GANTT_CONFIG.color?.palette || []), '#111827', '#FFFFFF'];

    return (
      <div className="drawing-controls-inline" ref={ref}>
        <div className="drawing-section-header">
          <span className="section-icon">🎨</span>
          <span className="section-title">Drawing Tools</span>
        </div>

        <div className="drawing-controls-grid">
          {/* Toggle Drawing Mode */}
          <div className="drawing-control-item">
            <button
              onClick={() => onToggle(!isActive)}
              className={`control-btn toggle-btn ${isActive ? 'active' : ''}`}
              title={isActive ? 'Exit drawing mode' : 'Enter drawing mode'}
            >
              {isActive ? '✏️ Drawing' : '🖊️ Draw'}
            </button>
          </div>

          {/* Color Picker */}
          <div className="drawing-control-item color-picker-wrapper">
            <button
              onClick={() => setShowColorPicker(!showColorPicker)}
              className="control-btn color-btn"
              style={{
                backgroundColor: brushColor,
                color: brushColor === '#ffffff' ? '#000' : '#fff'
              }}
              disabled={!isActive}
              title="Choose color"
            >
              🎨
            </button>
            {showColorPicker && (
              <div className="color-palette-inline">
                {colors.map((color) => (
                  <div
                    key={color}
                    onClick={() => {
                      setBrushColor(color);
                      setShowColorPicker(false);
                    }}
                    className="color-swatch"
                    style={{
                      backgroundColor: color,
                      border: color === brushColor ? '3px solid #333' : '1px solid #ccc'
                    }}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Brush Size */}
          <div className="drawing-control-item brush-size-inline">
            <label className="brush-size-label">Size: {brushSize}</label>
            <input
              type="range"
              min="1"
              max="20"
              value={brushSize}
              onChange={(e) => setBrushSize(Number(e.target.value))}
              disabled={!isActive}
              className="brush-size-slider"
            />
          </div>

          {/* Process Sort Mode */}
          {showSort && (
            <div className="drawing-control-item sort-mode-inline">
              <label className="sort-mode-label">Sort</label>
              <select
                className="sort-mode-select"
                value={processSortMode || 'fork'}
                onChange={(e) => onProcessSortModeChange && onProcessSortModeChange(e.target.value)}
              >
                <option value="fork">Fork (tree)</option>
                <option value="default">Default</option>
              </select>
            </div>
          )}

          {/* Clear Button */}
          <div className="drawing-control-item">
            <button
              onClick={onClear}
              className="control-btn clear-btn"
              disabled={!isActive}
              title="Clear all drawings"
            >
              🗑️ Clear
            </button>
          </div>
        </div>
      </div>
    );
  }
);

/**
 * Drawing canvas overlay - placed over the chart
 */
export const GanttDrawingOverlay = forwardRef<GanttDrawingOverlayHandle, GanttDrawingOverlayProps>(
  function GanttDrawingOverlay({ isActive, brushSize, brushColor, onPathsChange }, ref) {
    const svgRef = useRef<SVGSVGElement | null>(null);
    const [isDrawing, setIsDrawing] = useState(false);
    const [paths, setPaths] = useState<DrawingPath[]>([]);
    const [currentPath, setCurrentPath] = useState('');
    const [currentPathId, setCurrentPathId] = useState('');
    const [overlayStyle, setOverlayStyle] = useState({ width: 0, height: 0, top: 0, left: 0 });
    const prevStyleRef = useRef(overlayStyle);

    // Sync overlay position and size to the visible chart area (works with shared scroll container)
    useEffect(() => {
      const updateOverlayPosition = () => {
        const chartContainer = document.querySelector('.chart-container');
        const scrollBody = chartContainer?.querySelector('.gantt-scroll-body');
        const yAxisEl = chartContainer?.querySelector('.gantt-yaxis');
        if (!chartContainer || !scrollBody) return;

        const containerRect = chartContainer.getBoundingClientRect();
        const scrollBodyRect = scrollBody.getBoundingClientRect();
        const yAxisWidth = yAxisEl ? yAxisEl.getBoundingClientRect().width : 0;

        // Overlay covers the chart portion of the visible scroll viewport (right of y-axis)
        const newStyle = {
          width: Math.max(0, scrollBodyRect.width - yAxisWidth),
          height: Math.max(0, scrollBodyRect.height),
          left: scrollBodyRect.left + yAxisWidth - containerRect.left,
          top: scrollBodyRect.top - containerRect.top
        };

        const prev = prevStyleRef.current;
        const changed =
          Math.abs(newStyle.width - prev.width) > 1 ||
          Math.abs(newStyle.height - prev.height) > 1 ||
          Math.abs(newStyle.left - prev.left) > 1 ||
          Math.abs(newStyle.top - prev.top) > 1;
        if (changed) prevStyleRef.current = newStyle;
        setOverlayStyle(newStyle);
      };

      updateOverlayPosition();

      const chartContainer = document.querySelector('.chart-container');
      const scrollBody = chartContainer?.querySelector('.gantt-scroll-body');
      const resizeObserver = new ResizeObserver(updateOverlayPosition);
      if (chartContainer) resizeObserver.observe(chartContainer);
      if (scrollBody) {
        scrollBody.addEventListener('scroll', updateOverlayPosition);
      }
      window.addEventListener('resize', updateOverlayPosition);
      const interval = setInterval(updateOverlayPosition, 300);

      return () => {
        resizeObserver.disconnect();
        if (scrollBody) scrollBody.removeEventListener('scroll', updateOverlayPosition);
        window.removeEventListener('resize', updateOverlayPosition);
        clearInterval(interval);
      };
    }, [isActive]);

    // Get SVG coordinates from mouse event
    const getSVGCoordinates = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
      if (!svgRef.current) return null;

      const svg = svgRef.current;
      const rect = svg.getBoundingClientRect();

      // Calculate relative position within SVG
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      // Check if click is within bounds
      if (x < 0 || y < 0 || x > rect.width || y > rect.height) {
        return null;
      }

      return { x, y };
    }, []);

    // Start drawing
    const startDrawing = useCallback(
      (e: React.MouseEvent<SVGSVGElement>) => {
        if (!isActive) return;

        const coords = getSVGCoordinates(e);
        if (!coords) return;

        setIsDrawing(true);

        const pathId = `path-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
        const newPath = `M ${coords.x} ${coords.y}`;

        setCurrentPath(newPath);
        setCurrentPathId(pathId);
      },
      [isActive, getSVGCoordinates]
    );

    // Continue drawing
    const draw = useCallback(
      (e: React.MouseEvent<SVGSVGElement>) => {
        if (!isDrawing || !isActive || !currentPathId) return;

        const coords = getSVGCoordinates(e);
        if (!coords) return;

        const newPath = currentPath + ` L ${coords.x} ${coords.y}`;
        setCurrentPath(newPath);
      },
      [isDrawing, isActive, currentPathId, currentPath, getSVGCoordinates]
    );

    // Stop drawing
    const stopDrawing = useCallback(() => {
      if (!isActive || !isDrawing || !currentPath) return;

      // Save the completed path
      const newPaths: DrawingPath[] = [
        ...paths,
        {
          id: currentPathId,
          path: currentPath,
          color: brushColor,
          width: brushSize
        }
      ];

      setPaths(newPaths);
      if (onPathsChange) onPathsChange(newPaths);

      // Reset drawing state
      setIsDrawing(false);
      setCurrentPath('');
      setCurrentPathId('');
    }, [
      isActive,
      isDrawing,
      currentPath,
      currentPathId,
      brushColor,
      brushSize,
      paths,
      onPathsChange
    ]);

    // Clear all drawings
    const clearCanvas = useCallback(() => {
      setPaths([]);
      setCurrentPath('');
      setCurrentPathId('');
      setIsDrawing(false);
      if (onPathsChange) onPathsChange([]);
    }, [onPathsChange]);

    // Export annotated chart as image - using DOM export for reliability
    const exportAnnotatedImage = useCallback(async () => {
      try {
        console.log('Starting chart export with', paths.length, 'drawing paths...');

        // Export full left panel (widgets + chart with y-axis and topbar), excluding customization panel
        const chartContainer = document.querySelector('.chart-container');
        const leftPanel = chartContainer?.closest('.left-panel');
        const exportRoot = (leftPanel || chartContainer) as HTMLElement;
        if (!exportRoot) {
          console.error('Export root (left-panel or chart-container) not found');
          return null;
        }

        const allPaths = [...paths];
        if (currentPath) {
          allPaths.push({
            path: currentPath,
            color: brushColor,
            width: brushSize
          });
        }
        return await exportDOMToCanvas(exportRoot, allPaths);
      } catch (error) {
        console.error('Error exporting annotated chart:', error);
        return null;
      }
    }, [paths, currentPath, brushColor, brushSize]);

    // Expose methods via ref
    useImperativeHandle(ref, () => ({
      exportAnnotatedImage,
      clearCanvas
    }));

    if (!isActive) {
      return null;
    }

    return (
      <svg
        ref={svgRef}
        className="gantt-drawing-canvas-overlay"
        style={{
          cursor: isActive ? 'crosshair' : 'default',
          pointerEvents: isActive ? 'auto' : 'none',
          width: `${overlayStyle.width}px`,
          height: `${overlayStyle.height}px`,
          left: `${overlayStyle.left}px`,
          top: `${overlayStyle.top}px`
        }}
        onMouseDown={startDrawing}
        onMouseMove={draw}
        onMouseUp={stopDrawing}
        onMouseLeave={stopDrawing}
      >
        {/* Render saved paths */}
        {paths.map((pathData) => (
          <path
            key={pathData.id}
            d={pathData.path}
            stroke={pathData.color}
            strokeWidth={pathData.width}
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}

        {/* Render current drawing path */}
        {currentPath && (
          <path
            d={currentPath}
            stroke={brushColor}
            strokeWidth={brushSize}
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
      </svg>
    );
  }
);

export default GanttDrawingOverlay;

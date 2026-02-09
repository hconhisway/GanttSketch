import React from 'react';
import { DrawingControls } from '../chart/GanttDrawingOverlay';

interface ChatInputProps {
  inputMessage: string;
  setInputMessage: (value: string) => void;
  isStreaming: boolean;
  onSend: () => void;
  onKeyPress: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  isWidgetAgentMode: boolean;
  setIsWidgetAgentMode: (value: boolean) => void;
  isDrawingMode: boolean;
  setIsDrawingMode: (value: boolean) => void;
  brushSize: number;
  setBrushSize: (value: number) => void;
  brushColor: string;
  setBrushColor: (value: string) => void;
  onClear: () => void;
  onCaptureImage: () => void;
  selectedImageId: string | null;
}

export const ChatInput = React.memo(function ChatInput({
  inputMessage,
  setInputMessage,
  isStreaming,
  onSend,
  onKeyPress,
  isWidgetAgentMode,
  setIsWidgetAgentMode,
  isDrawingMode,
  setIsDrawingMode,
  brushSize,
  setBrushSize,
  brushColor,
  setBrushColor,
  onClear,
  onCaptureImage,
  selectedImageId
}: ChatInputProps) {
  return (
    <div className="chat-input-container">
      <div className="chat-mode-controls">
        <div className="chat-drawing-controls">
          <DrawingControls
            isActive={isDrawingMode}
            onToggle={setIsDrawingMode}
            onClear={onClear}
            brushSize={brushSize}
            setBrushSize={setBrushSize}
            brushColor={brushColor}
            setBrushColor={setBrushColor}
            showSort={false}
          />
        </div>
        <div className="widget-mode-toggle">
          <label className="toggle-label" title="Enable widget creation mode">
            <input
              type="checkbox"
              checked={isWidgetAgentMode}
              onChange={(e) => setIsWidgetAgentMode(e.target.checked)}
            />
            <span className="toggle-slider"></span>
            <span className="toggle-text">Widget Mode</span>
          </label>
        </div>
      </div>
      <div className="input-controls-row">
        <button
          className="capture-button"
          onClick={onCaptureImage}
          disabled={!isDrawingMode}
          title="Capture annotated chart"
        >
          📸
        </button>
        <textarea
          className={`chat-input ${isWidgetAgentMode ? 'widget-mode' : ''}`}
          placeholder={
            isWidgetAgentMode
              ? 'Describe the widget you want to create...'
              : 'Ask about the chart data...'
          }
          value={inputMessage}
          onChange={(e) => setInputMessage(e.target.value)}
          onKeyPress={onKeyPress}
          disabled={isStreaming}
          rows={3}
        />
        <button
          className="send-button"
          onClick={onSend}
          disabled={isStreaming || !inputMessage.trim()}
        >
          {isStreaming ? 'Sending...' : 'Send'}
        </button>
      </div>
      {selectedImageId && (
        <div className="selected-image-indicator">📎 Image will be sent with message</div>
      )}
      {isWidgetAgentMode && (
        <div className="widget-mode-indicator">
          🧩 Widget Mode: Describe a widget to create (e.g., "Create a filter dropdown for process
          names")
        </div>
      )}
    </div>
  );
});

import React from 'react';

interface DataSetupModalProps {
  open: boolean;
  eventCount: number;
  isAnalyzing: boolean;
  onRunAnalysis: () => void;
  onLoadConfig: () => void;
}

export const DataSetupModal = React.memo(function DataSetupModal({
  open,
  eventCount,
  isAnalyzing,
  onRunAnalysis,
  onLoadConfig
}: DataSetupModalProps) {
  if (!open) return null;

  return (
    <div className="data-setup-modal-overlay" role="dialog" aria-modal="true" aria-labelledby="data-setup-title">
      <div className="data-setup-modal">
        <h2 id="data-setup-title" className="data-setup-modal-title">Data loaded</h2>
        <p className="data-setup-modal-description">
          {eventCount > 0
            ? `${eventCount.toLocaleString()} events loaded. Choose how to set up the chart:`
            : 'Choose how to set up the chart:'}
        </p>
        <div className="data-setup-modal-actions">
          <button
            type="button"
            className="data-setup-modal-btn data-setup-modal-btn-primary"
            onClick={onRunAnalysis}
            disabled={eventCount === 0 || isAnalyzing}
          >
            {isAnalyzing ? 'Analyzing…' : 'Run Data Analysis'}
          </button>
          <button
            type="button"
            className="data-setup-modal-btn data-setup-modal-btn-secondary"
            onClick={onLoadConfig}
          >
            Load config
          </button>
        </div>
      </div>
    </div>
  );
});

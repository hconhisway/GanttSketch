import React from 'react';

interface LeftPanelProps {
  children: React.ReactNode;
}

export const LeftPanel = React.memo(function LeftPanel({ children }: LeftPanelProps) {
  return <div className="left-panel">{children}</div>;
});

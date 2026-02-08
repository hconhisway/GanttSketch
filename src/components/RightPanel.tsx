import React from 'react';

interface RightPanelProps {
  children: React.ReactNode;
}

export const RightPanel = React.memo(function RightPanel({ children }: RightPanelProps) {
  return <div className="right-panel">{children}</div>;
});

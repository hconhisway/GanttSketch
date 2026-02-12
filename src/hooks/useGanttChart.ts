import { useEffect, useRef } from 'react';

export function useGanttChart(render: () => void | (() => void), deps: any[]) {
  const renderRef = useRef(render);
  renderRef.current = render;
  useEffect(() => {
    return renderRef.current();
  }, deps);
}

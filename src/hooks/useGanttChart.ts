import { useEffect } from 'react';

export function useGanttChart(render: () => void | (() => void), deps: any[]) {
  useEffect(() => {
    return render();
  }, deps);
}

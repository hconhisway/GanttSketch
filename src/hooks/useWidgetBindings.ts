import { useEffect } from 'react';
import type { MutableRefObject, RefObject } from 'react';
import type { Widget } from '../types/widget';
import { buildWidgetHandler } from '../utils/widget';

interface WidgetBinding {
  element: Element;
  event: string;
  handler: EventListener;
}

interface UseWidgetBindingsArgs {
  widgets: Widget[];
  widgetAreaRef: RefObject<HTMLDivElement>;
  widgetApiRef: MutableRefObject<any>;
  widgetHandlersRef: MutableRefObject<WidgetBinding[]>;
}

export function useWidgetBindings({
  widgets,
  widgetAreaRef,
  widgetApiRef,
  widgetHandlersRef
}: UseWidgetBindingsArgs) {
  useEffect(() => {
    const host = widgetAreaRef.current;
    if (!host) return;

    widgetHandlersRef.current.forEach((binding) => {
      binding.element.removeEventListener(binding.event, binding.handler);
    });
    widgetHandlersRef.current = [];

    widgets.forEach((widget) => {
      const widgetRoot = host.querySelector(`[data-widget-id="${widget.id}"]`);
      if (!widgetRoot) return;
      const listeners = Array.isArray(widget.listeners) ? widget.listeners : [];
      listeners.forEach((listener: any) => {
        const handlerFn = buildWidgetHandler(listener.handler);
        if (!handlerFn) return;
        const elements = listener.selector
          ? widgetRoot.querySelectorAll(listener.selector)
          : [widgetRoot];
        elements.forEach((element) => {
          const eventName = listener.event || 'change';
          const wrapped: EventListener = (event) => {
            const payload = {
              event,
              target: (event as Event).target,
              value: (event as Event).target ? (event as any).target?.value : undefined,
              widgetRoot
            };
            const api = widgetApiRef.current;
            if (!api) return;
            handlerFn(payload, api, widget);
          };
          element.addEventListener(eventName, wrapped);
          widgetHandlersRef.current.push({ element, event: eventName, handler: wrapped });
        });
      });
    });
  }, [widgets, widgetAreaRef, widgetApiRef, widgetHandlersRef]);
}

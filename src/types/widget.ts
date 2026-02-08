export interface WidgetListener {
  selector: string;
  event: string;
  handler: string;
}

export interface Widget {
  id: string;
  name: string;
  html: string;
  listeners: WidgetListener[];
  description?: string;
}

export interface WidgetLayoutConfig {
  placement?: string;
  direction?: string;
  wrap?: string;
  gap?: number;
  maxWidth?: string | number;
  alignItems?: string;
}

export interface WidgetStyleConfig {
  container?: Record<string, any>;
  widgetCard?: Record<string, any>;
  widgetTitle?: Record<string, any>;
}

export interface WidgetConfig {
  layout: WidgetLayoutConfig;
  style: WidgetStyleConfig;
}

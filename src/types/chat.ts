export interface MessageSegment {
  type: 'text' | 'code';
  content: string;
  language?: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface StreamingState {
  isStreaming: boolean;
  currentMessage?: string;
}

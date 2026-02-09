import React from 'react';
import { ChatMessage, MessageSegment } from '../../types/chat';

interface ChatMessagesProps {
  messages: ChatMessage[];
  isStreaming: boolean;
  currentStreamingMessage: string;
  chatEndRef: React.RefObject<HTMLDivElement | null>;
  parseMessageSegments: (content: string) => MessageSegment[];
}

export const ChatMessages = React.memo(function ChatMessages({
  messages,
  isStreaming,
  currentStreamingMessage,
  chatEndRef,
  parseMessageSegments
}: ChatMessagesProps) {
  return (
    <div className="chat-messages">
      {messages.length === 0 && (
        <div className="chat-welcome">
          <p>👋 Hello! I'm your chart assistant.</p>
          <p>
            Ask me anything about the Gantt chart data, task scheduling, or resource utilization.
          </p>
        </div>
      )}

      {messages.map((msg, idx) => (
        <div key={idx} className={`message ${msg.role}`}>
          <div className="message-content">
            {parseMessageSegments(msg.content).map((segment, segmentIndex) => {
              if (segment.type === 'code') {
                const languageLabel = segment.language
                  ? `${segment.language.toUpperCase()} code`
                  : 'Code';
                return (
                  <details key={`msg-${idx}-code-${segmentIndex}`} className="message-code">
                    <summary>
                      <span className="message-code-label">{languageLabel}</span>
                      <span className="message-code-hint message-code-hint-closed">Show code</span>
                      <span className="message-code-hint message-code-hint-open">Hide code</span>
                    </summary>
                    <pre className="message-code-block">
                      <code>{segment.content}</code>
                    </pre>
                  </details>
                );
              }
              return (
                <span key={`msg-${idx}-text-${segmentIndex}`} className="message-text">
                  {segment.content}
                </span>
              );
            })}
          </div>
        </div>
      ))}

      {isStreaming && currentStreamingMessage && (
        <div className="message assistant streaming">
          <div className="message-content">
            {currentStreamingMessage}
            <span className="cursor-blink">▊</span>
          </div>
        </div>
      )}

      {isStreaming && !currentStreamingMessage && (
        <div className="message assistant">
          <div className="message-content">
            <span className="typing-indicator">
              <span></span>
              <span></span>
              <span></span>
            </span>
          </div>
        </div>
      )}

      <div ref={chatEndRef} />
    </div>
  );
});

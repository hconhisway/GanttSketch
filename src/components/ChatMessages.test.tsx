import React from 'react';
import { render } from '@testing-library/react';
import { ChatMessages } from './ChatMessages';

describe('ChatMessages', () => {
  it('shows welcome state when empty', () => {
    const { getByText } = render(
      <ChatMessages
        messages={[]}
        isStreaming={false}
        currentStreamingMessage=""
        chatEndRef={React.createRef<HTMLDivElement>()}
        parseMessageSegments={() => []}
      />
    );
    expect(getByText(/chart assistant/i)).toBeInTheDocument();
  });

  it('renders text and code segments', () => {
    const { getByText } = render(
      <ChatMessages
        messages={[{ role: 'assistant', content: 'Here is code' }]}
        isStreaming={false}
        currentStreamingMessage=""
        chatEndRef={React.createRef<HTMLDivElement>()}
        parseMessageSegments={() => [
          { type: 'text', content: 'Here is code' },
          { type: 'code', content: '{"a":1}', language: 'json' }
        ]}
      />
    );

    expect(getByText('Here is code')).toBeInTheDocument();
    expect(getByText('JSON code')).toBeInTheDocument();
    expect(getByText('{"a":1}')).toBeInTheDocument();
  });

  it('shows streaming cursor while streaming', () => {
    const { getByText } = render(
      <ChatMessages
        messages={[]}
        isStreaming={true}
        currentStreamingMessage="Streaming..."
        chatEndRef={React.createRef<HTMLDivElement>()}
        parseMessageSegments={() => []}
      />
    );
    expect(getByText('Streaming...')).toBeInTheDocument();
    expect(getByText('▊')).toBeInTheDocument();
  });
});

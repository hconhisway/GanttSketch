import React from 'react';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConfigPanel } from './ConfigPanel';

describe('ConfigPanel', () => {
  it('renders config and widget buttons with active/highlight states', async () => {
    const user = userEvent.setup();
    const onOpenConfigEditor = jest.fn();
    const onOpenWidgetEditor = jest.fn();

    const { getByRole } = render(
      <ConfigPanel
        configSpec={[
          {
            id: 'layout',
            title: 'Layout',
            items: [
              {
                id: 'layout.margin',
                label: 'Margin',
                path: 'layout.margin',
                description: 'Chart margin'
              }
            ]
          }
        ]}
        activeConfigItem={{ id: 'layout.margin' }}
        configHighlightId="layout.margin"
        onOpenConfigEditor={onOpenConfigEditor}
        widgets={[{ id: 'widget-1', name: 'Widget 1', html: '<div />', listeners: [] }]}
        activeWidget={{ id: 'widget-1', name: 'Widget 1', html: '<div />', listeners: [] }}
        widgetHighlightId="widget-1"
        onOpenWidgetEditor={onOpenWidgetEditor}
      />
    );

    const configButton = getByRole('button', { name: 'Margin' });
    expect(configButton).toHaveClass('active');
    expect(configButton).toHaveClass('highlight');
    await user.click(configButton);
    expect(onOpenConfigEditor).toHaveBeenCalledTimes(1);

    const widgetButton = getByRole('button', { name: 'Widget 1' });
    expect(widgetButton).toHaveClass('active');
    expect(widgetButton).toHaveClass('highlight');
    await user.click(widgetButton);
    expect(onOpenWidgetEditor).toHaveBeenCalledTimes(1);
  });
});

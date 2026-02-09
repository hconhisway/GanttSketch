import { validateWidget } from './widgetValidator';

describe('widgetValidator', () => {
  it('auto-fixes missing ids and strips script tags', () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(12345);
    const result = validateWidget({ html: '<div>ok</div><script>alert(1)</script>' }, []);
    expect(result.valid).toBe(true);
    expect(result.widget.id).toBe('widget-12345');
    expect(result.widget.name).toBe('widget-12345');
    expect(result.widget.html).toBe('<div>ok</div>');
    expect(result.warnings).toContain('Widget has no listeners - it will be display-only');
    nowSpy.mockRestore();
  });

  it('reports invalid listener handlers', () => {
    const result = validateWidget(
      {
        id: 'widget-1',
        name: 'Widget',
        html: '<button>Click</button>',
        listeners: [{ selector: 'button', event: 'click', handler: '' }]
      },
      []
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((err) => err.includes('Handler is missing'))).toBe(true);
  });
});

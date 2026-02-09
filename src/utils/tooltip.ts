import { evalExpr, evalPredicate, isEmptyValue } from './expression';
import { escapeHtml, formatArgValue } from './formatting';

export function renderTooltipRows(fields: any[], ctx: any): string {
  if (!Array.isArray(fields)) return '';
  return fields
    .map((field, idx) => {
      if (!field) return '';
      const whenRule = field.when;
      if (whenRule && !evalPredicate(whenRule, ctx)) return '';
      const labelRaw = field.label ?? field.name ?? `Field ${idx + 1}`;
      const valueRule = field.value ?? (field.path ? { op: 'get', path: field.path } : null);
      const label = typeof labelRaw === 'object' ? evalExpr(labelRaw, ctx) : labelRaw;
      const value = evalExpr(valueRule, ctx);
      if (isEmptyValue(value) && field.showEmpty !== true) return '';
      return `
      <div class="tooltip-row">
        <span class="tooltip-key">${escapeHtml(label ?? '')}:</span>
        <span class="tooltip-value">${escapeHtml(value ?? '')}</span>
      </div>
    `;
    })
    .join('');
}

export function buildTooltipHtml(hit: any, tooltipConfig: any, ctx: any): string {
  if (!tooltipConfig || tooltipConfig.enabled === false) return '';
  if (hit.area === 'process') {
    const processConfig = tooltipConfig.hierarchy1 ?? tooltipConfig.process ?? {};
    const rows = renderTooltipRows(processConfig.fields, ctx);
    const title = processConfig.title ?? 'Row';
    return `
      <div class="tooltip-grid">
        <div class="tooltip-col">
          <div class="tooltip-title">${escapeHtml(title)}</div>
          ${rows || `<div class="tooltip-muted">No fields</div>`}
        </div>
      </div>
    `;
  }

  const eventConfig = tooltipConfig.event || {};
  const rows = renderTooltipRows(eventConfig.fields, ctx);
  const title = eventConfig.title ?? 'Details';
  const argsConfig = eventConfig.args || {};
  const argsEnabled = argsConfig.enabled !== false;
  const argsLabel = argsConfig.label ?? 'Arguments';
  const argsMax = Number.isFinite(Number(argsConfig.max)) ? Number(argsConfig.max) : 24;

  let argsHtml = '';
  let extraHtml = '';

  if (argsEnabled) {
    const argsObj = ctx.event?.args && typeof ctx.event.args === 'object' ? ctx.event.args : {};
    let entries = Object.entries(argsObj);
    if (argsConfig.sort === 'alpha') {
      entries = entries.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    }
    if (argsConfig.filter) {
      entries = entries.filter(([key, value]) =>
        evalPredicate(argsConfig.filter, {
          ...ctx,
          argKey: key,
          argValue: value,
          vars: { ...(ctx.vars || {}), argKey: key, argValue: value }
        })
      );
    }
    const shownArgs = entries.slice(0, Math.max(0, argsMax));
    const remainingCount = Math.max(0, entries.length - shownArgs.length);
    argsHtml =
      shownArgs.length > 0
        ? shownArgs
            .map(([k, v]) => {
              const valueRule = argsConfig.value || null;
              const formattedValue = valueRule
                ? evalExpr(valueRule, {
                    ...ctx,
                    argKey: k,
                    argValue: v,
                    vars: { ...(ctx.vars || {}), argKey: k, argValue: v }
                  })
                : formatArgValue(v);
              return `
          <div class="tooltip-row">
            <span class="tooltip-key">${escapeHtml(k)}:</span>
            <span class="tooltip-value">${escapeHtml(formattedValue)}</span>
          </div>
        `;
            })
            .join('')
        : `<div class="tooltip-muted">No arguments</div>`;
    extraHtml =
      remainingCount > 0 ? `<div class="tooltip-muted">… (+${remainingCount} more)</div>` : '';
  }

  if (!argsEnabled) {
    return `
      <div class="tooltip-grid">
        <div class="tooltip-col">
          <div class="tooltip-title">${escapeHtml(title)}</div>
          ${rows || `<div class="tooltip-muted">No fields</div>`}
        </div>
      </div>
    `;
  }

  return `
    <div class="tooltip-grid">
      <div class="tooltip-col">
        <div class="tooltip-title">${escapeHtml(title)}</div>
        ${rows || `<div class="tooltip-muted">No fields</div>`}
      </div>
      <div class="tooltip-col">
        <div class="tooltip-title">${escapeHtml(argsLabel)}</div>
        ${argsHtml}
        ${extraHtml}
      </div>
    </div>
  `;
}

import { clampNumber, formatDurationUs, formatTimeUs, formatTimeUsFull } from './formatting';

export function hashStringToInt(value: unknown): number {
  const str = String(value ?? '');
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h * 31 + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

export function getValueAtPath(obj: any, path: unknown): any {
  if (!obj || !path) return undefined;
  const parts = String(path).split('.');
  let cursor = obj;
  for (const part of parts) {
    if (cursor && typeof cursor === 'object' && part in cursor) {
      cursor = cursor[part];
    } else {
      return undefined;
    }
  }
  return cursor;
}

export function pickFirstFieldValue(item: any, fields: unknown): any {
  if (!Array.isArray(fields)) return undefined;
  for (const field of fields) {
    const value = getValueAtPath(item, field);
    if (value !== undefined && value !== null && value !== '') {
      return value;
    }
  }
  return undefined;
}

export function isEmptyValue(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

export function evalExpr(expr: any, ctx: any): any {
  if (expr === undefined || expr === null) return undefined;
  if (typeof expr !== 'object') return expr;
  if (Array.isArray(expr)) return expr.map((item) => evalExpr(item, ctx));
  if (expr.type === 'expr') return evalExpr(expr.expr, ctx);
  const op = expr.op;
  if (!op) return expr;

  const args = Array.isArray(expr.args) ? expr.args : [];
  const evalArg = (index: number) => evalExpr(args[index], ctx);
  const evalArgs = () => args.map((item: any) => evalExpr(item, ctx));

  switch (op) {
    case 'var': {
      const name = expr.name;
      if (ctx && Object.prototype.hasOwnProperty.call(ctx, name)) return ctx[name];
      if (ctx?.vars && Object.prototype.hasOwnProperty.call(ctx.vars, name)) return ctx.vars[name];
      return undefined;
    }
    case 'get': {
      const path = expr.path;
      const fromKey = expr.from;
      const base = fromKey ? ctx?.[fromKey] : ctx;
      return getValueAtPath(base, path);
    }
    case 'coalesce': {
      for (const item of args) {
        const value = evalExpr(item, ctx);
        if (!isEmptyValue(value)) return value;
      }
      return undefined;
    }
    case 'concat': {
      return evalArgs()
        .map((v: any) => (v === null || v === undefined ? '' : String(v)))
        .join('');
    }
    case 'lower':
      return String(evalArg(0) ?? '').toLowerCase();
    case 'upper':
      return String(evalArg(0) ?? '').toUpperCase();
    case 'trim':
      return String(evalArg(0) ?? '').trim();
    case 'len': {
      const value = evalArg(0);
      if (Array.isArray(value) || typeof value === 'string') return value.length;
      return 0;
    }
    case 'if': {
      const cond = Boolean(evalArg(0));
      return cond ? evalArg(1) : evalArg(2);
    }
    case 'case': {
      const cases = Array.isArray(expr.cases) ? expr.cases : [];
      for (const entry of cases) {
        if (!Array.isArray(entry) || entry.length < 2) continue;
        if (Boolean(evalExpr(entry[0], ctx))) return evalExpr(entry[1], ctx);
      }
      return evalExpr(expr.else, ctx);
    }
    case '==':
      return evalArg(0) === evalArg(1);
    case '!=':
      return evalArg(0) !== evalArg(1);
    case '>':
      return Number(evalArg(0)) > Number(evalArg(1));
    case '>=':
      return Number(evalArg(0)) >= Number(evalArg(1));
    case '<':
      return Number(evalArg(0)) < Number(evalArg(1));
    case '<=':
      return Number(evalArg(0)) <= Number(evalArg(1));
    case 'and':
      return evalArgs().every(Boolean);
    case 'or':
      return evalArgs().some(Boolean);
    case 'not':
      return !Boolean(evalArg(0));
    case 'add':
      return evalArgs().reduce((sum: number, v: any) => sum + Number(v || 0), 0);
    case 'sub':
      return Number(evalArg(0) || 0) - Number(evalArg(1) || 0);
    case 'mul':
      return evalArgs().reduce((product: number, v: any) => product * Number(v || 0), 1);
    case 'div': {
      const denom = Number(evalArg(1) || 0);
      if (denom === 0) return 0;
      return Number(evalArg(0) || 0) / denom;
    }
    case 'clamp':
      return clampNumber(evalArg(0), evalArg(1), evalArg(2));
    case 'regexTest': {
      const value = String(evalArg(0) ?? '');
      const pattern = expr.pattern ?? evalArg(1);
      try {
        return new RegExp(pattern).test(value);
      } catch {
        return false;
      }
    }
    case 'regexCapture': {
      const value = String(evalArg(0) ?? '');
      const pattern = expr.pattern ?? evalArg(1);
      const groupIndex = Number(expr.group ?? evalArg(2) ?? 1);
      try {
        const match = value.match(new RegExp(pattern));
        return match ? match[groupIndex] : '';
      } catch {
        return '';
      }
    }
    case 'hash':
      return hashStringToInt(evalArg(0));
    case 'paletteHash': {
      const key = evalArg(0);
      const palette = evalArg(1);
      if (!Array.isArray(palette) || palette.length === 0) return '';
      const hash = hashStringToInt(key);
      return palette[hash % palette.length];
    }
    case 'formatTimeUs':
      return formatTimeUs(evalArg(0));
    case 'formatTimeUsFull':
      return formatTimeUsFull(evalArg(0));
    case 'formatDurationUs':
      return formatDurationUs(evalArg(0));
    default:
      return undefined;
  }
}

export function evalPredicate(rule: any, ctx: any): boolean {
  if (!rule) return false;
  if (rule.type === 'predicate') return Boolean(evalExpr(rule.when, ctx));
  if (rule.type === 'expr') return Boolean(evalExpr(rule.expr, ctx));
  if (rule.op) return Boolean(evalExpr(rule, ctx));
  return Boolean(rule);
}

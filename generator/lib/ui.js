'use strict';

// React UI generation. Every page follows the lab4ui pages the C3 Code agent wrote (PageFrame + Container +
// DataGrid/MetricCard/EChart, useEffect + cancelled flag + reportError, c3Call with bounded fetch specs, filters in URL
// params), made generic over the spec's entities.

var M = require('./model');

var HEADER = '/*\n * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.\n * Confidential and Proprietary C3 Materials.\n */\n\n';

function hdr(app) {
  return app.header ? HEADER : '';
}
function q(s) {
  return "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
}
function jsxText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/'/g, '&apos;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/{/g, '&#123;').replace(/}/g, '&#125;');
}
function uniq(a) {
  return a.filter(function (x, i) { return a.indexOf(x) === i; });
}
function hasPage(ent, p) {
  return ent.pages.indexOf(p) >= 0;
}

/** Collects named imports and renders them sorted (lab4 style: React, router, lucide, then '@/' modules). */
function Imports() {
  var mods = {};
  var defaults = {};
  return {
    add: function (mod, name) {
      (mods[mod] = mods[mod] || []).push(name);
    },
    def: function (mod, name) {
      defaults[mod] = name;
    },
    render: function () {
      var order = Object.keys(Object.assign({}, mods, defaults)).sort(function (a, b) {
        var rank = function (m) { return m === 'react' ? 0 : m === 'react-router-dom' ? 1 : m === 'lucide-react' ? 2 : 3; };
        return rank(a) - rank(b) || a.localeCompare(b);
      });
      var lines = [];
      var lastGroup = null;
      order.forEach(function (m) {
        var group = m.indexOf('@/') === 0 ? 1 : 0;
        if (lastGroup !== null && group !== lastGroup) lines.push('');
        lastGroup = group;
        var names = uniq(mods[m] || []).sort(function (a, b) {
          return a.replace(/^type /, '').localeCompare(b.replace(/^type /, ''));
        });
        var parts = [];
        if (defaults[m]) parts.push(defaults[m]);
        if (names.length) parts.push('{ ' + names.join(', ') + ' }');
        lines.push('import ' + parts.join(', ') + " from '" + m + "';");
      });
      return lines.join('\n') + '\n';
    },
  };
}

// ---------- field helpers ----------

function scalarKinds(f) {
  return ['string', 'int', 'double', 'boolean', 'datetime'].indexOf(f.kind) >= 0;
}

/** `r.site?.region` style accessor. */
function accessor(v, p) {
  var parts = p.split('.');
  return v + '.' + parts.join('?.');
}

function formatFn(f, detail, short) {
  if (f.format === 'currency') return 'formatCurrency';
  if (f.format === 'hours') return 'formatHours';
  if (f.format === 'percent') return 'formatPercent';
  if (f.kind === 'datetime' && short) return 'formatShortDate';
  if (f.kind === 'datetime') return f.format === 'date' || !detail ? 'formatDate' : 'formatDateTime';
  if (f.kind === 'int' || f.kind === 'double') return 'formatNumber';
  return null;
}

/** JSX expression rendering the value at `path` of row variable `v`. Registers the imports it needs. */
function cellJsx(app, ent, v, p, imp, opts) {
  opts = opts || {};
  var r = M.resolvePath(app, ent, p);
  var f = r.field;
  var acc = accessor(v, p);
  if (f.kind === 'enum') {
    imp.add('@/components/StatusBadges/StatusBadges', f.enumDef.badge);
    return '<' + f.enumDef.badge + ' value={' + acc + '} />';
  }
  if (f.kind === 'ref') {
    var target = app.byName[f.ref];
    var lab = acc + '?.' + target.label;
    if (hasPage(target, 'detail') && !opts.noLink) {
      return '{' + acc + ' ? (\n<a href={`#/' + target.route + '/${' + acc + '.id}`}' + (opts.short ? ' onClick={(e) => e.stopPropagation()}' : '') + ' className="' + (opts.short ? 'text-[var(--c3-style-basic-fg-primary)]' : 'text-[var(--c3-style-basic-fg-accent)]') + ' hover:underline">\n{' + lab + '}\n</a>\n) : (\n<span className="text-[var(--c3-style-basic-fg-secondary)]">' + (f.required ? '—' : 'Unassigned') + '</span>\n)}';
    }
    return '{' + lab + " ?? '—'}";
  }
  var fn = formatFn(f, opts.detail, opts.short);
  if (fn) {
    imp.add('@/lib/format', fn);
    return '{' + fn + '(' + acc + ')}';
  }
  if (f.kind === 'boolean') return '{' + acc + " == null ? '—' : " + acc + " ? 'Yes' : 'No'}";
  if (opts.link && hasPage(ent, 'detail')) {
    return '<a href={`#/' + ent.route + '/${' + v + '.id}`} className="text-[var(--c3-style-basic-fg-accent)] hover:underline">\n{' + acc + " ?? '—'}\n</a>";
  }
  return '{' + acc + " ?? '—'}";
}

/** Dashboard KPIs with `before` + `alert` (e.g. Overdue) become a small marker next to the KPI's first `where` column. */
function listFlags(app, ent, cols) {
  var d = app.dashboard;
  if (!d || d.entity !== ent) return [];
  return d.kpis.filter(function (k) { return k.before && k.alert && k.flag !== false; }).map(function (k) {
    var col = Object.keys(k.where || {})[0];
    return { kpi: k, label: k.flagLabel || k.label, column: cols.indexOf(col) >= 0 ? col : cols[cols.length - 1] };
  });
}

/** Include string for a set of paths (references pull id + label). */
function includeFor(app, ent, paths, extra) {
  var inc = ['id'].concat(extra || []);
  paths.forEach(function (p) {
    var r = M.resolvePath(app, ent, p);
    if (r.field.kind === 'ref' && p.indexOf('.') < 0) {
      var t = app.byName[r.field.ref];
      inc.push(p + '.id', p + '.' + t.label);
    } else inc.push(p);
  });
  return uniq(inc).join(', ');
}

function listColumns(app, ent) {
  if (ent.list.columns) return ent.list.columns;
  var cols = [ent.label];
  if (ent.subtitle) cols.push(ent.subtitle);
  ent.fields.forEach(function (f) {
    if (cols.length >= 8 || cols.indexOf(f.name) >= 0 || f.multiline || f.hidden) return;
    cols.push(f.name);
  });
  return cols;
}

function defaultSort(app, ent) {
  var s = ent.list.sort;
  if (s) return { field: s.field, dir: s.dir || 'desc' };
  var dt = ent.fields.filter(function (f) { return f.kind === 'datetime'; })[0];
  return dt ? { field: dt.name, dir: 'desc' } : { field: ent.label, dir: 'asc' };
}

/** Filter paths shown on a list page: declared ones plus every path the dashboard links to. */
function listFilters(app, ent) {
  var paths = (ent.list.filters || ent.fields.filter(function (f) { return f.kind === 'enum' || f.kind === 'ref'; })
    .map(function (f) { return f.name; })).slice();
  var d = app.dashboard;
  if (d && d.entity === ent) {
    d.kpis.forEach(function (k) {
      Object.keys(k.where || {}).forEach(function (p) { paths.push(p); });
    });
    d.charts.forEach(function (c) {
      if (c.groupBy) {
        var r = M.resolvePath(app, ent, c.groupBy);
        if (r.field.kind === 'enum' || r.field.kind === 'ref') paths.push(c.groupBy);
      }
    });
  }
  return uniq(paths).map(function (p) {
    var r = M.resolvePath(app, ent, p);
    if (r.field.kind !== 'enum' && r.field.kind !== 'ref') throw new Error('spec: list filter ' + ent.name + '.' + p + ' must be an enum or reference');
    return { path: p, field: r.field, owner: r.owner };
  });
}

function beforeFields(app, ent) {
  var d = app.dashboard;
  var out = [];
  if (d && d.entity === ent) d.kpis.forEach(function (k) { if (k.before) out.push(k.before); });
  return uniq(out);
}

/** Reference targets used by filters/forms of `ent` (loaded by useLookups). */
function lookupTargets(app, ent) {
  var t = [];
  listFilters(app, ent).forEach(function (lf) { if (lf.field.kind === 'ref') t.push(lf.field.ref); });
  ent.fields.forEach(function (f) { if (f.kind === 'ref') t.push(f.ref); });
  return uniq(t);
}

function lookupSubFields(app, target) {
  return target.fields.filter(function (f) { return f.kind === 'enum' || (f.kind === 'string' && !f.multiline && f.name !== target.label); }).slice(0, 2);
}

// ---------- shared files ----------

function interfaces(app) {
  var out = hdr(app);
  Object.keys(app.enums).forEach(function (k) {
    var en = app.enums[k];
    out += '/** Values of the backend `' + en.name + '` enum. */\n';
    out += 'export const ' + en.tsConst + ' = [' + en.values.map(function (v) { return q(v.label); }).join(', ') + '] as const;\n';
    out += 'export type ' + en.tsType + ' = (typeof ' + en.tsConst + ')[number];\n\n';
  });
  out += 'export interface Meta {\n  created?: string;\n  updated?: string;\n  createdBy?: string;\n}\n\n';
  app.entities.forEach(function (e) {
    out += 'export interface ' + e.name + ' {\n  id: string;\n  version?: number;\n';
    if (e.usesName) out += '  name: string;\n';
    e.fields.forEach(function (f) {
      out += '  ' + f.name + (f.required ? '' : '?') + ': ' + f.tsType + ';\n';
    });
    e.inverses.forEach(function (i) { out += '  ' + i.name + '?: ' + i.child + '[];\n'; });
    out += '  meta?: Meta;\n}\n\n';
  });
  out += 'export interface FetchResult<T> {\n  objs?: T[];\n  count?: number;\n  hasMore?: boolean;\n}\n';
  var d = app.dashboard;
  if (d) {
    var plans = require('./backend').chartPlan(app, d);
    out += '\nexport interface CountBucket {\n  key: string;\n  label: string;\n  count: number;\n  value?: number;\n}\n';
    out += '\nexport interface MonthBucket {\n  month: string;\n  counts: number[];\n}\n';
    out += '\n/** Shape returned by `' + d.entity.name + '.dashboardSummary()`. */\nexport interface DashboardSummary {\n';
    d.kpis.forEach(function (k) { out += '  ' + k.key + ': number;\n'; });
    plans.forEach(function (p) { out += '  ' + p.chart.key + ': ' + (p.type === 'month' ? 'MonthBucket' : 'CountBucket') + '[];\n'; });
    out += '}\n';
  }
  return out;
}

function format(app) {
  var enumTypes = Object.keys(app.enums).map(function (k) { return app.enums[k]; });
  var out = hdr(app);
  out += "import type { BadgeAppearance } from '@/components/ui/badge';\n";
  if (enumTypes.length) out += 'import type { ' + enumTypes.map(function (e) { return e.tsType; }).sort().join(', ') + " } from '@/Interfaces';\n";
  out += "import { readColor } from '@/lib/echarts-theme';\n\n";
  out += [
    "const currency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });",
    'const compactCurrency = new Intl.NumberFormat(\'en-US\', {',
    "  style: 'currency',",
    "  currency: 'USD',",
    "  notation: 'compact',",
    '  maximumFractionDigits: 1,',
    '});',
    "const number = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });",
    '',
    "export const formatCurrency = (value?: number | null): string => (value == null ? '—' : currency.format(value));",
    '',
    'export const formatCompactCurrency = (value?: number | null): string =>',
    "  value == null ? '—' : compactCurrency.format(value);",
    '',
    "export const formatNumber = (value?: number | null): string => (value == null ? '—' : number.format(value));",
    '',
    "export const formatHours = (value?: number | null): string => (value == null ? '—' : `${value.toFixed(1)} h`);",
    '',
    "export const formatDays = (value?: number | null): string => (value == null ? '—' : `${value.toFixed(1)} d`);",
    '',
    'export const formatPercent = (value?: number | null): string =>',
    "  value == null ? '—' : `${Math.round(value * 100)}%`;",
    '',
    'export const formatDate = (iso?: string | null): string => {',
    "  if (!iso) return '—';",
    '  const d = new Date(iso);',
    "  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });",
    '};',
    '',
    'export const formatDateTime = (iso?: string | null): string => {',
    "  if (!iso) return '—';",
    '  const d = new Date(iso);',
    '  return Number.isNaN(d.getTime())',
    "    ? '—'",
    "    : d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });",
    '};',
    '',
    '/** Compact date for table cells: `Nov 26`, with the year only when it is not the current year. */',
    'export const formatShortDate = (iso?: string | null): string => {',
    "  if (!iso) return '—';",
    '  const d = new Date(iso);',
    "  if (Number.isNaN(d.getTime())) return '—';",
    '  const sameYear = d.getFullYear() === new Date().getFullYear();',
    "  return d.toLocaleDateString('en-US', sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });",
    '};',
    '',
    '/** Whole days from a past date to now (0 for today or a future date). */',
    'export const daysSince = (iso?: string | null): string => {',
    "  if (!iso) return '—';",
    '  const t = new Date(iso).getTime();',
    "  return Number.isNaN(t) ? '—' : String(Math.max(0, Math.floor((Date.now() - t) / 86400000)));",
    '};',
    '',
    '/** `2026-06` → `Jun 2026`. */',
    'export const formatMonth = (month: string): string => {',
    "  const [y, m] = month.split('-').map(Number);",
    "  return new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });",
    '};',
    '',
    '/** Formats a KPI value by its declared format. */',
    "export const formatKpi = (value: number, kind: 'number' | 'currency' | 'percent' | 'hours' | 'days'): string => {",
    "  if (kind === 'currency') return formatCompactCurrency(value);",
    "  if (kind === 'percent') return formatPercent(value);",
    "  if (kind === 'hours') return formatHours(value);",
    "  if (kind === 'days') return formatDays(value);",
    '  return formatNumber(value);',
    '};',
    '',
  ].join('\n');
  enumTypes.forEach(function (en) {
    out += '\nexport const ' + en.tsAppearance + ': Record<' + en.tsType + ', BadgeAppearance> = {\n';
    en.values.forEach(function (v) {
      var key = /^[A-Za-z_$][\w$]*$/.test(v.label) ? v.label : q(v.label);
      out += '  ' + key + ': ' + q(v.appearance) + ',\n';
    });
    out += '};\n';
  });
  out += [
    '',
    '/** Semantic chart color for a badge appearance (token-driven, so it follows the theme). */',
    'const APPEARANCE_CHART_TOKEN: Record<BadgeAppearance, string> = {',
    "  primary: '--c3-style-chart-neutral',",
    "  secondary: '--c3-style-chart-neutral',",
    "  accent: '--c3-style-chart-accent',",
    "  success: '--c3-style-chart-success',",
    "  warning: '--c3-style-chart-warning',",
    "  danger: '--c3-style-chart-danger',",
    "  info: '--c3-style-chart-info',",
    '};',
    '',
    'export const chartColor = (appearance: BadgeAppearance): string => readColor(APPEARANCE_CHART_TOKEN[appearance]);',
    '',
    '/** Escapes a user-typed value for use inside a single-quoted C3 filter string literal. */',
    "export const filterLiteral = (value: string): string => `'${value.replace(/\\\\/g, '\\\\\\\\').replace(/'/g, \"\\\\'\")}'`;",
    '',
    "/** Today's date as a filter literal (`dateTime('YYYY-MM-DD')`). */",
    "export const todayLiteral = (): string => `dateTime(${filterLiteral(new Date().toISOString().substring(0, 10))})`;",
    '',
  ].join('\n');
  return out;
}

function statusBadges(app) {
  var enumTypes = Object.keys(app.enums).map(function (k) { return app.enums[k]; });
  var out = hdr(app) + "import React from 'react';\n\n";
  out += "import { Badge, type BadgeAppearance } from '@/components/ui/badge';\n";
  if (enumTypes.length) {
    out += 'import type { ' + enumTypes.map(function (e) { return e.tsType; }).sort().join(', ') + " } from '@/Interfaces';\n";
    out += 'import { ' + enumTypes.map(function (e) { return e.tsAppearance; }).sort().join(', ') + " } from '@/lib/format';\n";
  }
  out += '\n/** Soft badge for an enum value; one style for every enum so status columns read consistently. */\n';
  out += 'export function EnumBadge({ value, appearance }: { value?: string; appearance?: BadgeAppearance }) {\n';
  out += '  if (!value) return <span>—</span>;\n  return (\n    <Badge variant="soft" appearance={appearance ?? \'secondary\'} size="sm" shape="rounded">\n      {value}\n    </Badge>\n  );\n}\n';
  enumTypes.forEach(function (en) {
    out += '\nexport function ' + en.badge + '({ value }: { value?: ' + en.tsType + ' }) {\n';
    out += '  return <EnumBadge value={value} appearance={value ? ' + en.tsAppearance + '[value] : undefined} />;\n}\n';
  });
  return out;
}

function useLookups(app) {
  var targets = [];
  app.entities.forEach(function (e) { targets = targets.concat(lookupTargets(app, e)); });
  targets = uniq(targets).map(function (n) { return app.byName[n]; });
  if (!targets.length) return null;
  var out = hdr(app) + "import { useEffect, useState } from 'react';\n\nimport { c3Call } from '@/c3Action';\nimport { useErrorBoundary } from '@/components/ErrorBoundary/ErrorBoundary';\n";
  out += 'import type { FetchResult, ' + targets.map(function (t) { return t.name; }).sort().join(', ') + " } from '@/Interfaces';\n\n";
  out += '/** Upper bound for the reference tables used in pickers and filters. */\nconst LOOKUP_LIMIT = 500;\n\n';
  out += 'export interface Lookups {\n' + targets.map(function (t) { return '  ' + t.varPlural + ': ' + t.name + '[];\n'; }).join('') + '  loading: boolean;\n}\n\n';
  out += '/** Loads the reference records (' + targets.map(function (t) { return t.display.toLowerCase(); }).join(', ') + ') used by filter and form pickers. */\n';
  out += 'export function useLookups(): Lookups {\n  const { reportError } = useErrorBoundary();\n';
  out += '  const [state, setState] = useState<Lookups>({ ' + targets.map(function (t) { return t.varPlural + ': []'; }).join(', ') + ', loading: true });\n\n';
  out += '  useEffect(() => {\n    let cancelled = false;\n    Promise.all([\n';
  targets.forEach(function (t) {
    var inc = ['id', t.label].concat(lookupSubFields(app, t).map(function (f) { return f.name; }));
    out += "      c3Call('" + t.name + "', 'fetch', null, [\n        { include: " + q(uniq(inc).join(', ')) + ", order: 'ascending(" + t.label + ")', limit: LOOKUP_LIMIT, offset: 0 },\n      ]) as Promise<FetchResult<" + t.name + '>>,\n';
  });
  out += '    ])\n      .then(([' + targets.map(function (t, i) { return 'r' + i; }).join(', ') + ']) => {\n';
  out += '        if (!cancelled) setState({ ' + targets.map(function (t, i) { return t.varPlural + ': r' + i + '.objs ?? []'; }).join(', ') + ', loading: false });\n';
  out += '      })\n      .catch((err: unknown) => {\n        if (cancelled) return;\n        setState((prev) => ({ ...prev, loading: false }));\n        reportError(err);\n      });\n';
  out += '    return () => {\n      cancelled = true;\n    };\n  }, [reportError]);\n\n  return state;\n}\n';
  return out;
}

function lookupOptionsExpr(app, target, varName) {
  var subs = lookupSubFields(app, target);
  var sub = subs.length ? ', subLabel: [' + subs.map(function (f) { return 'x.' + f.name; }).join(', ') + "].filter(Boolean).join(' · ')" : '';
  return varName + '.map((x) => ({ value: x.id, label: x.' + target.label + sub + ' }))';
}

// ---------- list page ----------

function listPage(app, ent) {
  var imp = Imports();
  imp.def('react', 'React');
  ['useCallback', 'useEffect', 'useMemo', 'useState'].forEach(function (n) { imp.add('react', n); });
  imp.add('react-router-dom', 'useSearchParams');
  imp.add('@/c3Action', 'c3Call');
  imp.add('@/components/ErrorBoundary/ErrorBoundary', 'useErrorBoundary');
  imp.def('@/components/PageFrame/PageFrame', 'PageFrame');
  ['EmptyRows', 'ErrorState', 'errorMessage'].forEach(function (n) { imp.add('@/components/PageFrame/PageFrame', n); });
  imp.add('@/components/ui/button', 'Button');
  imp.add('@/components/ui/container', 'Container');
  ['DataGrid', 'DataGridBody', 'DataGridCell', 'DataGridHead', 'DataGridHeader', 'DataGridRow'].forEach(function (n) { imp.add('@/components/ui/data-grid', n); });
  imp.add('@/components/ui/input-search', 'InputSearch');
  imp.add('@/components/ui/pagination', 'Pagination');
  imp.add('@/components/ui/spinner', 'Spinner');
  imp.add('@/Interfaces', 'type FetchResult');
  imp.add('@/Interfaces', 'type ' + ent.name);
  imp.add('@/lib/format', 'filterLiteral');
  imp.add('lucide-react', 'FilterX');

  var cols = listColumns(app, ent);
  var filters = listFilters(app, ent);
  var befores = beforeFields(app, ent);
  var sort = defaultSort(app, ent);
  var search = ent.list.search || [ent.label].concat(ent.subtitle ? [ent.subtitle] : []);
  var sortable = cols.filter(function (c) {
    if (c.indexOf('.') >= 0) return false;
    var f = M.resolvePath(app, ent, c).field;
    return scalarKinds(f) && f.kind !== 'boolean';
  });
  if (sortable.indexOf(sort.field) < 0) sortable.push(sort.field);
  var lookups = uniq(filters.filter(function (lf) { return lf.field.kind === 'ref'; }).map(function (lf) { return lf.field.ref; }));
  if (lookups.length) imp.add('@/hooks/useLookups', 'useLookups');
  if (filters.length) imp.add('@/components/ui/combobox', 'Combobox');
  if (befores.length) {
    imp.add('@/lib/format', 'todayLiteral');
    imp.add('@/components/ui/checkbox', 'Checkbox');
  }
  var canCreate = hasPage(ent, 'form');
  if (canCreate) {
    imp.add('react-router-dom', 'useNavigate');
    imp.add('lucide-react', 'Plus');
  }
  var C = ent.name;
  var flags = listFlags(app, ent, cols);
  var flagPaths = [];
  flags.forEach(function (fl) { flagPaths = flagPaths.concat(Object.keys(fl.kpi.where || {}), [fl.kpi.before]); });
  var inc = includeFor(app, ent, cols.concat(search.filter(function (s) { return s.indexOf('.') >= 0; })).concat(flagPaths));
  var hasDetail = hasPage(ent, 'detail');
  if ((hasDetail || ent.map || ent.ingest) && !canCreate) imp.add('react-router-dom', 'useNavigate');
  var inline = filters.slice(0, ent.list.inlineFilters || 3);
  var more = filters.slice(inline.length);
  if (more.length || befores.length) imp.add('lucide-react', 'SlidersHorizontal');

  var b = [];
  b.push('const PAGE_SIZE_OPTIONS = [10, 20, 50];');
  if (filters.some(function (lf) { return lf.field.kind === 'ref' && !lf.field.required; })) b.push("const NONE = '__none__';");
  b.push('');
  b.push('const SORT_FIELDS = [' + sortable.map(q).join(', ') + '] as const;');
  b.push('type SortField = (typeof SORT_FIELDS)[number];', '');
  b.push('const LIST_INCLUDE = ' + q(inc) + ';', '');
  if (filters.length) {
    b.push('/** Turns a URL param (`a|b` for several values) into a filter clause. */');
    b.push('const valuesClause = (path: string, raw: string): string => {');
    b.push("  const values = raw.split('|').filter(Boolean);");
    b.push('  return values.length === 1');
    b.push('    ? `${path} == ${filterLiteral(values[0])}`');
    b.push("    : `intersects(${path}, [${values.map(filterLiteral).join(', ')}])`;");
    b.push('};', '');
  }
  flags.forEach(function (fl, i) {
    var k = fl.kpi;
    var conds = Object.keys(k.where || {}).map(function (p) {
      return '[' + [].concat(k.where[p]).map(q).join(', ') + '].includes(' + accessor('r', p) + " ?? '')";
    });
    conds.push('Boolean(' + accessor('r', k.before) + ')', 'new Date(' + accessor('r', k.before) + " ?? '') < startOfToday()");
    b.push('/** ' + fl.label + ': same rule as the dashboard KPI `' + k.key + '`. */');
    b.push('const isFlag' + i + ' = (r: ' + C + '): boolean =>');
    b.push('  ' + conds.join(' &&\n  ') + ';', '');
  });
  if (flags.length) {
    b.push('const startOfToday = (): Date => {');
    b.push('  const d = new Date();');
    b.push('  d.setHours(0, 0, 0, 0);');
    b.push('  return d;');
    b.push('};', '');
  }
  b.push('const ' + C + 'List: React.FC = () => {');
  if (canCreate || hasDetail || ent.map || ent.ingest) b.push('  const navigate = useNavigate();');
  if (app.access && canCreate) {
    imp.add('@/hooks/useAccess', 'useAccess');
    b.push('  const { can } = useAccess();');
    b.push("  const canCreate = can('" + C + "', 'create');");
  }
  b.push('  const { reportError } = useErrorBoundary();');
  if (lookups.length) b.push('  const { ' + lookups.map(function (n) { return app.byName[n].varPlural; }).join(', ') + ' } = useLookups();');
  b.push('  const [params, setParams] = useSearchParams();', '');
  filters.forEach(function (lf, i) { b.push('  const f' + i + ' = params.get(' + q(lf.path) + ');'); });
  befores.forEach(function (bf, i) { b.push('  const before' + i + ' = params.get(\'before\') === ' + q(bf) + ';'); });
  b.push("  const query = params.get('q') ?? '';");
  b.push("  const sortParam = params.get('sort');");
  b.push('  // Only known columns: an unknown ?sort= would make the server reject the whole fetch.');
  b.push('  const sortField: SortField = SORT_FIELDS.find((f) => f === sortParam) ?? ' + q(sort.field) + ';');
  b.push("  const sortDir: 'asc' | 'desc' = params.get('dir') === " + (sort.dir === 'asc' ? "'desc' ? 'desc' : 'asc'" : "'asc' ? 'asc' : 'desc'") + ';');
  b.push("  const page = Math.max(1, Number(params.get('page') ?? '1') || 1);");
  b.push("  const pageSize = PAGE_SIZE_OPTIONS.includes(Number(params.get('size'))) ? Number(params.get('size')) : " + (ent.list.pageSize || 20) + ';', '');
  b.push('  const [searchText, setSearchText] = useState(query);');
  b.push('  const [rows, setRows] = useState<' + C + '[]>([]);');
  b.push('  const [total, setTotal] = useState(0);');
  b.push('  const [loading, setLoading] = useState(true);');
  b.push('  const [error, setError] = useState<string | null>(null);');
  if (more.length || befores.length) {
    b.push('  const [showMore, setShowMore] = useState(' + (more.map(function (lf) { return 'Boolean(f' + filters.indexOf(lf) + ')'; }).concat(befores.map(function (x, i) { return 'before' + i; })).join(' || ') || 'false') + ');');
  }
  b.push('  const [reloadKey, setReloadKey] = useState(0);', '');
  b.push('  const updateParams = useCallback(');
  b.push('    (changes: Record<string, string | null>, resetPage = true) => {');
  b.push('      setParams(');
  b.push('        (prev) => {');
  b.push('          const next = new URLSearchParams(prev);');
  b.push('          Object.entries(changes).forEach(([k, v]) => {');
  b.push("            if (v == null || v === '') next.delete(k);");
  b.push('            else next.set(k, v);');
  b.push('          });');
  b.push("          if (resetPage) next.delete('page');");
  b.push('          return next;');
  b.push('        },');
  b.push('        { replace: true },');
  b.push('      );');
  b.push('    },');
  b.push('    [setParams],');
  b.push('  );', '');
  b.push('  // Debounce the search box into the URL.');
  b.push('  useEffect(() => {');
  b.push('    if (searchText === query) return undefined;');
  b.push('    const handle = window.setTimeout(() => updateParams({ q: searchText.trim() || null }), 300);');
  b.push('    return () => window.clearTimeout(handle);');
  b.push('  }, [searchText, query, updateParams]);', '');
  b.push('  const filter = useMemo(() => {');
  b.push('    const clauses: string[] = [];');
  filters.forEach(function (lf, i) {
    if (lf.field.kind === 'ref') {
      if (!lf.field.required) b.push('    if (f' + i + ' === NONE) clauses.push(' + q('!exists(' + lf.path + ')') + ');');
      b.push('    ' + (lf.field.required ? '' : 'else ') + 'if (f' + i + ') clauses.push(valuesClause(' + q(lf.path + '.id') + ', f' + i + '));');
    } else b.push('    if (f' + i + ') clauses.push(valuesClause(' + q(lf.path) + ', f' + i + '));');
  });
  befores.forEach(function (bf, i) { b.push('    if (before' + i + ') clauses.push(`' + bf + ' < ${todayLiteral()}`);'); });
  b.push('    if (query) {');
  b.push('      const q = filterLiteral(query.toLowerCase());');
  b.push('      clauses.push(`(' + search.map(function (s) { return 'contains(lowerCase(' + s + '), ${q})'; }).join(' || ') + ')`);');
  b.push('    }');
  b.push("    return clauses.join(' && ');");
  b.push('  }, [' + filters.map(function (lf, i) { return 'f' + i; }).concat(befores.map(function (x, i) { return 'before' + i; })).concat(['query']).join(', ') + ']);', '');
  b.push('  useEffect(() => {');
  b.push('    let cancelled = false;');
  b.push('    setLoading(true);');
  b.push('    setError(null);');
  b.push('    const spec = {');
  b.push('      include: LIST_INCLUDE,');
  b.push("      order: `${sortDir === 'asc' ? 'ascending' : 'descending'}(${sortField}), id`,");
  b.push('      limit: pageSize,');
  b.push('      offset: (page - 1) * pageSize,');
  b.push('      ...(filter ? { filter } : {}),');
  b.push('    };');
  b.push('    Promise.all([');
  b.push("      c3Call('" + C + "', 'fetch', null, [spec]) as Promise<FetchResult<" + C + '>>,');
  b.push("      c3Call('" + C + "', 'fetchCount', null, [filter ? { filter } : {}]) as Promise<number>,");
  b.push('    ])');
  b.push('      .then(([res, count]) => {');
  b.push('        if (cancelled) return;');
  b.push('        setRows(res.objs ?? []);');
  b.push('        setTotal(count ?? 0);');
  b.push('      })');
  b.push('      .catch((err: unknown) => {');
  b.push('        if (cancelled) return;');
  b.push('        setError(errorMessage(err));');
  b.push('        reportError(err);');
  b.push('      })');
  b.push('      .finally(() => {');
  b.push('        if (!cancelled) setLoading(false);');
  b.push('      });');
  b.push('    return () => {');
  b.push('      cancelled = true;');
  b.push('    };');
  b.push('  }, [filter, sortField, sortDir, page, pageSize, reloadKey, reportError]);', '');
  b.push('  const pageCount = Math.max(1, Math.ceil(total / pageSize));', '');
  b.push('  const headProps = (field: SortField) => ({');
  b.push('    sortable: true,');
  b.push('    filterable: false,');
  b.push("    sortDirection: sortField === field ? sortDir : (null as 'asc' | 'desc' | null),");
  b.push("    onSort: () => updateParams({ sort: field, dir: sortField === field && sortDir === 'desc' ? 'asc' : 'desc' }, true),");
  b.push('  });');
  var needPlain = cols.some(function (c) { return sortable.indexOf(c) < 0; });
  if (needPlain) b.push('  const plainHead = { sortable: false, filterable: false };');
  b.push('');
  b.push('  const hasFilters = Boolean(' + filters.map(function (lf, i) { return 'f' + i; }).concat(befores.map(function (x, i) { return 'before' + i; })).concat(['query']).join(' || ') + ');');
  if (more.length || befores.length) {
    b.push('  const hiddenActive = [' + more.map(function (lf) { return 'f' + filters.indexOf(lf); }).concat(befores.map(function (x, i) { return 'before' + i; })).join(', ') + '].filter(Boolean).length;');
  }
  b.push('');
  b.push('  const clearFilters = () => {');
  b.push("    setSearchText('');");
  b.push('    setParams(new URLSearchParams(), { replace: true });');
  b.push('  };', '');
  function combo(lf, i, indent) {
    var label = lf.path.indexOf('.') >= 0 ? M.titleCase(lf.path.split('.').pop()) : lf.field.label;
    var opts;
    if (lf.field.kind === 'enum') {
      imp.add('@/Interfaces', lf.field.enumDef.tsConst);
      opts = lf.field.enumDef.tsConst + '.map((v) => ({ value: v, label: v }))';
    } else {
      var t = app.byName[lf.field.ref];
      opts = (lf.field.required ? '' : "[{ value: NONE, label: 'Unassigned' }, ...") + lookupOptionsExpr(app, t, t.varPlural) + (lf.field.required ? '' : ']');
    }
    b.push(indent + '<div className="w-[calc(50%-4px)] md:w-44">');
    b.push(indent + '  <Combobox');
    b.push(indent + '    size="sm"');
    b.push(indent + '    placeholder=' + JSON.stringify('All ' + M.plural(label.toLowerCase())));
    b.push(indent + '    options={' + opts + '}');
    b.push(indent + '    value={f' + i + '}');
    b.push(indent + '    onValueChange={(v) => updateParams({ ' + q(lf.path) + ': v })}');
    b.push(indent + '  />');
    b.push(indent + '</div>');
  }
  var countText = "`${total.toLocaleString('en-US')} ${total === 1 ? " + q(ent.singular.toLowerCase()) + ' : ' + q(ent.display.toLowerCase()) + '}`';
  b.push('  return (');
  b.push('    <PageFrame');
  b.push('      title=' + JSON.stringify(ent.display));
  b.push('      description=' + JSON.stringify(ent.list.description || ('Search, filter, and manage ' + ent.display.toLowerCase())));
  b.push("      breadcrumbs={[" + (app.dashboard ? "{ label: 'Dashboard', href: '#/' }, " : '') + '{ label: ' + q(ent.display) + ' }]}');
  var headerActions = [];
  if (ent.ingest) {
    imp.add('lucide-react', 'Upload');
    headerActions.push('<Button variant="outline" appearance="secondary" leadingIcon={<Upload />} onClick={() => navigate(' + q('/' + ent.route + '/imports') + ')}>', '  Imports', '</Button>');
  }
  if (ent.map) {
    imp.add('lucide-react', 'Map as MapIcon');
    headerActions.push('<Button variant="outline" appearance="secondary" leadingIcon={<MapIcon />} onClick={() => navigate(' + q('/' + ent.route + '/map') + ')}>', '  Map', '</Button>');
  }
  if (canCreate) {
    headerActions.push(app.access ? '{canCreate && (' : '{(');
    headerActions.push("  <Button leadingIcon={<Plus />} onClick={() => navigate('/" + ent.route + "/new')}>", '    New ' + jsxText(ent.singular), '  </Button>', ')}');
  }
  if (headerActions.length) {
    b.push('      actions={');
    b.push('        <div className="flex flex-wrap gap-2">');
    headerActions.forEach(function (l) { b.push('          ' + l); });
    b.push('        </div>');
    b.push('      }');
  }
  b.push('    >');
  b.push('      <div className="flex flex-col gap-2">');
  b.push('        <div className="flex flex-wrap items-center gap-2">');
  b.push('          <div className="w-full md:w-72">');
  b.push('            <InputSearch');
  b.push('              size="sm"');
  b.push('              aria-label=' + JSON.stringify('Search ' + ent.display.toLowerCase()));
  b.push('              placeholder=' + JSON.stringify('Search ' + search.map(function (s) { return M.words(s.replace('.', ' ')).toLowerCase(); }).join(', ')));
  b.push('              value={searchText}');
  b.push('              onChange={(e) => setSearchText(e.target.value)}');
  b.push('              onClear={() => {');
  b.push("                setSearchText('');");
  b.push('                updateParams({ q: null });');
  b.push('              }}');
  b.push('            />');
  b.push('          </div>');
  inline.forEach(function (lf) { combo(lf, filters.indexOf(lf), '          '); });
  if (more.length || befores.length) {
    b.push('          <Button');
    b.push('            variant="ghost"');
    b.push('            appearance="secondary"');
    b.push('            size="sm"');
    b.push('            leadingIcon={<SlidersHorizontal />}');
    b.push('            aria-expanded={showMore}');
    b.push('            onClick={() => setShowMore((v) => !v)}');
    b.push('          >');
    b.push("            {hiddenActive > 0 ? `More filters (${hiddenActive})` : 'More filters'}");
    b.push('          </Button>');
  }
  b.push('          {hasFilters && (');
  b.push('            <Button variant="ghost" appearance="secondary" size="sm" leadingIcon={<FilterX />} onClick={clearFilters}>');
  b.push('              Clear');
  b.push('            </Button>');
  b.push('          )}');
  b.push('          <span className="ml-auto flex items-center gap-2 text-c3-regular-body-p2 tabular-nums text-[var(--c3-style-basic-fg-secondary)]">');
  b.push('            {loading && <Spinner size="sm" />}');
  b.push('            {' + countText + '}');
  b.push('          </span>');
  b.push('        </div>');
  if (more.length || befores.length) {
    b.push('        {showMore && (');
    b.push('          <div className="flex flex-wrap items-center gap-2">');
    more.forEach(function (lf) { combo(lf, filters.indexOf(lf), '            '); });
    befores.forEach(function (bf, i) {
      var fl = M.resolvePath(app, ent, bf).field;
      b.push('            <Checkbox');
      b.push('              id="before-' + i + '"');
      b.push('              label=' + JSON.stringify('Past ' + fl.label.toLowerCase()));
      b.push('              checked={before' + i + '}');
      b.push("              onCheckedChange={(c) => updateParams({ before: c === true ? " + q(bf) + ' : null })}');
      b.push('            />');
    });
    b.push('          </div>');
    b.push('        )}');
  }
  b.push('      </div>', '');
  b.push('      {error && <ErrorState message={`Could not load ' + ent.display.toLowerCase() + ': ${error}`} onRetry={() => setReloadKey((k) => k + 1)} />}', '');
  b.push('      <Container');
  b.push('        contentWidth="full-width"');
  b.push('        footer={');
  b.push('          <Pagination');
  b.push('            type="full"');
  b.push('            page={Math.min(page, pageCount)}');
  b.push('            pageCount={pageCount}');
  b.push('            totalItems={total}');
  b.push('            pageSize={pageSize}');
  b.push('            pageSizeOptions={PAGE_SIZE_OPTIONS}');
  b.push('            onPageChange={(p) => updateParams({ page: String(p) }, false)}');
  b.push('            onPageSizeChange={(s) => updateParams({ size: String(s) })}');
  b.push('          />');
  b.push('        }');
  b.push('      >');
  b.push('        <div className="overflow-x-auto">');
  b.push('          <DataGrid className="app-table w-full">');
  b.push('            <DataGridHeader>');
  b.push('              <DataGridRow>');
  cols.forEach(function (c) {
    var f = M.resolvePath(app, ent, c).field;
    var title = c.indexOf('.') >= 0 ? M.titleCase(c.split('.').pop()) : f.label;
    var right = f.kind === 'int' || f.kind === 'double';
    var props = sortable.indexOf(c) >= 0 ? '{...headProps(' + q(c) + ')}' : '{...plainHead}';
    b.push('                <DataGridHead ' + props + (right ? ' align="right"' : '') + '>' + jsxText(title) + '</DataGridHead>');
  });
  b.push('              </DataGridRow>');
  b.push('            </DataGridHeader>');
  b.push('            <DataGridBody>');
  b.push('              {!loading && !error && rows.length === 0 && (');
  b.push('                <EmptyRows');
  b.push('                  colSpan={' + cols.length + '}');
  b.push('                  label={hasFilters ? "No ' + jsxText(ent.display.toLowerCase()) + ' match these filters." : "No ' + jsxText(ent.display.toLowerCase()) + ' yet."}');
  b.push('                  action={');
  b.push('                    hasFilters ? (');
  b.push('                      <Button variant="outline" appearance="secondary" size="sm" leadingIcon={<FilterX />} onClick={clearFilters}>');
  b.push('                        Clear filters');
  b.push('                      </Button>');
  b.push('                    ) : undefined');
  b.push('                  }');
  b.push('                />');
  b.push('              )}');
  b.push('              {rows.map((r) => (');
  if (hasDetail) {
    b.push('                <DataGridRow key={r.id} className="cursor-pointer" onClick={() => navigate(`/' + ent.route + '/${r.id}`)}>');
  } else b.push('                <DataGridRow key={r.id}>');
  cols.forEach(function (c, i) {
    var f = M.resolvePath(app, ent, c).field;
    var right = f.kind === 'int' || f.kind === 'double';
    var jsx = cellJsx(app, ent, 'r', c, imp, { link: i === 0, short: true });
    // single-line cells; free text and references truncate so 8 columns fit at 1280px without horizontal scroll
    var cls = i > 0 && f.kind === 'string' && !f.multiline ? 'max-w-48 truncate' : i > 0 && f.kind === 'ref' ? 'max-w-32 truncate' : 'whitespace-nowrap';
    if (right) cls += ' tabular-nums';
    var myFlags = flags.filter(function (fl) { return fl.column === c; });
    if (myFlags.length) {
      var parts = [jsx.charAt(0) === '{' ? jsx : jsx];
      myFlags.forEach(function (fl) {
        var idx = flags.indexOf(fl);
        // dot + label on wide screens, dot only (label in the tooltip) below 1536px so the row still fits
        parts.push('{isFlag' + idx + '(r) && (\n<span title=' + JSON.stringify(fl.label) + ' className="ml-2 inline-flex items-center gap-1 text-xs text-[var(--c3-style-basic-fg-danger)]">\n<span aria-hidden className="size-1.5 rounded-full bg-[var(--c3-style-basic-fg-danger)]" />\n<span className="sr-only 2xl:not-sr-only">' + jsxText(fl.label) + '</span>\n</span>\n)}');
      });
      jsx = parts.join('\n');
    }
    // the first-column link stops the row click from firing twice
    b.push('                  <DataGridCell className="' + cls + '"' + (right ? ' align="right"' : '') + '>' + jsx + '</DataGridCell>');
  });
  b.push('                </DataGridRow>');
  b.push('              ))}');
  b.push('            </DataGridBody>');
  b.push('          </DataGrid>');
  b.push('        </div>');
  b.push('      </Container>');
  b.push('    </PageFrame>');
  b.push('  );');
  b.push('};', '');
  b.push('export default ' + C + 'List;');
  return hdr(app) + imp.render() + '\n' + b.join('\n') + '\n';
}

// ---------- detail page ----------

function detailInclude(app, ent) {
  var inc = ['this'];
  ent.fields.forEach(function (f) {
    if (f.kind !== 'ref') return;
    var t = app.byName[f.ref];
    inc.push(f.name + '.id', f.name + '.' + t.label);
    t.fields.forEach(function (tf) { if (tf.kind !== 'ref' && !tf.multiline) inc.push(f.name + '.' + tf.name); });
  });
  return uniq(inc).join(', ');
}

function detailPage(app, ent) {
  var imp = Imports();
  imp.def('react', 'React');
  ['useEffect', 'useState'].forEach(function (n) { imp.add('react', n); });
  imp.add('react-router-dom', 'useNavigate');
  imp.add('react-router-dom', 'useParams');
  imp.add('@/c3Action', 'c3Call');
  imp.def('@/components/DetailList/DetailList', 'DetailList');
  imp.add('@/components/ErrorBoundary/ErrorBoundary', 'useErrorBoundary');
  imp.def('@/components/PageFrame/PageFrame', 'PageFrame');
  ['ErrorState', 'LoadingState', 'errorMessage'].forEach(function (n) { imp.add('@/components/PageFrame/PageFrame', n); });
  imp.add('@/components/ui/button', 'Button');
  imp.add('@/components/ui/container', 'Container');
  imp.add('@/Interfaces', 'type ' + ent.name);
  ['Modal', 'ModalBody', 'ModalContent', 'ModalFooter', 'ModalHeader', 'ModalSubtitle', 'ModalTitle'].forEach(function (n) { imp.add('@/components/ui/modal', n); });
  imp.add('lucide-react', 'Trash2');
  var C = ent.name;
  var v = 'rec';
  var actions = ent.detail.actions || [];
  var related = ent.inverses.filter(function (i) { return hasPage(app.byName[i.child], 'list'); });
  var canEdit = hasPage(ent, 'form');
  if (canEdit) imp.add('lucide-react', 'Pencil');
  if (actions.length) imp.add('react', 'useCallback');
  if (related.length) {
    ['Tabs', 'TabsList', 'TabsTrigger'].forEach(function (n) { imp.add('@/components/ui/tabs', n); });
    imp.add('@/Interfaces', 'type FetchResult');
    imp.add('@/lib/format', 'filterLiteral');
    ['DataGrid', 'DataGridBody', 'DataGridCell', 'DataGridHead', 'DataGridHeader', 'DataGridRow'].forEach(function (n) { imp.add('@/components/ui/data-grid', n); });
    imp.add('@/components/PageFrame/PageFrame', 'EmptyRows');
    related.forEach(function (r) { imp.add('@/Interfaces', 'type ' + r.child); });
  }
  var listHref = hasPage(ent, 'list') ? "'#/" + ent.route + "'" : null;
  var crumbsBase = (app.dashboard ? "{ label: 'Dashboard', href: '#/' }, " : '') + '{ label: ' + q(ent.display) + (listHref ? ', href: ' + listHref : '') + ' }';

  var b = [];
  b.push('const DETAIL_INCLUDE =\n  ' + q(detailInclude(app, ent)) + ';', '');
  related.forEach(function (r, i) {
    var child = app.byName[r.child];
    var cols = listColumns(app, child).filter(function (c) { return c !== r.field && c.split('.')[0] !== r.field; }).slice(0, 6);
    r.cols = cols;
    b.push('const RELATED_' + i + '_INCLUDE = ' + q(includeFor(app, child, cols)) + ';');
  });
  if (related.length) {
    b.push('', "type TabKey = 'overview'" + related.map(function (r) { return ' | ' + q(r.name); }).join('') + ';');
  }
  b.push('');
  b.push('const ' + C + 'Detail: React.FC = () => {');
  b.push('  const { id } = useParams<{ id: string }>();');
  b.push('  const navigate = useNavigate();');
  b.push('  const { reportError } = useErrorBoundary();');
  if (app.access) {
    imp.add('@/hooks/useAccess', 'useAccess');
    b.push('  const { can } = useAccess();');
    b.push("  const canEdit = can('" + C + "', 'merge');");
    b.push("  const canDelete = can('" + C + "', 'remove');");
  }
  b.push('  const [' + v + ', setRec] = useState<' + C + ' | null>(null);');
  b.push('  const [loading, setLoading] = useState(true);');
  b.push('  const [error, setError] = useState<string | null>(null);');
  if (actions.length) b.push('  const [reloadKey, setReloadKey] = useState(0);');
  b.push('  const [saving, setSaving] = useState(false);');
  b.push('  const [confirmDelete, setConfirmDelete] = useState(false);');
  if (related.length) {
    b.push("  const [tab, setTab] = useState<TabKey>('overview');");
    related.forEach(function (r, i) { b.push('  const [related' + i + ', setRelated' + i + '] = useState<' + r.child + '[] | null>(null);'); });
  }
  b.push('');
  b.push('  useEffect(() => {');
  b.push('    let cancelled = false;');
  b.push('    setLoading(true);');
  b.push('    setError(null);');
  related.forEach(function (r, i) { b.push('    setRelated' + i + '(null);'); });
  b.push("    (c3Call('" + C + "', 'get', { id }, [DETAIL_INCLUDE]) as Promise<" + C + ' | null>)');
  b.push('      .then((res) => {');
  b.push('        if (!cancelled) setRec(res);');
  b.push('      })');
  b.push('      .catch((err: unknown) => {');
  b.push('        if (cancelled) return;');
  b.push('        setError(errorMessage(err));');
  b.push('        reportError(err);');
  b.push('      })');
  b.push('      .finally(() => {');
  b.push('        if (!cancelled) setLoading(false);');
  b.push('      });');
  b.push('    return () => {');
  b.push('      cancelled = true;');
  b.push('    };');
  b.push('  }, [id, ' + (actions.length ? 'reloadKey, ' : '') + 'reportError]);', '');
  related.forEach(function (r, i) {
    var child = app.byName[r.child];
    var srt = defaultSort(app, child);
    b.push('  useEffect(() => {');
    b.push('    if (tab !== ' + q(r.name) + ' || !id || related' + i + ') return undefined;');
    b.push('    let cancelled = false;');
    b.push('    (');
    b.push("      c3Call('" + r.child + "', 'fetch', null, [");
    b.push('        {');
    b.push('          filter: `' + r.field + '.id == ${filterLiteral(id)}`,');
    b.push('          include: RELATED_' + i + '_INCLUDE,');
    b.push("          order: '" + (srt.dir === 'asc' ? 'ascending' : 'descending') + '(' + srt.field + ")',");
    b.push('          limit: 25,');
    b.push('          offset: 0,');
    b.push('        },');
    b.push('      ]) as Promise<FetchResult<' + r.child + '>>');
    b.push('    )');
    b.push('      .then((res) => {');
    b.push('        if (!cancelled) setRelated' + i + '(res.objs ?? []);');
    b.push('      })');
    b.push('      .catch((err: unknown) => {');
    b.push('        if (!cancelled) reportError(err);');
    b.push('      });');
    b.push('    return () => {');
    b.push('      cancelled = true;');
    b.push('    };');
    b.push('  }, [tab, id, related' + i + ', reportError]);', '');
  });
  if (actions.length) {
    b.push('  const applyChange = useCallback(');
    b.push('    async (patch: Partial<' + C + '>) => {');
    b.push('      if (!' + v + ') return;');
    b.push('      setSaving(true);');
    b.push('      try {');
    b.push("        await c3Call('" + C + "', 'merge', { id: " + v + '.id, ...patch });');
    b.push('        setReloadKey((k) => k + 1);');
    b.push('      } catch (err) {');
    b.push('        setError(errorMessage(err));');
    b.push('        reportError(err);');
    b.push('      } finally {');
    b.push('        setSaving(false);');
    b.push('      }');
    b.push('    },');
    b.push('    [' + v + ', reportError],');
    b.push('  );', '');
  }
  b.push('  const onDelete = async () => {');
  b.push('    if (!' + v + ') return;');
  b.push('    setSaving(true);');
  b.push('    try {');
  b.push("      await c3Call('" + C + "', 'remove', { id: " + v + '.id });');
  b.push('      setConfirmDelete(false);');
  b.push('      navigate(' + (hasPage(ent, 'list') ? q('/' + ent.route) : "'/'") + ');');
  b.push('    } catch (err) {');
  b.push('      setError(errorMessage(err));');
  b.push('      reportError(err);');
  b.push('    } finally {');
  b.push('      setSaving(false);');
  b.push('    }');
  b.push('  };', '');
  b.push('  if (loading && !' + v + ') {');
  b.push('    return (');
  b.push('      <PageFrame title=' + JSON.stringify(ent.singular) + " breadcrumbs={[" + crumbsBase + ", { label: '…' }]}>");
  b.push('        <LoadingState label=' + JSON.stringify('Loading ' + ent.singular.toLowerCase() + '…') + ' />');
  b.push('      </PageFrame>');
  b.push('    );');
  b.push('  }', '');
  b.push('  if (!' + v + ') {');
  b.push('    return (');
  b.push('      <PageFrame title=' + JSON.stringify(ent.singular) + " breadcrumbs={[" + crumbsBase + ", { label: 'Not found' }]}>");
  b.push('        <ErrorState message={error ? `Could not load ' + ent.singular.toLowerCase() + ': ${error}` : `' + ent.singular + ' "${id}" was not found.`} />');
  b.push('      </PageFrame>');
  b.push('    );');
  b.push('  }', '');
  var titleExpr = ent.subtitle ? '`${' + v + '.' + ent.label + '} · ${' + v + '.' + ent.subtitle + " ?? ''}`" : v + '.' + ent.label;
  b.push('  const actions = (');
  b.push('    <div className="flex flex-wrap gap-2">');
  actions.forEach(function (a) {
    if (a.icon) imp.add('lucide-react', a.icon);
    var cond = Object.keys(a.when || {}).map(function (p) {
      return '[' + [].concat(a.when[p]).map(q).join(', ') + '].includes(' + accessor(v, p) + " ?? '')";
    }).join(' && ');
    var patch = Object.keys(a.set || {}).map(function (k) {
      var val = a.set[k];
      if (val === '$now') return k + ': new Date().toISOString()';
      return k + ': ' + JSON.stringify(val);
    }).join(', ');
    if (app.access) cond = cond ? 'canEdit && ' + cond : 'canEdit';
    b.push('      ' + (cond ? '{' + cond + ' && (' : '{('));
    b.push('        <Button');
    b.push('          variant="outline"');
    b.push('          appearance=' + JSON.stringify(a.appearance || 'secondary'));
    if (a.icon) b.push('          leadingIcon={<' + a.icon + ' />}');
    b.push('          loading={saving}');
    b.push('          onClick={() => applyChange({ ' + patch + ' })}');
    b.push('        >');
    b.push('          ' + jsxText(a.label));
    b.push('        </Button>');
    b.push('      )}');
  });
  if (app.access) b.push('      {canDelete && (');
  b.push('      <Button variant="ghost" appearance="danger" leadingIcon={<Trash2 />} onClick={() => setConfirmDelete(true)}>');
  b.push('        Delete');
  b.push('      </Button>');
  if (app.access) b.push('      )}');
  if (canEdit) {
    if (app.access) b.push('      {canEdit && (');
    b.push('      <Button leadingIcon={<Pencil />} onClick={() => navigate(`/' + ent.route + '/${' + v + '.id}/edit`)}>');
    b.push('        Edit');
    b.push('      </Button>');
    if (app.access) b.push('      )}');
  }
  b.push('    </div>');
  b.push('  );', '');
  var badgeFields = ent.fields.filter(function (f) { return f.kind === 'enum' && f.badge; });
  b.push('  return (');
  b.push('    <PageFrame');
  b.push('      title={' + titleExpr + '}');
  b.push('      breadcrumbs={[' + crumbsBase + ', { label: ' + v + '.' + ent.label + ' }]}');
  if (badgeFields.length) {
    b.push('      badges={');
    b.push('        <div className="flex items-center gap-1">');
    badgeFields.forEach(function (f) { b.push('          ' + cellJsx(app, ent, v, f.name, imp)); });
    b.push('        </div>');
    b.push('      }');
  }
  b.push('      actions={actions}');
  if (related.length) {
    b.push('      tabs={');
    b.push('        <Tabs variant="bordered" size="lg" value={tab} onValueChange={(t) => setTab(t as TabKey)}>');
    b.push('          <TabsList>');
    b.push('            <TabsTrigger value="overview">Overview</TabsTrigger>');
    related.forEach(function (r) { b.push('            <TabsTrigger value="' + r.name + '">' + jsxText(r.label) + '</TabsTrigger>'); });
    b.push('          </TabsList>');
    b.push('        </Tabs>');
    b.push('      }');
  }
  b.push('    >');
  b.push('      {error && <ErrorState message={error} />}', '');
  var overviewOpen = related.length ? "      {tab === 'overview' && (" : '      {(';
  b.push(overviewOpen);
  var refFields = ent.fields.filter(function (f) { return f.kind === 'ref'; });
  var multi = ent.fields.filter(function (f) { return f.multiline; });
  var scalars = ent.allFields.filter(function (f) { return f.kind !== 'ref' && !f.multiline; });
  b.push('        <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">');
  b.push('          <div className="flex flex-col gap-4 ' + (refFields.length ? 'xl:col-span-2' : 'xl:col-span-3') + '">');
  b.push('            <Container title="Details">');
  b.push('              <DetailList');
  b.push('                columns={' + (refFields.length ? 2 : 3) + '}');
  b.push('                items={[');
  scalars.forEach(function (f) {
    var jsx = cellJsx(app, ent, v, f.name, imp, { detail: true });
    var val = jsx.charAt(0) === '{' ? jsx.slice(1, -1) : jsx;
    b.push('                  { label: ' + q(f.label) + ', value: ' + val + ' },');
  });
  b.push('                ]}');
  b.push('              />');
  b.push('            </Container>');
  multi.forEach(function (f) {
    b.push('            <Container title=' + JSON.stringify(f.label) + '>');
    b.push('              <p className="whitespace-pre-wrap text-c3-regular-body-p2 text-[var(--c3-style-basic-fg-primary)]">');
    b.push('                {' + v + '.' + f.name + " || 'Not provided.'}");
    b.push('              </p>');
    b.push('            </Container>');
  });
  b.push('          </div>');
  if (refFields.length) {
    b.push('          <div className="flex flex-col gap-4">');
    refFields.forEach(function (f) {
      var t = app.byName[f.ref];
      var tAcc = v + '.' + f.name;
      var tFields = t.allFields.filter(function (tf) { return tf.kind !== 'ref' && !tf.multiline; }).slice(0, 6);
      b.push('            <Container');
      b.push('              title=' + JSON.stringify(f.label));
      if (hasPage(t, 'detail')) {
        b.push('              actions={');
        b.push('                ' + tAcc + ' ? (');
        b.push('                  <Button variant="ghost" appearance="accent" size="sm" onClick={() => navigate(`/' + t.route + '/${' + tAcc + '?.id}`)}>');
        b.push('                    Open');
        b.push('                  </Button>');
        b.push('                ) : undefined');
        b.push('              }');
      }
      b.push('            >');
      b.push('              {' + tAcc + ' ? (');
      b.push('                <DetailList');
      b.push('                  columns={1}');
      b.push('                  items={[');
      tFields.forEach(function (tf) {
        var jsx = cellJsx(app, t, tAcc, tf.name, imp, { detail: true });
        var val = jsx.charAt(0) === '{' ? jsx.slice(1, -1) : jsx;
        b.push('                    { label: ' + q(tf.label) + ', value: ' + val + ' },');
      });
      b.push('                  ]}');
      b.push('                />');
      b.push('              ) : (');
      b.push('                <p className="text-c3-regular-body-p2 text-[var(--c3-style-basic-fg-secondary)]">');
      b.push('                  No ' + jsxText(f.label.toLowerCase()) + ' linked.' + (canEdit ? ' Use Edit to set one.' : ''));
      b.push('                </p>');
      b.push('              )}');
      b.push('            </Container>');
    });
    b.push('          </div>');
  }
  b.push('        </div>');
  b.push('      )}');
  related.forEach(function (r, i) {
    var child = app.byName[r.child];
    b.push('', "      {tab === '" + r.name + "' && (");
    b.push('        <Container');
    b.push('          contentWidth="full-width"');
    b.push('          title=' + JSON.stringify(r.label));
    b.push('          actions={');
    b.push('            <Button');
    b.push('              variant="ghost"');
    b.push('              appearance="accent"');
    b.push('              size="sm"');
    b.push('              onClick={() => navigate(`/' + child.route + '?' + r.field + '=${encodeURIComponent(' + v + '.id)}`)}');
    b.push('            >');
    b.push('              Open in list');
    b.push('            </Button>');
    b.push('          }');
    b.push('        >');
    b.push('          {related' + i + ' == null ? (');
    b.push('            <LoadingState />');
    b.push('          ) : (');
    b.push('            <div className="overflow-x-auto">');
    b.push('              <DataGrid className="w-full">');
    b.push('                <DataGridHeader>');
    b.push('                  <DataGridRow>');
    r.cols.forEach(function (c) {
      var f = M.resolvePath(app, child, c).field;
      b.push('                    <DataGridHead sortable={false} filterable={false}>' + jsxText(c.indexOf('.') >= 0 ? M.titleCase(c.split('.').pop()) : f.label) + '</DataGridHead>');
    });
    b.push('                  </DataGridRow>');
    b.push('                </DataGridHeader>');
    b.push('                <DataGridBody>');
    b.push('                  {related' + i + '.length === 0 && <EmptyRows colSpan={' + r.cols.length + '} label="No ' + jsxText(r.label.toLowerCase()) + ' yet." />}');
    b.push('                  {related' + i + '.map((c) => (');
    b.push('                    <DataGridRow key={c.id}>');
    r.cols.forEach(function (c, j) {
      b.push('                      <DataGridCell className="whitespace-nowrap">' + cellJsx(app, child, 'c', c, imp, { link: j === 0 }) + '</DataGridCell>');
    });
    b.push('                    </DataGridRow>');
    b.push('                  ))}');
    b.push('                </DataGridBody>');
    b.push('              </DataGrid>');
    b.push('            </div>');
    b.push('          )}');
    b.push('        </Container>');
    b.push('      )}');
  });
  b.push('');
  b.push('      <Modal open={confirmDelete} onOpenChange={(next) => !saving && setConfirmDelete(next)}>');
  b.push('        <ModalContent width={460} aria-describedby="delete-subtitle">');
  b.push('          <ModalHeader>');
  b.push('            <ModalTitle>Delete ' + jsxText(ent.singular) + '</ModalTitle>');
  b.push('            <ModalSubtitle id="delete-subtitle">This cannot be undone.</ModalSubtitle>');
  b.push('          </ModalHeader>');
  b.push('          <ModalBody>');
  b.push('            <p className="py-2 text-c3-regular-body-p2 text-[var(--c3-style-basic-fg-primary)]">');
  b.push('              Delete <span className="text-c3-bold-body-p2">{' + v + '.' + ent.label + '}</span>?');
  b.push('            </p>');
  b.push('          </ModalBody>');
  b.push('          <ModalFooter>');
  b.push('            <div className="flex items-center gap-2">');
  b.push('              <Button type="button" variant="ghost" appearance="secondary" disabled={saving} onClick={() => setConfirmDelete(false)}>');
  b.push('                Cancel');
  b.push('              </Button>');
  b.push('              <Button type="button" variant="solid" appearance="danger" loading={saving} onClick={onDelete}>');
  b.push('                Delete');
  b.push('              </Button>');
  b.push('            </div>');
  b.push('          </ModalFooter>');
  b.push('        </ModalContent>');
  b.push('      </Modal>');
  b.push('    </PageFrame>');
  b.push('  );');
  b.push('};', '');
  b.push('export default ' + C + 'Detail;');
  return hdr(app) + imp.render() + '\n' + b.join('\n') + '\n';
}

// ---------- form page ----------

function formFields(ent) {
  var fs = ent.usesName ? [ent.labelField] : [];
  return fs.concat(ent.fields.filter(function (f) { return !f.auto && !f.hidden && !f.calc; }));
}

function formPage(app, ent) {
  var imp = Imports();
  imp.def('react', 'React');
  ['useEffect', 'useState', 'type ReactNode'].forEach(function (n) { imp.add('react', n); });
  imp.add('react-router-dom', 'useNavigate');
  imp.add('react-router-dom', 'useParams');
  imp.add('lucide-react', 'Save');
  imp.add('@/c3Action', 'c3Call');
  imp.add('@/components/ErrorBoundary/ErrorBoundary', 'useErrorBoundary');
  imp.def('@/components/PageFrame/PageFrame', 'PageFrame');
  ['ErrorState', 'LoadingState', 'errorMessage'].forEach(function (n) { imp.add('@/components/PageFrame/PageFrame', n); });
  imp.add('@/components/ui/button', 'Button');
  imp.add('@/components/ui/container', 'Container');
  imp.add('@/components/ui/label', 'Label');
  imp.add('@/Interfaces', 'type ' + ent.name);
  var C = ent.name;
  var fields = formFields(ent);
  var autos = ent.fields.filter(function (f) { return f.auto; });
  var refs = uniq(fields.filter(function (f) { return f.kind === 'ref'; }).map(function (f) { return f.ref; }));
  if (refs.length) imp.add('@/hooks/useLookups', 'useLookups');
  var defaults = ent.form.defaults || {};

  function stateType(f) {
    if (f.kind === 'string' || f.kind === 'int' || f.kind === 'double') return 'string';
    if (f.kind === 'boolean') return 'boolean';
    if (f.kind === 'datetime') return 'Date | undefined';
    if (f.kind === 'enum') { imp.add('@/Interfaces', 'type ' + f.enumDef.tsType); return f.enumDef.tsType + ' | null'; }
    return 'string | null';
  }
  function emptyVal(f) {
    if (f.kind === 'string' || f.kind === 'int' || f.kind === 'double') return defaults[f.name] !== undefined ? q(String(defaults[f.name])) : "''";
    if (f.kind === 'boolean') return defaults[f.name] ? 'true' : 'false';
    if (f.kind === 'datetime') return 'undefined';
    if (f.kind === 'enum') return defaults[f.name] !== undefined ? q(defaults[f.name]) : 'null';
    return 'null';
  }
  function fromRecord(f) {
    var a = 'r.' + f.name;
    if (f.kind === 'string') return a + " ?? ''";
    if (f.kind === 'int' || f.kind === 'double') return a + " != null ? String(" + a + ") : ''";
    if (f.kind === 'boolean') return 'Boolean(' + a + ')';
    if (f.kind === 'datetime') return 'toDate(' + a + ')';
    if (f.kind === 'enum') return a + ' ?? null';
    return a + '?.id ?? null';
  }
  function toPayload(f) {
    var a = 'form.' + f.name;
    if (f.kind === 'string') return a + '.trim() || null';
    if (f.kind === 'int' || f.kind === 'double') return 'toNumber(' + a + ')';
    if (f.kind === 'boolean') return a;
    if (f.kind === 'datetime') return 'withTime(' + a + ', original?.' + f.name + ')';
    if (f.kind === 'enum') return a;
    return a + ' ? { id: ' + a + ' } : null';
  }
  var hasDate = fields.some(function (f) { return f.kind === 'datetime'; });
  var hasNum = fields.some(function (f) { return f.kind === 'int' || f.kind === 'double'; });

  var b = [];
  b.push('interface FormState {');
  fields.forEach(function (f) { b.push('  ' + f.name + ': ' + stateType(f) + ';'); });
  b.push('}', '');
  b.push('type FormErrors = Partial<Record<keyof FormState, string>>;', '');
  b.push('const EMPTY: FormState = {');
  fields.forEach(function (f) { b.push('  ' + f.name + ': ' + emptyVal(f) + ','); });
  b.push('};', '');
  var formInc = ['this'];
  fields.forEach(function (f) { if (f.kind === 'ref') formInc.push(f.name + '.id', f.name + '.' + app.byName[f.ref].label); });
  b.push('const FORM_INCLUDE = ' + q(formInc.join(', ')) + ';', '');
  b.push('/** Fields written on edit. Listing them in the merge include also writes nulls, so cleared values are saved. */');
  b.push('const MERGE_INCLUDE = ' + q(fields.map(function (f) { return f.name; }).join(', ')) + ';', '');
  if (hasDate) {
    b.push('const toDate = (iso?: string): Date | undefined => (iso ? new Date(iso) : undefined);', '');
    b.push('/** Keeps the original time of day when only the calendar day changed; new dates default to 9:00 local. */');
    b.push('const withTime = (day: Date | undefined, original?: string): string | null => {');
    b.push('  if (!day) return null;');
    b.push('  const d = new Date(day);');
    b.push('  const src = original ? new Date(original) : null;');
    b.push('  d.setHours(src ? src.getHours() : 9, src ? src.getMinutes() : 0, 0, 0);');
    b.push('  return d.toISOString();');
    b.push('};', '');
    imp.add('@/components/ui/date-picker', 'DatePicker');
  }
  if (hasNum) {
    b.push("const toNumber = (v: string): number | null => (v.trim() === '' ? null : Number(v));", '');
    imp.add('@/components/ui/input-number', 'InputNumber');
  }
  b.push('function Field({');
  b.push('  id,');
  b.push('  label,');
  b.push('  required,');
  b.push('  error,');
  b.push('  hint,');
  b.push('  children,');
  b.push('  className,');
  b.push('}: {');
  b.push('  id: string;');
  b.push('  label: string;');
  b.push('  required?: boolean;');
  b.push('  error?: string;');
  b.push('  hint?: string;');
  b.push('  children: ReactNode;');
  b.push('  className?: string;');
  b.push('}) {');
  b.push('  return (');
  b.push("    <div className={`flex flex-col gap-1.5 ${className ?? ''}`}>");
  b.push('      <Label htmlFor={id}>');
  b.push('        {label}');
  b.push('        {required && <span className="text-[var(--c3-style-basic-fg-danger)]">*</span>}');
  b.push('      </Label>');
  b.push('      {children}');
  b.push('      {error ? (');
  b.push('        <span className="text-c3-regular-body-p3 text-[var(--c3-style-basic-fg-danger)]">{error}</span>');
  b.push('      ) : hint ? (');
  b.push('        <span className="text-c3-regular-body-p3 text-[var(--c3-style-basic-fg-secondary)]">{hint}</span>');
  b.push('      ) : null}');
  b.push('    </div>');
  b.push('  );');
  b.push('}', '');
  b.push('const ' + C + 'Form: React.FC = () => {');
  b.push('  const { id } = useParams<{ id: string }>();');
  b.push('  const isEdit = Boolean(id);');
  b.push('  const navigate = useNavigate();');
  b.push('  const { reportError } = useErrorBoundary();');
  if (refs.length) b.push('  const { ' + refs.map(function (n) { return app.byName[n].varPlural; }).join(', ') + ', loading: lookupsLoading } = useLookups();');
  if (app.access) {
    imp.add('@/hooks/useAccess', 'useAccess');
    b.push('  const { can, loading: accessLoading } = useAccess();');
    b.push("  const allowed = can('" + C + "', isEdit ? 'merge' : 'create');");
  }
  b.push('  const [form, setForm] = useState<FormState>(EMPTY);');
  b.push('  const [original, setOriginal] = useState<' + C + ' | null>(null);');
  b.push('  const [loading, setLoading] = useState(isEdit);');
  b.push('  const [loadError, setLoadError] = useState<string | null>(null);');
  b.push('  const [saveError, setSaveError] = useState<string | null>(null);');
  b.push('  const [errors, setErrors] = useState<FormErrors>({});');
  b.push('  const [saving, setSaving] = useState(false);', '');
  b.push('  useEffect(() => {');
  b.push('    if (!id) return undefined;');
  b.push('    let cancelled = false;');
  b.push("    (c3Call('" + C + "', 'get', { id }, [FORM_INCLUDE]) as Promise<" + C + ' | null>)');
  b.push('      .then((r) => {');
  b.push('        if (cancelled) return;');
  b.push('        if (!r) {');
  b.push('          setLoadError(`' + ent.singular + ' "${id}" was not found.`);');
  b.push('          return;');
  b.push('        }');
  b.push('        setOriginal(r);');
  b.push('        setForm({');
  fields.forEach(function (f) { b.push('          ' + f.name + ': ' + fromRecord(f) + ','); });
  b.push('        });');
  b.push('      })');
  b.push('      .catch((err: unknown) => {');
  b.push('        if (cancelled) return;');
  b.push('        setLoadError(errorMessage(err));');
  b.push('        reportError(err);');
  b.push('      })');
  b.push('      .finally(() => {');
  b.push('        if (!cancelled) setLoading(false);');
  b.push('      });');
  b.push('    return () => {');
  b.push('      cancelled = true;');
  b.push('    };');
  b.push('  }, [id, reportError]);', '');
  b.push('  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {');
  b.push('    setForm((prev) => ({ ...prev, [key]: value }));');
  b.push('    setErrors((prev) => ({ ...prev, [key]: undefined }));');
  b.push('  };', '');
  b.push('  const validate = (): FormErrors => {');
  b.push('    const e: FormErrors = {};');
  fields.forEach(function (f) {
    if (f.required) {
      var cond = f.kind === 'string' ? '!form.' + f.name + '.trim()' : (f.kind === 'int' || f.kind === 'double') ? "form." + f.name + ".trim() === ''" : f.kind === 'boolean' ? 'false' : '!form.' + f.name;
      if (cond !== 'false') b.push('    if (' + cond + ') e.' + f.name + ' = ' + q(f.label + ' is required.') + ';');
    }
    if (f.kind === 'int' || f.kind === 'double') {
      b.push('    if (form.' + f.name + ".trim() !== '' && Number.isNaN(Number(form." + f.name + '))) e.' + f.name + " = 'Enter a number.';");
    }
  });
  b.push('    return e;');
  b.push('  };', '');
  var seq = autos.filter(function (f) { return f.auto === 'seq'; })[0];
  if (seq) {
    imp.add('@/Interfaces', 'type FetchResult');
    var g = seq.gen || {};
    var fmt = g.format || '{n}';
    var pre = fmt.split('{n}')[0];
    var post = fmt.split('{n}')[1] || '';
    b.push('  /** Next ' + seq.label.toLowerCase() + ' after the highest existing one. */');
    b.push('  const nextNumber = async (): Promise<string> => {');
    b.push("    const res = (await c3Call('" + C + "', 'fetch', null, [");
    b.push("      { include: '" + seq.name + "', order: 'descending(" + seq.name + ")', limit: 1, offset: 0 },");
    b.push('    ])) as FetchResult<' + C + '>;');
    b.push('    const last = res.objs?.[0]?.' + seq.name + ';');
    b.push("    const n = last ? Number(String(last).replace(/\\D/g, '')) : " + ((g.start || 1) - 1) + ';');
    b.push('    return `' + pre + '${(Number.isFinite(n) ? n : ' + ((g.start || 1) - 1) + ') + 1}' + post + '`;');
    b.push('  };', '');
  }
  b.push('  const onSubmit = async (event: React.FormEvent) => {');
  b.push('    event.preventDefault();');
  b.push('    const e = validate();');
  b.push('    setErrors(e);');
  b.push('    if (Object.keys(e).length > 0) return;');
  b.push('    setSaving(true);');
  b.push('    setSaveError(null);');
  b.push('    try {');
  b.push('      const fields = {');
  fields.forEach(function (f) { b.push('        ' + f.name + ': ' + toPayload(f) + ','); });
  b.push('      };');
  b.push('      if (isEdit && original) {');
  b.push("        await c3Call('" + C + "', 'merge', { id: original.id, ...fields }, [MERGE_INCLUDE]);");
  b.push('        navigate(`/' + ent.route + '/${original.id}`);');
  b.push('      } else {');
  var autoParts = autos.map(function (f) {
    if (f.auto === 'seq') return f.name + ': await nextNumber()';
    if (f.auto === 'now') return f.name + ': new Date().toISOString()';
    return null;
  }).filter(Boolean);
  b.push("        const created = (await c3Call('" + C + "', 'create', { " + autoParts.concat(['...fields']).join(', ') + ' })) as ' + C + ' | null;');
  b.push('        navigate(created?.id ? `/' + ent.route + '/${created.id}` : ' + q('/' + (hasPage(ent, 'list') ? ent.route : '')) + ');');
  b.push('      }');
  b.push('    } catch (err) {');
  b.push('      setSaveError(errorMessage(err));');
  b.push('      reportError(err);');
  b.push('    } finally {');
  b.push('      setSaving(false);');
  b.push('    }');
  b.push('  };', '');
  var listCrumb = hasPage(ent, 'list') ? '{ label: ' + q(ent.display) + ", href: '#/" + ent.route + "' }" : '{ label: ' + q(ent.display) + ' }';
  b.push('  const title = isEdit ? `Edit ${original?.' + ent.label + ' ?? ' + q(ent.singular) + '}` : ' + q('New ' + ent.singular) + ';');
  b.push('  const breadcrumbs = [');
  b.push('    ' + listCrumb + ',');
  b.push('    ...(isEdit && original ? [{ label: String(original.' + ent.label + '), href: `#/' + ent.route + '/${original.id}` }] : []),');
  b.push("    { label: isEdit ? 'Edit' : 'New' },");
  b.push('  ];', '');
  if (app.access) {
    b.push('  // Route guard: the server enforces the role too; this only avoids showing a form that would fail on save.');
    b.push('  if (!accessLoading && !allowed) {');
    b.push('    return (');
    b.push('      <PageFrame title={title} breadcrumbs={breadcrumbs}>');
    b.push("        <ErrorState message={`Your role does not allow ${isEdit ? 'editing' : 'creating'} " + jsxText(ent.display.toLowerCase()) + ".`} />");
    b.push('      </PageFrame>');
    b.push('    );');
    b.push('  }', '');
  }
  b.push('  if (loading' + (refs.length ? ' || (isEdit && lookupsLoading)' : '') + (app.access ? ' || accessLoading' : '') + ') {');
  b.push('    return (');
  b.push('      <PageFrame title={title} breadcrumbs={breadcrumbs}>');
  b.push('        <LoadingState label=' + JSON.stringify('Loading ' + ent.singular.toLowerCase() + '…') + ' />');
  b.push('      </PageFrame>');
  b.push('    );');
  b.push('  }', '');
  b.push('  if (loadError) {');
  b.push('    return (');
  b.push('      <PageFrame title={title} breadcrumbs={breadcrumbs}>');
  b.push('        <ErrorState message={loadError} />');
  b.push('      </PageFrame>');
  b.push('    );');
  b.push('  }', '');
  b.push('  const cancelTarget = isEdit && original ? `/' + ent.route + '/${original.id}` : ' + q('/' + (hasPage(ent, 'list') ? ent.route : '')) + ';', '');
  b.push('  return (');
  b.push('    <PageFrame title={title} description={isEdit ? undefined : ' + JSON.stringify(ent.form.description || ('Create a new ' + ent.singular.toLowerCase())) + '} breadcrumbs={breadcrumbs}>');
  b.push('      <form onSubmit={onSubmit} noValidate className="flex max-w-6xl flex-col gap-4">');
  b.push('        {saveError && <ErrorState message={`Could not save: ${saveError}`} />}', '');

  var sections = ent.form.sections || [
    { title: 'Details', fields: fields.filter(function (f) { return f.kind !== 'ref'; }).map(function (f) { return f.name; }) },
    { title: 'Relationships', fields: fields.filter(function (f) { return f.kind === 'ref'; }).map(function (f) { return f.name; }) },
  ];
  var byName = {};
  fields.forEach(function (f) { byName[f.name] = f; });
  sections.forEach(function (s) {
    if (!s.fields.length) return;
    b.push('        <Container title=' + JSON.stringify(s.title) + '>');
    b.push('          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">');
    s.fields.forEach(function (name) {
      var f = byName[name];
      if (!f) throw new Error('spec: form section field ' + ent.name + '.' + name + ' is not an editable field');
      var fid = M.kebab(ent.name) + '-' + M.kebab(f.name);
      var wide = f.multiline || (f.kind === 'string' && f.name === ent.label) || f.name === ent.subtitle;
      var errAttr = f.required ? ' error={errors.' + f.name + '}' : (f.kind === 'int' || f.kind === 'double') ? ' error={errors.' + f.name + '}' : '';
      b.push('            <Field id="' + fid + '" label=' + JSON.stringify(f.label) + (f.required ? ' required' : '') + errAttr + (wide ? ' className="md:col-span-3"' : '') + '>');
      var appearance = f.required ? "\n                appearance={errors." + f.name + " ? 'danger' : 'default'}" : '';
      if (f.kind === 'string' && f.multiline) {
        imp.add('@/components/ui/textarea', 'Textarea');
        b.push('              <Textarea id="' + fid + '" rows={4} value={form.' + f.name + '} onChange={(e) => set(' + q(f.name) + ', e.target.value)} />');
      } else if (f.kind === 'string') {
        imp.add('@/components/ui/input', 'Input');
        b.push('              <Input');
        b.push('                id="' + fid + '"');
        b.push('                value={form.' + f.name + '}' + appearance);
        b.push('                onChange={(e) => set(' + q(f.name) + ', e.target.value)}');
        b.push('              />');
      } else if (f.kind === 'int' || f.kind === 'double') {
        b.push('              <InputNumber');
        b.push('                id="' + fid + '"');
        b.push('                step={' + (f.kind === 'int' ? 1 : 0.5) + '}' + (f.format === 'currency' ? '\n                incrementButtons={false}' : ''));
        b.push('                value={form.' + f.name + '}');
        b.push('                onChange={(e) => set(' + q(f.name) + ', e.target.value)}');
        b.push('              />');
      } else if (f.kind === 'boolean') {
        imp.add('@/components/ui/checkbox', 'Checkbox');
        b.push('              <Checkbox id="' + fid + '" label=' + JSON.stringify(f.label) + ' checked={form.' + f.name + '} onCheckedChange={(c) => set(' + q(f.name) + ', c === true)} />');
      } else if (f.kind === 'datetime') {
        b.push('              <DatePicker placeholder="Pick a date" value={form.' + f.name + '}' + appearance.replace('\n                ', ' ') + ' onChange={(d) => set(' + q(f.name) + ', d)} />');
      } else if (f.kind === 'enum') {
        imp.add('@/components/ui/combobox', 'Combobox');
        imp.add('@/Interfaces', f.enumDef.tsConst);
        b.push('              <Combobox');
        b.push('                id="' + fid + '"');
        b.push('                options={' + f.enumDef.tsConst + '.map((v) => ({ value: v, label: v }))}');
        b.push('                value={form.' + f.name + '}' + appearance);
        b.push('                onValueChange={(v) => set(' + q(f.name) + ', v as ' + f.enumDef.tsType + ' | null)}');
        b.push('              />');
      } else {
        var t = app.byName[f.ref];
        imp.add('@/components/ui/combobox', 'Combobox');
        b.push('              <Combobox');
        b.push('                id="' + fid + '"');
        b.push('                placeholder=' + JSON.stringify(f.required ? 'Select ' + f.label.toLowerCase() : 'None'));
        b.push('                options={' + lookupOptionsExpr(app, t, t.varPlural) + '}');
        b.push('                value={form.' + f.name + '}' + appearance);
        b.push('                onValueChange={(v) => set(' + q(f.name) + ', v)}');
        b.push('              />');
      }
      b.push('            </Field>');
    });
    b.push('          </div>');
    b.push('        </Container>', '');
  });
  b.push('        <div className="flex justify-end gap-2">');
  b.push('          <Button type="button" variant="outline" appearance="secondary" onClick={() => navigate(cancelTarget)}>');
  b.push('            Cancel');
  b.push('          </Button>');
  b.push('          <Button type="submit" leadingIcon={<Save />} loading={saving}>');
  b.push("            {isEdit ? 'Save Changes' : " + q('Create ' + ent.singular) + '}');
  b.push('          </Button>');
  b.push('        </div>');
  b.push('      </form>');
  b.push('    </PageFrame>');
  b.push('  );');
  b.push('};', '');
  b.push('export default ' + C + 'Form;');
  return hdr(app) + imp.render() + '\n' + b.join('\n') + '\n';
}

// ---------- dashboard ----------

/** List-page URL for a KPI's filter (its `link`, else `where` + `before`), or null. */
function kpiLink(listRoute, k) {
  if (!listRoute) return null;
  if (k.link || k.where || k.before) {
    var qs = [];
    var link = k.link || k.where || {};
    Object.keys(link).forEach(function (p) { qs.push(encodeURIComponent(p) + '=' + [].concat(link[p]).map(encodeURIComponent).join('|')); });
    if (k.before) qs.push('before=' + encodeURIComponent(k.before));
    return '/' + listRoute + (qs.length ? '?' + qs.join('&') : '');
  }
  if (k.agg === 'count') return '/' + listRoute;
  return null;
}

/** `"of {totalCount} total"` -> a TS template literal formatting the named KPIs; plain text -> a quoted string. */
function kpiTemplate(d, text) {
  if (!/\{\w+\}/.test(text || '')) return q(text || '');
  return '`' + String(text).replace(/`/g, '\\`').replace(/\{(\w+)\}/g, function (_, key) {
    var k = d.kpis.filter(function (x) { return x.key === key; })[0];
    if (!k) throw new Error('spec: caption references unknown KPI {' + key + '}');
    return '${formatKpi(summary.' + key + ', ' + q(k.format) + ')}';
  }) + '`';
}

/** Client-side filter string (a TS template literal) equivalent to a KPI's `where` + `before`. */
function kpiFilterTs(app, ent, k) {
  var clauses = Object.keys(k.where || {}).map(function (p) {
    M.resolvePath(app, ent, p);
    var vals = [].concat(k.where[p]);
    return vals.length === 1 ? p + " == '" + vals[0] + "'" : 'intersects(' + p + ', [' + vals.map(function (v) { return "'" + v + "'"; }).join(', ') + '])';
  });
  if (k.before) clauses.push(k.before + ' < ${todayLiteral()}');
  return '`' + clauses.join(' && ') + '`';
}

function dashboardPage(app) {
  var d = app.dashboard;
  var ent = d.entity;
  var plans = require('./backend').chartPlan(app, d);
  var imp = Imports();
  imp.def('react', 'React');
  ['useEffect', 'useMemo', 'useState'].forEach(function (n) { imp.add('react', n); });
  imp.add('react-router-dom', 'useNavigate');
  imp.add('lucide-react', 'RefreshCw');
  imp.add('@/c3Action', 'c3Call');
  if (plans.some(function (p) { return p.chart.kind !== 'bars'; })) imp.def('@/components/charts/EChart', 'EChart');
  if (plans.some(function (p) { return p.chart.kind === 'bars'; })) imp.def('@/components/charts/BarList', 'BarList');
  imp.add('@/components/ErrorBoundary/ErrorBoundary', 'useErrorBoundary');
  imp.def('@/components/PageFrame/PageFrame', 'PageFrame');
  ['ErrorState', 'LoadingState', 'errorMessage'].forEach(function (n) { imp.add('@/components/PageFrame/PageFrame', n); });
  imp.add('@/components/ui/button', 'Button');
  imp.add('@/components/ui/container', 'Container');
  ['MetricCard', 'MetricCardCaption', 'MetricCardHeader', 'MetricCardLabel', 'MetricCardValue'].forEach(function (n) { imp.add('@/components/ui/metric-card', n); });
  imp.add('@/Interfaces', 'type DashboardSummary');
  imp.add('@/lib/format', 'formatKpi');
  imp.add('@/lib/format', 'chartColor');
  var listRoute = hasPage(ent, 'list') ? ent.route : null;
  var canCreate = hasPage(ent, 'form');
  if (canCreate) imp.add('lucide-react', 'Plus');

  var b = [];
  b.push('interface Kpi {');
  b.push('  label: string;');
  b.push('  value: string;');
  b.push('  caption: string;');
  b.push("  tone?: 'danger' | 'warning' | 'success';");
  b.push('  to?: string;');
  b.push('}', '');
  b.push("const TONE_CLASS: Record<NonNullable<Kpi['tone']>, string> = {");
  b.push("  danger: 'text-[var(--c3-style-basic-fg-danger)]',");
  b.push("  warning: 'text-[var(--c3-style-basic-fg-warning)]',");
  b.push("  success: 'text-[var(--c3-style-basic-fg-success)]',");
  b.push('};', '');
  var recent = d.recent;
  var recentKpi = null;
  var recentCols = [];
  if (recent) {
    imp.add('@/Interfaces', 'type FetchResult');
    imp.add('@/Interfaces', 'type ' + ent.name);
    ['DataGrid', 'DataGridBody', 'DataGridCell', 'DataGridHead', 'DataGridHeader', 'DataGridRow'].forEach(function (n) { imp.add('@/components/ui/data-grid', n); });
    imp.add('@/components/PageFrame/PageFrame', 'EmptyRows');
    var rsort = recent.sort ? { field: recent.sort.field, dir: recent.sort.dir || 'desc' } : defaultSort(app, ent);
    if (recent.kpi) {
      recentKpi = d.kpis.filter(function (k) { return k.key === recent.kpi; })[0];
      if (!recentKpi) throw new Error('spec: dashboard.recent.kpi "' + recent.kpi + '" is not a KPI key');
      imp.add('@/lib/format', 'todayLiteral');
    }
    // columns: a path, or { "since": "<datetime field>", "label": "Days overdue" } (whole days since that date)
    recentCols = recent.columns.map(function (c) { return typeof c === 'string' ? { path: c } : c; });
    var incPaths = recentCols.map(function (c) { return c.path || c.since; });
    b.push('const RECENT_INCLUDE = ' + q(includeFor(app, ent, incPaths)) + ';', '');
  }
  b.push('const Dashboard: React.FC = () => {');
  if (app.access && canCreate) {
    imp.add('@/hooks/useAccess', 'useAccess');
    b.push('  const { can } = useAccess();');
  }
  b.push('  const navigate = useNavigate();');
  b.push('  const { reportError } = useErrorBoundary();');
  b.push('  const [summary, setSummary] = useState<DashboardSummary | null>(null);');
  if (recent) b.push('  const [recent, setRecent] = useState<' + ent.name + '[]>([]);');
  b.push('  const [error, setError] = useState<string | null>(null);');
  b.push('  const [reloadKey, setReloadKey] = useState(0);', '');
  b.push('  useEffect(() => {');
  b.push('    let cancelled = false;');
  b.push('    setError(null);');
  b.push('    Promise.all([');
  b.push("      c3Call('" + ent.name + "', 'dashboardSummary', null, []) as Promise<DashboardSummary>,");
  if (recent) {
    b.push("      c3Call('" + ent.name + "', 'fetch', null, [");
    b.push('        {');
    b.push('          include: RECENT_INCLUDE,');
    if (recentKpi) b.push('          filter: ' + kpiFilterTs(app, ent, recentKpi) + ',');
    b.push("          order: '" + (rsort.dir === 'asc' ? 'ascending' : 'descending') + '(' + rsort.field + ")',");
    b.push('          limit: ' + (recent.limit || 8) + ',');
    b.push('          offset: 0,');
    b.push('        },');
    b.push('      ]) as Promise<FetchResult<' + ent.name + '>>,');
  }
  b.push('    ])');
  b.push('      .then(([s' + (recent ? ', r' : '') + ']) => {');
  b.push('        if (cancelled) return;');
  b.push('        setSummary(s);');
  if (recent) b.push('        setRecent(r.objs ?? []);');
  b.push('      })');
  b.push('      .catch((err: unknown) => {');
  b.push('        if (cancelled) return;');
  b.push('        setError(errorMessage(err));');
  b.push('        reportError(err);');
  b.push('      });');
  b.push('    return () => {');
  b.push('      cancelled = true;');
  b.push('    };');
  b.push('  }, [reloadKey, reportError]);', '');
  b.push('  const kpis: Kpi[] = useMemo(() => {');
  b.push('    if (!summary) return [];');
  b.push('    return [');
  d.kpis.filter(function (k) { return k.tile !== false; }).forEach(function (k) {
    var parts = ['label: ' + q(k.label), 'value: formatKpi(summary.' + k.key + ', ' + q(k.format) + ')', 'caption: ' + kpiTemplate(d, k.caption)];
    if (k.alert) parts.push('tone: summary.' + k.key + ' > 0 ? ' + q(k.alert) + ' : undefined');
    if (k.goodAbove !== undefined) parts.push('tone: summary.' + k.key + ' >= ' + k.goodAbove + " ? 'success' : 'warning'");
    var to = kpiLink(listRoute, k);
    if (to) parts.push('to: ' + q(to));
    b.push('      {');
    parts.forEach(function (x) { b.push('        ' + x + ','); });
    b.push('      },');
  });
  b.push('    ];');
  b.push('  }, [summary]);', '');

  plans.forEach(function (p) {
    var c = p.chart;
    var name = c.key + 'Option';
    var data = 'summary?.' + c.key + ' ?? []';
    if (p.type === 'month') {
      imp.add('@/lib/format', 'formatMonth');
      b.push('  const ' + name + ' = useMemo(() => {');
      b.push('    const months = ' + data + ';');
      b.push('    return {');
      b.push("      tooltip: { trigger: 'axis' },");
      b.push('      legend: { top: 0 },');
      b.push('      grid: { left: 48, right: 24, top: 40, bottom: 32 },');
      b.push("      xAxis: { type: 'category', data: months.map((m) => formatMonth(m.month)) },");
      b.push("      yAxis: { type: 'value' },");
      b.push('      series: [');
      p.series.forEach(function (s, i) {
        b.push('        {');
        b.push('          name: ' + q(s.label) + ',');
        b.push("          type: 'bar',");
        b.push('          barMaxWidth: 20,');
        b.push('          itemStyle: { color: chartColor(' + q(s.appearance || (i === 0 ? 'accent' : 'success')) + ') },');
        b.push('          data: months.map((m) => m.counts[' + i + '] ?? 0),');
        b.push('        },');
      });
      b.push('      ],');
      b.push('    };');
      b.push('  }, [summary]);', '');
      return;
    }
    var metric = c.metric === 'value' ? 'value' : 'count';
    if (c.kind === 'bars') return; // rendered with <BarList>, no eCharts option
    var colorExpr;
    if (p.type === 'enum') {
      imp.add('@/lib/format', p.field.enumDef.tsAppearance);
      imp.add('@/Interfaces', 'type ' + p.field.enumDef.tsType);
      colorExpr = 'chartColor(' + p.field.enumDef.tsAppearance + '[b.label as ' + p.field.enumDef.tsType + "] ?? 'secondary')";
    } else colorExpr = "chartColor('accent')";
    var tooltipFmt = c.measure ? (c.measure.format === 'currency' ? 'formatCurrency' : 'formatNumber') : null;
    if (tooltipFmt) imp.add('@/lib/format', tooltipFmt);
    b.push('  const ' + name + ' = useMemo(() => {');
    b.push('    const rows = ' + (c.kind === 'donut' ? '(' + data + ').filter((b) => b.' + metric + ' > 0)' : data) + ';');
    if (c.kind === 'donut') {
      b.push('    return {');
      b.push("      tooltip: { trigger: 'item' },");
      b.push("      legend: { orient: 'vertical', right: 0, top: 'middle' },");
      b.push('      series: [');
      b.push('        {');
      b.push('          name: ' + q(c.title || c.key) + ',');
      b.push("          type: 'pie',");
      b.push("          radius: ['52%', '76%'],");
      b.push("          center: ['36%', '50%'],");
      b.push('          label: { show: false },');
      b.push('          data: rows.map((b) => ({ name: b.label, value: b.' + metric + ', itemStyle: { color: ' + colorExpr + ' } })),');
      b.push('        },');
      b.push('      ],');
      b.push('    };');
    } else {
      var horiz = c.kind === 'hbar';
      b.push('    return {');
      if (tooltipFmt) {
        b.push('      tooltip: {');
        b.push("        trigger: 'axis',");
        b.push('        formatter: (items: { dataIndex: number }[]) => {');
        b.push('          const row = rows[items[0]?.dataIndex ?? 0];');
        b.push("          return row ? `${row.label}<br/>Count: ${row.count}<br/>" + (c.measure.label || 'Value') + ': ${' + tooltipFmt + "(row.value)}` : '';");
        b.push('        },');
        b.push('      },');
      } else b.push("      tooltip: { trigger: 'axis' },");
      b.push('      grid: { left: ' + (horiz ? 120 : 48) + ', right: 24, top: 16, bottom: 32 },');
      if (horiz) {
        b.push("      xAxis: { type: 'value' },");
        b.push("      yAxis: { type: 'category', data: rows.map((b) => b.label), inverse: true },");
      } else {
        b.push("      xAxis: { type: 'category', data: rows.map((b) => b.label) },");
        b.push("      yAxis: { type: 'value' },");
      }
      b.push('      series: [');
      b.push('        {');
      b.push('          name: ' + q(metric === 'value' && c.measure ? (c.measure.label || 'Value') : 'Count') + ',');
      b.push("          type: 'bar',");
      b.push('          barMaxWidth: ' + (horiz ? 18 : 28) + ',');
      b.push('          data: rows.map((b) => ({ value: b.' + metric + ', itemStyle: { color: ' + colorExpr + ' } })),');
      b.push('        },');
      b.push('      ],');
      b.push('    };');
    }
    b.push('  }, [summary]);', '');
  });

  b.push('  const actions = (');
  b.push('    <div className="flex gap-2">');
  b.push('      <Button variant="outline" appearance="secondary" leadingIcon={<RefreshCw />} onClick={() => setReloadKey((k) => k + 1)}>');
  b.push('        Refresh');
  b.push('      </Button>');
  if (canCreate) {
    if (app.access) b.push("      {can('" + ent.name + "', 'create') && (");
    b.push("      <Button leadingIcon={<Plus />} onClick={() => navigate('/" + ent.route + "/new')}>");
    b.push('        New ' + jsxText(ent.singular));
    b.push('      </Button>');
    if (app.access) b.push('      )}');
  }
  b.push('    </div>');
  b.push('  );', '');
  b.push('  return (');
  b.push('    <PageFrame title=' + JSON.stringify(d.title) + ' description=' + JSON.stringify(d.description) + ' actions={actions}>');
  b.push('      {error && <ErrorState message={`Could not load dashboard: ${error}`} onRetry={() => setReloadKey((k) => k + 1)} />}');
  b.push('      {!summary && !error && <LoadingState label="Loading dashboard…" />}');
  b.push('      {summary && (');
  b.push('        <>');
  b.push('          <div className="grid grid-cols-2 gap-3 md:gap-4 xl:grid-cols-4">');
  b.push('            {kpis.map((k) => (');
  b.push('              <MetricCard');
  b.push('                key={k.label}');
  b.push('                interactive={Boolean(k.to)}');
  b.push('                onClick={k.to ? () => navigate(k.to as string) : undefined}');
  b.push('                onKeyDown={(e) => {');
  b.push("                  if (k.to && (e.key === 'Enter' || e.key === ' ')) navigate(k.to);");
  b.push('                }}');
  b.push('              >');
  b.push('                <MetricCardHeader>');
  b.push('                  <MetricCardLabel className="text-[13px]">{k.label}</MetricCardLabel>');
  b.push('                </MetricCardHeader>');
  b.push("                <MetricCardValue className={`text-[28px] leading-9 ${k.tone ? TONE_CLASS[k.tone] : ''}`}>{k.value}</MetricCardValue>");
  b.push('                <MetricCardCaption className="truncate text-xs" title={k.caption}>');
  b.push('                  {k.caption}');
  b.push('                </MetricCardCaption>');
  b.push('              </MetricCard>');
  b.push('            ))}');
  b.push('          </div>', '');
  // Cards in rows of a 6-column grid: span 1 = a third, "half" = a half, 2 = two thirds, 3 = full width.
  // The recent table joins the grid when it declares a span (lab4 layout: workload chart + overdue table side by side).
  var SPANS = { 1: 2, half: 3, 2: 4, 3: 6 };
  var cards = plans.slice();
  if (recent && recent.span) {
    var at = recent.after ? cards.findIndex(function (p) { return p.chart.key === recent.after; }) + 1 : cards.length;
    if (at === 0) throw new Error('spec: dashboard.recent.after "' + recent.after + '" is not a chart key');
    cards.splice(at, 0, { recent: true, chart: { span: recent.span } });
  }
  var row = [];
  var used = 0;
  var rowsOut = [];
  cards.forEach(function (p) {
    var span = SPANS[p.chart.span || 1];
    if (!span) throw new Error('spec: chart span must be 1, 2, 3 or "half"');
    p.cols6 = span;
    if (used + span > 6) { rowsOut.push(row); row = []; used = 0; }
    row.push(p);
    used += span;
  });
  if (row.length) rowsOut.push(row);
  var recentTitle = recent ? kpiTemplate(d, recent.title || ('Recent ' + ent.display)) : null;
  function recentCard(indent, className) {
    var I = indent;
    b.push(I + '<Container');
    if (className) b.push(I + '  className="' + className + '"');
    b.push(I + '  contentWidth="full-width"');
    b.push(I + '  title={' + recentTitle + '}');
    if (recent.subtitle) b.push(I + '  subtitle={' + kpiTemplate(d, recent.subtitle) + '}');
    if (listRoute) {
      var to = recentKpi ? kpiLink(listRoute, recentKpi) : '/' + listRoute;
      b.push(I + '  actions={');
      b.push(I + '    <Button variant="ghost" appearance="accent" size="sm" onClick={() => navigate(' + q(to) + ')}>');
      b.push(I + '      View all');
      b.push(I + '    </Button>');
      b.push(I + '  }');
    }
    b.push(I + '>');
    b.push(I + '  <div className="overflow-x-auto">');
    b.push(I + '    <DataGrid className="w-full">');
    b.push(I + '      <DataGridHeader>');
    b.push(I + '        <DataGridRow>');
    recentCols.forEach(function (c) {
      if (c.since) {
        b.push(I + '          <DataGridHead sortable={false} filterable={false} align="right">' + jsxText(c.label || 'Days') + '</DataGridHead>');
        return;
      }
      var f = M.resolvePath(app, ent, c.path).field;
      var right = f.kind === 'int' || f.kind === 'double';
      b.push(I + '          <DataGridHead sortable={false} filterable={false}' + (right ? ' align="right"' : '') + '>' + jsxText(c.label || (c.path.indexOf('.') >= 0 ? M.titleCase(c.path.split('.').pop()) : f.label)) + '</DataGridHead>');
    });
    b.push(I + '        </DataGridRow>');
    b.push(I + '      </DataGridHeader>');
    b.push(I + '      <DataGridBody>');
    b.push(I + '        {recent.length === 0 && <EmptyRows colSpan={' + recentCols.length + '} label=' + JSON.stringify(recent.empty || ('No ' + ent.display.toLowerCase() + ' yet.')) + ' />}');
    b.push(I + '        {recent.map((r) => (');
    b.push(I + '          <DataGridRow key={r.id}>');
    recentCols.forEach(function (c, i) {
      if (c.since) {
        imp.add('@/lib/format', 'daysSince');
        b.push(I + '            <DataGridCell align="right" className="whitespace-nowrap tabular-nums">{daysSince(r.' + c.since + ')}</DataGridCell>');
        return;
      }
      var f = M.resolvePath(app, ent, c.path).field;
      var right = f.kind === 'int' || f.kind === 'double';
      var cls = i > 0 && (f.kind === 'string' || f.kind === 'ref') ? 'max-w-48 truncate' : 'whitespace-nowrap';
      b.push(I + '            <DataGridCell className="' + cls + '"' + (right ? ' align="right"' : '') + '>' + cellJsx(app, ent, 'r', c.path, imp, { link: i === 0, short: true }) + '</DataGridCell>');
    });
    b.push(I + '          </DataGridRow>');
    b.push(I + '        ))}');
    b.push(I + '      </DataGridBody>');
    b.push(I + '    </DataGrid>');
    b.push(I + '  </div>');
    b.push(I + '</Container>');
  }
  var COLSPAN = { 2: 'xl:col-span-2', 3: 'xl:col-span-3', 4: 'xl:col-span-4', 6: 'xl:col-span-6' };
  rowsOut.forEach(function (r) {
    b.push('          <div className="grid grid-cols-1 gap-4 xl:grid-cols-6">');
    r.forEach(function (p) {
      if (p.recent) {
        recentCard('            ', COLSPAN[p.cols6]);
        return;
      }
      var c = p.chart;
      b.push('            <Container className="' + COLSPAN[p.cols6] + '" title=' + JSON.stringify(c.title || c.key) + (c.subtitle ? ' subtitle={' + kpiTemplate(d, c.subtitle) + '}' : '') + '>');
      var clickTarget = null;
      if (listRoute && (p.type === 'enum' || p.type === 'ref') && c.link !== false) {
        clickTarget = p.type === 'enum' ? 'name' : 'key';
      }
      if (c.kind === 'bars') {
        var metric = c.metric === 'value' ? 'value' : 'count';
        var color = p.type === 'enum'
          ? 'chartColor(' + p.field.enumDef.tsAppearance + '[b.label as ' + p.field.enumDef.tsType + "] ?? 'secondary')"
          : "chartColor('accent')";
        if (p.type === 'enum') {
          imp.add('@/lib/format', p.field.enumDef.tsAppearance);
          imp.add('@/Interfaces', 'type ' + p.field.enumDef.tsType);
        }
        var fmt = c.measure && metric === 'value' && c.measure.format === 'currency' ? 'formatCurrency' : null;
        if (fmt) imp.add('@/lib/format', fmt);
        b.push('              <BarList');
        b.push('                items={(summary.' + c.key + ' ?? []).map((b) => ({ key: b.key, label: b.label, value: b.' + metric + ', color: ' + color + ' }))}');
        if (fmt) b.push('                format={' + fmt + '}');
        if (clickTarget) b.push('                onItemClick={(item) => navigate(`/' + listRoute + '?' + c.groupBy + '=${encodeURIComponent(item.' + (clickTarget === 'name' ? 'label' : 'key') + ')}`)}');
        b.push('              />');
      } else {
        var click = '';
        if (clickTarget === 'name') click = ' onItemClick={(name) => navigate(`/' + listRoute + '?' + c.groupBy + '=${encodeURIComponent(name)}`)}';
        else if (clickTarget) click = ' onItemClick={(name) => {\n                  const hit = (summary.' + c.key + ' ?? []).find((b) => b.label === name);\n                  if (hit?.key) navigate(`/' + listRoute + '?' + c.groupBy + '=${encodeURIComponent(hit.key)}`);\n                }}';
        b.push('              <EChart ariaLabel=' + JSON.stringify(c.title || c.key) + ' option={' + c.key + 'Option} className="' + (c.height || 'h-72') + '"' + click + ' />');
      }
      b.push('            </Container>');
    });
    b.push('          </div>', '');
  });
  if (recent && !recent.span) recentCard('          ', null);
  b.push('        </>');
  b.push('      )}');
  b.push('    </PageFrame>');
  b.push('  );');
  b.push('};', '');
  b.push('export default Dashboard;');
  return hdr(app) + imp.render() + '\n' + b.join('\n') + '\n';
}

// ---------- access (roles) ----------

function useAccessTs(app) {
  var A = app.access;
  var out = hdr(app);
  out += "import { useEffect, useState } from 'react';\n\nimport { c3Call } from '@/c3Action';\n\n";
  out += '/** What the signed-in user may do, from `' + A.type + '.mine()` (server-side `Authorizer` checks). */\n';
  out += 'export interface AccessSummary {\n  user?: string;\n  roles?: string[];\n  canCreate?: string[];\n  canEdit?: string[];\n  canDelete?: string[];\n}\n\n';
  out += "export type AccessAction = 'create' | 'merge' | 'remove';\n\n";
  out += '/** Display label per application role id. */\nexport const ROLE_LABELS: Record<string, string> = {\n';
  A.roles.forEach(function (r) { out += '  ' + r.id + ': ' + q(r.label) + ',\n'; });
  out += '};\n\n';
  out += '// One request per page load, shared by every component that asks.\nlet pending: Promise<AccessSummary> | null = null;\n\n';
  out += 'const loadAccess = (): Promise<AccessSummary> => {\n';
  out += "  pending ??= (c3Call('" + A.type + "', 'mine', null, []) as Promise<AccessSummary>).catch(() => ({}) as AccessSummary);\n";
  out += '  return pending;\n};\n\n';
  out += '/**\n * Role-based UI gating. Buttons for actions the role lacks are hidden and form routes show a message; the platform\n';
  out += ' * still enforces the role on every call (metadata/Role/*.json). Until the answer arrives nothing is allowed.\n */\n';
  out += 'export function useAccess(): { loading: boolean; access: AccessSummary; can: (type: string, action: AccessAction) => boolean } {\n';
  out += '  const [access, setAccess] = useState<AccessSummary | null>(null);\n\n';
  out += '  useEffect(() => {\n    let cancelled = false;\n    loadAccess().then((a) => {\n      if (!cancelled) setAccess(a);\n    });\n';
  out += '    return () => {\n      cancelled = true;\n    };\n  }, []);\n\n';
  out += '  const can = (type: string, action: AccessAction): boolean => {\n    if (!access) return false;\n';
  out += "    const list = action === 'create' ? access.canCreate : action === 'merge' ? access.canEdit : access.canDelete;\n";
  out += '    return (list ?? []).includes(type);\n  };\n\n';
  out += '  return { loading: access == null, access: access ?? {}, can };\n}\n';
  return out;
}

function accessBadgeTsx(app) {
  var out = hdr(app);
  out += "import React from 'react';\n\nimport { Badge } from '@/components/ui/badge';\nimport { ROLE_LABELS, useAccess } from '@/hooks/useAccess';\n\n";
  out += '/** The signed-in user\'s application role, shown in the top bar. */\n';
  out += 'export default function AccessBadge() {\n  const { loading, access } = useAccess();\n  if (loading) return null;\n';
  out += '  const roles = (access.roles ?? []).map((r) => ROLE_LABELS[r] ?? r);\n';
  out += "  const label = roles.length ? roles.join(', ') : (access.canCreate ?? []).length ? 'Admin' : 'No role';\n";
  out += '  return (\n    <Badge variant="soft" appearance={roles.length ? \'accent\' : \'secondary\'} size="sm" shape="rounded" title={access.user}>\n';
  out += '      {label}\n    </Badge>\n  );\n}\n';
  return out;
}

// ---------- map page (react-leaflet + OSM tiles, the approach C3 Code used in lab2 and lab4) ----------

function mapPage(app, ent) {
  var mp = ent.map;
  var imp = Imports();
  imp.def('react', 'React');
  ['useEffect', 'useMemo', 'useState'].forEach(function (n) { imp.add('react', n); });
  ['CircleMarker', 'MapContainer', 'Popup', 'TileLayer', 'useMap'].forEach(function (n) { imp.add('react-leaflet', n); });
  imp.add('leaflet', 'latLngBounds');
  imp.add('@/c3Action', 'c3Call');
  imp.add('@/components/ErrorBoundary/ErrorBoundary', 'useErrorBoundary');
  imp.def('@/components/PageFrame/PageFrame', 'PageFrame');
  ['ErrorState', 'LoadingState', 'errorMessage'].forEach(function (n) { imp.add('@/components/PageFrame/PageFrame', n); });
  imp.add('@/Interfaces', 'type FetchResult');
  imp.add('@/Interfaces', 'type ' + ent.name);
  imp.add('@/lib/format', 'chartColor');
  var C = ent.name;
  var lat = M.resolvePath(app, ent, mp.lat).field;
  var lng = M.resolvePath(app, ent, mp.lng).field;
  [lat, lng].forEach(function (f) { if (f.kind !== 'double') throw new Error('spec: ' + C + '.map lat/lng must be double fields'); });
  var color = mp.colorBy ? M.resolvePath(app, ent, mp.colorBy).field : null;
  if (color && color.kind !== 'enum') throw new Error('spec: ' + C + '.map.colorBy must be an enum field');
  var popup = mp.popup || ent.fields.filter(function (f) { return f.kind !== 'ref' && !f.multiline && f !== lat && f !== lng; }).slice(0, 3).map(function (f) { return f.name; });
  var inc = includeFor(app, ent, [ent.label, mp.lat, mp.lng].concat(color ? [mp.colorBy] : []).concat(popup));
  var b = [];
  b.push('/** Upper bound on markers drawn. */');
  b.push('const MAX_MARKERS = 2000;', '');
  b.push('const MAP_INCLUDE = ' + q(inc) + ';', '');
  b.push('type Located = ' + C + ' & { ' + mp.lat + ': number; ' + mp.lng + ': number };', '');
  b.push('/** Fits the map to the markers once they are loaded. */');
  b.push('function FitBounds({ points }: { points: Located[] }) {');
  b.push('  const map = useMap();');
  b.push('  useEffect(() => {');
  b.push('    if (!points.length) return;');
  b.push('    map.fitBounds(latLngBounds(points.map((p) => [p.' + mp.lat + ', p.' + mp.lng + '] as [number, number])), { padding: [32, 32] });');
  b.push('  }, [points, map]);');
  b.push('  return null;');
  b.push('}', '');
  b.push('const ' + C + 'Map: React.FC = () => {');
  b.push('  const { reportError } = useErrorBoundary();');
  b.push('  const [points, setPoints] = useState<Located[] | null>(null);');
  b.push('  const [error, setError] = useState<string | null>(null);', '');
  b.push('  useEffect(() => {');
  b.push('    let cancelled = false;');
  b.push("    (c3Call('" + C + "', 'fetch', null, [");
  b.push("      { include: MAP_INCLUDE, filter: 'exists(" + mp.lat + ') && exists(' + mp.lng + ")', limit: MAX_MARKERS, offset: 0 },");
  b.push('    ]) as Promise<FetchResult<' + C + '>>)');
  b.push('      .then((res) => {');
  b.push('        if (!cancelled) setPoints((res.objs ?? []) as Located[]);');
  b.push('      })');
  b.push('      .catch((err: unknown) => {');
  b.push('        if (cancelled) return;');
  b.push('        setError(errorMessage(err));');
  b.push('        reportError(err);');
  b.push('      });');
  b.push('    return () => {');
  b.push('      cancelled = true;');
  b.push('    };');
  b.push('  }, [reportError]);', '');
  if (color) {
    var en = color.enumDef;
    imp.add('@/Interfaces', en.tsConst);
    imp.add('@/Interfaces', 'type ' + en.tsType);
    imp.add('@/lib/format', en.tsAppearance);
    b.push('  // Marker colors follow the enum badge appearance (semantic chart tokens), resolved once per render of the theme.');
    b.push('  const colors = useMemo(() => {');
    b.push('    const out = {} as Record<' + en.tsType + ', string>;');
    b.push('    ' + en.tsConst + '.forEach((v) => {');
    b.push('      out[v] = chartColor(' + en.tsAppearance + '[v]);');
    b.push('    });');
    b.push('    return out;');
    b.push('  }, []);', '');
    b.push('  const counts = useMemo(() => {');
    b.push('    const c: Record<string, number> = {};');
    b.push('    (points ?? []).forEach((p) => {');
    b.push("      const k = p." + mp.colorBy + " ?? '';");
    b.push('      c[k] = (c[k] ?? 0) + 1;');
    b.push('    });');
    b.push('    return c;');
    b.push('  }, [points]);', '');
  } else {
    b.push("  const accent = useMemo(() => chartColor('accent'), []);", '');
  }
  var listCrumb = hasPage(ent, 'list') ? '{ label: ' + q(ent.display) + ", href: '#/" + ent.route + "' }" : '{ label: ' + q(ent.display) + ' }';
  b.push('  return (');
  b.push('    <PageFrame');
  b.push('      title=' + JSON.stringify(mp.title || (ent.display + ' Map')));
  b.push('      description=' + JSON.stringify(mp.description || ('Each marker is one ' + ent.singular.toLowerCase() + (color ? ', colored by ' + color.label.toLowerCase() : '') + '. Click a marker for details.')));
  b.push("      breadcrumbs={[" + (app.dashboard ? "{ label: 'Dashboard', href: '#/' }, " : '') + listCrumb + ", { label: 'Map' }]}");
  b.push('    >');
  if (color) {
    b.push('      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">');
    b.push('        {' + color.enumDef.tsConst + '.map((v) => (');
    b.push('          <span key={v} className="inline-flex items-center gap-2 text-c3-regular-body-p2 text-[var(--c3-style-basic-fg-primary)]">');
    b.push('            <span aria-hidden className="inline-block size-3 rounded-full" style={{ backgroundColor: colors[v] }} />');
    b.push('            {v}');
    b.push('            <span className="tabular-nums text-[var(--c3-style-basic-fg-secondary)]">{counts[v] ?? 0}</span>');
    b.push('          </span>');
    b.push('        ))}');
    b.push('      </div>');
  }
  b.push('      {error ? (');
  b.push('        <ErrorState message={`Could not load ' + ent.display.toLowerCase() + ': ${error}`} />');
  b.push('      ) : !points ? (');
  b.push('        <LoadingState label="Loading map…" />');
  b.push('      ) : (');
  b.push('        <div className="app-map h-[calc(100vh-260px)] min-h-[360px] overflow-hidden rounded-[var(--c3-style-border-radius-6)] border border-[var(--c3-style-basic-border-border)]">');
  b.push('          <MapContainer center={[39.5, -98.35]} zoom={4} scrollWheelZoom className="h-full w-full">');
  b.push('            <TileLayer');
  b.push('              attribution=\'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors\'');
  b.push('              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"');
  b.push('            />');
  b.push('            <FitBounds points={points} />');
  b.push('            {points.map((p) => {');
  b.push('              const color = ' + (color ? 'p.' + mp.colorBy + " ? colors[p." + mp.colorBy + "] : chartColor('secondary')" : 'accent') + ';');
  b.push('              return (');
  b.push('                <CircleMarker');
  b.push('                  key={p.id}');
  b.push('                  center={[p.' + mp.lat + ', p.' + mp.lng + ']}');
  b.push('                  radius={8}');
  b.push('                  pathOptions={{ color, fillColor: color, fillOpacity: 0.75, weight: 1.5 }}');
  b.push('                >');
  b.push('                  <Popup>');
  b.push('                    <div className="flex min-w-48 flex-col gap-1 text-c3-regular-body-p2">');
  b.push('                      <strong className="text-c3-bold-body-p2">{p.' + ent.label + '}</strong>');
  popup.forEach(function (pth) {
    var f = M.resolvePath(app, ent, pth).field;
    var jsx = cellJsx(app, ent, 'p', pth, imp, { noLink: true });
    b.push('                      <span>');
    b.push('                        <span className="text-[var(--c3-style-basic-fg-secondary)]">' + jsxText(f.label) + ':</span> ' + jsx);
    b.push('                      </span>');
  });
  if (hasPage(ent, 'detail')) b.push('                      <a href={`#/' + ent.route + '/${p.id}`}>Open ' + jsxText(ent.singular.toLowerCase()) + '</a>');
  b.push('                    </div>');
  b.push('                  </Popup>');
  b.push('                </CircleMarker>');
  b.push('              );');
  b.push('            })}');
  b.push('          </MapContainer>');
  b.push('        </div>');
  b.push('      )}');
  b.push('    </PageFrame>');
  b.push('  );');
  b.push('};', '');
  b.push('export default ' + C + 'Map;');
  return hdr(app) + imp.render().replace("from 'react';\n", "from 'react';\n").replace(/(import \{[^}]*\} from 'leaflet';\n)/, '$1import \'leaflet/dist/leaflet.css\';\n') + '\n' + b.join('\n') + '\n';
}

// ---------- shell ----------

var APP_HEADER = '/*\n * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.\n * Confidential and Proprietary C3 Materials.\n * This material, including without limitation any software, is the confidential trade secret and proprietary\n * information of C3 and its licensors. Reproduction, use and/or distribution of this material in any form is\n * strictly prohibited except as set forth in a written license agreement with C3 and/or its authorized distributors.\n * This material may be covered by one or more patents or pending patent applications.\n */\n\n';

function appTsx(app) {
  var imports = ["import React, { useCallback, useState } from 'react';", "import { Route, Routes } from 'react-router-dom';"];
  var routes = [];
  if (app.dashboard) {
    imports.push("import Dashboard from './pages/Dashboard/Dashboard';");
    routes.push('<Route path="/" element={<Dashboard />} />');
  }
  app.entities.forEach(function (e) {
    if (hasPage(e, 'list')) {
      imports.push('import ' + e.name + "List from './pages/" + e.area + '/' + e.name + "List';");
      routes.push('<Route path="/' + e.route + '" element={<' + e.name + 'List />} />');
    }
    if (hasPage(e, 'form')) {
      imports.push('import ' + e.name + "Form from './pages/" + e.area + '/' + e.name + "Form';");
      routes.push('<Route path="/' + e.route + '/new" element={<' + e.name + 'Form />} />');
    }
    if (hasPage(e, 'detail')) {
      imports.push('import ' + e.name + "Detail from './pages/" + e.area + '/' + e.name + "Detail';");
      routes.push('<Route path="/' + e.route + '/:id" element={<' + e.name + 'Detail />} />');
    }
    if (hasPage(e, 'form')) routes.push('<Route path="/' + e.route + '/:id/edit" element={<' + e.name + 'Form key="edit" />} />');
    if (e.ingest) {
      imports.push('import ' + e.name + "Imports from './pages/" + e.area + '/' + e.name + "Imports';");
      routes.push('<Route path="/' + e.route + '/imports" element={<' + e.name + 'Imports />} />');
    }
    if (e.map) {
      imports.push('import ' + e.name + "Map from './pages/" + e.area + '/' + e.name + "Map';");
      routes.push('<Route path="/' + e.route + '/map" element={<' + e.name + 'Map />} />');
    }
  });
  if (!app.dashboard) {
    var first = app.entities.filter(function (e) { return hasPage(e, 'list'); })[0];
    if (first) {
      imports.splice(1, 1, "import { Navigate, Route, Routes } from 'react-router-dom';");
      routes.unshift('<Route path="/" element={<Navigate to="/' + first.route + '" replace />} />');
    }
  }
  if (app.access) imports.push("import AccessBadge from './components/AccessBadge/AccessBadge';");
  imports.push("import SideNav from './components/SideNav/SideNav';", "import TopNav from './components/TopNav/TopNav';", "import ErrorReporterProvider from './components/ErrorBoundary/ErrorBoundary';");
  return (app.header ? APP_HEADER : '') + imports.join('\n') + '\n\n' + [
    '/**',
    ' * Application shell.',
    ' *',
    ' * The chrome — {@link TopNav} across the top and {@link SideNav} down the left —',
    ' * is rendered here, OUTSIDE `<Routes>`, so it is present on **every** page. The',
    ' * router only ever swaps the `<main>` content; the top bar and side nav are part',
    ' * of the shell and cannot be dropped by an individual page. Per the C3 Design',
    ' * System, the TopNavBar is expected on every screen — keep it mounted here and',
    ' * do not move it inside a route.',
    ' */',
    'export default function App() {',
    '  // Phone width: the side nav is a drawer opened from the TopNav menu button.',
    '  const [navOpen, setNavOpen] = useState(false);',
    '  const openNav = useCallback(() => setNavOpen(true), []);',
    '  const closeNav = useCallback(() => setNavOpen(false), []);',
    '',
    '  return (',
    '    <ErrorReporterProvider>',
    '      <div className="h-screen flex flex-col max-w-full overflow-hidden">',
    '        <TopNav title=' + JSON.stringify(app.title) + ' onMenuClick={openNav}' + (app.access ? ' actions={<AccessBadge />}' : '') + ' />',
    '        <div className="flex flex-1 min-h-0">',
    '          <SideNav mobileOpen={navOpen} onMobileClose={closeNav} />',
    '          <div className="flex-1 flex flex-col min-w-0">',
    '            <main className="flex-1 overflow-auto bg-[var(--c3-style-basic-bg-page)]">',
    '              <Routes>',
    '                {/* Add page routes here */}',
  ].join('\n') + '\n' + routes.map(function (r) { return '                ' + r; }).join('\n') + '\n' + [
    '                <Route',
    '                  path="*"',
    '                  element={',
    "                    import.meta.env.MODE === 'development' ? (",
    '                      <div className="flex h-full items-center justify-center p-8 text-center text-[var(--c3-style-basic-fg-neutral)]">',
    '                        <p>No route matched. Add routes in App.tsx.</p>',
    '                      </div>',
    '                    ) : (',
    '                      <div className="flex h-full items-center justify-center p-8 text-center text-[var(--c3-style-basic-fg-neutral)]">',
    '                        <p>Page not found.</p>',
    '                      </div>',
    '                    )',
    '                  }',
    '                />',
    '              </Routes>',
    '            </main>',
    '          </div>',
    '        </div>',
    '      </div>',
    '    </ErrorReporterProvider>',
    '  );',
    '}',
    '',
  ].join('\n');
}

function navigation(app) {
  var items = [];
  if (app.nav) {
    items = app.nav;
  } else {
    if (app.dashboard) items.push({ id: 'dashboard', path: '/', icon: 'House', label: 'Dashboard', tooltip: app.dashboard.title });
    app.entities.forEach(function (e) {
      if (hasPage(e, 'list') && e.nav) items.push({ id: e.route, path: '/' + e.route, icon: e.icon, label: e.display, tooltip: 'Browse ' + e.display.toLowerCase() });
      if (e.map && e.nav) items.push({ id: e.route + '-map', path: '/' + e.route + '/map', icon: 'Map', label: e.map.title || (e.display + ' Map'), tooltip: e.display + ' on a map' });
    });
  }
  var icons = uniq(items.map(function (i) { return i.icon; })).sort();
  // `Map` would shadow the global, so lucide's Map icon is imported as MapIcon (as lab4 did).
  var alias = function (n) { return n === 'Map' ? 'MapIcon' : n; };
  var out = app.header ? APP_HEADER : '';
  out += 'import { ' + icons.map(function (n) { return n === 'Map' ? 'Map as MapIcon' : n; }).join(', ') + " } from 'lucide-react';\n\n";
  out += "import { NavigationItem } from '@/types/navigation';\n\n";
  out += '/**\n * Navigation configuration for the application\n * To add a new page:\n * 1. Add a new item to this array\n * 2. Make sure the path matches your route in App.tsx\n * 3. Add the corresponding page component\n */\n';
  out += 'export const navigationConfig: NavigationItem[] = [\n';
  items.forEach(function (i) {
    out += '  {\n    id: ' + q(i.id) + ',\n    path: ' + q(i.path) + ',\n    icon: ' + alias(i.icon) + ',\n    iconActive: ' + alias(i.icon) + ',\n    label: ' + q(i.label) + ',\n    tooltip: ' + q(i.tooltip || i.label) + ',\n  },\n';
  });
  out += '];\n\n';
  out += [
    '/**',
    ' * Helper function to add navigation item dynamically',
    ' */',
    'export const addNavigationItem = (item: NavigationItem) => {',
    '  navigationConfig.push(item);',
    '};',
    '',
    '/**',
    ' * Helper function to remove navigation item',
    ' */',
    'export const removeNavigationItem = (id: string) => {',
    '  const index = navigationConfig.findIndex((item) => item.id === id);',
    '  if (index > -1) {',
    '    navigationConfig.splice(index, 1);',
    '  }',
    '};',
    '',
    '/**',
    ' * Helper function to update badge count',
    ' */',
    'export const updateNavigationBadge = (id: string, badge?: number) => {',
    '  const item = navigationConfig.find((item) => item.id === id);',
    '  if (item) {',
    '    item.badge = badge;',
    '  }',
    '};',
    '',
  ].join('\n');
  return out;
}

module.exports = {
  interfaces: interfaces,
  format: format,
  statusBadges: statusBadges,
  useLookups: useLookups,
  listPage: listPage,
  detailPage: detailPage,
  formPage: formPage,
  dashboardPage: dashboardPage,
  appTsx: appTsx,
  navigation: navigation,
  mapPage: mapPage,
  useAccessTs: useAccessTs,
  accessBadgeTsx: accessBadgeTsx,
  hasPage: hasPage,
};

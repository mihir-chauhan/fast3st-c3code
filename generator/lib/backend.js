'use strict';

// Writes the package manifest, `.c3typ` files, the `.js` method implementations and the Jasmine test,
// following the c3-type-dsl / c3-backend-code / c3-testing skills and the lab4ui generated code.

var M = require('./model');

var JS_HEADER = '/*\n * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.\n * Confidential and Proprietary C3 Materials.\n */\n\n';

/** Multi-line `/** ... *\/` doc block, wrapped at ~116 columns. */
function doc(text, indent) {
  indent = indent || '';
  var width = 116 - indent.length - 3;
  var lines = [];
  String(text).split('\n').forEach(function (para) {
    var cur = '';
    para.split(/\s+/).filter(Boolean).forEach(function (w) {
      if (cur && (cur + ' ' + w).length > width) {
        lines.push(cur);
        cur = w;
      } else cur = cur ? cur + ' ' + w : w;
    });
    lines.push(cur);
  });
  return indent + '/**\n' + lines.map(function (l) { return indent + ' * ' + l; }).join('\n') + '\n' + indent + ' */\n';
}

function fieldType(f) {
  if (f.calc) return '?' + f.kind + (f.stored ? ' stored calc ' : ' calc ') + f.calc;
  var req = f.required ? '!' : '';
  if (f.kind === 'ref') return req + f.ref;
  if (f.kind === 'enum') return req + 'string enum ' + f.enumName;
  return req + f.kind;
}

function manifest(app) {
  var deps = { mcpServer: '8.10' };
  if (app.tests) deps.testtools = '8.10'; // '*' loads but raises Pkg.Issue INVALID_FIELD (SemanticVersion.MajorMinor)
  return JSON.stringify({
    author: '{{author}}',
    name: app.pkg,
    description: app.description || '{{description}}',
    dependencies: deps,
    version: '1.0.0',
  }, null, 2) + '\n';
}

function entityTyp(app, ent) {
  var out = doc(ent.doc);
  out += '@db(index=[' + ent.index.map(function (i) { return "'" + i + "'"; }).join(', ') + '])\n';
  out += 'entity type ' + ent.name + ' {\n';
  ent.fields.forEach(function (f) {
    out += '\n' + doc(f.doc, '  ') + '  ' + f.name + ': ' + fieldType(f) + '\n';
  });
  ent.inverses.forEach(function (inv) {
    out += '\n' + doc(inv.doc, '  ') + '  ' + inv.name + ': [' + inv.child + '](' + inv.field + ')\n';
  });
  if (app.dashboard && app.dashboard.entity === ent) {
    out += '\n' + doc('Returns the KPIs and chart groupings shown on the Dashboard page, computed over every ' +
      M.words(ent.name).toLowerCase() + ' with `fetchCount` and grouped `evaluate` calls.', '  ');
    out += '  dashboardSummary: function(): ' + ent.name + '.DashboardSummary js-server\n';
  }
  return out + '}\n';
}

function enumTyp(en) {
  var out = doc(en.doc) + 'enum type ' + en.name + ' {\n';
  en.values.forEach(function (v) {
    out += doc(v.doc, '  ') + '  ' + v.key + " = '" + v.label.replace(/'/g, "\\'") + "'\n";
  });
  return out + '}\n';
}

function valueTyp(name, docText, fields) {
  var out = doc(docText) + 'type ' + name + ' {\n';
  fields.forEach(function (f) {
    out += doc(f.doc, '  ') + '  ' + f.name + ': ' + f.type + '\n';
  });
  return out + '}\n';
}

// ---------- dashboard ----------

function enumConst(en, label) {
  var v = en.values.filter(function (x) { return x.label === label || x.key === label; })[0];
  if (!v) throw new Error('spec: "' + label + '" is not a value of ' + en.name);
  return en.name + '.' + v.key;
}

/** JS expression (source text) for a KPI/chart filter, or null. */
function filterCode(app, ent, where, before) {
  var code = null;
  Object.keys(where || {}).forEach(function (p) {
    var r = M.resolvePath(app, ent, p);
    var vals = [].concat(where[p]);
    var lits = vals.map(function (v) { return r.field.kind === 'enum' ? enumConst(r.field.enumDef, v) : JSON.stringify(v); });
    var call = "intersects('" + p + "', [" + lits.join(', ') + '])';
    code = code ? code + '.and().' + call : 'Filter.' + call;
  });
  if (before) {
    M.resolvePath(app, ent, before);
    var expr = "'" + before + " < ' + todayLiteral()";
    code = code ? code + '.and(' + expr + ')' : expr;
  }
  return code;
}

function chartPlan(app, d) {
  var ent = d.entity;
  return d.charts.map(function (c) {
    var plan = { chart: c };
    if (c.kind === 'monthly') {
      plan.type = 'month';
      plan.series = c.series.map(function (s) {
        M.resolvePath(app, ent, s.dateField);
        return s;
      });
      return plan;
    }
    var r = M.resolvePath(app, ent, c.groupBy);
    plan.field = r.field;
    if (r.field.kind === 'enum') plan.type = 'enum';
    else if (r.field.kind === 'ref') {
      plan.type = 'ref';
      plan.target = app.byName[r.field.ref];
    } else plan.type = 'value';
    if (c.measure) M.resolvePath(app, ent, c.measure.field);
    return plan;
  });
}

function dashboardTypes(app) {
  var d = app.dashboard;
  var ent = d.entity;
  var files = {};
  var plans = chartPlan(app, d);
  var fields = d.kpis.map(function (k) {
    return { name: k.key, type: k.agg === 'count' ? 'int' : 'double', doc: k.doc || (k.label + (k.caption ? ': ' + k.caption : '') + '.') };
  });
  var needCount = false;
  var needMonth = false;
  plans.forEach(function (p) {
    if (p.type === 'month') {
      needMonth = true;
      fields.push({ name: p.chart.key, type: '[' + ent.name + '.MonthBucket]', doc: (p.chart.title || p.chart.key) + ': counts per calendar month, oldest first.' });
    } else {
      needCount = true;
      fields.push({ name: p.chart.key, type: '[' + ent.name + '.CountBucket]', doc: (p.chart.title || p.chart.key) + ': counts grouped by `' + p.chart.groupBy + '`.' });
    }
  });
  files[ent.name + '.DashboardSummary'] = valueTyp(ent.name + '.DashboardSummary',
    'KPIs and chart breakdowns over all {@link ' + ent.name + '} records, returned by {@link ' + ent.name + '#dashboardSummary}.', fields);
  if (needCount) {
    files[ent.name + '.CountBucket'] = valueTyp(ent.name + '.CountBucket',
      'One group of {@link ' + ent.name + '} records in a {@link ' + ent.name + '.DashboardSummary} breakdown.', [
        { name: 'key', type: 'string', doc: 'Group key: the enum value, the referenced record id, or the grouped value.' },
        { name: 'label', type: 'string', doc: 'Display label for the group.' },
        { name: 'count', type: 'int', doc: 'Number of records in the group.' },
        { name: 'value', type: 'double', doc: 'Measure of the group (for example a sum), when the chart defines one.' },
      ]);
  }
  if (needMonth) {
    files[ent.name + '.MonthBucket'] = valueTyp(ent.name + '.MonthBucket',
      'Record counts for one calendar month in a {@link ' + ent.name + '.DashboardSummary}.', [
        { name: 'month', type: 'string', doc: 'Month in `YYYY-MM` form.' },
        { name: 'counts', type: '[int]', doc: 'One count per chart series, in the order the chart declares them.' },
      ]);
  }
  return files;
}

function dashboardJs(app) {
  var d = app.dashboard;
  var ent = d.entity;
  var T = ent.name;
  var plans = chartPlan(app, d);
  var used = {};
  var body = [];

  d.kpis.forEach(function (k) {
    if (k.agg === 'ratio') return;
    var f = filterCode(app, ent, k.where, k.before);
    if (k.before) used.today = true;
    if (k.agg === 'count') {
      body.push('  var ' + k.key + ' = ' + T + '.fetchCount(' + (f ? '{ filter: ' + f + ' }' : '') + ');');
    } else if (k.agg === 'sum' || k.agg === 'avg') {
      M.resolvePath(app, ent, k.field);
      used.cellNum = true;
      body.push('  var ' + k.key + ' = cellNum(' + T + ".evaluate({ projection: '" + k.agg + '(' + k.field + ")'" +
        (f ? ', filter: ' + f : '') + ' }).tuples[0], 0);');
    } else throw new Error('spec: kpi agg must be count, sum, avg or ratio');
  });
  d.kpis.forEach(function (k) {
    if (k.agg !== 'ratio') return;
    body.push('  var ' + k.key + ' = ' + k.over + ' > 0 ? ' + k.of + ' / ' + k.over + ' : 0;');
  });

  plans.forEach(function (p) {
    var c = p.chart;
    var measure = c.measure ? "'" + c.measure.agg + '(' + c.measure.field + ")'" : 'null';
    if (p.type === 'enum') {
      used.enumBuckets = true;
      var en = p.field.enumDef;
      body.push('  var ' + c.key + " = enumBuckets('" + c.groupBy + "', [" +
        en.values.map(function (v) { return en.name + '.' + v.key; }).join(', ') + '], ' + measure + ');');
    } else if (p.type === 'ref') {
      used.groupBuckets = true;
      body.push('  var ' + c.key + " = groupBuckets('" + c.groupBy + ".id', '" + c.groupBy + '.' + p.target.label + "', " +
        (c.top || 10) + ', ' + measure + (c.skipEmpty ? ", 'exists(" + c.groupBy + ")'" : '') + ');');
    } else if (p.type === 'value') {
      used.groupBuckets = true;
      body.push('  var ' + c.key + " = groupBuckets('" + c.groupBy + "', '" + c.groupBy + "', " + (c.top || 10) + ', ' + measure +
        (c.skipEmpty ? ", 'exists(" + c.groupBy + ")'" : '') + ');');
    } else {
      used.monthBuckets = true;
      body.push('  var ' + c.key + ' = monthBuckets([' + p.series.map(function (s) { return "'" + s.dateField + "'"; }).join(', ') +
        '], ' + (c.months || 6) + ');');
    }
  });
  if (used.enumBuckets || used.groupBuckets) used.cellNum = true;

  var out = app.header ? JS_HEADER : '';
  out += "var log = Logger.for('" + T + "');\n\n";
  if (used.cellNum) {
    out += '/** A tuple cell value; the platform returns a null cell (not a cell holding null) for a null value. */\n' +
      'function cellValue(tuple, idx) {\n  var c = tuple.cells[idx];\n  return c == null ? null : c.value();\n}\n\n' +
      'function cellNum(tuple, idx) {\n  var v = cellValue(tuple, idx);\n  return v == null ? 0 : Number(v);\n}\n\n';
  }
  if (used.today) {
    out += "/** Today's date as an expression-engine literal, for date comparisons in filters. */\n" +
      "function todayLiteral() {\n  return \"dateTime('\" + new Date().toISOString().substring(0, 10) + \"')\";\n}\n\n";
  }
  if (used.enumBuckets) {
    out += '/** Counts (and an optional measure) per enum value, in enum order, including empty groups. */\n' +
      'function enumBuckets(field, values, measure) {\n' +
      "  var res = " + T + ".evaluate({\n    projection: field + ', count()' + (measure ? ', ' + measure : ''),\n    group: field,\n    limit: -1,\n  });\n" +
      '  var counts = {};\n  var sums = {};\n  var tuples = res.tuples || [];\n' +
      '  for (var i = 0; i < tuples.length; i++) {\n    var key = String(cellValue(tuples[i], 0));\n' +
      '    counts[key] = cellNum(tuples[i], 1);\n    if (measure) sums[key] = cellNum(tuples[i], 2);\n  }\n' +
      '  return values.map(function (v) {\n    return { key: v, label: v, count: counts[v] || 0, value: sums[v] || 0 };\n  });\n}\n\n';
  }
  if (used.groupBuckets) {
    out += '/** The `top` largest groups by count; `keyPath` and `labelPath` may be equal. Null keys are reported as Unassigned. */\n' +
      'function groupBuckets(keyPath, labelPath, top, measure, filter) {\n' +
      "  var group = keyPath === labelPath ? keyPath : keyPath + ', ' + labelPath;\n" +
      "  var spec = {\n    projection: group + ', count()' + (measure ? ', ' + measure : ''),\n    group: group,\n" +
      "    order: 'descending(count())',\n    limit: top,\n  };\n" +
      '  if (filter) spec.filter = filter;\n' +
      '  var res = ' + T + '.evaluate(spec);\n' +
      '  var n = keyPath === labelPath ? 1 : 2;\n  var rows = [];\n  var tuples = res.tuples || [];\n' +
      '  for (var i = 0; i < tuples.length; i++) {\n    var key = cellValue(tuples[i], 0);\n    var label = cellValue(tuples[i], n - 1);\n' +
      "    rows.push({\n      key: key == null ? '' : String(key),\n      label: label == null ? 'Unassigned' : String(label),\n" +
      '      count: cellNum(tuples[i], n),\n      value: measure ? cellNum(tuples[i], n + 1) : 0,\n    });\n  }\n  return rows;\n}\n\n';
  }
  if (used.monthBuckets) {
    out += '/** Counts per calendar month for each date field, for the last `months` months including the current one. */\n' +
      'function monthBuckets(dateFields, months) {\n  var now = new Date();\n  var keys = [];\n' +
      '  for (var i = months - 1; i >= 0; i--) {\n    var d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));\n' +
      '    keys.push(d.toISOString().substring(0, 7));\n  }\n  var counts = {};\n' +
      '  keys.forEach(function (k) {\n    counts[k] = dateFields.map(function () {\n      return 0;\n    });\n  });\n' +
      "  " + T + ".fetchObjStream({ include: dateFields.join(', ') }).each(function (obj) {\n" +
      '    dateFields.forEach(function (f, idx) {\n      var v = obj[f];\n      var k = v == null ? null : String(v).substring(0, 7);\n' +
      '      if (k != null && counts[k]) counts[k][idx]++;\n    });\n  });\n' +
      '  return keys.map(function (k) {\n    return { month: k, counts: counts[k] };\n  });\n}\n\n';
  }
  out += 'function dashboardSummary() {\n' + body.join('\n') + '\n\n';
  var all = d.kpis.map(function (k) { return k.key; }).concat(d.charts.map(function (c) { return c.key; }));
  out += "  log.info('Computed dashboard summary over {} records', " + (d.kpis.filter(function (k) { return k.agg === 'count' && !k.where && !k.before; })[0] || { key: "'all'" }).key + ');\n\n';
  out += '  return ' + T + '.DashboardSummary.make({\n' + all.map(function (k) { return '    ' + k + ': ' + k + ','; }).join('\n') + '\n  });\n}\n';
  return out;
}

// ---------- test (c3-testing) ----------

/** JS literal with single-quoted strings (the style of the generated .js files). */
function lit(v) {
  if (typeof v === 'string') return "'" + v.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
  if (v && typeof v === 'object') return '{ ' + Object.keys(v).map(function (k) { return k + ': ' + lit(v[k]); }).join(', ') + ' }';
  return String(v);
}

function testRowsFor(app, ent, n) {
  var rows = [];
  for (var i = 0; i < n; i++) {
    var r = {};
    ent.allFields.forEach(function (f) {
      if (f.kind === 'enum') r[f.name] = f.enumDef.values[i % f.enumDef.values.length].label;
      else if (f.required && f.kind === 'string') r[f.name] = 'TEST-' + ent.name + '-' + (i + 1);
      else if (f.required && (f.kind === 'int' || f.kind === 'double')) r[f.name] = i + 1;
      else if (f.required && f.kind === 'boolean') r[f.name] = true;
      else if (f.required && f.kind === 'datetime') r[f.name] = '2020-01-0' + (i + 1) + 'T09:00:00Z';
    });
    rows.push(r);
  }
  return rows;
}

function testJs(app) {
  var d = app.dashboard;
  var ent = d.entity;
  var T = ent.name;
  var reqRefs = ent.fields.filter(function (f) { return f.kind === 'ref' && f.required; });
  var rows = testRowsFor(app, ent, 3);
  var total = d.kpis.filter(function (k) { return k.agg === 'count' && !k.where && !k.before; })[0];
  var whereKpis = d.kpis.filter(function (k) {
    return k.agg === 'count' && k.where && !k.before && Object.keys(k.where).every(function (p) { return p.indexOf('.') < 0; });
  });
  var out = '/**\n * Tests for ' + T + '.dashboardSummary: records created in the test are reflected in the KPIs.\n */\n';
  out += "const filename = 'test_" + T + "';\n\ndescribe(filename, function () {\n  beforeAll(function () {\n";
  out += '    this.ctx = TestApi.createContext(filename);\n';
  reqRefs.forEach(function (f) {
    var parent = app.byName[f.ref];
    var pr = testRowsFor(app, parent, 1)[0];
    out += '    this.' + f.name + ' = TestApi.createEntity(this.ctx, ' + parent.name + ', ' + lit(pr) + ').get();\n';
  });
  out += '    this.before = ' + T + '.dashboardSummary();\n';
  out += '    this.ids = TestApi.createBatchEntity(this.ctx, ' + T + ', [\n';
  rows.forEach(function (r) {
    var parts = Object.keys(r).map(function (k) { return k + ': ' + lit(r[k]); });
    reqRefs.forEach(function (f) { parts.push(f.name + ': this.' + f.name); });
    out += '      ' + T + '.make({ ' + parts.join(', ') + ' }),\n';
  });
  out += '    ]);\n    TestApi.waitForSetup(this.ctx);\n    this.after = ' + T + '.dashboardSummary();\n  });\n\n';
  out += '  afterAll(function () {\n    TestApi.teardown(this.ctx);\n  });\n\n';
  out += "  describe('#dashboardSummary', function () {\n";
  if (total) {
    out += "    it('counts every created record in " + total.key + "', function () {\n" +
      '      expect(this.after.' + total.key + ' - this.before.' + total.key + ').toBe(this.ids.length);\n    });\n';
  }
  whereKpis.forEach(function (k) {
    var expected = rows.filter(function (r) {
      return Object.keys(k.where).every(function (p) { return [].concat(k.where[p]).indexOf(r[p]) >= 0; });
    }).length;
    out += "\n    it('counts only matching records in " + k.key + "', function () {\n" +
      '      expect(this.after.' + k.key + ' - this.before.' + k.key + ').toBe(' + expected + ');\n    });\n';
  });
  out += '  });\n});\n';
  return out;
}

// ---------- summaries / steering ----------

function workspaceSummary(app, seedCounts) {
  var d = app.dashboard;
  var L = [];
  L.push('# Workspace Summary', '');
  L.push('> Work-to-date map of this workspace (maintained by the agent). See `TEMPLATE_SUMMARY.md` for the');
  L.push("> template's initial state. Note: in this workspace both summaries live in `" + app.pkg + '/src/`.', '');
  L.push('## Current state', '');
  L.push('**' + app.title + '**' + (app.description ? ' — ' + app.description : '') + '. Generated code-first by');
  L.push('`templates/c3app-gen` in the C3 Code layout; all UI data comes from C3 types via `c3Call`.', '');
  L.push('## Backend types (`' + app.pkg + '/src/`)', '');
  app.entities.forEach(function (e) {
    var f = (e.usesName ? ['inherited `name`'] : []).concat(e.fields.map(function (x) {
      return '`' + x.name + (x.required ? '!' : '') + '`' + (x.kind === 'enum' ? ' (`' + x.enumName + '`)' : x.kind === 'ref' ? ' (→ `' + x.ref + '`)' : '');
    }));
    e.inverses.forEach(function (i) { f.push('inverse `' + i.name + ': [' + i.child + '](' + i.field + ')`'); });
    L.push('- `' + e.name + '` (entity): ' + f.join(', ') + '.');
    e.enumsLocal.forEach(function (en) {
      L.push('  - `' + en.name + '` enum: ' + en.values.map(function (v) { return v.label; }).join(' / ') + '.');
    });
  });
  if (d) {
    L.push('- `' + d.entity.name + '.dashboardSummary(): ' + d.entity.name + '.DashboardSummary` (js-server, `' + d.entity.name + '.js`) —');
    L.push('  KPIs via `fetchCount` / `evaluate`, charts via grouped `evaluate` (`' + d.entity.name + '.CountBucket`) and a');
    L.push('  streamed month count (`' + d.entity.name + '.MonthBucket`).');
  }
  L.push('', '## Data (`' + app.pkg + '/' + app.dataDir + '/`)', '');
  app.entities.forEach(function (e) {
    L.push('- `' + e.name + '/' + e.name + '.json` (' + (seedCounts[e.name] || 0) + ' rows).');
  });
  L.push('- Deterministic (seed `' + app.seed + '`, anchored at ' + app.asOf + '); regenerate with the generator, do not hand-edit.');
  L.push('- Load: `C3.pkg().upsertAllSeed(true)` via `runJsOnLiveApp` (or `App.State.inst().get().withFields({ pkgFingerprint: -1, seeded: false }).update(); C3.pkg().upsertAllSeed()`).', '');
  L.push('## UI pages / routes (`ui/react/src/`)', '', '| Route | Page |', '| --- | --- |');
  if (d) L.push('| `/` | `pages/Dashboard/Dashboard.tsx` — KPI tiles, charts from `dashboardSummary`, recent records |');
  app.entities.forEach(function (e) {
    if (e.pages.indexOf('list') >= 0) L.push('| `/' + e.route + '` | `pages/' + e.area + '/' + e.name + 'List.tsx` — server-side filter/sort/paginate, filters in URL params |');
    if (e.pages.indexOf('form') >= 0) L.push('| `/' + e.route + '/new`, `/' + e.route + '/:id/edit` | `pages/' + e.area + '/' + e.name + 'Form.tsx` — `create` / `merge` (merge include lists the form fields so cleared values are saved) |');
    if (e.pages.indexOf('detail') >= 0) L.push('| `/' + e.route + '/:id` | `pages/' + e.area + '/' + e.name + 'Detail.tsx` — details, related records, actions via `merge`, delete via `remove` |');
  });
  L.push('', 'Shared: `components/PageFrame` (PageHeader + content; `LoadingState`, `ErrorState`, `EmptyRows`, `errorMessage`),');
  L.push('`components/StatusBadges` (one soft badge per enum), `components/DetailList`, `components/charts/EChart.tsx` (vendored');
  L.push('`lib/echarts*.ts` theme), `hooks/useLookups.ts` (reference lists for pickers), `lib/format.ts` (formatters, badge');
  L.push('appearance maps, `filterLiteral`, chart colors). Types and enum value arrays in `Interfaces.tsx`.', '');
  L.push('## Key decisions', '');
  L.push('- `c3Action.ts` is the canonical `c3Call` version from the c3-frontend skill; template placeholders removed.');
  L.push('- Font: `styles/manual-tokens.css` points `--theme-font-family-font-sans` at `Inter Variable` (the face');
  L.push('  `@fontsource-variable/inter` registers); `tokens.css` is untouched.');
  L.push('- Charts use semantic colors (badge appearance → `--c3-style-chart-*`), not the 8-hue categorical palette.');
  L.push('- Vendored `ui/chart.tsx` needs React 19, so `components/charts/EChart.tsx` wraps eCharts directly.');
  L.push('- `npm run build` needs `VITE_C3_PKG=' + app.pkg + '` in a plain shell.');
  if (app.tests) L.push('- Jasmine test `test/js-rhino/test_' + (d ? d.entity.name : '') + '.js`; `testtools` is in the manifest.');
  return L.join('\n') + '\n';
}

function pkgClaude(app) {
  return [
    '---',
    'description: Conventions for the ' + app.title + ' package (generated code-first by c3app-gen)',
    'alwaysApply: false',
    '---',
    '',
    '# ' + app.title + ' — package conventions',
    '',
    'This package was generated in the C3 Code `blankPkg` layout. Read `src/WORKSPACE_SUMMARY.md` first. When you change it,',
    'keep these conventions so the generated files and your edits stay consistent:',
    '',
    '- One type per file in `src/`; enums and result types are nested (`<Type>.<Enum>.c3typ`, `<Type>.DashboardSummary.c3typ`).',
    '  Every type, field, enum value and method has a multi-line `/** */` doc.',
    '- Display names use the inherited `name` field where the summary says so; never declare `name`, `type` or `version`.',
    '- Sample rows are in `' + app.dataDir + '/<Type>/<Type>.json` (explicit ids, references as `{ "id": ... }`). Upsert with',
    '  `C3.pkg().upsertAllSeed(true)` after changing them.',
    '- UI: every backend call is `c3Call` from `@/c3Action`; pages render inside `components/PageFrame`; badge colors come',
    '  from the `*_APPEARANCE` maps in `lib/format.ts`; chart colors from `chartColor()` there. Do not hard-code colors.',
    '- Keep `npm run build` green (lint + tsc + vite).',
    '',
  ].join('\n');
}

// ---------- access control (c3-access-control skill; lab1 verified the Role + UserGroup pair live) ----------

function rolePermissions(app, r) {
  var perms = [];
  r.read.forEach(function (n) { perms.push('allow:' + n + ':read:'); });
  if (r.read.length) {
    if (app.dashboard) perms.push('allow:' + app.dashboard.entity.name + '::dashboardSummary');
    perms.push('allow:' + app.access.type + '::mine');
  }
  r.write.forEach(function (n) { perms.push('allow:' + n + '::create', 'allow:' + n + '::merge'); });
  r.remove.forEach(function (n) { perms.push('allow:' + n + '::remove'); });
  return perms;
}

/** `metadata/Role/<id>.json` per role and one `<dataDir>/UserGroup/UserGroup.json` row per role (a role needs a same-id UserGroup to be assignable). */
function accessFiles(app) {
  var files = {};
  app.access.roles.forEach(function (r) {
    var role = { id: r.id, description: r.description, permissions: rolePermissions(app, r) };
    if (r.nested.length) role.nestedRoles = r.nested;
    files['metadata/Role/' + r.id + '.json'] = JSON.stringify(role, null, 2) + '\n';
  });
  // UserGroup is a 'data'-category type: under seed/ the platform raises a Pkg.Issue WARNING (seen live in lab6).
  files[app.dataDir + '/UserGroup/UserGroup.json'] = JSON.stringify(app.access.roles.map(function (r) {
    return { id: r.id, name: r.label, inactive: false };
  }), null, 2) + '\n';
  var A = app.access.type;
  files['src/' + A + '.c3typ'] = doc('Application access for the signed-in user: which of this app\'s roles they hold and which ' +
    'record actions the platform authorizes for them. The UI uses it to hide actions the role lacks; the platform still ' +
    'enforces every call through the roles in `metadata/Role/`.') + 'type ' + A + ' {\n' +
    doc('Roles and authorized actions of the caller ({@link User#myUser}), checked with {@link Authorizer#isAuthorized}.', '  ') +
    '  mine: function(): ' + A + '.Summary js-server\n}\n';
  files['src/' + A + '.Summary.c3typ'] = valueTyp(A + '.Summary', 'What the signed-in user may do, returned by {@link ' + A + '#mine}.', [
    { name: 'user', type: 'string', doc: 'Id of the signed-in user.' },
    { name: 'roles', type: '[string]', doc: 'Application role ids (UserGroups) the user belongs to.' },
    { name: 'canCreate', type: '[string]', doc: 'Entity type names the user may `create`.' },
    { name: 'canEdit', type: '[string]', doc: 'Entity type names the user may `merge`.' },
    { name: 'canDelete', type: '[string]', doc: 'Entity type names the user may `remove`.' },
  ]);
  var ents = app.entities.map(function (e) { return "'" + e.name + "'"; }).join(', ');
  files['src/' + A + '.js'] = (app.header ? JS_HEADER : '') + "var log = Logger.for('" + A + "');\n\n" +
    '/** Application role ids, from metadata/Role. */\nvar ROLES = [' + app.access.roles.map(function (r) { return "'" + r.id + "'"; }).join(', ') + '];\n\n' +
    '/** Entity types the UI gates. */\nvar ENTITIES = [' + ents + '];\n\n' +
    '/** True when the platform authorizes the caller for `action` on `type` (never throws). */\n' +
    'function allowed(type, action) {\n  try {\n    return Authorizer.isAuthorized(type, action, true) === true;\n  } catch (e) {\n' +
    "    log.warn('Authorization check failed for {}#{}', type, action);\n    return false;\n  }\n}\n\n" +
    'function mine() {\n  var user = User.myUser();\n' +
    '  return ' + A + '.Summary.make({\n    user: user.id,\n' +
    '    roles: ROLES.filter(function (r) {\n      return user.hasGroup(r);\n    }),\n' +
    "    canCreate: ENTITIES.filter(function (t) {\n      return allowed(t, 'create');\n    }),\n" +
    "    canEdit: ENTITIES.filter(function (t) {\n      return allowed(t, 'merge');\n    }),\n" +
    "    canDelete: ENTITIES.filter(function (t) {\n      return allowed(t, 'remove');\n    }),\n  });\n}\n";
  return files;
}

module.exports = {
  accessFiles: accessFiles,
  rolePermissions: rolePermissions,
  manifest: manifest,
  entityTyp: entityTyp,
  enumTyp: enumTyp,
  dashboardTypes: dashboardTypes,
  dashboardJs: dashboardJs,
  testJs: testJs,
  workspaceSummary: workspaceSummary,
  pkgClaude: pkgClaude,
  chartPlan: chartPlan,
  JS_HEADER: JS_HEADER,
  doc: doc,
  valueTyp: valueTyp,
};

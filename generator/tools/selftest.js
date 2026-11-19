#!/usr/bin/env node
'use strict';

/*
 * Local proof for a generated package:
 *   1. regenerating from the same spec is byte-for-byte stable (deterministic seed data),
 *   2. the generated dashboardSummary() runs (tools/mock-c3.js) and every KPI / chart bucket equals a value recomputed
 *      independently from the seed rows and the spec.
 *
 *   node tools/selftest.js <spec.json> <outDir>
 */

var fs = require('fs');
var os = require('os');
var path = require('path');
var cp = require('child_process');

var M = require('../lib/model');
var mock = require('./mock-c3');

var specPath = path.resolve(process.argv[2]);
var outDir = path.resolve(process.argv[3]);
var app = M.load(specPath);
var pkgDir = path.join(outDir, app.pkg);
var failures = 0;

function sortKeys(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return o;
  var r = {};
  Object.keys(o).sort().forEach(function (k) { r[k] = o[k]; });
  return r;
}

function check(name, actual, expected) {
  actual = sortKeys(actual);
  expected = sortKeys(expected);
  var ok = typeof expected === 'number' ? Math.abs(actual - expected) < 1e-6 : JSON.stringify(actual) === JSON.stringify(expected);
  process.stdout.write((ok ? 'ok   ' : 'FAIL ') + name + ' = ' + JSON.stringify(actual) + (ok ? '' : ' (expected ' + JSON.stringify(expected) + ')') + '\n');
  if (!ok) failures++;
}

// 1. determinism: generate twice into temp dirs and compare every non-UI-shell file
var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'c3app-gen-'));
['a', 'b'].forEach(function (d) {
  cp.execFileSync(process.execPath, [path.join(__dirname, '..', 'gen.js'), specPath, path.join(tmp, d)], { stdio: 'pipe' });
});
var diff = cp.spawnSync('diff', ['-r', '-q', path.join(tmp, 'a'), path.join(tmp, 'b')], { encoding: 'utf8' });
check('regeneration is byte-identical', diff.status, 0);
var diff2 = cp.spawnSync('diff', ['-r', '-q', '-x', 'node_modules', '-x', 'content', path.join(tmp, 'a', app.pkg), pkgDir], { encoding: 'utf8' });
check('output dir matches a fresh generation', diff2.status === 0 ? 0 : diff2.stdout.trim(), 0);
fs.rmSync(tmp, { recursive: true, force: true });

// 2. dashboard against seed rows
var d = app.dashboard;
if (d) {
  var run = mock.run(pkgDir, d.entity.name, 'dashboardSummary');
  var s = run.result;
  var rows = run.rows[d.entity.name];
  var read = function (r, p) { return run.read(d.entity.name, r, p); };
  var today = new Date().toISOString().substring(0, 10);
  var match = function (k) {
    return rows.filter(function (r) {
      var ok = Object.keys(k.where || {}).every(function (p) { return [].concat(k.where[p]).indexOf(read(r, p)) >= 0; });
      if (ok && k.before) {
        var v = read(r, k.before);
        ok = v != null && v.substring(0, 10) < today;
      }
      return ok;
    });
  };
  d.kpis.forEach(function (k) {
    var expected;
    if (k.agg === 'count') expected = match(k).length;
    else if (k.agg === 'sum' || k.agg === 'avg') {
      var vals = match(k).map(function (r) { return read(r, k.field); }).filter(function (v) { return v != null; });
      var sum = vals.reduce(function (a, b) { return a + b; }, 0);
      expected = k.agg === 'sum' ? sum : (vals.length ? sum / vals.length : 0);
    } else {
      expected = s[k.over] > 0 ? s[k.of] / s[k.over] : 0;
    }
    check('kpi ' + k.key, s[k.key], expected);
  });
  d.charts.forEach(function (c) {
    var buckets = s[c.key];
    if (c.kind === 'monthly') {
      c.series.forEach(function (ser, i) {
        var inWindow = buckets.map(function (b) { return b.month; });
        var expected = rows.filter(function (r) { var v = r[ser.dateField]; return v && inWindow.indexOf(v.substring(0, 7)) >= 0; }).length;
        var got = buckets.reduce(function (a, b) { return a + b.counts[i]; }, 0);
        check('chart ' + c.key + ' ' + ser.label + ' total over ' + inWindow.length + ' months', got, expected);
      });
      return;
    }
    var counts = {};
    rows.forEach(function (r) {
      var v = read(r, c.groupBy);
      if (c.skipEmpty && v == null) return;
      if (v && typeof v === 'object') v = v.id;
      counts[v == null ? '' : v] = (counts[v == null ? '' : v] || 0) + 1;
    });
    var got = {};
    buckets.forEach(function (b) { if (b.count) got[b.key] = b.count; });
    var top = c.top || 10;
    var r = M.resolvePath(app, d.entity, c.groupBy);
    if (r.field.kind === 'enum') {
      var exp = {};
      Object.keys(counts).forEach(function (k) { if (k) exp[k] = counts[k]; });
      check('chart ' + c.key + ' buckets', got, exp);
    } else {
      var sorted = Object.keys(counts).map(function (k) { return counts[k]; }).sort(function (a, b) { return b - a; }).slice(0, top);
      check('chart ' + c.key + ' top-' + top + ' counts', buckets.map(function (b) { return b.count; }), sorted);
    }
    if (c.measure) {
      var mexp = 0;
      rows.forEach(function (row) { if (!(c.skipEmpty && read(row, c.groupBy) == null)) mexp += read(row, c.measure.field) || 0; });
      check('chart ' + c.key + ' measure total', buckets.reduce(function (a, b) { return a + b.value; }, 0), mexp);
    }
  });
}
process.stdout.write(failures ? failures + ' check(s) failed\n' : 'all checks passed\n');
process.exitCode = failures ? 1 : 0;

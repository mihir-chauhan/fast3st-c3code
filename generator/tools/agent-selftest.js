#!/usr/bin/env node
'use strict';

/*
 * Runs the generated agent tool methods (src/<Agent>.js) locally against the seed rows with an in-memory stand-in for
 * the platform APIs they use (Logger.for, Filter.intersects/.and()/.and(expr), fetchObjStream with include paths,
 * fetch, <Type>.make().create()/merge(), arrayBuilder), and checks the results against values recomputed
 * independently from the rows. Also prints the ground truth for the live Assistant questions (knowledge/23).
 *
 *   node tools/agent-selftest.js <spec.json> <outDir>
 *
 * Like mock-c3.js this proves the generated JS logic, not the platform semantics (see README "lab7").
 */

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var assert = require('assert');

var M = require('../lib/model');
var A = require('../lib/agent');

function main(argv) {
  var specPath = argv[2];
  var out = path.resolve(argv[3]);
  var app = M.load(specPath);
  var ag = A.normalize(JSON.parse(fs.readFileSync(specPath, 'utf8')), app);
  if (!ag) throw new Error('spec has no agent section');
  var pkg = path.join(out, app.pkg);
  var rows = {};
  app.entities.forEach(function (e) {
    rows[e.name] = JSON.parse(fs.readFileSync(path.join(pkg, app.dataDir, e.name, e.name + '.json'), 'utf8'));
  });
  var byId = {};
  Object.keys(rows).forEach(function (t) {
    byId[t] = {};
    rows[t].forEach(function (r) { byId[t][r.id] = r; });
  });

  function read(type, row, p) {
    var parts = p.split('.');
    var cur = row;
    var ent = app.byName[type];
    for (var i = 0; i < parts.length; i++) {
      if (cur == null) return null;
      var v = cur[parts[i]];
      if (i < parts.length - 1) {
        var f = ent.fieldByName[parts[i]];
        if (!f || f.kind !== 'ref' || v == null) return null;
        cur = byId[f.ref][v.id];
        ent = app.byName[f.ref];
      } else return v === undefined ? null : v;
    }
    return null;
  }

  // include 'a, b.c' -> object with refs expanded only as far as included (like the platform)
  function project(type, row, include) {
    var o = { id: row.id };
    include.split(',').map(function (s) { return s.trim(); }).forEach(function (p) {
      var parts = p.split('.');
      var cur = o;
      for (var i = 0; i < parts.length - 1; i++) {
        cur[parts[i]] = cur[parts[i]] || {};
        cur = cur[parts[i]];
      }
      var v = read(type, row, p);
      if (v !== null) cur[parts[parts.length - 1]] = v;
    });
    return o;
  }

  function Flt(preds) { this.preds = preds || []; }
  Flt.prototype.intersects = function (p, vals) {
    return new Flt(this.preds.concat([function (t, r) { return vals.indexOf(read(t, r, p)) >= 0; }]));
  };
  Flt.prototype.eq = function (p, v) { return this.intersects(p, [v]); };
  Flt.prototype.and = function (expr) { return expr === undefined ? this : new Flt(this.preds.concat([exprPred(expr)])); };
  function exprPred(s) {
    var conj = String(s).split('&&');
    if (conj.length > 1) {
      var ps = conj.map(exprPred);
      return function (t, r) { return ps.every(function (p) { return p(t, r); }); };
    }
    var m = String(s).match(/^\s*([\w.]+)\s*(>=|<)\s*dateTime\('(\d{4}-\d{2}-\d{2})'\)\s*$/);
    if (!m) throw new Error('mock cannot evaluate ' + s);
    return function (t, r) {
      var v = read(t, r, m[1]);
      if (v == null) return false;
      var d = String(v).substring(0, 10);
      return m[2] === '>=' ? d >= m[3] : d < m[3];
    };
  }
  function matches(type, filter, r) {
    if (!filter) return true;
    if (typeof filter === 'string') return exprPred(filter)(type, r);
    return filter.preds.every(function (p) { return p(type, r); });
  }
  function sortRows(type, list, order) {
    if (!order) return list;
    var m = order.match(/^(ascending|descending)\(([\w.]+)\)$/);
    var dir = m[1] === 'ascending' ? 1 : -1;
    return list.slice().sort(function (a, b) {
      var x = read(type, a, m[2]);
      var y = read(type, b, m[2]);
      return (x < y ? -1 : x > y ? 1 : 0) * dir;
    });
  }

  var created = [];
  var merged = [];
  function entityType(name) {
    return {
      fetchObjStream: function (spec) {
        var list = sortRows(name, rows[name].filter(function (r) { return matches(name, spec.filter, r); }), spec.order);
        return { each: function (fn) { list.forEach(function (r) { fn(project(name, r, spec.include)); }); } };
      },
      fetch: function (spec) {
        var list = rows[name].filter(function (r) { return matches(name, spec.filter, r); }).slice(0, spec.limit || 2000);
        return { objs: list.map(function (r) { return project(name, r, spec.include); }) };
      },
      make: function (o) {
        return { merge: function () { merged.push({ type: name, obj: o }); }, create: function () { created.push(o); return Object.assign({ id: 'pc_' + created.length }, o); } };
      },
    };
  }
  var ctx = {
    Logger: { for: function () { return { info: function () {}, warn: function () {} }; } },
    Filter: { intersects: function (p, v) { return new Flt().intersects(p, v); }, eq: function (p, v) { return new Flt().eq(p, v); } },
    DateTime: { now: function () { return new Date().toISOString(); } },
    JSON: JSON,
  };
  app.entities.forEach(function (e) { ctx[e.name] = entityType(e.name); });
  var T = {
    Stats: { make: function (o) { return o; } },
    PendingChange: entityType('__none__'),
  };
  T.PendingChange.make = function (o) { return { create: function () { created.push(o); return Object.assign({ id: 'pc_' + created.length }, o); } }; };
  ag.tools.forEach(function (t) {
    if (t.kind === 'search') {
      T[t.hitType.split('.')[1]] = {
        make: function (o) { return o; },
        arrayBuilder: function () { var a = []; return { add: function (x) { a.push(x); }, build: function () { return a; } }; },
      };
    }
  });
  ctx[ag.type] = T;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(pkg, 'src', ag.type + '.js'), 'utf8'), ctx, { filename: ag.type + '.js' });

  var checks = 0;
  function eq(actual, expected, label) {
    assert.deepStrictEqual(actual, expected, label);
    checks++;
  }

  // ----- independent recomputation for every stats tool: each groupBy, unfiltered, and with every enum filter value
  ag.tools.filter(function (t) { return t.kind === 'stats'; }).forEach(function (t) {
    var E = t.entity.name;
    var nArgs = 1 + t.filters.length + (t.dateField ? 2 : 0);
    function call(groupBy, filterVals, from, to) {
      var args = [groupBy].concat(t.filters.map(function (f) { return filterVals[f.param] || null; }));
      if (t.dateField) args.push(from || null, to || null);
      assert.strictEqual(args.length, nArgs);
      return ctx[t.name].apply(null, args);
    }
    function expect(groupKey, filterVals, from, to) {
      var g = t.groupBy.filter(function (x) { return x.key === groupKey; })[0];
      var list = rows[E].filter(function (r) {
        var ok = t.filters.every(function (f) {
          var v = filterVals[f.param];
          if (!v) return true;
          var want = v.split(',').map(function (s) { return s.trim().toLowerCase(); });
          return want.indexOf(String(read(E, r, f.path) || '').toLowerCase()) >= 0;
        });
        if (ok && from) ok = read(E, r, t.dateField.path) != null && read(E, r, t.dateField.path).substring(0, 10) >= from;
        if (ok && to) ok = read(E, r, t.dateField.path) != null && read(E, r, t.dateField.path).substring(0, 10) < to;
        return ok;
      });
      var counts = {};
      if (g) {
        list.forEach(function (r) {
          var v = read(E, r, g.path);
          var k = v == null || v === '' ? '(none)' : g.month ? String(v).substring(0, 7) : String(v);
          counts[k] = (counts[k] || 0) + 1;
        });
      }
      return { total: list.length, counts: counts };
    }
    var res = call('none', {});
    eq(res.total, rows[E].length, t.name + ' total');
    t.groupBy.forEach(function (g) {
      var r = call(g.key.toUpperCase(), {});
      var exp = expect(g.key, {});
      var got = {};
      r.buckets.forEach(function (b) { got[b.key] = b.count; });
      eq(got, exp.counts, t.name + ' groupBy ' + g.key);
    });
    t.filters.forEach(function (f) {
      if (!f.enumDef) return;
      f.enumDef.values.forEach(function (v) {
        var fv = {};
        fv[f.param] = v.label.toLowerCase();
        eq(call('none', fv).total, expect(null, fv).total, t.name + ' ' + f.param + '=' + v.label);
      });
    });
    if (t.dateField) eq(call('none', {}, '2026-10-01', '2026-11-01').total, expect(null, {}, '2026-10-01', '2026-11-01').total, t.name + ' date range');
    assert.throws(function () { call('nonsense', {}); }, /Unsupported groupBy/);
    var bad = {};
    var ef = t.filters.filter(function (f) { return f.enumDef; })[0];
    if (ef) {
      bad[ef.param] = 'Bogus';
      assert.throws(function () { call('none', bad); }, /Use one of/);
    }
    checks += 2;
  });

  // ----- search tools: ordering, limit, text match
  ag.tools.filter(function (t) { return t.kind === 'search'; }).forEach(function (t) {
    var args = [null].concat(t.filters.map(function () { return null; }), t.dateField ? [null, null] : [], [5]);
    var hits = ctx[t.name].apply(null, args);
    eq(hits.length, Math.min(5, rows[t.entity.name].length), t.name + ' limit');
    if (t.dateField) {
      var sorted = rows[t.entity.name].map(function (r) { return read(t.entity.name, r, t.dateField.path); }).sort().reverse().slice(0, 5);
      var col = t.columns.filter(function (c) { return c.path === t.dateField.path; })[0];
      if (col) eq(hits.map(function (h) { return h[col.prop]; }), sorted, t.name + ' newest first');
    }
    hits.forEach(function (h) { assert.ok(h.recordId, t.name + ' recordId'); });
  });

  // ----- write tool: proposes only
  if (ag.write) {
    var w = ag.write;
    var target = rows[w.entity.name][4];
    var f0 = w.fields[0];
    var other = f0.enumDef ? f0.enumDef.values.map(function (v) { return v.label; }).filter(function (l) { return l !== target[f0.name]; })[0] : 'x';
    var wargs = [String(target[w.key.name]).toLowerCase()].concat(w.fields.map(function (f) { return f === f0 ? other.toLowerCase() : null; }), ['selftest']);
    var msg = ctx[w.name].apply(null, wargs);
    assert.ok(/PROPOSED \(not applied\)/.test(msg), msg);
    eq(created.length, 1, 'one PendingChange');
    eq(JSON.parse(created[0].changes)[f0.name], { from: target[f0.name], to: other }, 'change recorded');
    eq(merged.length, 0, 'nothing merged by the agent tool');
    checks++;
  }
  process.stdout.write('agent-selftest: ' + checks + ' checks passed\n');

  // ----- ground truth for the live questions (supportdesk example)
  if (rows.SupportTicket && rows.Customer) {
    var tk = rows.SupportTicket;
    var cust = byId.Customer;
    var openS = ['Open', 'In Progress', 'Waiting on Customer'];
    var gt = {};
    gt.q1_criticalOpen = tk.filter(function (r) { return r.priority === 'Critical' && openS.indexOf(r.status) >= 0; }).map(function (r) { return r.number + ' ' + r.status; });
    var byC = {};
    tk.forEach(function (r) { byC[r.customer.id] = (byC[r.customer.id] || 0) + 1; });
    gt.q2_topCustomers = Object.keys(byC).sort(function (a, b) { return byC[b] - byC[a]; }).slice(0, 4).map(function (id) { return cust[id].name + ' (' + cust[id].tier + ') ' + byC[id]; });
    var gold = tk.filter(function (r) { return cust[r.customer.id].tier === 'Gold' && r.satisfaction != null; });
    gt.q3_goldAvgCsat = { n: gold.length, avg: Math.round(gold.reduce(function (s, r) { return s + r.satisfaction; }, 0) / gold.length * 100) / 100 };
    gt.q4_octoberCreated = tk.filter(function (r) { return r.createdDate.substring(0, 7) === '2026-10'; }).length;
    gt.q5_recentOutages = tk.filter(function (r) { return r.category === 'Outage'; }).sort(function (a, b) { return a.createdDate < b.createdDate ? 1 : -1; })
      .slice(0, 3).map(function (r) { return r.number + ' | ' + cust[r.customer.id].name + ' | ' + r.status + ' | ' + r.createdDate.substring(0, 10); });
    gt.byStatus = {};
    tk.forEach(function (r) { gt.byStatus[r.status] = (gt.byStatus[r.status] || 0) + 1; });
    gt.writeTarget = tk.filter(function (r) { return r.number === 'TCK-1005'; }).map(function (r) { return r.number + ' ' + r.status + ' ' + r.priority; })[0];
    process.stdout.write(JSON.stringify(gt, null, 1) + '\n');
  }
}

main(process.argv);

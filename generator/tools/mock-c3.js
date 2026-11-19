#!/usr/bin/env node
'use strict';

/*
 * Runs a generated `<Type>.js` server method locally against the package's seed rows, with a tiny in-memory stand-in
 * for the platform APIs the generator emits (Logger.for, Filter.intersects/and, fetchCount, evaluate with
 * projection/group/order/limit, fetchObjStream().each, <Type>.<Enum>.KEY, <Type>.<Value>.make).
 *
 *   node tools/mock-c3.js <pkgDir> <Type> <method>
 *
 * This proves the generated JS runs and aggregates the seed data the way the dashboard expects. It does NOT prove the
 * platform's own semantics (evaluate grouping on reference paths, Filter serialization, null handling) — see README.
 */

var fs = require('fs');
var path = require('path');
var vm = require('vm');

function main(argv) {
  var pkg = path.resolve(argv[2]);
  var typeName = argv[3];
  var method = argv[4];
  var dataRoot = fs.existsSync(path.join(pkg, 'data')) ? path.join(pkg, 'data') : path.join(pkg, 'test/data');
  var rows = {};
  fs.readdirSync(dataRoot).forEach(function (t) {
    rows[t] = JSON.parse(fs.readFileSync(path.join(dataRoot, t, t + '.json'), 'utf8'));
  });
  var index = {};
  Object.keys(rows).forEach(function (t) {
    index[t] = {};
    rows[t].forEach(function (r) { index[t][r.id] = r; });
  });
  // reference field → target type, from the .c3typ files
  var refs = {};
  var enums = {};
  fs.readdirSync(path.join(pkg, 'src')).filter(function (f) { return /\.c3typ$/.test(f); }).forEach(function (f) {
    var src = fs.readFileSync(path.join(pkg, 'src', f), 'utf8');
    var name = f.replace(/\.c3typ$/, '');
    if (/^enum type /m.test(src)) {
      enums[name] = {};
      src.replace(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*'([^']*)'/gm, function (_, k, v) { enums[name][k] = v; });
      return;
    }
    refs[name] = {};
    src.replace(/^\s*(\w+):\s*!?([A-Z]\w*)\s*$/gm, function (_, fld, target) { refs[name][fld] = target; });
  });

  function read(type, row, p) {
    var parts = p.split('.');
    var cur = row;
    var curType = type;
    for (var i = 0; i < parts.length; i++) {
      if (cur == null) return null;
      var v = cur[parts[i]];
      if (i < parts.length - 1) {
        var target = refs[curType] && refs[curType][parts[i]];
        if (!target || v == null) return null;
        cur = index[target][v.id] || null;
        curType = target;
      } else return v === undefined ? null : v;
    }
    return null;
  }

  function parseExpr(type, s) {
    var ex = String(s).match(/^\s*exists\(([\w.]+)\)\s*$/);
    if (ex) return function (r) { return read(type, r, ex[1]) != null; };
    var m = String(s).match(/^\s*([\w.]+)\s*<\s*dateTime\('([^']+)'\)\s*$/);
    if (!m) throw new Error('mock cannot evaluate filter expression: ' + s);
    return function (r) {
      var v = read(type, r, m[1]);
      return v != null && String(v).substring(0, 10) < m[2];
    };
  }

  function FilterImpl(preds) {
    this.preds = preds || [];
  }
  FilterImpl.prototype.intersects = function (p, values) {
    var vals = [].concat(values);
    return new FilterImpl(this.preds.concat([{ path: p, test: function (type, r) { return vals.indexOf(read(type, r, p)) >= 0; } }]));
  };
  FilterImpl.prototype.eq = function (p, v) { return this.intersects(p, [v]); };
  FilterImpl.prototype.and = function (expr) {
    if (expr === undefined) return this;
    var self = this;
    return new FilterImpl(self.preds.concat([{ expr: expr }]));
  };
  var Filter = {
    intersects: function (p, v) { return new FilterImpl().intersects(p, v); },
    eq: function (p, v) { return new FilterImpl().eq(p, v); },
  };

  function matcher(type, filter) {
    if (!filter) return function () { return true; };
    if (typeof filter === 'string') return parseExpr(type, filter);
    var preds = filter.preds.map(function (p) {
      if (p.expr) return parseExpr(type, p.expr);
      return function (r) { return p.test(type, r); };
    });
    return function (r) { return preds.every(function (f) { return f(r); }); };
  }

  function cell(v) { return v == null ? null : { value: function () { return v; } }; } // live platform: null value -> null cell

  function makeType(type) {
    var T = {
      fetchCount: function (spec) {
        var m = matcher(type, spec && spec.filter);
        return rows[type].filter(m).length;
      },
      fetchObjStream: function (spec) {
        var m = matcher(type, spec && spec.filter);
        var list = rows[type].filter(m);
        return { each: function (fn) { list.forEach(function (r) { fn(r); }); } };
      },
      evaluate: function (spec) {
        var m = matcher(type, spec.filter);
        var list = rows[type].filter(m);
        var proj = spec.projection.split(',').map(function (x) { return x.trim(); });
        var groupCols = spec.group ? spec.group.split(',').map(function (x) { return x.trim(); }) : [];
        var groups = {};
        var order = [];
        list.forEach(function (r) {
          var key = JSON.stringify(groupCols.map(function (g) { return read(type, r, g); }));
          if (!groups[key]) { groups[key] = []; order.push(key); }
          groups[key].push(r);
        });
        if (!groupCols.length && !order.length) { groups['[]'] = []; order.push('[]'); }
        var tuples = order.map(function (key) {
          var members = groups[key];
          return {
            cells: proj.map(function (p) {
              var agg = p.match(/^(count|sum|avg)\((.*)\)$/);
              if (!agg) return cell(read(type, members[0] || {}, p));
              if (agg[1] === 'count') return cell(members.length);
              var vals = members.map(function (r) { return read(type, r, agg[2]); }).filter(function (v) { return v != null; });
              var sum = vals.reduce(function (a, b) { return a + b; }, 0);
              return cell(agg[1] === 'sum' ? (vals.length ? sum : null) : (vals.length ? sum / vals.length : null));
            }),
          };
        });
        if (spec.order === 'descending(count())') {
          var ci = proj.indexOf('count()');
          tuples.sort(function (a, b) { return b.cells[ci].value() - a.cells[ci].value(); });
        } else if (spec.order) throw new Error('mock cannot order by ' + spec.order);
        if (spec.limit > 0) tuples = tuples.slice(0, spec.limit);
        return { tuples: tuples };
      },
      make: function (o) { return o; },
    };
    return T;
  }

  var sandbox = { Filter: Filter, Logger: { for: function () { return { info: function () {}, warn: function () {}, error: function () {} }; } } };
  Object.keys(refs).concat(Object.keys(rows)).forEach(function (t) {
    if (t.indexOf('.') < 0 && !sandbox[t]) sandbox[t] = makeType(t);
  });
  Object.keys(refs).forEach(function (t) {
    if (t.indexOf('.') < 0) return;
    var parts = t.split('.');
    sandbox[parts[0]] = sandbox[parts[0]] || makeType(parts[0]);
    sandbox[parts[0]][parts[1]] = { make: function (o) { return o; } };
  });
  Object.keys(enums).forEach(function (t) {
    var parts = t.split('.');
    sandbox[parts[0]] = sandbox[parts[0]] || makeType(parts[0]);
    sandbox[parts[0]][parts[1]] = enums[t];
  });
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(pkg, 'src', typeName + '.js'), 'utf8'), sandbox, { filename: typeName + '.js' });
  var result = vm.runInContext(method + '()', sandbox);
  return { result: result, rows: rows, index: index, read: read };
}

module.exports = { run: function (pkg, type, method) { return main(['', '', pkg, type, method]); } };

if (require.main === module) {
  var out = main(process.argv);
  process.stdout.write(JSON.stringify(out.result, null, 2) + '\n');
}

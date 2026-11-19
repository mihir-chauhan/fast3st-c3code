#!/usr/bin/env node
'use strict';

/*
 * Offline checks for a C3 package in the C3 Code layout (generated or hand-written):
 *
 *   node validate.js <pkgDir> [--types-index <docs-raw-types dir>]
 *
 * - `.c3typ`: a line-level parser for the subset of the C3TypeDsl grammar (c3-type-dsl skill references/grammar.md)
 *   that app types use: header forms, field value types/modifiers, inverse fkeys, enum members, method forms + claims,
 *   doc blocks, `@db(index=[...])` fields, reserved names, and every referenced type resolving to the package or to the
 *   platform type index (knowledge/09 source dump `docs-raw-types/<pkg>/_index.tsv`).
 * - `.js`: `node --check`, and one top-level function per declared js-server method.
 * - `data/` + `test/data/`: JSON arrays, ids, required fields, enum values, ISO datetimes, references resolving.
 * - UI: every `c3Call('<Type>', '<action>')` targets a known type/method; include/order/filter field paths exist;
 *   every nav path has a route.
 *
 * Exit code 1 when any error is found. Nothing here proves the platform accepts the package — see README.
 */

var fs = require('fs');
var path = require('path');
var cp = require('child_process');

var PRIMS = ['string', 'boolean', 'int', 'int32', 'int16', 'byte', 'bigint', 'double', 'float', 'decimal', 'number', 'binary', 'json', 'datetime', 'date', 'any', 'void'];
var RESERVED_FIELDS = ['type', 'version', 'id', 'name', 'meta', 'make', 'at', 'scan', 'schema'];
var BUILTIN_ACTIONS = ['fetch', 'fetchCount', 'get', 'create', 'merge', 'remove', 'update', 'upsert', 'evaluate', 'fetchObjStream', 'removeAll', 'mergeBatch', 'createBatch', 'upsertBatch'];
var INHERITED_FIELDS = ['id', 'name', 'meta', 'version', 'typeIdent'];

var errors = [];
var warnings = [];
function err(file, msg) { errors.push(file + ': ' + msg); }
function warn(file, msg) { warnings.push(file + ': ' + msg); }

function walk(dir, out) {
  out = out || [];
  if (!fs.existsSync(dir)) return out;
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (d) {
    if (d.name === 'node_modules' || d.name === 'content') return;
    var p = path.join(dir, d.name);
    if (d.isDirectory()) walk(p, out);
    else out.push(p);
  });
  return out;
}

function loadPlatformIndex(dir) {
  var names = {};
  if (!dir || !fs.existsSync(dir)) return null;
  fs.readdirSync(dir).forEach(function (pkg) {
    var idx = path.join(dir, pkg, '_index.tsv');
    if (!fs.existsSync(idx)) return;
    fs.readFileSync(idx, 'utf8').split('\n').forEach(function (l) {
      var n = l.split('\t')[0];
      if (n) names[n] = pkg;
    });
  });
  return names;
}

// ---------- .c3typ ----------

function stripStrings(s) {
  return s.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, '""');
}

/** Parses one value type; returns { refs: [type names], enumRef, inline enum values, inverse } or throws. */
function parseValueType(t) {
  var res = { refs: [], required: false };
  var m;
  t = t.trim();
  m = t.match(/^(!\?|!|\?)?(.*)$/);
  res.required = m[1] === '!';
  t = m[2].trim();
  if ((m = t.match(/^string\s+enum\s*\((.*)\)$/))) {
    res.inlineEnum = m[1].split(',').map(function (x) { return x.trim(); });
    res.inlineEnum.forEach(function (x) { if (!/^'[^']*'$/.test(x)) throw new Error('inline enum values must be quoted strings: ' + x); });
    res.kind = 'enum';
    return res;
  }
  if ((m = t.match(/^(string|int)\s+enum\s+([A-Z][\w.]*)$/))) {
    res.kind = 'enum';
    res.enumRef = m[2];
    res.refs.push(m[2]);
    return res;
  }
  if ((m = t.match(/^\[\s*(!?)([A-Z][\w.]*)\s*\]\s*\(\s*(\w+)\s*\)$/))) {
    res.kind = 'inverse';
    res.refs.push(m[2]);
    res.inverse = { child: m[2], field: m[3] };
    return res;
  }
  if ((m = t.match(/^\[(.*)\]$/))) {
    var inner = parseValueType(m[1]);
    res.refs = inner.refs;
    res.kind = 'array';
    return res;
  }
  if ((m = t.match(/^(map|set|stream)<(.*)>$/))) {
    m[2].split(',').forEach(function (x) { res.refs = res.refs.concat(parseValueType(x).refs); });
    res.kind = m[1];
    return res;
  }
  if ((m = t.match(/^datetime(\s+(with millis|with micros|with nanos|no tz))?$/))) {
    res.kind = 'datetime';
    return res;
  }
  if (PRIMS.indexOf(t) >= 0) {
    res.kind = t === 'date' ? 'datetime' : t;
    return res;
  }
  if ((m = t.match(/^(mixing\s+)?([A-Z][\w]*(\.[A-Z][\w]*)*)$/))) {
    res.kind = 'ref';
    res.refs.push(m[2]);
    return res;
  }
  throw new Error('unrecognized value type "' + t + '"');
}

function parseTyp(file) {
  var src = fs.readFileSync(file, 'utf8');
  var base = path.basename(file, '.c3typ');
  var t = { file: file, name: null, kind: null, fields: {}, methods: {}, enumValues: [], index: [], refs: [] };
  // drop doc/block comments but remember where docs were
  var lines = src.split('\n');
  var i = 0;
  var pendingDoc = false;
  var pendingAnn = [];
  var depth = 0;
  var opens = (stripStrings(src).match(/{/g) || []).length;
  var closes = (stripStrings(src).match(/}/g) || []).length;
  if (opens !== closes) err(file, 'unbalanced braces');
  while (i < lines.length) {
    var line = lines[i].trim();
    if (line.indexOf('/**') === 0) {
      if (/\*\/\s*$/.test(line) && line !== '/**') {
        warn(file + ':' + (i + 1), 'single-line doc block (conventions want multi-line /** ... */)');
      }
      while (i < lines.length && lines[i].indexOf('*/') < 0) i++;
      pendingDoc = true;
      i++;
      continue;
    }
    if (line === '' || line.indexOf('//') === 0) { i++; continue; }
    if (line.indexOf('/*') === 0) { while (i < lines.length && lines[i].indexOf('*/') < 0) i++; i++; continue; }
    var ln = file + ':' + (i + 1);
    if (line.charAt(0) === '@') {
      pendingAnn.push(line);
      var m0 = line.match(/^@db\(index=\[(.*)\]\)$/);
      if (m0) {
        t.index = m0[1].split(',').map(function (x) { return x.trim().replace(/^'|'$/g, '').trim(); }).filter(Boolean);
      }
      i++;
      continue;
    }
    if (depth === 0) {
      var hm = line.match(/^((?:(?:abstract|private|inline|final|sealed|entity|extendable|remix|native)\s+)*)(enum\s+)?type\s+([A-Z][\w.]*)(\s+extends\s+[A-Z][\w.]*)?(\s+mixes\s+[A-Z][\w.<>, ]*?)?\s*(\{)?\s*$/);
      if (!hm) { err(ln, 'header does not match `[modifiers] [enum] type Name [extends X] [mixes A, B] {`: ' + line); i++; continue; }
      t.name = hm[3];
      t.kind = hm[2] ? 'enum' : /\bentity\b/.test(hm[1]) ? 'entity' : 'type';
      if (/extends\s+Persistable|mixes\s+.*\b(Persistable|ValueType|MetadataFile|UuidIdGenerated)\b/.test(line)) err(ln, 'forbidden extends/mixes (c3-backend-code MUST 1)');
      if (hm[5]) hm[5].replace(/\s+mixes\s+/, '').split(',').forEach(function (x) { t.refs.push(x.trim().replace(/<.*$/, '')); });
      if (hm[4]) t.refs.push(hm[4].replace(/\s+extends\s+/, '').trim());
      if (!pendingDoc) warn(ln, 'type has no doc block');
      if (t.name !== base) err(ln, 'type name ' + t.name + ' does not match file name ' + base + '.c3typ (one type per file)');
      if (!hm[6]) err(ln, 'expected `{` at end of header');
      depth = 1;
      pendingDoc = false;
      pendingAnn = [];
      i++;
      continue;
    }
    if (line === '}') { depth = 0; i++; continue; }
    if (t.kind === 'enum') {
      var em = line.match(/^([A-Z][A-Z0-9_]*)(\s*=\s*('(?:[^'\\]|\\.)*'|-?\d+(\.\d+)?))?\s*,?$/);
      if (!em) err(ln, 'enum member must be `KEY` or `KEY = \'Label\'`: ' + line);
      else {
        t.enumValues.push({ key: em[1], label: em[3] ? em[3].replace(/^'|'$/g, '').replace(/\\'/g, "'") : em[1] });
        if (!pendingDoc) warn(ln, 'enum value ' + em[1] + ' has no doc block');
      }
      pendingDoc = false;
      i++;
      continue;
    }
    var mm = line.match(/^(\w+)\s*:\s*(.*)$/);
    if (!mm) { err(ln, 'member must be `name: ...`: ' + line); i++; continue; }
    var name = mm[1];
    var rest = mm[2].trim();
    if (!pendingDoc) warn(ln, 'member ' + name + ' has no doc block');
    pendingDoc = false;
    var meth = rest.match(/^((?:(?:abstract|optional|final|inline|cached|stateful|private)\s+)*)(function|member function)\s*\((.*)\)\s*(?::\s*(.+?))?\s+(js-server|js-client|js|py(?:-[\w-]+)?|java)(\s*\|\s*\w[\w-]*)*$/);
    var over = rest.match(/^~\s*(js-server|js|py[\w-]*|java)?$/);
    if (meth) {
      t.methods[name] = { claim: meth[5], member: meth[2] === 'member function' };
      if (meth[4]) {
        try { t.refs = t.refs.concat(parseValueType(meth[4]).refs); } catch (e) { err(ln, 'return type: ' + e.message); }
      }
      if (meth[3].trim()) {
        var seenOptional = false;
        meth[3].split(/,(?![^<]*>)/).forEach(function (p) {
          var pm = p.trim().match(/^(\w+)\s*:\s*(.+?)(\s*=\s*.+)?$/);
          if (!pm) { err(ln, 'bad parameter: ' + p); return; }
          try {
            var pt = parseValueType(pm[2]);
            t.refs = t.refs.concat(pt.refs);
            if (pt.required && seenOptional) warn(ln, 'required parameter ' + pm[1] + ' after an optional one');
            if (!pt.required) seenOptional = true;
          } catch (e) { err(ln, 'parameter ' + pm[1] + ': ' + e.message); }
        });
      }
      i++;
      continue;
    }
    if (/function\s*\(/.test(rest)) { err(ln, 'method ' + name + ' needs a runtime claim (js-server, js, py, ...)'); i++; continue; }
    if (over) { t.methods[name] = { claim: over[1] || '~' }; i++; continue; }
    // field
    if (name === 'name') warn(ln, 'declares `name`, which every entity inherits (c3-backend-code says reuse it; lab1 redeclared it and loaded)');
    else if (RESERVED_FIELDS.indexOf(name) >= 0) err(ln, 'field name `' + name + '` collides with an inherited member');
    var fm = rest.match(/^((?:private|const)\s+)?(.+?)(\s+(?:stored\s+)?calc\s+.+)?(\s*=\s*(.+))?$/);
    var vt = fm[2];
    var def = fm[5];
    if (def && /^false$/.test(def.trim())) warn(ln, '`= false` (conventions: leave booleans unset)');
    try {
      var pv = parseValueType(vt);
      t.fields[name] = pv;
      t.refs = t.refs.concat(pv.refs);
      if (pv.inverse && pv.required) err(ln, 'inverse collection must not be required');
    } catch (e) { err(ln, 'field ' + name + ': ' + e.message); }
    i++;
  }
  return t;
}

// ---------- main ----------

function main(argv) {
  var args = argv.slice(2);
  var idxDir = path.resolve(__dirname, '../../docs-raw-types');
  var k = args.indexOf('--types-index');
  if (k >= 0) { idxDir = path.resolve(args[k + 1]); args.splice(k, 2); }
  if (!args[0]) { process.stderr.write('Usage: node validate.js <pkgDir> [--types-index <dir>]\n'); process.exitCode = 2; return; }
  var pkg = path.resolve(args[0]);
  var pkgName = path.basename(pkg);
  var platform = loadPlatformIndex(idxDir);
  if (!platform) warn(pkg, 'platform type index not found at ' + idxDir + '; skipping platform name checks');

  // manifest
  var manifestFile = path.join(pkg, pkgName + '.c3pkg.json');
  if (!fs.existsSync(manifestFile)) err(pkg, 'missing ' + pkgName + '.c3pkg.json (folder name must equal package name)');
  else {
    var man = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    if (man.name !== pkgName) err(manifestFile, 'name "' + man.name + '" != folder "' + pkgName + '"');
    if (fs.existsSync(path.join(pkg, 'test/js-rhino')) && !(man.dependencies || {}).testtools) err(manifestFile, 'Jasmine tests need the testtools dependency (c3-testing)');
  }

  // every JSON file parses
  // tsconfig*.json are JSONC (comments allowed), so they are skipped.
  walk(pkg).filter(function (f) { return /\.json$/.test(f) && !/tsconfig[\w.]*\.json$/.test(f); }).forEach(function (f) {
    try { JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { err(f, 'invalid JSON: ' + e.message); }
  });

  // types
  var types = {};
  walk(path.join(pkg, 'src')).filter(function (f) { return /\.c3typ$/.test(f); }).forEach(function (f) {
    var t = parseTyp(f);
    if (t.name) types[t.name] = t;
  });
  Object.keys(types).forEach(function (n) {
    var t = types[n];
    if (platform && platform[n] && n.indexOf('.') < 0) err(t.file, 'type name ' + n + ' already exists in platform package "' + platform[n] + '" (shadowing; prefix it with the domain)');
    t.refs.forEach(function (r) {
      if (types[r]) return;
      if (platform && platform[r]) return;
      if (!platform && /^[A-Z]/.test(r)) return;
      err(t.file, 'unknown type ' + r);
    });
    t.index.forEach(function (f) {
      if (!t.fields[f.split('.')[0].split(',')[0].trim()] && INHERITED_FIELDS.indexOf(f) < 0) err(t.file, '@db index field ' + f + ' is not declared');
    });
    Object.keys(t.fields).forEach(function (fn) {
      var fv = t.fields[fn];
      if (fv.inverse) {
        var child = types[fv.inverse.child];
        if (!child) return;
        var cf = child.fields[fv.inverse.field];
        if (!cf) err(t.file, 'inverse ' + fn + ': ' + fv.inverse.child + ' has no field ' + fv.inverse.field);
        else if (cf.refs[0] !== n) err(t.file, 'inverse ' + fn + ': ' + fv.inverse.child + '.' + fv.inverse.field + ' is not a ' + n + ' reference');
      }
      if (fv.enumRef && types[fv.enumRef] && types[fv.enumRef].kind !== 'enum') err(t.file, fn + ': ' + fv.enumRef + ' is not an enum type');
    });
    // implementation file
    var jsMethods = Object.keys(t.methods).filter(function (m) { return /^js/.test(t.methods[m].claim); });
    var jsFile = path.join(path.dirname(t.file), n + '.js');
    if (jsMethods.length) {
      if (!fs.existsSync(jsFile)) err(t.file, 'js methods declared but ' + n + '.js is missing');
      else {
        var js = fs.readFileSync(jsFile, 'utf8');
        jsMethods.forEach(function (m) {
          if (!new RegExp('^function\\s+' + m + '\\s*\\(', 'm').test(js)) err(jsFile, 'no top-level function ' + m + '() for ' + n + '.' + m);
        });
        if (/console\.(log|error)/.test(js)) err(jsFile, 'console.* in backend code (use Logger.for)');
        if (/limit:\s*-1/.test(js) && /\.fetch\(/.test(js)) warn(jsFile, 'fetch with limit -1 (stream with fetchObjStream instead)');
      }
    }
  });
  walk(pkg).filter(function (f) { return /\.js$/.test(f) && f.indexOf('/ui/') < 0; }).forEach(function (f) {
    try { cp.execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); } catch (e) { err(f, 'JS syntax: ' + String(e.stderr).split('\n').slice(0, 4).join(' ')); }
  });

  // data
  ['data', 'test/data', 'seed', 'test/seed'].forEach(function (dd) {
    var root = path.join(pkg, dd);
    if (!fs.existsSync(root)) return;
    var all = {};
    fs.readdirSync(root).forEach(function (tn) {
      var dir = path.join(root, tn);
      if (!fs.statSync(dir).isDirectory()) { err(dir, 'data files go in a type-named folder: ' + dd + '/<Type>/<Type>.json'); return; }
      // seed records of platform types (e.g. seed/UserGroup/<role>.json, one object per file) are not checked here
      if (!types[tn] && platform && platform[tn]) return;
      fs.readdirSync(dir).filter(function (f) { return /\.json$/.test(f); }).forEach(function (f) {
        var rows = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        all[tn] = (all[tn] || []).concat(rows);
      });
    });
    Object.keys(all).forEach(function (tn) {
      var file = path.join(root, tn);
      var t = types[tn];
      if (!t) { err(file, 'no type ' + tn + ' in src/'); return; }
      if (t.kind !== 'entity') err(file, tn + ' is not an entity type');
      var rows = all[tn];
      if (!Array.isArray(rows)) { err(file, 'must be a JSON array'); return; }
      var ids = {};
      rows.forEach(function (r, i) {
        var at = file + '[' + i + ']';
        if (!r.id) err(at, 'missing id');
        else if (ids[r.id]) err(at, 'duplicate id ' + r.id);
        ids[r.id] = true;
        if (r.meta) err(at, 'meta must not be in seed rows');
        Object.keys(t.fields).forEach(function (fn) {
          var fv = t.fields[fn];
          if (fv.required && (r[fn] === undefined || r[fn] === null || r[fn] === '')) err(at, 'required field ' + fn + ' missing');
        });
        Object.keys(r).forEach(function (fn) {
          if (INHERITED_FIELDS.indexOf(fn) >= 0) return;
          var fv = t.fields[fn];
          var v = r[fn];
          if (!fv) { err(at, 'field ' + fn + ' is not declared on ' + tn); return; }
          if (fv.inverse) { err(at, 'inverse field ' + fn + ' is not stored'); return; }
          if (fv.kind === 'enum') {
            var allowed = fv.inlineEnum ? fv.inlineEnum.map(function (x) { return x.replace(/^'|'$/g, ''); }) :
              (types[fv.enumRef] ? types[fv.enumRef].enumValues.map(function (e) { return e.label; }) : null);
            if (allowed && allowed.indexOf(v) < 0) err(at, fn + ' = "' + v + '" is not one of ' + allowed.join(', '));
          } else if (fv.kind === 'datetime') {
            if (typeof v !== 'string' || isNaN(Date.parse(v)) || !/^\d{4}-\d\d-\d\d/.test(v)) err(at, fn + ' must be an ISO-8601 string');
          } else if (['int', 'int32', 'int16', 'bigint'].indexOf(fv.kind) >= 0) {
            if (!Number.isInteger(v)) err(at, fn + ' must be an integer');
          } else if (['double', 'float', 'decimal', 'number'].indexOf(fv.kind) >= 0) {
            if (typeof v !== 'number') err(at, fn + ' must be a number');
          } else if (fv.kind === 'boolean') {
            if (typeof v !== 'boolean') err(at, fn + ' must be a boolean');
          } else if (fv.kind === 'string') {
            if (typeof v !== 'string') err(at, fn + ' must be a string');
          } else if (fv.kind === 'ref') {
            if (!v || typeof v !== 'object' || !v.id) err(at, fn + ' must be { "id": ... }');
          }
        });
      });
    });
    Object.keys(all).forEach(function (tn) {
      var t = types[tn];
      if (!t) return;
      all[tn].forEach(function (r, i) {
        Object.keys(r).forEach(function (fn) {
          var fv = t.fields[fn];
          if (!fv || fv.kind !== 'ref' || !r[fn] || !r[fn].id) return;
          var target = fv.refs[0];
          if (!all[target]) { warn(path.join(root, tn) + '[' + i + ']', fn + ' → ' + target + ' has no rows in ' + dd + '/'); return; }
          if (!all[target].some(function (x) { return x.id === r[fn].id; })) err(path.join(root, tn) + '[' + i + ']', fn + ' references missing ' + target + ' ' + r[fn].id);
        });
      });
    });
  });

  // UI
  var uiSrc = path.join(pkg, 'ui/react/src');
  var tsFiles = walk(uiSrc).filter(function (f) { return /\.(ts|tsx)$/.test(f) && f.indexOf('/components/ui/') < 0 && !/c3Action\.ts$/.test(f); });
  function fieldPathOk(typeName, p) {
    var parts = p.split('.');
    var cur = types[typeName];
    for (var j = 0; j < parts.length; j++) {
      if (!cur) return true; // platform type: not checked
      var part = parts[j];
      if (part === 'this' || INHERITED_FIELDS.indexOf(part) >= 0) return j === parts.length - 1 || part === 'meta';
      var fv = cur.fields[part];
      if (!fv) return false;
      if (j < parts.length - 1) cur = types[fv.refs[0]];
    }
    return true;
  }
  tsFiles.forEach(function (f) {
    var src = fs.readFileSync(f, 'utf8');
    if (/console\.(log|error)/.test(src)) warn(f, 'console.* in UI code');
    if (/document\.cookie/.test(src) && /c3auth/.test(src)) err(f, 'forbidden c3auth cookie bootstrap (c3-frontend)');
    var consts = {};
    src.replace(/const\s+(\w+)\s*=\s*\n?\s*'([^']*)'\s*;/g, function (_, n, v) { consts[n] = v; });
    var re = /c3Call\(\s*'([\w.]+)'\s*,\s*'(\w+)'([\s\S]{0,400}?)\)\s*(as|;|\))/g;
    var m;
    while ((m = re.exec(src))) {
      var tn = m[1];
      var action = m[2];
      var t = types[tn];
      if (!t) { if (!platform || !platform[tn]) err(f, "c3Call('" + tn + "') — unknown type"); continue; }
      if (BUILTIN_ACTIONS.indexOf(action) < 0 && !t.methods[action]) err(f, "c3Call('" + tn + "', '" + action + "') — not declared on " + tn);
      if (/fetch'/.test("'" + action + "'") && action === 'fetch' && !/limit/.test(m[3]) && !/\[spec\]/.test(m[3])) warn(f, "c3Call('" + tn + "', 'fetch') without an explicit limit");
      var chunk = m[3];
      var incs = [];
      chunk.replace(/include:\s*'([^']*)'/g, function (_, v) { incs.push(v); });
      chunk.replace(/include:\s*([A-Z_]+)/g, function (_, n) { if (consts[n]) incs.push(consts[n]); });
      chunk.replace(/\[\s*([A-Z_]+INCLUDE)\s*\]/g, function (_, n) { if (consts[n]) incs.push(consts[n]); });
      incs.forEach(function (inc) {
        inc.split(',').map(function (x) { return x.trim(); }).filter(Boolean).forEach(function (p) {
          if (!fieldPathOk(tn, p)) err(f, 'include path ' + tn + '.' + p + ' does not exist');
        });
      });
      chunk.replace(/order:\s*'(?:ascending|descending)\(([\w.]+)\)/g, function (_, p) {
        if (!fieldPathOk(tn, p)) err(f, 'order path ' + tn + '.' + p + ' does not exist');
      });
    }
  });
  var appTsx = path.join(uiSrc, 'App.tsx');
  var nav = path.join(uiSrc, 'config/navigation.ts');
  if (fs.existsSync(appTsx) && fs.existsSync(nav)) {
    var routes = [];
    fs.readFileSync(appTsx, 'utf8').replace(/path="([^"]+)"/g, function (_, p) { routes.push(p); });
    fs.readFileSync(nav, 'utf8').replace(/path:\s*'([^']+)'/g, function (_, p) {
      if (routes.indexOf(p) < 0) err(nav, 'nav path ' + p + ' has no <Route> in App.tsx');
    });
    ['data/sampleData.ts', 'shared/api.ts'].forEach(function (p) {
      if (fs.existsSync(path.join(uiSrc, p)) && /sampleData/.test(p)) err(path.join(uiSrc, p), 'template placeholder data file still present');
    });
  }

  var summary = 'validate ' + pkgName + ': ' + Object.keys(types).length + ' types, ' + errors.length + ' errors, ' + warnings.length + ' warnings';
  warnings.forEach(function (w) { process.stdout.write('WARN  ' + w + '\n'); });
  errors.forEach(function (e) { process.stdout.write('ERROR ' + e + '\n'); });
  process.stdout.write(summary + '\n');
  if (errors.length) process.exitCode = 1;
}

main(process.argv);

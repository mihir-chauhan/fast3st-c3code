'use strict';

// Deterministic seed rows (c3-synthetic-data rules): fixed seed, weighted categorical values, bounded normal/uniform
// numbers, ISO-8601 datetimes, references drawn only from parent rows that already exist, free text from the spec's
// literal `rows`/value lists. Or rows loaded from a CSV file.

var fs = require('fs');
var path = require('path');

var DAY = 86400000;

function hashSeed(text) {
  var h = 2166136261;
  for (var i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rng(seed) {
  var s = hashSeed(String(seed)) || 1;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    var t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normal(r) {
  return Math.sqrt(-2 * Math.log(Math.max(r(), 1e-12))) * Math.cos(2 * Math.PI * r());
}

function pickWeighted(r, values) {
  var items = values.map(function (v) { return typeof v === 'object' && v !== null && 'value' in v ? v : { value: v, weight: 1 }; });
  var total = items.reduce(function (s, i) { return s + (i.weight === undefined ? 1 : i.weight); }, 0);
  var t = r() * total;
  for (var i = 0; i < items.length; i++) {
    t -= items[i].weight === undefined ? 1 : items[i].weight;
    if (t <= 0) return items[i].value;
  }
  return items[items.length - 1].value;
}

function round(v, d) {
  var f = Math.pow(10, d === undefined ? 2 : d);
  return Math.round(v * f) / f;
}

function iso(ms) {
  return new Date(ms).toISOString().replace('.000Z', 'Z');
}

/** Reads `a.b` from a row, following `{id}` references into already generated parent rows. */
function readPath(row, p, ent, app, rowsByType) {
  var parts = p.split('.');
  var cur = row;
  var curEnt = ent;
  for (var i = 0; i < parts.length; i++) {
    if (cur == null) return null;
    var v = cur[parts[i]];
    if (i < parts.length - 1) {
      var f = curEnt.fieldByName[parts[i]];
      if (!f || f.kind !== 'ref' || v == null) return null;
      curEnt = app.byName[f.ref];
      cur = rowsByType[f.ref].index[v.id];
    } else return v === undefined ? null : v;
  }
  return null;
}

function genValue(app, ent, f, g, row, i, r, rowsByType) {
  var kind = g.kind;
  if (kind === 'seq') return (g.format || '{n}').replace('{n}', String((g.start || 1) + i));
  if (kind === 'pick') return pickWeighted(r, g.values);
  if (kind === 'pickBy') {
    var key = readPath(row, g.field, ent, app, rowsByType);
    var list = g.values[key] || g.values['*'];
    return list ? pickWeighted(r, list) : null;
  }
  if (kind === 'number' || kind === 'int') {
    var v = g.dist === 'uniform' ? g.min + r() * (g.max - g.min) : g.mean + normal(r) * g.stdDev;
    if (g.min !== undefined) v = Math.max(g.min, v);
    if (g.max !== undefined) v = Math.min(g.max, v);
    if (g.times) {
      var base = readPath(row, g.times, ent, app, rowsByType);
      if (base == null) return null;
      v *= base;
    }
    return round(v, kind === 'int' ? 0 : (g.decimals === undefined ? 2 : g.decimals));
  }
  if (kind === 'bool') return r() < (g.rate === undefined ? 0.5 : g.rate);
  if (kind === 'pattern') {
    return g.pattern.replace(/#/g, function () { return String(Math.floor(r() * 10)); });
  }
  if (kind === 'datetime') {
    var start;
    if (g.after) {
      var a = readPath(row, g.after, ent, app, rowsByType);
      if (a == null) return null;
      start = Date.parse(a);
      var ms = start + ((g.minDays || 0) + r() * ((g.maxDays || 1) - (g.minDays || 0))) * DAY;
      if (g.notAfterAsOf) ms = Math.min(ms, Date.parse(app.asOf + 'T18:00:00Z'));
      return iso(Math.round(ms / 60000) * 60000);
    }
    var anchor = Date.parse(app.asOf + 'T00:00:00Z');
    var from = anchor + (g.fromDays === undefined ? -180 : g.fromDays) * DAY;
    var to = anchor + (g.toDays === undefined ? 0 : g.toDays) * DAY;
    var t = from + r() * (to - from);
    // working hours, whole quarter hours
    var day = Math.floor(t / DAY) * DAY;
    return iso(day + (8 * 60 + Math.floor(r() * 40) * 15) * 60000);
  }
  if (kind === 'ref') {
    if (!rowsByType[f.ref]) throw new Error('spec: list ' + f.ref + ' before ' + ent.name + ' (parents are seeded first)');
    var parents = rowsByType[f.ref].rows;
    if (g.match) {
      var m = parents.filter(function (p) {
        return Object.keys(g.match).every(function (k) { return p[k] === readPath(row, g.match[k], ent, app, rowsByType); });
      });
      if (m.length) parents = m;
    }
    return parents.length ? { id: parents[Math.floor(r() * parents.length)].id } : null;
  }
  throw new Error('spec: ' + ent.name + '.' + f.name + ': unknown gen kind ' + kind);
}

function conditionHolds(app, ent, row, when, rowsByType) {
  return Object.keys(when).every(function (p) {
    return [].concat(when[p]).indexOf(readPath(row, p, ent, app, rowsByType)) >= 0;
  });
}

function defaultGen(f) {
  if (f.kind === 'enum') return { kind: 'pick', values: f.enumDef.values.map(function (v) { return { value: v.label, weight: v.weight }; }) };
  if (f.kind === 'ref') return { kind: 'ref' };
  if (f.kind === 'datetime') return { kind: 'datetime' };
  if (f.kind === 'int') return { kind: 'int', dist: 'uniform', min: 0, max: 100 };
  if (f.kind === 'double') return { kind: 'number', dist: 'uniform', min: 0, max: 100 };
  if (f.kind === 'boolean') return { kind: 'bool' };
  return null;
}

function generateEntity(app, ent, rowsByType) {
  var s = ent.seed;
  if (s.csv) return loadCsv(app, ent, s);
  var base = s.rows || [];
  var count = s.count === undefined ? base.length : s.count;
  if (base.length && count !== base.length && !s.cycleRows) throw new Error('spec: ' + ent.name + '.seed: count must equal rows.length (or set cycleRows)');
  var prefix = s.idPrefix || ('seed_' + ent.name.toLowerCase() + '_');
  var width = s.idWidth || Math.max(3, String((s.idStart || 1) + count - 1).length);
  var r = rng(app.seed + ':' + ent.name);
  var rows = [];
  for (var i = 0; i < count; i++) {
    var row = { id: prefix + String((s.idStart || 1) + i).padStart(width, '0') };
    var b = base.length ? base[i % base.length] : {};
    if (b.id) row.id = b.id;
    if (ent.usesName && b.name !== undefined) row.name = b.name;
    ent.fields.forEach(function (f) {
      if (f.calc) return; // computed by the platform
      if (b[f.name] !== undefined) {
        row[f.name] = f.kind === 'ref' && typeof b[f.name] === 'string' ? { id: b[f.name] } : b[f.name];
        return;
      }
      // `gen` may be a list: the first entry whose `when` holds is used.
      var g = [].concat(f.gen || defaultGen(f) || []).filter(function (x) {
        return !x.when || conditionHolds(app, ent, row, x.when, rowsByType);
      })[0];
      if (!g) return;
      if (g.nullRate && r() < g.nullRate) return;
      var v = genValue(app, ent, f, g, row, i, r, rowsByType);
      if (v !== null && v !== undefined) row[f.name] = v;
    });
    if (ent.usesName && row.name === undefined && s.nameFormat) row.name = s.nameFormat.replace('{n}', String(i + 1));
    rows.push(row);
  }
  return rows;
}

// ---------- CSV ----------

function parseCsv(text) {
  var rows = [];
  var row = [];
  var cur = '';
  var q = false;
  for (var i = 0; i < text.length; i++) {
    var c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); cur = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

function loadCsv(app, ent, s) {
  var file = path.resolve(app.dir, s.csv);
  var table = parseCsv(fs.readFileSync(file, 'utf8'));
  var header = table.shift().map(function (h) { return h.trim(); });
  var map = s.columns || {};
  var prefix = s.idPrefix || ('seed_' + ent.name.toLowerCase() + '_');
  return table.map(function (cells, i) {
    var row = {};
    header.forEach(function (h, j) {
      var fieldName = map[h] || h;
      var raw = cells[j] === undefined ? '' : cells[j].trim();
      if (raw === '') return;
      if (fieldName === 'id') { row.id = raw; return; }
      if (fieldName === 'name' && ent.usesName) { row.name = raw; return; }
      var f = ent.fieldByName[fieldName];
      if (!f) return; // unmapped column
      if (f.kind === 'ref') row[f.name] = { id: raw };
      else if (f.kind === 'int') row[f.name] = parseInt(raw, 10);
      else if (f.kind === 'double') row[f.name] = Number(raw);
      else if (f.kind === 'boolean') row[f.name] = /^(true|1|yes|y)$/i.test(raw);
      else if (f.kind === 'datetime') row[f.name] = new Date(raw).toISOString().replace('.000Z', 'Z');
      else row[f.name] = raw;
    });
    if (!row.id) row.id = prefix + String(i + 1).padStart(3, '0');
    var ordered = { id: row.id };
    Object.keys(row).forEach(function (k) { ordered[k] = row[k]; });
    return ordered;
  });
}

/** Generates (or loads) rows for every entity in spec order; parents must come before children. */
function generateAll(app) {
  var rowsByType = {};
  app.entities.forEach(function (ent) {
    var rows = generateEntity(app, ent, rowsByType);
    var index = {};
    rows.forEach(function (row) { index[row.id] = row; });
    rowsByType[ent.name] = { rows: rows, index: index };
  });
  return rowsByType;
}

module.exports = { generateAll: generateAll, parseCsv: parseCsv, rng: rng };

'use strict';

// Reads the app spec and resolves every name the generators need (type names, enum names, routes, TS names).

var fs = require('fs');
var path = require('path');

var PRIMITIVES = { string: 'string', int: 'number', double: 'number', boolean: 'boolean', datetime: 'string' };

// Platform-owned names the c3-backend-code skill forbids (types) and inherited member names (fields).
var FORBIDDEN_TYPES = ['Batch', 'Tenant', 'Unit', 'Alert', 'Server', 'TestResult', 'Tag', 'Client', 'Event', 'User',
  'Role', 'Workflow', 'Metric', 'Dataset', 'Site', 'Order', 'Job', 'Action', 'Type', 'File', 'Group', 'Status'];
var FORBIDDEN_FIELDS = ['type', 'version', 'id', 'name', 'meta', 'make', 'at', 'scan', 'schema', 'typeIdent'];

var APPEARANCES = ['primary', 'secondary', 'accent', 'success', 'warning', 'danger', 'info'];

function camel(s) {
  var parts = String(s).replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/).filter(Boolean);
  return parts.map(function (p, i) {
    var l = p.toLowerCase();
    return i === 0 ? l : l.charAt(0).toUpperCase() + l.slice(1);
  }).join('');
}
function pascal(s) {
  var c = camel(s);
  return c.charAt(0).toUpperCase() + c.slice(1);
}
function kebab(s) {
  return String(s).replace(/([a-z0-9])([A-Z])/g, '$1-$2').split(/[^A-Za-z0-9]+/).filter(Boolean)
    .map(function (p) { return p.toLowerCase(); }).join('-');
}
function snakeUpper(s) {
  return String(s).replace(/([a-z0-9])([A-Z])/g, '$1_$2').split(/[^A-Za-z0-9]+/).filter(Boolean)
    .map(function (p) { return p.toUpperCase(); }).join('_');
}
function words(s) {
  return String(s).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
}
function titleCase(s) {
  return words(s).split(' ').filter(Boolean).map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1); }).join(' ');
}
function plural(s) {
  if (/[^aeiou]y$/i.test(s)) return s.slice(0, -1) + 'ies';
  if (/(s|x|z|ch|sh)$/i.test(s)) return s + 'es';
  return s + 's';
}

function fail(msg) {
  throw new Error('spec: ' + msg);
}

function load(specPath) {
  var spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  spec.__dir = path.dirname(path.resolve(specPath));
  return normalize(spec);
}

function normalize(spec) {
  if (!/^[a-z][a-zA-Z0-9]*$/.test(spec.package || '')) fail('"package" must be camelCase letters/digits (C3 Code uses pkg<8hex>)');
  var app = {
    pkg: spec.package,
    title: spec.title || titleCase(spec.package),
    description: spec.description || '',
    asOf: spec.asOf || new Date().toISOString().substring(0, 10),
    seed: spec.seed || spec.package,
    dataDir: spec.dataDir || 'data',
    tests: spec.tests !== false,
    header: spec.copyrightHeader === true, // opt-in: C3 Code stamps a C3 AI notice on files it writes
    agentNotes: spec.agentNotes !== false,
    dir: spec.__dir,
    entities: [],
    byName: {},
    enums: {},
    dashboard: null,
    nav: spec.nav || null,
  };
  if (['data', 'test/data'].indexOf(app.dataDir) < 0) fail('"dataDir" must be "data" or "test/data"');

  (spec.entities || []).forEach(function (e) {
    if (!/^[A-Z][A-Za-z0-9]*$/.test(e.name || '')) fail('entity name must be PascalCase: ' + e.name);
    if (FORBIDDEN_TYPES.indexOf(e.name) >= 0) fail('entity name "' + e.name + '" is a platform type name; prefix it with the domain (e.g. Service' + e.name + ')');
    var ent = {
      name: e.name,
      doc: e.doc || ('A ' + words(e.name).toLowerCase() + ' record.'),
      label: e.label || 'name',
      subtitle: e.subtitle || null,
      display: e.plural || titleCase(plural(e.name)),
      singular: e.singular || titleCase(e.name),
      icon: e.icon || 'Database',
      pages: e.pages || ['list', 'detail', 'form'],
      nav: e.nav !== false,
      fields: [],
      enumsLocal: [],
      inverses: [],
      methods: [],
      list: e.list || {},
      map: e.map || null,
      ingest: e.ingest || null, // CSV ingestion pipeline (lib/ingest.js) // { lat, lng, colorBy?, popup?: [paths], title?, description? } -> /<route>/map page

      detail: e.detail || {},
      form: e.form || {},
      seed: e.seed || { count: 10 },
      indexSpec: e.index || null,
      tsName: e.name,
    };
    ent.area = e.area || pascal(ent.display);
    ent.route = e.route || kebab(ent.display);
    ent.varPlural = camel(ent.display);
    ent.usesName = ent.label === 'name' || (e.usesName === true);
    (e.enums || []).forEach(function (en) {
      var full = e.name + '.' + en.name;
      var def = {
        name: full,
        owner: e.name,
        short: en.name,
        doc: en.doc || ('Allowed values of ' + words(en.name).toLowerCase() + ' for a {@link ' + e.name + '}.'),
        values: (en.values || []).map(function (v, i) {
          if (typeof v === 'string') v = { label: v };
          return {
            key: v.key || snakeUpper(v.label),
            label: v.label,
            doc: v.doc || (v.label + '.'),
            appearance: v.appearance || APPEARANCES[(i + 6) % APPEARANCES.length],
            weight: v.weight === undefined ? 1 : v.weight,
          };
        }),
        tsType: e.name + pascal(en.name),
        tsConst: snakeUpper(e.name + '_' + en.name) + '_VALUES',
        tsAppearance: snakeUpper(e.name + '_' + en.name) + '_APPEARANCE',
        badge: e.name + pascal(en.name) + 'Badge',
      };
      def.values.forEach(function (v) {
        if (APPEARANCES.indexOf(v.appearance) < 0) fail(full + '.' + v.key + ': appearance must be one of ' + APPEARANCES.join(', '));
      });
      app.enums[full] = def;
      ent.enumsLocal.push(def);
    });
    ent.rawFields = e.fields || [];
    app.entities.push(ent);
    app.byName[ent.name] = ent;
  });

  app.entities.forEach(function (ent) {
    ent.rawFields.forEach(function (f) {
      if (!/^[a-z][A-Za-z0-9]*$/.test(f.name || '')) fail(ent.name + ': field name must be camelCase: ' + f.name);
      if (FORBIDDEN_FIELDS.indexOf(f.name) >= 0) fail(ent.name + '.' + f.name + ': reserved/inherited member name (use e.g. ' + ent.name.charAt(0).toLowerCase() + ent.name.slice(1) + pascal(f.name) + ')');
      var fld = {
        name: f.name,
        label: f.label || titleCase(f.name),
        doc: f.doc || (titleCase(f.name) + ' of the ' + words(ent.name).toLowerCase() + '.'),
        required: !!f.required,
        multiline: !!f.multiline,
        format: f.format || null,
        gen: f.gen || null,
        auto: f.auto || null, // 'seq' | 'now'
        hidden: !!f.hidden,
        csv: f.csv || null,
        // calc field: "calc": "<expression-engine expression>", "stored": true (default) | false. Not seeded, not in forms.
        calc: f.calc || null,
        stored: f.stored !== false,
      };
      if (f.ref) {
        if (!app.byName[f.ref]) fail(ent.name + '.' + f.name + ': unknown ref ' + f.ref);
        fld.kind = 'ref';
        fld.ref = f.ref;
        fld.tsType = f.ref;
        var parent = app.byName[f.ref];
        var inv = f.inverse === false ? null : (f.inverse || camel(plural(ent.name)));
        if (inv) {
          parent.inverses.push({
            name: inv,
            child: ent.name,
            field: f.name,
            label: f.inverseLabel || titleCase(plural(ent.name)),
            doc: f.inverseDoc || (titleCase(plural(ent.name)) + ' linked to this ' + words(parent.name).toLowerCase() + ' (inverse of {@link ' + ent.name + '#' + f.name + '}).'),
          });
        }
      } else if (f.enum) {
        var full = f.enum.indexOf('.') >= 0 ? f.enum : ent.name + '.' + f.enum;
        if (!app.enums[full]) fail(ent.name + '.' + f.name + ': unknown enum ' + full);
        fld.kind = 'enum';
        fld.enumName = full;
        fld.enumDef = app.enums[full];
        fld.tsType = fld.enumDef.tsType;
        fld.badge = f.badge !== false;
      } else {
        var t = f.type || 'string';
        if (!PRIMITIVES[t]) fail(ent.name + '.' + f.name + ': type must be one of ' + Object.keys(PRIMITIVES).join(', '));
        fld.kind = t;
        fld.tsType = PRIMITIVES[t];
      }
      ent.fields.push(fld);
    });
    ent.fieldByName = {};
    ent.fields.forEach(function (f) { ent.fieldByName[f.name] = f; });
    if (!ent.usesName && !ent.fieldByName[ent.label]) fail(ent.name + ': label field "' + ent.label + '" is not declared');
    // `name` is the built-in field every entity inherits; it is never declared.
    ent.labelField = ent.usesName ? { name: 'name', label: 'Name', kind: 'string', tsType: 'string', required: true, doc: 'Display name (inherited `name`).' } : ent.fieldByName[ent.label];
    ent.allFields = (ent.usesName ? [ent.labelField] : []).concat(ent.fields);
    ent.index = ent.indexSpec || defaultIndex(ent);
  });

  if (spec.dashboard) {
    var d = spec.dashboard;
    var ent = app.byName[d.entity];
    if (!ent) fail('dashboard.entity must be one of the entities');
    app.dashboard = {
      entity: ent,
      title: d.title || (app.title + ' Dashboard'),
      description: d.description || '',
      kpis: (d.kpis || []).map(function (k) {
        var key = k.key || camel(k.label);
        return Object.assign({ key: key, agg: 'count', format: 'number' }, k, { key: key });
      }),
      charts: (d.charts || []).map(function (c, i) {
        var key = c.key || camel(c.title || ('chart ' + i));
        return Object.assign({ span: 1, kind: 'bar' }, c, { key: key });
      }),
      recent: d.recent || null,
    };
    ent.methods.push({ name: 'dashboardSummary' });
  }
  if (spec.access) {
    // Role-based access (c3-access-control): metadata/Role/<id>.json + seed/UserGroup/<id>.json per role, an access type
    // whose mine() tells the UI what the caller may do. Each role: { id, label, description, read: "*" | [entities],
    // write: [entities] (create + merge), delete: [entities] (remove), nested: [role ids] }.
    var ac = spec.access;
    app.access = {
      type: ac.type || 'AppAccess',
      roles: (ac.roles || []).map(function (r) {
        if (!/^[A-Z][A-Za-z0-9]*$/.test(r.id || '')) fail('access role id must be PascalCase letters/digits: ' + r.id);
        var list = function (v) {
          var names = v === '*' ? app.entities.map(function (e) { return e.name; }) : (v || []);
          names.forEach(function (n) { if (!app.byName[n]) fail('access role ' + r.id + ': unknown entity ' + n); });
          return names;
        };
        return { id: r.id, label: r.label || r.id, description: r.description || ('Application role ' + r.id + '.'),
          read: list(r.read), write: list(r.write), remove: list(r.delete), nested: r.nested || [] };
      }),
    };
    if (!/^[A-Z][A-Za-z0-9]*$/.test(app.access.type)) fail('access.type must be PascalCase');
  }
  return app;
}

function defaultIndex(ent) {
  var idx = [];
  ent.fields.forEach(function (f) {
    if (f.kind === 'enum' || f.kind === 'ref' || f.kind === 'datetime' || f.name === ent.label) idx.push(f.name);
  });
  return idx;
}

/** Resolves a dotted path (e.g. `site.region`) from an entity to its field definition. */
function resolvePath(app, ent, p) {
  var parts = p.split('.');
  var cur = ent;
  var fld = null;
  for (var i = 0; i < parts.length; i++) {
    var name = parts[i];
    if (name === 'name' && cur.usesName) fld = cur.labelField;
    else fld = cur.fieldByName[name];
    if (!fld) fail('unknown path ' + ent.name + '.' + p);
    if (i < parts.length - 1) {
      if (fld.kind !== 'ref') fail('path ' + p + ' goes through a non-reference field');
      cur = app.byName[fld.ref];
    }
  }
  return { field: fld, owner: cur };
}

module.exports = {
  load: load,
  normalize: normalize,
  resolvePath: resolvePath,
  camel: camel,
  pascal: pascal,
  kebab: kebab,
  snakeUpper: snakeUpper,
  titleCase: titleCase,
  plural: plural,
  words: words,
  FORBIDDEN_FIELDS: FORBIDDEN_FIELDS,
  FORBIDDEN_TYPES: FORBIDDEN_TYPES,
};

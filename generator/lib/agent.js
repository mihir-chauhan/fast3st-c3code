'use strict';

// In-app AI agent ("chat with your data") for a generated app, emitted the way C3 Code built the lab3 "Support
// Analyst" (knowledge/13-lab3-agents-ml.md §3B, source mirrored in backbones/lab3agent):
//   - a GenaiCore.Agent.LangChain agent (Agent Gallery), Model Hub completion client, Kv short-term memory;
//   - purpose-built read-only js-server tool methods wrapped as GenaiCore.Tool.C3Method (createFromMethodName),
//     flat optional string filters, results with primitive fields only (groups as json);
//   - a py entry type with ensureAgent(publish) (idempotent create / createNewVersion) and ask(question, sessionId);
//   - an Assistant page that calls <Agent>.ask through c3Call and round-trips the session id.
// Addition over lab3: an optional write tool that only PROPOSES a change (a <Agent>.PendingChange row). The change is
// applied only when the user clicks Confirm on the Assistant page (<Agent>.confirmChange), so the agent itself has no
// path that writes app data. The platform's own HITL switch (toolCallConfirmationMode NONE|ALL) is all-or-nothing.
//
// Entry points used by gen.js: normalize(rawSpec, app) -> agent model or null; emit(app, agent, ctx) writes the files
// and patches the manifest, App.tsx, navigation.ts, WORKSPACE_SUMMARY.md and CLAUDE.md that gen.js already wrote.

var fs = require('fs');
var path = require('path');
var M = require('./model');

var JS_HEADER = '/*\n * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.\n * Confidential and Proprietary C3 Materials.\n */\n\n';
var PY_HEADER = '#\n# Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.\n# Confidential and Proprietary C3 Materials.\n#\n\n';
var GENERIC_TOOLS = ['entityFieldRetriever', 'entityDataRetriever', 'search_types_bm25', 'get_type_definitions', 'getEntityTypes'];

function fail(msg) {
  throw new Error('spec.agent: ' + msg);
}

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

function q(s) {
  return "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
}

/** Parameter / field name for a path: `customer.tier` -> `customerTier`. */
function pathName(p) {
  return M.camel(p.split('.').join(' '));
}

/** Resolves a path on an entity; a bare reference field resolves to the referenced entity's label. */
function resolve(app, ent, p) {
  var r = M.resolvePath(app, ent, p);
  var f = r.field;
  if (f.kind === 'ref') {
    var target = app.byName[f.ref];
    return { path: p + '.' + target.labelField.name, field: target.labelField, label: p, kind: target.labelField.kind, enumDef: null };
  }
  return { path: p, field: f, label: p, kind: f.kind, enumDef: f.enumDef || null };
}

function valuesHint(r) {
  if (r.enumDef) return r.enumDef.values.map(function (v) { return v.label; }).join(', ');
  return null;
}

function normalize(spec, app) {
  var a = spec.agent;
  if (!a) return null;
  if (!a.name) fail('"name" is required (the agent name shown in the Agent Gallery)');
  var ag = {
    name: a.name,
    type: a.type || M.pascal(a.name),
    category: a.category || 'General',
    description: a.description || ('Read-only assistant over this app\'s data.'),
    llmClient: a.llmClient || 'default-completions',
    route: a.route || 'assistant',
    label: a.label || 'Assistant',
    icon: a.icon || 'Bot',
    instructions: [].concat(a.instructions || []),
    suggestions: a.suggestions || [],
    genericTools: a.genericTools || [],
    sessionStore: a.sessionStore || 'langchain_agent_session_store',
    tools: [],
    write: null,
    dependencies: a.dependencies || { genAiUi: '8.12' },
  };
  if (!/^[A-Z][A-Za-z0-9]*$/.test(ag.type)) fail('"type" must be PascalCase');
  if (app.byName[ag.type]) fail('"type" ' + ag.type + ' clashes with an entity');
  ag.genericTools.forEach(function (t) {
    if (GENERIC_TOOLS.indexOf(t) < 0) fail('genericTools: unknown provisioned tool ' + t + ' (known: ' + GENERIC_TOOLS.join(', ') + ')');
  });
  var names = {};
  (a.tools || []).forEach(function (t) {
    if (!/^[a-z][A-Za-z0-9]*$/.test(t.name || '')) fail('tool name must be camelCase: ' + t.name);
    if (names[t.name]) fail('duplicate tool ' + t.name);
    names[t.name] = true;
    var ent = app.byName[t.entity];
    if (!ent) fail(t.name + ': unknown entity ' + t.entity);
    var tool = { name: t.name, kind: t.kind, entity: ent, doc: t.doc || null, filters: [], groupBy: [], measures: [], text: [], columns: [], dateField: null };
    if (['stats', 'search'].indexOf(t.kind) < 0) fail(t.name + ': kind must be stats or search');
    (t.filters || []).forEach(function (p) {
      var r = resolve(app, ent, p);
      if (['string', 'enum'].indexOf(r.kind) < 0) fail(t.name + ': filter ' + p + ' must be a string or enum field');
      r.param = pathName(p);
      tool.filters.push(r);
    });
    if (t.dateField) {
      var d = resolve(app, ent, t.dateField);
      if (d.kind !== 'datetime') fail(t.name + ': dateField ' + t.dateField + ' is not a datetime');
      tool.dateField = d;
    }
    if (t.kind === 'stats') {
      (t.groupBy || []).forEach(function (p) {
        if (p === 'month') {
          if (!tool.dateField) fail(t.name + ': groupBy month needs dateField');
          tool.groupBy.push({ key: 'month', path: tool.dateField.path, month: true });
          return;
        }
        var r = resolve(app, ent, p);
        tool.groupBy.push({ key: pathName(p), path: r.path, month: false, r: r });
      });
      (t.measures || []).forEach(function (m) {
        var r = resolve(app, ent, m.field);
        if (['int', 'double'].indexOf(r.kind) < 0) fail(t.name + ': measure field ' + m.field + ' must be int or double');
        if (['avg', 'sum', 'min', 'max'].indexOf(m.agg) < 0) fail(t.name + ': measure agg must be avg, sum, min or max');
        tool.measures.push({ key: m.key || M.camel(m.agg + ' ' + m.field), agg: m.agg, path: r.path, label: m.label || (m.agg + ' of ' + m.field) });
      });
    } else {
      tool.text = (t.text || []).map(function (p) { return resolve(app, ent, p); });
      tool.limit = t.limit || 20;
      var cols = t.columns || [ent.labelField.name];
      tool.columns = cols.map(function (p) {
        var r = resolve(app, ent, p);
        r.prop = pathName(p);
        // `id` / `name` collide with inherited members (validate.js); prefix them with the entity
        if (r.prop === 'id' || r.prop === 'name') r.prop = M.camel(ent.name + ' ' + r.prop);
        return r;
      });
      tool.hitType = ag.type + '.' + M.pascal(t.name) + 'Hit';
    }
    ag.tools.push(tool);
  });
  if (a.write) {
    var w = a.write;
    var went = app.byName[w.entity];
    if (!went) fail('write: unknown entity ' + w.entity);
    if (!/^[a-z][A-Za-z0-9]*$/.test(w.name || '')) fail('write.name must be camelCase');
    var key = w.key ? went.fieldByName[w.key] || (w.key === 'name' && went.usesName ? went.labelField : null) : went.labelField;
    if (!key) fail('write.key ' + w.key + ' is not a field of ' + went.name);
    ag.write = {
      name: w.name,
      entity: went,
      key: key,
      fields: (w.fields || []).map(function (fn) {
        var f = went.fieldByName[fn];
        if (!f) fail('write: ' + went.name + ' has no field ' + fn);
        if (['enum', 'string', 'int', 'double'].indexOf(f.kind) < 0) fail('write: field ' + fn + ' must be enum, string or number');
        return f;
      }),
    };
    if (!ag.write.fields.length) fail('write.fields must list at least one field');
  }
  if (!ag.tools.length) fail('at least one tool is required');
  return ag;
}

// ---------------------------------------------------------------------------------------------------------- c3typ

function filterParamDocs(tool) {
  return tool.filters.map(function (f) {
    var hint = valuesHint(f);
    return '@param ' + f.param + ' ' + (hint ? 'Filter on ' + f.label + ': ' + hint + '. ' : 'Filter on ' + f.label + ' (exact, case-insensitive). ') +
      'Comma-separate several values; empty means any.';
  });
}

function dateParamDocs(tool) {
  if (!tool.dateField) return [];
  return ['@param ' + tool.dateField.label + 'From Only records with ' + tool.dateField.label + ' on or after this date (YYYY-MM-DD).',
    '@param ' + tool.dateField.label + 'To Only records with ' + tool.dateField.label + ' before this date (YYYY-MM-DD).'];
}

function filterSig(tool) {
  return tool.filters.map(function (f) { return f.param + ': string'; })
    .concat(tool.dateField ? [tool.dateField.label + 'From: string', tool.dateField.label + 'To: string'] : []);
}

function toolDoc(ag, tool) {
  var en = M.words(tool.entity.name).toLowerCase();
  if (tool.kind === 'stats') {
    return (tool.doc || ('Read-only ' + en + ' counts for the "' + ag.name + '" agent. Counts the ' + M.plural(en) +
      ' that match the optional filters and, unless groupBy is none, breaks the count down by one dimension' +
      (tool.measures.length ? ', with ' + tool.measures.map(function (m) { return m.label; }).join(' and ') + ' per group' : '') + '.')) +
      ' Use it for every count, share, breakdown, ranking or trend question.\n\n' +
      ['@param groupBy One of: none, ' + tool.groupBy.map(function (g) { return g.key; }).join(', ') + '.'].concat(filterParamDocs(tool), dateParamDocs(tool))
        .concat(['@return the total, per-group counts' + (tool.measures.length ? ' and measures' : '') + ', and the filters applied.']).join('\n');
  }
  return (tool.doc || ('Read-only ' + en + ' search for the "' + ag.name + '" agent. Returns ' + M.plural(en) +
    (tool.text.length ? ' whose ' + tool.text.map(function (t) { return t.label; }).join(', ') + ' contains the text (case-insensitive)' : '') +
    ' and that match the optional filters, ' + (tool.dateField ? 'newest first' : 'sorted by ' + tool.entity.labelField.name) + '.')) +
    ' Use it to find or list specific records or read their details; use a stats tool for counts.\n\n' +
    ['@param text Free text to look for; empty matches every record.'].concat(filterParamDocs(tool), dateParamDocs(tool),
      ['@param limit Maximum rows to return (default ' + tool.limit + ', max 50).', '@return matching records with their main fields.']).join('\n');
}

function agentTyp(app, ag) {
  var T = ag.type;
  var out = doc('Server-side entry point and tools of the "' + ag.name + '" AI agent: a {@link GenaiCore.Agent.LangChain} agent ' +
    '(Agent Gallery, category "' + ag.category + '") that answers questions about the data of this app with the read-only tool methods ' +
    'below (wrapped as {@link GenaiCore.Tool.C3Method})' + (ag.genericTools.length ? ' plus the provisioned ' + ag.genericTools.join(', ') + ' tools' : '') +
    '. It runs inside this app as the calling user, so it needs no app connection and sees exactly the data that user can read.' +
    (ag.write ? ' The agent cannot write: {@link ' + T + '#' + ag.write.name + '} only records a {@link ' + T + '.PendingChange}, which the ' +
      'user applies with {@link ' + T + '#confirmChange} from the Assistant page.' : ''));
  out += 'type ' + T + ' {\n\n';
  out += doc('Creates the tools of the agent and the agent, or a new agent version when its prompt, model or tools changed. ' +
    'Idempotent: when the latest version already matches, nothing is written.\n\n' +
    '@param publish If true, also publishes the agent into this package (dev mode only) so other environments get it as seed data.\n' +
    '@return the id of the latest {@link GenaiCore.Agent} version named "' + ag.name + '".', '  ');
  out += '  ensureAgent: function(publish: boolean): !string py\n\n';
  out += doc('Asks the agent a question and waits for the answer.\n\n@param question The question of the user.\n' +
    '@param sessionId Conversation id from a previous {@link ' + T + '.Reply#sessionId}; empty starts a new conversation.\n' +
    '@return the answer of the agent plus the session and run ids.', '  ');
  out += '  ask: function(question: !string, sessionId: string): !' + T + '.Reply py\n';
  var many = false;
  ag.tools.forEach(function (tool) {
    var sig;
    if (tool.kind === 'stats') sig = ['groupBy: !string'].concat(filterSig(tool));
    else sig = ['text: string'].concat(filterSig(tool), ['limit: int']);
    if (sig.length > 5) many = true;
    out += '\n' + (sig.length > 5 ? '  // c3-analysis-disable c3-excessive-method-params -- flat optional filters are easier for an LLM tool caller than a spec object.\n' : '');
    out += doc(toolDoc(ag, tool), '  ');
    var ret = tool.kind === 'stats' ? '!' + T + '.Stats' : '![' + tool.hitType + ']';
    out += '  ' + tool.name + ': function(' + sig.join(', ') + '): ' + ret + ' js-server\n';
    if (sig.length > 5) out += '  // c3-analysis-enable c3-excessive-method-params\n';
  });
  if (ag.write) {
    var w = ag.write;
    var en = M.words(w.entity.name).toLowerCase();
    out += '\n' + doc('Agent tool: PROPOSES a change to one ' + en + ' and returns a description of the proposal. It does NOT change the ' + en +
      ': the proposal is stored as a {@link ' + T + '.PendingChange} that the user must confirm on the Assistant page. Only call it ' +
      'when the user explicitly asks for a change.\n\n' +
      '@param ' + w.key.name + ' The ' + en + ' to change, by ' + w.key.label + ' (e.g. as shown by the search tool).\n' +
      w.fields.map(function (f) {
        var hint = f.enumDef ? ': ' + f.enumDef.values.map(function (v) { return v.label; }).join(', ') : '';
        return '@param ' + f.name + ' New ' + f.label.toLowerCase() + hint + '; empty leaves it unchanged.';
      }).join('\n') + '\n@param reason Why the change is requested, in the words of the user.\n@return what was proposed and that it awaits the user\'s confirmation.', '  ');
    out += '  ' + w.name + ': function(' + [w.key.name + ': !string'].concat(w.fields.map(function (f) { return f.name + ': string'; }), ['reason: string']).join(', ') + '): !string js-server\n';
    out += '\n' + doc('Applies a pending change proposed by the agent. Called by the Assistant page when the user clicks Confirm; it is not an agent tool.\n\n' +
      '@param changeId Id of the {@link ' + T + '.PendingChange}.\n@return a description of what was applied.', '  ');
    out += '  confirmChange: function(changeId: !string): !string js-server\n';
    out += '\n' + doc('Discards a pending change without applying it. Called by the Assistant page; not an agent tool.\n\n' +
      '@param changeId Id of the {@link ' + T + '.PendingChange}.\n@return a short confirmation.', '  ');
    out += '  discardChange: function(changeId: !string): !string js-server\n';
  }
  void many;
  return out + '}\n';
}

function valueTyp(name, text, fields) {
  var out = doc(text) + 'type ' + name + ' {\n';
  fields.forEach(function (f, i) {
    out += (i ? '\n' : '\n') + doc(f[2], '  ') + '  ' + f[0] + ': ' + f[1] + '\n';
  });
  return out + '}\n';
}

function replyTyp(ag) {
  return valueTyp(ag.type + '.Reply', 'One answer from the "' + ag.name + '" agent, returned by {@link ' + ag.type + '#ask} to the Assistant page.', [
    ['answer', 'string', 'The answer of the agent as markdown text.'],
    ['sessionId', 'string', 'Conversation id; pass it back to {@link ' + ag.type + '#ask} to continue the same conversation.'],
    ['runId', 'string', 'Id of the {@link GenaiCore.Agent.Run} that produced the answer (for traces and feedback).'],
    ['status', 'string', 'Final {@link GenaiCore.Agent.Run} status, e.g. `completed` or `failed`.'],
    ['seconds', 'double', 'Wall-clock seconds the agent took to answer.'],
  ]);
}

function statsTyp(ag) {
  return valueTyp(ag.type + '.Stats', 'Read-only counts returned by the "' + ag.name + '" stats tools. Agent tool results must have primitive fields, ' +
    'so the groups are JSON.', [
    ['groupBy', 'string', 'The grouping that was applied, or `none`.'],
    ['total', 'int', 'Number of records matching the filters.'],
    ['buckets', 'json', 'Per-group results as a JSON array of `{"key": <group value>, "count": <n>, <measure>: <value>}`, largest count first ' +
      '(months in calendar order); empty when groupBy is none. Empty group values are reported as `(none)`.'],
    ['measures', 'json', 'Measures over all matching records as a JSON object (e.g. averages); empty when the tool has no measures.'],
    ['appliedFilters', 'string', 'Human-readable description of the filters that were applied.'],
  ]);
}

function hitTyp(ag, tool) {
  var fields = [['recordId', 'string', 'Id of the {@link ' + tool.entity.name + '}.']];
  tool.columns.forEach(function (c) {
    fields.push([c.prop, 'string', c.field.doc ? c.field.doc.replace(/\s+/g, ' ') + (c.prop === 'description' ? ' Truncated to 400 characters.' : '') : c.label + '.']);
  });
  return valueTyp(tool.hitType, 'Compact ' + M.words(tool.entity.name).toLowerCase() + ' row returned by {@link ' + ag.type + '#' + tool.name +
    '}; used as an AI agent tool result, so every field is a string.', fields);
}

function pendingTyp(ag) {
  var T = ag.type;
  var out = doc('A change proposed by the "' + ag.name + '" agent through {@link ' + T + '#' + ag.write.name + '}. Nothing is changed until the user ' +
    'confirms it on the Assistant page ({@link ' + T + '#confirmChange}) or discards it ({@link ' + T + '#discardChange}). The inherited ' +
    '`name` holds a one-line summary.');
  out += "@db(index=['state'])\nentity type " + T + '.PendingChange {\n';
  [['targetType', 'string', 'Type of the record to change.'],
    ['targetId', 'string', 'Id of the record to change.'],
    ['targetLabel', 'string', 'Display label of the record to change (e.g. its number).'],
    ['changes', 'string', 'JSON object `{"<field>": {"from": <old>, "to": <new>}}` of the proposed field changes.'],
    ['reason', 'string', 'Why the change was requested, as given to the agent.'],
    ['state', 'string', 'Pending, Applied or Discarded.'],
    ['decidedAt', 'datetime', 'When the user confirmed or discarded the change.']].forEach(function (f) {
    out += '\n' + doc(f[2], '  ') + '  ' + f[0] + ': ' + f[1] + '\n';
  });
  return out + '}\n';
}

// ---------------------------------------------------------------------------------------------------------- js

function toolJs(app, ag) {
  var T = ag.type;
  var out = app.header ? JS_HEADER : '';
  out += "var log = Logger.for('" + T + "');\n\n";
  out += [
    '// Read-only agent tools. Enum filters are canonicalised (case-insensitive) and applied in the database; other string',
    '// filters, grouping and measures are applied while streaming the matching rows (fetchObjStream).',
    '',
    '/** Splits a comma-separated filter value into trimmed, non-empty values. */',
    'function splitValues(value) {',
    "  if (value === null || value === undefined) return [];",
    "  return String(value).split(',').map(function (v) { return v.trim(); }).filter(function (v) { return v.length > 0; });",
    '}',
    '',
    '/** Maps user values onto the enum labels (case-insensitive); throws with the allowed values on a miss. */',
    'function canonical(param, value, allowed) {',
    '  return splitValues(value).map(function (v) {',
    '    for (var i = 0; i < allowed.length; i++) {',
    '      if (allowed[i].toLowerCase() === v.toLowerCase()) return allowed[i];',
    '    }',
    "    throw new Error('Unknown ' + param + ' \"' + v + '\". Use one of: ' + allowed.join(', '));",
    '  });',
    '}',
    '',
    '/** Lower-cased lookup set for in-memory matching, or null when the filter is not set. */',
    'function valueSet(value) {',
    '  var vals = splitValues(value);',
    '  if (vals.length === 0) return null;',
    '  var set = {};',
    '  vals.forEach(function (v) { set[v.toLowerCase()] = true; });',
    '  return set;',
    '}',
    '',
    '/** Reads a dotted path from a fetched object (references are included objects). */',
    'function read(obj, path) {',
    "  var parts = path.split('.');",
    '  var cur = obj;',
    '  for (var i = 0; i < parts.length; i++) {',
    '    if (cur === null || cur === undefined) return null;',
    '    cur = cur[parts[i]];',
    '  }',
    '  return cur === undefined ? null : cur;',
    '}',
    '',
    '/** ISO date part of a user date (YYYY-MM-DD...), or throws. */',
    'function isoDate(param, value) {',
    '  var s = String(value).trim();',
    '  if (!/^\\d{4}-\\d{2}-\\d{2}/.test(s)) throw new Error(param + \' must be a date like 2026-10-01, got \"\' + s + \'\"\');',
    '  return s.substring(0, 10);',
    '}',
    '',
    '/** Database filter: enum values via Filter.intersects, dates via dateTime() expressions. */',
    'function dbFilter(enumClauses, dateClauses) {',
    '  var f = null;',
    '  enumClauses.forEach(function (c) {',
    '    if (c.values.length) f = f ? f.and().intersects(c.path, c.values) : Filter.intersects(c.path, c.values);',
    '  });',
    "  var expr = dateClauses.join(' && ');",
    '  if (!expr) return f;',
    '  return f ? f.and(expr) : expr;',
    '}',
    '',
    '/** Streams the rows matching the filter spec `fs` and calls `fn(obj)` for each one that also passes the in-memory filters. */',
    'function eachMatching(type, include, order, fs, fn) {',
    '  var enumClauses = [];',
    '  var dateClauses = [];',
    '  var sets = [];',
    '  fs.filters.forEach(function (f) {',
    '    if (f.allowed) enumClauses.push({ path: f.path, values: canonical(f.param, f.value, f.allowed) });',
    '    else {',
    '      var s = valueSet(f.value);',
    '      if (s) sets.push({ path: f.path, set: s });',
    '    }',
    '  });',
    "  if (fs.dateFrom) dateClauses.push(fs.datePath + \" >= dateTime('\" + isoDate('from', fs.dateFrom) + \"')\");",
    "  if (fs.dateTo) dateClauses.push(fs.datePath + \" < dateTime('\" + isoDate('to', fs.dateTo) + \"')\");",
    '  var spec = { include: include };',
    '  if (order) spec.order = order;',
    '  var filter = dbFilter(enumClauses, dateClauses);',
    '  if (filter) spec.filter = filter;',
    '  type.fetchObjStream(spec).each(function (obj) {',
    '    for (var i = 0; i < sets.length; i++) {',
    '      var v = read(obj, sets[i].path);',
    "      if (sets[i].set[String(v === null ? '' : v).toLowerCase()] !== true) return;",
    '    }',
    '    fn(obj);',
    '  });',
    '}',
    '',
    'function describeFilters(fs) {',
    '  var parts = [];',
    '  fs.filters.forEach(function (f) {',
    "    if (splitValues(f.value).length) parts.push(f.param + '=' + splitValues(f.value).join('|'));",
    '  });',
    "  if (fs.dateFrom) parts.push('from=' + fs.dateFrom);",
    "  if (fs.dateTo) parts.push('to=' + fs.dateTo);",
    "  return parts.length ? parts.join('; ') : 'none';",
    '}',
    '',
    'function fmtValue(v) {',
    "  if (v === null || v === undefined) return '';",
    '  return String(v);',
    '}',
    '',
    '/** Rounds a measure to 2 decimals (null when there were no values). */',
    'function measureValue(m) {',
    '  if (!m.n) return null;',
    "  var v = m.agg === 'avg' ? m.sum / m.n : m.agg === 'sum' ? m.sum : m.agg === 'min' ? m.min : m.max;",
    '  return Math.round(v * 100) / 100;',
    '}',
    '',
    'function addMeasure(m, v) {',
    '  if (v === null || v === undefined) return;',
    '  var x = Number(v);',
    '  m.n++;',
    '  m.sum += x;',
    '  m.min = m.min === null ? x : Math.min(m.min, x);',
    '  m.max = m.max === null ? x : Math.max(m.max, x);',
    '}',
    '',
  ].join('\n') + '\n';

  ag.tools.forEach(function (tool) {
    var E = tool.entity.name;
    var params = (tool.kind === 'stats' ? ['groupBy'] : ['text']).concat(tool.filters.map(function (f) { return f.param; }),
      tool.dateField ? [tool.dateField.label + 'From', tool.dateField.label + 'To'] : [], tool.kind === 'search' ? ['limit'] : []);
    var fsLines = '  var fs = {\n    filters: [\n' + tool.filters.map(function (f) {
      return '      { param: ' + q(f.param) + ', path: ' + q(f.path) + ', value: ' + f.param + ', allowed: ' +
        (f.enumDef ? '[' + f.enumDef.values.map(function (v) { return q(v.label); }).join(', ') + ']' : 'null') + ' },';
    }).join('\n') + '\n    ],\n' +
      (tool.dateField ? '    datePath: ' + q(tool.dateField.path) + ',\n    dateFrom: ' + tool.dateField.label + 'From,\n    dateTo: ' + tool.dateField.label + 'To,\n' : '') +
      '  };\n';
    if (tool.kind === 'stats') {
      var paths = ['id'].concat(tool.filters.map(function (f) { return f.path; }), tool.groupBy.map(function (g) { return g.path; }),
        tool.measures.map(function (m) { return m.path; }));
      if (tool.dateField) paths.push(tool.dateField.path);
      var include = paths.filter(function (p, i) { return paths.indexOf(p) === i; }).join(', ');
      out += 'var ' + M.snakeUpper(tool.name) + '_GROUPS = {\n  none: null,\n' + tool.groupBy.map(function (g) {
        return '  ' + g.key + ': ' + q(g.path) + ',';
      }).join('\n') + '\n};\n\n';
      out += 'function ' + tool.name + '(' + params.join(', ') + ') {\n';
      out += "  var g = String(groupBy || 'none').trim();\n";
      out += '  var groups = ' + M.snakeUpper(tool.name) + '_GROUPS;\n';
      out += '  var key = Object.keys(groups).filter(function (k) { return k.toLowerCase() === g.toLowerCase(); })[0];\n';
      out += "  if (!key) throw new Error('Unsupported groupBy \"' + g + '\". Use one of: ' + Object.keys(groups).join(', '));\n";
      out += fsLines;
      out += '  var measureDefs = [' + tool.measures.map(function (m) { return '{ key: ' + q(m.key) + ', agg: ' + q(m.agg) + ', path: ' + q(m.path) + ' }'; }).join(', ') + '];\n';
      out += '  var newMeasures = function () {\n    return measureDefs.map(function (d) { return { agg: d.agg, n: 0, sum: 0, min: null, max: null }; });\n  };\n';
      out += '  var total = 0;\n  var all = newMeasures();\n  var buckets = {};\n';
      out += '  eachMatching(' + E + ', ' + q(include) + ', null, fs, function (obj) {\n';
      out += '    total++;\n    measureDefs.forEach(function (d, i) { addMeasure(all[i], read(obj, d.path)); });\n';
      out += "    if (key === 'none') return;\n";
      out += '    var v = read(obj, groups[key]);\n';
      out += "    var k = v === null || v === '' ? '(none)' : " + (tool.groupBy.some(function (x) { return x.month; }) ? "key === 'month' ? String(v).substring(0, 7) : String(v)" : 'String(v)') + ';\n';
      out += '    var b = buckets[k] || (buckets[k] = { count: 0, m: newMeasures() });\n';
      out += '    b.count++;\n    measureDefs.forEach(function (d, i) { addMeasure(b.m[i], read(obj, d.path)); });\n  });\n';
      out += '  var keys = Object.keys(buckets).sort(function (a, b) {\n';
      out += "    if (key === 'month') return a < b ? -1 : a > b ? 1 : 0;\n";
      out += '    return buckets[b].count - buckets[a].count || (a < b ? -1 : a > b ? 1 : 0);\n  });\n';
      out += '  var rows = keys.map(function (k) {\n    var row = { key: k, count: buckets[k].count };\n';
      out += '    measureDefs.forEach(function (d, i) { row[d.key] = measureValue(buckets[k].m[i]); });\n    return row;\n  });\n';
      out += '  var measures = {};\n  measureDefs.forEach(function (d, i) { measures[d.key] = measureValue(all[i]); });\n';
      out += "  log.info('" + tool.name + " groupBy={} total={}', key, total);\n";
      out += '  return ' + T + '.Stats.make({ groupBy: key, total: total, buckets: rows, measures: measures, appliedFilters: describeFilters(fs) });\n}\n\n';
    } else {
      var spaths = ['id'].concat(tool.filters.map(function (f) { return f.path; }), tool.text.map(function (t) { return t.path; }), tool.columns.map(function (c) { return c.path; }));
      if (tool.dateField) spaths.push(tool.dateField.path);
      var sinclude = spaths.filter(function (p, i) { return spaths.indexOf(p) === i; }).join(', ');
      var order = tool.dateField ? 'descending(' + tool.dateField.path + ')' : 'ascending(' + tool.entity.labelField.name + ')';
      out += 'function ' + tool.name + '(' + params.join(', ') + ') {\n';
      out += '  var max = limit && limit > 0 ? Math.min(limit, 50) : ' + tool.limit + ';\n';
      out += "  var needle = text ? String(text).trim().toLowerCase() : '';\n";
      out += fsLines;
      out += '  var hits = ' + tool.hitType + '.arrayBuilder();\n  var n = 0;\n';
      out += '  eachMatching(' + E + ', ' + q(sinclude) + ', ' + q(order) + ', fs, function (obj) {\n';
      out += '    if (n >= max) return;\n';
      if (tool.text.length) {
        out += '    if (needle) {\n      var hay = [' + tool.text.map(function (t) { return 'read(obj, ' + q(t.path) + ')'; }).join(', ') + "].join(' ').toLowerCase();\n";
        out += '      if (hay.indexOf(needle) < 0) return;\n    }\n';
      }
      out += '    n++;\n';
      out += '    hits.add(' + tool.hitType + '.make({\n      recordId: obj.id,\n' + tool.columns.map(function (c) {
        var v = 'fmtValue(read(obj, ' + q(c.path) + '))';
        if (c.prop === 'description' || c.field.multiline) v = 'truncate(' + v + ')';
        return '      ' + c.prop + ': ' + v + ',';
      }).join('\n') + '\n    }));\n  });\n';
      out += "  log.info('" + tool.name + " returned {} rows', n);\n";
      out += '  return hits.build();\n}\n\n';
    }
  });
  if (/truncate\(/.test(out)) {
    out = out.replace("function fmtValue(v) {", "/** Long text is cut to 400 characters so tool results stay small. */\nfunction truncate(s) {\n  return s.length > 400 ? s.substring(0, 400) + '…' : s;\n}\n\nfunction fmtValue(v) {");
  }
  if (ag.write) out += writeJs(app, ag);
  return out;
}

function writeJs(app, ag) {
  var T = ag.type;
  var w = ag.write;
  var E = w.entity.name;
  var out = '// ---------------------------------------------------------------------------------------------------------------\n' +
    '// Write path: the agent can only PROPOSE; the user applies the change from the Assistant page.\n' +
    '// ---------------------------------------------------------------------------------------------------------------\n\n';
  out += 'var WRITE_FIELDS = [\n' + w.fields.map(function (f) {
    return '  { name: ' + q(f.name) + ', label: ' + q(f.label) + ', kind: ' + q(f.kind) + ', allowed: ' +
      (f.enumDef ? '[' + f.enumDef.values.map(function (v) { return q(v.label); }).join(', ') + ']' : 'null') + ' },';
  }).join('\n') + '\n];\n\n';
  out += 'function ' + w.name + '(' + [w.key.name].concat(w.fields.map(function (f) { return f.name; }), ['reason']).join(', ') + ') {\n';
  out += '  var keyValue = String(' + w.key.name + " || '').trim();\n";
  out += "  if (!keyValue) throw new Error('" + w.key.name + " is required');\n";
  out += '  var include = ' + q(['id', w.key.name].concat(w.fields.map(function (f) { return f.name; })).filter(function (p, i, a) { return a.indexOf(p) === i; }).join(', ')) + ';\n';
  out += '  var found = ' + E + '.fetch({ filter: Filter.eq(' + q(w.key.name) + ', keyValue), include: include, limit: 1 }).objs;\n';
  out += '  if (!found || found.length === 0) {\n';
  out += '    found = ' + E + ".fetch({ filter: Filter.eq('id', keyValue), include: include, limit: 1 }).objs;\n  }\n";
  out += '  if (!found || found.length === 0) {\n';
  out += "    found = " + E + ".fetch({ filter: Filter.eq(" + q(w.key.name) + ", keyValue.toUpperCase()), include: include, limit: 1 }).objs;\n  }\n";
  out += "  if (!found || found.length === 0) throw new Error('No " + M.words(E).toLowerCase() + " with " + w.key.name + " ' + keyValue);\n";
  out += '  var target = found[0];\n';
  out += '  var requested = {\n' + w.fields.map(function (f) { return '    ' + f.name + ': ' + f.name + ','; }).join('\n') + '\n  };\n';
  out += '  var changes = {};\n  var parts = [];\n';
  out += '  WRITE_FIELDS.forEach(function (f) {\n';
  out += '    var raw = requested[f.name];\n';
  out += "    if (raw === null || raw === undefined || String(raw).trim() === '') return;\n";
  out += '    var to = f.allowed ? canonical(f.name, raw, f.allowed)[0] : String(raw).trim();\n';
  out += "    if (f.kind === 'int' || f.kind === 'double') to = Number(to);\n";
  out += '    var from = target[f.name] === undefined ? null : target[f.name];\n';
  out += '    if (String(from) === String(to)) return;\n';
  out += '    changes[f.name] = { from: from, to: to };\n';
  out += "    parts.push(f.label + ' ' + fmtValue(from) + ' -> ' + to);\n  });\n";
  out += "  if (parts.length === 0) return 'Nothing to change: ' + keyValue + ' already has those values.';\n";
  out += '  var label = fmtValue(target.' + w.key.name + ') || target.id;\n';
  out += "  var summary = label + ': ' + parts.join(', ');\n";
  out += '  var pc = ' + T + '.PendingChange.make({\n    name: summary,\n    targetType: ' + q(E) + ',\n    targetId: target.id,\n    targetLabel: label,\n' +
    "    changes: JSON.stringify(changes),\n    reason: reason ? String(reason) : null,\n    state: 'Pending',\n  }).create();\n";
  out += "  log.info('Proposed change {}: {}', pc.id, summary);\n";
  out += "  return 'PROPOSED (not applied): ' + summary + '. Proposal id ' + pc.id + '. The change is applied only after the user clicks ' +\n" +
    "    'Confirm on the proposal card shown below the chat; tell the user to review and confirm it there.';\n}\n\n";
  out += '/** Loads a pending change or throws when it is unknown or already decided. */\n';
  out += 'function pendingChange(changeId) {\n';
  out += '  var pc = ' + T + ".PendingChange.forId(changeId);\n";
  out += "  if (!pc) throw new Error('Unknown pending change ' + changeId);\n";
  out += '  pc = pc.get();\n';
  out += "  if (pc.state !== 'Pending') throw new Error('Change ' + changeId + ' is already ' + pc.state);\n  return pc;\n}\n\n";
  out += 'function confirmChange(changeId) {\n  var pc = pendingChange(changeId);\n';
  out += '  var changes = JSON.parse(pc.changes);\n  var obj = { id: pc.targetId };\n';
  out += '  Object.keys(changes).forEach(function (k) {\n    obj[k] = changes[k].to;\n  });\n';
  out += '  ' + E + '.make(obj).merge();\n';
  out += "  pc.withFields({ state: 'Applied', decidedAt: DateTime.now() }).merge();\n";
  out += "  log.info('Applied change {}: {}', pc.id, pc.name);\n";
  out += "  return 'Applied: ' + pc.name;\n}\n\n";
  out += 'function discardChange(changeId) {\n  var pc = pendingChange(changeId);\n';
  out += "  pc.withFields({ state: 'Discarded', decidedAt: DateTime.now() }).merge();\n";
  out += "  return 'Discarded: ' + pc.name;\n}\n";
  return out;
}

// ---------------------------------------------------------------------------------------------------------- py

function systemPrompt(app, ag) {
  var lines = [];
  var ents = app.entities.map(function (e) { return e.name; }).join(' and ');
  lines.push('You are the ' + ag.name + ' for the "' + app.title + '" application. You answer questions about the application\'s ' + ents + ' data.');
  lines.push('');
  lines.push('Data:');
  app.entities.forEach(function (e) {
    lines.push('- ' + e.name + ': ' + e.allFields.map(function (f) {
      var s = f.name;
      if (f.kind === 'enum') s += ' (' + f.enumDef.values.map(function (v) { return v.label; }).join(' / ') + ')';
      if (f.kind === 'ref') s += ' -> ' + f.ref;
      return s;
    }).join(', ') + '.');
  });
  lines.push('');
  lines.push('Rules:');
  if (ag.write) {
    lines.push('- You never change data yourself. When the user explicitly asks to change a ' + M.words(ag.write.entity.name).toLowerCase() +
      ' (' + ag.write.fields.map(function (f) { return f.name; }).join(' or ') + ' only), call ' + ag.write.name + ' once; it only creates a proposal. ' +
      'Then tell the user the change is NOT applied until they click Confirm on the proposal card. Never say a change was made. ' +
      'Refuse any other kind of change (create, delete, other fields).');
  } else {
    lines.push('- You are strictly READ-ONLY. Never create, update or delete data, and never offer to. If asked to change data, explain that you can only read and report.');
  }
  lines.push('- Always get numbers from the tools; never guess or estimate counts, and never compute a count from a search result list.');
  ag.tools.forEach(function (t) {
    if (t.kind === 'stats') {
      lines.push('- Use ' + t.name + ' for every ' + M.words(t.entity.name).toLowerCase() + ' count, share, average, ranking or trend (groupBy one of ' +
        t.groupBy.map(function (g) { return g.key; }).join(', ') + '; filters accept comma-separated values' +
        (t.dateField ? '; ' + t.dateField.label + 'From / ' + t.dateField.label + 'To take YYYY-MM-DD dates' : '') + ').');
    } else {
      lines.push('- Use ' + t.name + ' to find or list specific ' + M.plural(M.words(t.entity.name).toLowerCase()) + ' or read their details before summarizing them.');
    }
  });
  if (ag.genericTools.length) lines.push('- Use ' + ag.genericTools.join(' / ') + ' only for questions the purpose-built tools cannot answer.');
  var enumLines = [];
  ag.tools.forEach(function (t) {
    t.filters.forEach(function (f) {
      if (f.enumDef && enumLines.indexOf(f.param + ': ' + valuesHint(f)) < 0) enumLines.push(f.param + ': ' + valuesHint(f));
    });
  });
  if (enumLines.length) lines.push('- Valid filter values: ' + enumLines.join('; ') + '.');
  ag.instructions.forEach(function (i) { lines.push('- ' + i); });
  lines.push('- Answer concisely in markdown. Lead with the direct answer, then a short supporting breakdown (a small table is fine). If there are ties, say so.');
  lines.push('- Only discuss this application\'s data. Politely decline unrelated requests (general knowledge, weather, coding, etc.) in one sentence.');
  return lines.join('\n');
}

function agentPy(app, ag) {
  var T = ag.type;
  var toolParams = {};
  ag.tools.forEach(function (t) {
    toolParams[t.name] = (t.kind === 'stats' ? ['groupBy'] : ['text']).concat(t.filters.map(function (f) { return f.param; }),
      t.dateField ? [t.dateField.label + 'From', t.dateField.label + 'To'] : [], t.kind === 'search' ? ['limit'] : []);
  });
  if (ag.write) toolParams[ag.write.name] = [ag.write.key.name].concat(ag.write.fields.map(function (f) { return f.name; }), ['reason']);
  var py = app.header ? PY_HEADER : '';
  py += 'import time\nimport uuid\n\n';
  py += 'AGENT_NAME = ' + JSON.stringify(ag.name) + '\n';
  py += 'AGENT_TYPE = ' + JSON.stringify(T) + '\n';
  py += 'LLM_CLIENT_NAME = ' + JSON.stringify(ag.llmClient) + '\n';
  py += '# Platform-provided Kv session store (seeded by genaiPlatform) that holds conversation checkpoints by session id.\n';
  py += 'SESSION_STORE_ID = ' + JSON.stringify(ag.sessionStore) + '\n';
  py += '# Tool methods on ' + T + ' and their parameters (a tool whose schema no longer matches is recreated).\n';
  py += 'CUSTOM_TOOLS = {\n' + Object.keys(toolParams).map(function (k) { return '    ' + JSON.stringify(k) + ': ' + JSON.stringify(toolParams[k]) + ','; }).join('\n') + '\n}\n';
  py += 'GENERIC_TOOL_IDS = ' + JSON.stringify(ag.genericTools) + '\n';
  py += 'CATEGORY = ' + JSON.stringify(ag.category) + '\n\n';
  py += 'SYSTEM_PROMPT = """' + systemPrompt(app, ag).replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"') + '"""\n\n';
  py += 'DESCRIPTION = ' + JSON.stringify(ag.description) + '\n\n';
  py += 'DOCUMENTATION = """**' + ag.name + '** answers questions about this app\'s data.\n\nTools: ' +
    Object.keys(toolParams).map(function (k) { return '`' + k + '`'; }).concat(ag.genericTools.map(function (k) { return '`' + k + '`'; })).join(', ') + '.\n' +
    (ag.write ? 'The agent never writes: `' + ag.write.name + '` only records a proposal that the user confirms on the Assistant page.\n' : 'The agent never modifies data.\n') +
    (ag.suggestions.length ? '\nExamples: ' + ag.suggestions.map(function (s) { return JSON.stringify(s); }).join(', ') + '\n' : '') + '"""\n\n';
  py += [
    '',
    'def _latest_agent(cls):',
    '    objs = c3.GenaiCore.Agent.fetch(filter=c3.Filter.eq("name", AGENT_NAME), order="descending(ver)", limit=1).objs',
    '    # Re-read the full record: without it the short-term memory store is not resolved and follow-ups lose context.',
    '    return objs[0].get("this") if objs else None',
    '',
    '',
    'def _schema_params(tool):',
    '    try:',
    '        schema = tool.argsSchema or {}',
    '        props = schema.get("properties") if isinstance(schema, dict) else None',
    '        return sorted((props or {}).keys())',
    '    except Exception:  # noqa: BLE001 - unknown shape: treat as stale',
    '        return []',
    '',
    '',
    'def _custom_tools():',
    '    """Reuses the C3Method tool of each method (ids look like <Type>_<method>_<n>) when its parameters still match;',
    '    creates it otherwise, so repeated calls do not create duplicate tools or agent versions."""',
    '    tools = []',
    '    for method, params in CUSTOM_TOOLS.items():',
    '        existing = c3.GenaiCore.Tool.C3Method.fetch(',
    '            filter=c3.Filter.startsWith("id", AGENT_TYPE + "_" + method + "_").and_().eq("name", method),',
    '            order="descending(meta.created)",',
    '            limit=1,',
    '        ).objs',
    '        if existing and _schema_params(existing[0].get("this")) == sorted(params):',
    '            tools.append(existing[0])',
    '        else:',
    '            tools.append(c3.GenaiCore.Tool.C3Method.createFromMethodName(type=getattr(c3, AGENT_TYPE), methodName=method))',
    '    return tools',
    '',
    '',
    'def _new_agent(tool_ids):',
    '    return c3.GenaiCore.Agent.LangChain(',
    '        name=AGENT_NAME,',
    '        description=DESCRIPTION,',
    '        documentation=DOCUMENTATION,',
    '        category=CATEGORY,',
    '        systemPrompt=SYSTEM_PROMPT,',
    '        llmClient=c3.GenaiCore.Llm.Completion.Client(name=LLM_CLIENT_NAME),',
    '        tools=[c3.GenaiCore.Tool(id=i) for i in tool_ids],',
    '        # the store must be referenced by its concrete Kv type, otherwise memory is silently not restored',
    '        shortTermMemoryStore=c3.GenaiCore.SessionStore.Kv(id=SESSION_STORE_ID),',
    '    )',
    '',
    '',
    'def ensureAgent(cls, publish=False):',
    '    tools = _custom_tools() + [c3.GenaiCore.Tool.forId(tid) for tid in GENERIC_TOOL_IDS]',
    '    tool_ids = [t.id for t in tools]',
    '    latest = _latest_agent(cls)',
    '    if latest is None:',
    '        agent = _new_agent(tool_ids).create()',
    '    else:',
    '        same = (',
    '            latest.type().name() == "GenaiCore.Agent.LangChain"',
    '            and latest.systemPrompt == SYSTEM_PROMPT',
    '            and latest.llmClient is not None',
    '            and latest.llmClient.name == LLM_CLIENT_NAME',
    '            and [t.id for t in (latest.tools or [])] == tool_ids',
    '            and latest.shortTermMemoryStore is not None',
    '            and latest.shortTermMemoryStore.type().name() == "GenaiCore.SessionStore.Kv"',
    '        )',
    '        agent = latest if same else _new_agent(tool_ids).createNewVersion()',
    '    if publish:',
    '        agent = agent.publishAgent()',
    '    return agent.id',
    '',
    '',
    'def _text_of(content):',
    '    if content is None:',
    '        return ""',
    '    if isinstance(content, str):',
    '        return content',
    '    if isinstance(content, dict):',
    '        return "\\n\\n".join(_text_of(v) for v in content.values())',
    '    value = getattr(content, "value", None)',
    '    if isinstance(value, str):',
    '        return value',
    '    parts = getattr(content, "parts", None)',
    '    if parts:',
    '        return "".join(_text_of(p) for p in parts)',
    '    for attr in ("text", "content"):',
    '        v = getattr(content, attr, None)',
    '        if isinstance(v, str):',
    '            return v',
    '    return str(content)',
    '',
    '',
    'def ask(cls, question, sessionId=None):',
    '    started = time.time()',
    '    agent = _latest_agent(cls)',
    '    if agent is None:',
    '        getattr(c3, AGENT_TYPE).ensureAgent(False)',
    '        agent = _latest_agent(cls)',
    '    session_id = sessionId or (AGENT_TYPE.lower() + "-" + uuid.uuid4().hex)',
    '    # The session id is the LangChain thread id: the agent restores/saves the conversation in its Kv session store.',
    '    run = agent.run(query=question, spec=c3.GenaiCore.Agent.RunSpec(sessionId=session_id))',
    '    run = run.get("id, status, error, response")',
    '    answer = _text_of(run.response)',
    '    if not answer and run.error:',
    '        answer = "The " + AGENT_NAME + " could not answer: " + str(run.error)',
    '    return getattr(c3, AGENT_TYPE).Reply(',
    '        answer=answer,',
    '        sessionId=session_id,',
    '        runId=run.id,',
    '        status=str(run.status),',
    '        seconds=round(time.time() - started, 1),',
    '    )',
    '',
  ].join('\n');
  return py;
}

// ---------------------------------------------------------------------------------------------------------- UI

function assistantPage(app, ag) {
  var T = ag.type;
  var hdr = app.header ? JS_HEADER : '';
  var w = ag.write;
  var lines = [
    "import React, { FormEvent, KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react';",
    "import ReactMarkdown from 'react-markdown';",
    "import remarkGfm from 'remark-gfm';",
    "import { Bot, Check, RotateCcw, Send, X } from 'lucide-react';",
    '',
    "import { c3Call } from '@/c3Action';",
    "import PageFrame, { errorMessage } from '@/components/PageFrame/PageFrame';",
    "import { Button } from '@/components/ui/button';",
    "import { Container } from '@/components/ui/container';",
    "import { Spinner } from '@/components/ui/spinner';",
    "import { Textarea } from '@/components/ui/textarea';",
    '',
    '/** {@link ' + T + '.Reply} from `' + T + '.ask`. */',
    'interface AgentReply {',
    '  answer?: string;',
    '  sessionId?: string;',
    '  runId?: string;',
    '  status?: string;',
    '  seconds?: number;',
    '}',
    '',
  ];
  if (w) {
    lines = lines.concat([
      '/** A change the agent proposed (' + T + '.PendingChange); applied only when the user confirms it. */',
      'interface PendingChange {',
      '  id: string;',
      '  name?: string;',
      '  targetLabel?: string;',
      '  reason?: string;',
      '  state?: string;',
      '}',
      '',
    ]);
  }
  lines = lines.concat([
    'interface ChatMessage {',
    '  id: number;',
    "  role: 'user' | 'assistant' | 'error' | 'system';",
    '  text: string;',
    '  meta?: string;',
    '}',
    '',
    'const SUGGESTIONS: string[] = ' + JSON.stringify(ag.suggestions) + ';',
    '',
    '// Markdown answers: no typography plugin in the template, so style the elements the agent uses.',
    "const MD_CLASS = 'min-w-0 text-sm leading-6 text-[var(--c3-style-basic-fg-primary)] [&_p]:my-2 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0.5 [&_strong]:font-semibold [&_h1]:text-base [&_h1]:font-semibold [&_h2]:text-base [&_h2]:font-semibold [&_h3]:font-semibold [&_code]:rounded-sm [&_code]:bg-[var(--c3-style-basic-bg-page)] [&_code]:px-1 [&_table]:my-2 [&_table]:w-full [&_table]:border-collapse [&_th]:border [&_th]:border-[var(--c3-style-basic-border-border)] [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:font-semibold [&_td]:border [&_td]:border-[var(--c3-style-basic-border-border)] [&_td]:px-2 [&_td]:py-1';",
    '',
    '/**',
    ' * Chat with the "' + ag.name + '" GenaiCore agent. Each question goes to the server-side `' + T + '.ask` method, which runs',
    ' * the agent inside this app as the signed-in user (no app connection needed). The returned session id is sent back with',
    ' * every follow-up so the agent keeps the conversation context.' + (w ? ' Changes the agent proposes are listed under the chat and' : ''),
    w ? ' * are applied only when the user clicks Confirm.' : null,
    ' */',
    'const AssistantPage: React.FC = () => {',
    '  const [messages, setMessages] = useState<ChatMessage[]>([]);',
    "  const [input, setInput] = useState('');",
    '  const [sessionId, setSessionId] = useState<string | null>(null);',
    '  const [pending, setPending] = useState(false);',
    w ? '  const [changes, setChanges] = useState<PendingChange[]>([]);' : null,
    w ? '  const [deciding, setDeciding] = useState<string | null>(null);' : null,
    '  const nextId = useRef(1);',
    '  const bottomRef = useRef<HTMLDivElement>(null);',
    '  const mounted = useRef(true);',
    '',
    '  useEffect(() => {',
    '    mounted.current = true;',
    '    return () => {',
    '      mounted.current = false;',
    '    };',
    '  }, []);',
    '',
    '  useEffect(() => {',
    "    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });",
    '  }, [messages, pending]);',
    '',
    "  const addMessage = useCallback((role: ChatMessage['role'], text: string, meta?: string) => {",
    '    const id = nextId.current++;',
    '    setMessages((prev) => [...prev, { id, role, text, meta }]);',
    '  }, []);',
    '',
  ]).filter(function (l) { return l !== null; });
  if (w) {
    lines = lines.concat([
      '  const loadChanges = useCallback(async () => {',
      '    try {',
      "      const res = await c3Call('" + T + ".PendingChange', 'fetch', null, [",
      "        { filter: 'state == \"Pending\"', order: 'descending(meta.created)', limit: 10, include: 'id, name, targetLabel, reason, state' },",
      '      ]);',
      '      if (mounted.current) setChanges((res?.objs ?? []) as PendingChange[]);',
      '    } catch (err: unknown) {',
      "      if (mounted.current) addMessage('error', errorMessage(err));",
      '    }',
      '  }, [addMessage]);',
      '',
      '  useEffect(() => {',
      '    void loadChanges();',
      '  }, [loadChanges]);',
      '',
      "  const decide = async (change: PendingChange, action: 'confirmChange' | 'discardChange') => {",
      '    setDeciding(change.id);',
      '    try {',
      "      const msg = (await c3Call('" + T + "', action, null, [change.id])) as string;",
      "      if (mounted.current) addMessage('system', msg);",
      '    } catch (err: unknown) {',
      "      if (mounted.current) addMessage('error', errorMessage(err));",
      '    } finally {',
      '      if (mounted.current) setDeciding(null);',
      '      void loadChanges();',
      '    }',
      '  };',
      '',
    ]);
  }
  lines = lines.concat([
    '  const send = async (question: string) => {',
    '    const q = question.trim();',
    '    if (!q || pending) return;',
    "    addMessage('user', q);",
    "    setInput('');",
    '    setPending(true);',
    '    try {',
    "      const reply = (await c3Call('" + T + "', 'ask', null, [q, sessionId])) as AgentReply;",
    '      if (!mounted.current) return;',
    '      if (reply.sessionId) setSessionId(reply.sessionId);',
    "      const meta = reply.seconds !== undefined ? `${reply.seconds.toFixed(1)} s` : undefined;",
    "      addMessage(reply.status === 'completed' ? 'assistant' : 'error', reply.answer || 'The agent returned no answer.', meta);",
    '    } catch (err: unknown) {',
    "      if (mounted.current) addMessage('error', errorMessage(err));",
    '    } finally {',
    '      if (mounted.current) setPending(false);',
    w ? '      void loadChanges();' : null,
    '    }',
    '  };',
    '',
    '  const onSubmit = (e: FormEvent) => {',
    '    e.preventDefault();',
    '    void send(input);',
    '  };',
    '',
    '  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {',
    "    if (e.key === 'Enter' && !e.shiftKey) {",
    '      e.preventDefault();',
    '      void send(input);',
    '    }',
    '  };',
    '',
    '  const newConversation = () => {',
    '    setMessages([]);',
    '    setSessionId(null);',
    "    setInput('');",
    '  };',
    '',
    '  return (',
    '    <PageFrame',
    '      title=' + JSON.stringify(ag.name),
    '      description=' + JSON.stringify(w ? 'AI agent over this app\'s live data. It can propose changes; nothing is changed until you confirm.' : 'Read-only AI agent over this app\'s live data.'),
    "      breadcrumbs={[{ label: " + JSON.stringify(ag.label) + " }]}",
    '      actions={',
    '        <Button variant="outline" appearance="secondary" leadingIcon={<RotateCcw />} onClick={newConversation} disabled={pending || messages.length === 0}>',
    '          New conversation',
    '        </Button>',
    '      }',
    '    >',
    '      <Container className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-4">',
    '        {messages.length === 0 && (',
    '          <div className="flex flex-col gap-3">',
    '            <div className="flex items-center gap-2 text-sm text-[var(--c3-style-basic-fg-secondary)]">',
    '              <Bot className="size-4" aria-hidden />',
    '              Ask a question about the data, or try one of these:',
    '            </div>',
    '            <div className="flex flex-wrap gap-2">',
    '              {SUGGESTIONS.map((s) => (',
    '                <Button key={s} variant="outline" appearance="secondary" size="sm" onClick={() => void send(s)}>',
    '                  {s}',
    '                </Button>',
    '              ))}',
    '            </div>',
    '          </div>',
    '        )}',
    '',
    '        {messages.map((m) => {',
    "          if (m.role === 'user') {",
    '            return (',
    '              <div key={m.id} className="flex justify-end">',
    '                <div className="max-w-[80%] whitespace-pre-wrap rounded-md bg-[var(--c3-style-basic-bg-page)] px-4 py-2 text-sm">{m.text}</div>',
    '              </div>',
    '            );',
    '          }',
    "          if (m.role === 'error') {",
    '            return (',
    '              <div key={m.id} role="alert" className="rounded-md border border-[var(--c3-style-basic-fg-danger)] px-4 py-2 text-sm text-[var(--c3-style-basic-fg-danger)]">',
    '                {m.text}',
    '              </div>',
    '            );',
    '          }',
    "          if (m.role === 'system') {",
    '            return (',
    '              <div key={m.id} className="text-center text-xs text-[var(--c3-style-basic-fg-secondary)]">',
    '                {m.text}',
    '              </div>',
    '            );',
    '          }',
    '          return (',
    '            <div key={m.id} className="flex gap-3" data-testid="assistant-answer">',
    '              <Bot className="mt-1 size-5 shrink-0 text-[var(--c3-style-basic-fg-secondary)]" aria-hidden />',
    '              <div className="min-w-0 flex-1">',
    '                <div className={MD_CLASS}>',
    '                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.text}</ReactMarkdown>',
    '                </div>',
    '                {m.meta && <div className="text-xs text-[var(--c3-style-basic-fg-secondary)]">{m.meta}</div>}',
    '              </div>',
    '            </div>',
    '          );',
    '        })}',
    '',
    '        {pending && (',
    '          <div className="flex items-center gap-2 text-sm text-[var(--c3-style-basic-fg-secondary)]" aria-live="polite">',
    '            <Spinner size="sm" />',
    '            ' + ag.name + ' is looking at the data…',
    '          </div>',
    '        )}',
    '        <div ref={bottomRef} />',
    '      </Container>',
    '',
  ]).filter(function (l) { return l !== null; });
  if (w) {
    lines = lines.concat([
      '      {changes.length > 0 && (',
      '        <Container className="mx-auto flex w-full max-w-4xl flex-col gap-2 p-4" data-testid="pending-changes">',
      '          <div className="text-sm font-semibold">Proposed changes awaiting your confirmation</div>',
      '          {changes.map((c) => (',
      '            <div key={c.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-[var(--c3-style-basic-border-border)] px-3 py-2">',
      '              <div className="min-w-0 text-sm">',
      '                <div className="font-medium">{c.name}</div>',
      '                {c.reason && <div className="text-xs text-[var(--c3-style-basic-fg-secondary)]">{c.reason}</div>}',
      '              </div>',
      '              <div className="flex gap-2">',
      "                <Button size=\"sm\" variant=\"solid\" appearance=\"accent\" leadingIcon={<Check />} onClick={() => void decide(c, 'confirmChange')} disabled={deciding !== null}>",
      '                  Confirm',
      '                </Button>',
      "                <Button size=\"sm\" variant=\"ghost\" appearance=\"secondary\" leadingIcon={<X />} onClick={() => void decide(c, 'discardChange')} disabled={deciding !== null}>",
      '                  Discard',
      '                </Button>',
      '              </div>',
      '            </div>',
      '          ))}',
      '        </Container>',
      '      )}',
      '',
    ]);
  }
  lines = lines.concat([
    '      <form onSubmit={onSubmit} className="mx-auto flex w-full max-w-4xl items-end gap-2">',
    '        <label htmlFor="assistant-input" className="sr-only">',
    '          Ask the ' + ag.name,
    '        </label>',
    '        <Textarea',
    '          id="assistant-input"',
    '          rows={2}',
    '          value={input}',
    '          onChange={(e) => setInput(e.target.value)}',
    '          onKeyDown={onKeyDown}',
    '          placeholder="Ask about the data… (Enter to send, Shift+Enter for a new line)"',
    '          disabled={pending}',
    '          className="min-h-10 flex-1 resize-none"',
    '        />',
    '        <Button type="submit" variant="solid" appearance="accent" leadingIcon={<Send />} disabled={pending || !input.trim()}>',
    '          Send',
    '        </Button>',
    '      </form>',
    '    </PageFrame>',
    '  );',
    '};',
    '',
    'export default AssistantPage;',
    '',
  ]);
  return hdr + lines.join('\n');
}

// ---------------------------------------------------------------------------------------------------------- patches

function patchFile(file, fn) {
  var src = fs.readFileSync(file, 'utf8');
  var out = fn(src);
  if (out === src) throw new Error('agent: could not patch ' + file);
  fs.writeFileSync(file, out);
}

function emit(app, ag, ctx) {
  var out = ctx.out;
  var P = app.pkg + '/';
  var R = P + 'ui/react/';
  var e = ctx.emit;
  e(P + 'src/' + ag.type + '.c3typ', agentTyp(app, ag));
  e(P + 'src/' + ag.type + '.Reply.c3typ', replyTyp(ag));
  if (ag.tools.some(function (t) { return t.kind === 'stats'; })) e(P + 'src/' + ag.type + '.Stats.c3typ', statsTyp(ag));
  ag.tools.forEach(function (t) {
    if (t.kind === 'search') e(P + 'src/' + t.hitType + '.c3typ', hitTyp(ag, t));
  });
  if (ag.write) e(P + 'src/' + ag.type + '.PendingChange.c3typ', pendingTyp(ag));
  e(P + 'src/' + ag.type + '.js', toolJs(app, ag));
  e(P + 'src/' + ag.type + '.py', agentPy(app, ag));
  e(R + 'src/pages/Assistant/AssistantPage.tsx', assistantPage(app, ag));

  // manifest: the GenAI dependency lab3's agent app ended with (genAiUi pulls genAiBase; genaiPlatform comes via mcpServer)
  patchFile(path.join(out, P + app.pkg + '.c3pkg.json'), function (src) {
    var m = JSON.parse(src);
    Object.keys(ag.dependencies).forEach(function (k) { m.dependencies[k] = ag.dependencies[k]; });
    return JSON.stringify(m, null, 2) + '\n';
  });
  // route + nav item
  patchFile(path.join(out, R + 'src/App.tsx'), function (src) {
    return src.replace(/(import SideNav from )/, "import AssistantPage from './pages/Assistant/AssistantPage';\n$1")
      .replace(/(\n(\s*)<Route\n\s*path="\*")/, '\n$2<Route path="/' + ag.route + '" element={<AssistantPage />} />$1');
  });
  patchFile(path.join(out, R + 'src/config/navigation.ts'), function (src) {
    var withIcon = src.replace(/import \{ ([^}]*) \} from 'lucide-react';/, function (all, names) {
      var list = names.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      if (list.indexOf(ag.icon) < 0) list.push(ag.icon);
      return 'import { ' + list.sort().join(', ') + " } from 'lucide-react';";
    });
    return withIcon.replace(/\n\];\n/, '\n  {\n    id: ' + q(ag.route) + ',\n    path: ' + q('/' + ag.route) + ',\n    icon: ' + ag.icon + ',\n    iconActive: ' + ag.icon +
      ',\n    label: ' + q(ag.label) + ',\n    tooltip: ' + q('Ask the ' + ag.name) + ',\n  },\n];\n');
  });
  // summaries for the C3 Code agent
  var section = '\n## AI agent: ' + ag.name + '\n\n' +
    '- `src/' + ag.type + '.c3typ/.py/.js`: GenaiCore.Agent.LangChain "' + ag.name + '" (model client `' + ag.llmClient + '`, Kv memory `' + ag.sessionStore +
    '`). `' + ag.type + '.ensureAgent(false)` creates or versions the agent and its tools (run once after a pull; `ask` also does it on first use).\n' +
    '- Read-only tools (js-server, wrapped as GenaiCore.Tool.C3Method): ' + ag.tools.map(function (t) { return '`' + t.name + '`'; }).join(', ') +
    (ag.genericTools.length ? '; provisioned: ' + ag.genericTools.join(', ') : '') + '.\n' +
    (ag.write ? '- Write tool `' + ag.write.name + '` only creates a `' + ag.type + '.PendingChange`; the user applies it with Confirm on the Assistant page (`confirmChange`).\n' : '') +
    '- UI: `ui/react/src/pages/Assistant/AssistantPage.tsx` at `/' + ag.route + '`, calls `' + ag.type + '.ask(question, sessionId)`.\n';
  [P + 'src/WORKSPACE_SUMMARY.md', P + 'CLAUDE.md'].forEach(function (rel) {
    var f = path.join(out, rel);
    if (fs.existsSync(f)) fs.appendFileSync(f, section);
  });
}

module.exports = {
  normalize: normalize,
  emit: emit,
  systemPrompt: systemPrompt,
};

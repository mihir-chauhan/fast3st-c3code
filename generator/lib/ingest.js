'use strict';

// lab6: optional CSV ingestion pipeline per entity (`entities[].ingest`), the shape C3 Code built for lab2
// (knowledge/12 §10, c3-data-ingestion skill): a `mixes Source` type with one string field per CSV column, a
// FileSourceSystem + FileSourceCollection, a createOnly DbTargetCollection, two Transforms (records and rejections),
// a `<Entity>.Rejection` entity for rows that fail, and cleaning code that never throws (one throw fails the file).
// Extra over lab2: static `feedStatus()` / `uploadCsv()` / `processInbox()` so a generated Imports page can show runs
// and rejected rows and load a CSV without File Explorer.
//
//   "ingest": { "columns": { "<csv header>": "<field>" }, "idColumn": "<csv header>" (optional, becomes the record id),
//               "feed": "WorkOrderFeed" (optional), "sample": [ { "<csv header>": "value" }, ... ] (optional) }

var M = require('./model');
var B = require('./backend');

function names(ent) {
  var feed = ent.ingest.feed || ent.name + 'Feed';
  return {
    feed: feed,
    system: feed + 'System',
    source: 'Source' + ent.name,
    rejection: ent.name + '.Rejection',
    target: ent.name + 'CreateOnly',
    status: 'Source' + ent.name + '.FeedStatus',
    run: 'Source' + ent.name + '.FeedRun',
  };
}

function normalize(app, ent) {
  var ig = ent.ingest;
  if (!ig.columns) throw new Error('spec: ' + ent.name + '.ingest.columns is required');
  ig.cols = Object.keys(ig.columns).map(function (h) {
    var fname = ig.columns[h];
    var f = fname === 'name' && ent.usesName ? ent.labelField : ent.fieldByName[fname];
    if (!f) throw new Error('spec: ' + ent.name + '.ingest.columns: unknown field ' + fname);
    if (f.calc) throw new Error('spec: ' + ent.name + '.ingest.columns: ' + fname + ' is a calc field');
    var prop = M.camel(h);
    if (['timestamp', 'type', 'sourceSystem', 'sourcesId', 'sourceFileUrl', 'sourceFileEncodedPath', 'sourceFileSheet', 'id', 'name', 'version', 'meta'].indexOf(prop) >= 0) prop = 'src' + M.pascal(h);
    return { header: h, prop: prop, field: f };
  });
  return names(ent);
}

function c3typFiles(app, ent) {
  var n = normalize(app, ent);
  var files = {};
  var src = B.doc('One row of a ' + ent.display.toLowerCase() + ' CSV file dropped in the `' + n.feed + '` inbox. Every column is read ' +
    'as text and cleaned by {@link ' + n.source + '#toTargets}; rows that fail become {@link ' + n.rejection + '} records.');
  src += 'type ' + n.source + ' mixes Source {\n';
  ent.ingest.cols.forEach(function (c) {
    src += '\n' + B.doc('CSV column `' + c.header + '` (-> {@link ' + ent.name + '#' + c.field.name + '}).', '  ');
    src += '  @ser(name="' + c.header + '")\n  ' + c.prop + ': string\n';
  });
  src += '\n' + B.doc('The cleaned ' + ent.singular.toLowerCase() + ' for this row, or nothing when the row is rejected.', '  ');
  src += '  toTargets: member function(): [' + ent.name + '] js-server\n';
  src += '\n' + B.doc('The rejection record for this row, or nothing when the row is valid.', '  ');
  src += '  rejectionTargets: member function(): [' + n.rejection + '] js-server\n';
  src += '\n' + B.doc('Inbox location, recent file runs and the rejected-row count, for the Imports page.', '  ');
  src += '  feedStatus: function(): ' + n.status + ' js-server\n';
  src += '\n' + B.doc('Writes `content` as `fileName` into the inbox and processes the collection. Returns the file URL.', '  ');
  src += '  uploadCsv: function(fileName: !string, content: !string): string js-server\n';
  src += '\n' + B.doc('Processes every file waiting in the inbox (`FileSourceCollection#process`).', '  ');
  src += '  processInbox: function(): string js-server\n}\n';
  files['src/source/' + n.source + '.c3typ'] = src;
  files['src/source/' + n.status + '.c3typ'] = B.valueTyp(n.status, 'State of the `' + n.feed + '` feed, returned by {@link ' + n.source + '#feedStatus}.', [
    { name: 'inboxUrl', type: 'string', doc: 'Folder new CSV files are uploaded to.' },
    { name: 'rejectedCount', type: 'int', doc: 'Number of {@link ' + n.rejection + '} records.' },
    { name: 'runs', type: '[' + n.run + ']', doc: 'Most recent file runs, newest first.' },
  ]);
  files['src/source/' + n.run + '.c3typ'] = B.valueTyp(n.run, 'One processed file of the `' + n.feed + '` feed (from `SourceStatus`).', [
    { name: 'file', type: 'string', doc: 'Source status id (collection + file name).' },
    { name: 'state', type: 'string', doc: 'Run state, e.g. `completed`.' },
    { name: 'count', type: 'int', doc: 'Rows read.' },
    { name: 'successful', type: 'int', doc: 'Rows that went through the transforms.' },
    { name: 'failed', type: 'int', doc: 'Rows that failed in the platform.' },
    { name: 'started', type: 'datetime', doc: 'When the run was created.' },
  ]);
  var rej = B.doc('A CSV row of the `' + n.feed + '` feed that could not be loaded into {@link ' + ent.name + '}, with the reason.');
  rej += "@db(index=['sourceFile', 'rowKey'])\nentity type " + n.rejection + ' {\n';
  [['sourceFile', 'string', 'File the row came from.'], ['rowKey', 'string', 'Identifying value of the row (its id column), when present.'],
    ['reason', '!string', 'Why the row was rejected.'], ['rawRow', 'string', 'The row as read, for fixing and re-uploading.']].forEach(function (f) {
    rej += '\n' + B.doc(f[2], '  ') + '  ' + f[0] + ': ' + f[1] + '\n';
  });
  files['src/' + n.rejection + '.c3typ'] = rej + '}\n';
  return files;
}

function sourceJs(app, ent) {
  var n = names(ent);
  var ig = ent.ingest;
  var idCol = ig.idColumn ? ig.cols.filter(function (c) { return c.header === ig.idColumn; })[0] : null;
  if (ig.idColumn && !idCol) throw new Error('spec: ' + ent.name + '.ingest.idColumn must be one of the columns');
  var L = [];
  if (app.header) L.push(B.JS_HEADER.trim(), '');
  L.push("var log = Logger.for('" + n.source + "');", '');
  L.push("var FEED = '" + n.feed + "';", '');
  L.push('/** Allowed labels per enum column (case-insensitive match, stored with the canonical label). */');
  L.push('var ENUMS = {');
  ig.cols.forEach(function (c) {
    if (c.field.kind === 'enum') L.push('  ' + c.prop + ': [' + c.field.enumDef.values.map(function (v) { return "'" + v.label.replace(/'/g, "\\'") + "'"; }).join(', ') + '],');
  });
  L.push('};', '');
  L.push("var EMPTY = ['', 'n/a', 'na', 'null', '-'];", '');
  L.push('function blank(v) {');
  L.push('  return v == null || EMPTY.indexOf(String(v).trim().toLowerCase()) >= 0;');
  L.push('}', '');
  L.push('/** `$1,234.50` -> 1234.5; blank -> null; anything else -> NaN. */');
  L.push('function parseNumber(v) {');
  L.push('  if (blank(v)) return null;');
  L.push("  var n = Number(String(v).replace(/[$,\\s]/g, ''));");
  L.push('  return isNaN(n) ? NaN : n;');
  L.push('}', '');
  L.push('/** ISO, `yyyy-MM-dd`, `yyyy/MM/dd` or `MM/dd/yyyy` -> ISO string; blank -> null; invalid -> undefined. */');
  L.push('function parseDate(v) {');
  L.push('  if (blank(v)) return null;');
  L.push('  var s = String(v).trim();');
  L.push('  var m = s.match(/^(\\d{4})[-\\/](\\d{1,2})[-\\/](\\d{1,2})(.*)$/);');
  L.push('  var us = s.match(/^(\\d{1,2})\\/(\\d{1,2})\\/(\\d{4})$/);');
  L.push('  var y, mo, d, rest;');
  L.push('  if (m) {');
  L.push('    y = +m[1]; mo = +m[2]; d = +m[3]; rest = m[4];');
  L.push('  } else if (us) {');
  L.push("    y = +us[3]; mo = +us[1]; d = +us[2]; rest = '';");
  L.push('  } else return undefined;');
  L.push('  var dt = new Date(Date.UTC(y, mo - 1, d));');
  L.push('  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return undefined;');
  L.push("  if (rest && /^T\\d{2}:\\d{2}/.test(rest)) { var full = new Date(s); return isNaN(full.getTime()) ? undefined : full.toISOString(); }");
  L.push("  return dt.toISOString().substring(0, 10) + 'T09:00:00.000Z';");
  L.push('}', '');
  L.push("var TRUE = ['true', 'yes', 'y', '1'];");
  L.push("var FALSE = ['false', 'no', 'n', '0'];", '');
  L.push('/** Cleans one row: `{ rec: {...} }` or `{ reason: "..." }`. Never throws (a throw fails the whole file). */');
  L.push('function evaluateRow(row) {');
  L.push('  try {');
  L.push('    var rec = {};');
  L.push('    var problems = [];');
  ig.cols.forEach(function (c) {
    var f = c.field;
    var v = 'row.' + c.prop;
    var label = "'" + c.header + "'";
    if (f.kind === 'string') {
      L.push('    if (!blank(' + v + ')) rec.' + f.name + ' = String(' + v + ').trim();');
    } else if (f.kind === 'int' || f.kind === 'double') {
      L.push('    var n_' + c.prop + ' = parseNumber(' + v + ');');
      L.push('    if (n_' + c.prop + ' !== n_' + c.prop + ') problems.push(' + label + " + ' is not a number');");
      L.push('    else if (n_' + c.prop + ' != null) rec.' + f.name + ' = ' + (f.kind === 'int' ? 'Math.round(n_' + c.prop + ')' : 'n_' + c.prop) + ';');
    } else if (f.kind === 'datetime') {
      L.push('    var d_' + c.prop + ' = parseDate(' + v + ');');
      L.push('    if (d_' + c.prop + ' === undefined) problems.push(' + label + " + ' is not a date');");
      L.push('    else if (d_' + c.prop + ') rec.' + f.name + ' = d_' + c.prop + ';');
    } else if (f.kind === 'boolean') {
      L.push('    if (!blank(' + v + ')) {');
      L.push('      var b_' + c.prop + ' = String(' + v + ').trim().toLowerCase();');
      L.push('      if (TRUE.indexOf(b_' + c.prop + ') >= 0) rec.' + f.name + ' = true;');
      L.push('      else if (FALSE.indexOf(b_' + c.prop + ') >= 0) rec.' + f.name + ' = false;');
      L.push('      else problems.push(' + label + " + ' is not yes/no');");
      L.push('    }');
    } else if (f.kind === 'enum') {
      L.push('    if (!blank(' + v + ')) {');
      L.push('      var e_' + c.prop + ' = ENUMS.' + c.prop + '.filter(function (x) {');
      L.push('        return x.toLowerCase() === String(' + v + ').trim().toLowerCase();');
      L.push('      })[0];');
      L.push('      if (e_' + c.prop + ') rec.' + f.name + ' = e_' + c.prop + ';');
      L.push('      else problems.push(' + label + " + ' has unknown value \"' + " + v + " + '\"');");
      L.push('    }');
    } else if (f.kind === 'ref') {
      L.push('    if (!blank(' + v + ')) {');
      L.push('      var r_' + c.prop + ' = String(' + v + ').trim();');
      L.push('      // the platform accepts dangling references silently (knowledge/12), so check the parent exists');
      L.push('      if (' + f.ref + ".fetchCount({ filter: Filter.eq('id', r_" + c.prop + ') }) > 0) rec.' + f.name + ' = { id: r_' + c.prop + ' };');
      L.push('      else problems.push(' + label + " + ' refers to unknown " + M.words(f.ref).toLowerCase() + " ' + r_" + c.prop + ');');
      L.push('    }');
    }
    if (f.required) L.push('    if (rec.' + f.name + ' == null && problems.length === 0) problems.push(' + label + " + ' is required');");
  });
  if (idCol) {
    L.push('    if (!blank(row.' + idCol.prop + ')) {');
    L.push('      rec.id = String(row.' + idCol.prop + ').trim();');
    // duplicate = same id, or the same value in the field the id column maps to (seed rows use other ids)
    L.push('      if (' + ent.name + ".fetchCount({ filter: Filter.eq('id', rec.id) }) > 0 || " + ent.name + ".fetchCount({ filter: Filter.eq('" + idCol.field.name + "', rec.id) }) > 0) {");
    L.push("        problems.push('duplicate: ' + rec.id + ' is already loaded');");
    L.push('      }');
    L.push('    }');
  }
  L.push("    if (problems.length) return { reason: problems.join('; ') };");
  L.push('    return { rec: rec };');
  L.push('  } catch (e) {');
  L.push("    return { reason: 'unexpected error: ' + String(e) };");
  L.push('  }');
  L.push('}', '');
  L.push('function fileName(row) {');
  L.push("  var u = row.sourceFileUrl ? String(row.sourceFileUrl) : '';");
  L.push("  return u ? u.substring(u.lastIndexOf('/') + 1) : null;");
  L.push('}', '');
  L.push('function toTargets() {');
  L.push('  var r = evaluateRow(this);');
  L.push('  return r.rec ? [' + ent.name + '.make(r.rec)] : [];');
  L.push('}', '');
  L.push('function rejectionTargets() {');
  L.push('  var r = evaluateRow(this);');
  L.push('  if (!r.reason) return [];');
  L.push('  var raw = {};');
  ig.cols.forEach(function (c) { L.push('  raw[' + JSON.stringify(c.header) + '] = this.' + c.prop + ';'); });
  L.push('  return [');
  L.push('    ' + ent.name + '.Rejection.make({');
  L.push('      sourceFile: fileName(this),');
  L.push('      rowKey: ' + (idCol ? 'blank(this.' + idCol.prop + ') ? null : String(this.' + idCol.prop + ')' : 'null') + ',');
  L.push('      reason: r.reason,');
  L.push('      rawRow: JSON.stringify(raw),');
  L.push('    }),');
  L.push('  ];');
  L.push('}', '');
  L.push('function feedStatus() {');
  L.push('  var coll = FileSourceCollection.forName(FEED);');
  L.push("  var res = SourceStatus.fetch({ filter: \"startsWith(id, '\" + FEED + \"')\", include: 'id, state, count, successful, failed, meta.created', order: 'descending(meta.created)', limit: 20 });");
  L.push('  var runs = (res.objs || []).map(function (s) {');
  L.push('    return {');
  L.push('      file: s.id,');
  L.push('      state: s.state == null ? null : String(s.state),');
  L.push('      count: s.count,');
  L.push('      successful: s.successful,');
  L.push('      failed: s.failed,');
  L.push('      started: s.meta ? s.meta.created : null,');
  L.push('    };');
  L.push('  });');
  L.push('  return ' + n.status + '.make({ inboxUrl: coll.inboxUrl(), rejectedCount: ' + ent.name + '.Rejection.fetchCount(), runs: runs });');
  L.push('}', '');
  L.push('function uploadCsv(fileName, content) {');
  L.push("  var safe = String(fileName).replace(/[^A-Za-z0-9._-]/g, '_');");
  L.push("  if (!/\\.csv$/i.test(safe)) safe += '.csv';");
  L.push('  var inbox = FileSourceCollection.forName(FEED).inboxUrl();');
  L.push("  var file = FileSystem.makeFile(inbox.replace(/\\/$/, '') + '/' + safe);");
  L.push('  file.writeString(content);');
  L.push('  processInbox();');
  L.push("  log.info('Uploaded {} to {}', safe, inbox);");
  L.push('  return file.url;');
  L.push('}', '');
  L.push('function processInbox() {');
  L.push('  FileSourceCollection.forName(FEED).process(DataIntegSpec.make({ process: true }));');
  L.push("  return 'queued';");
  L.push('}');
  return L.join('\n') + '\n';
}

function metadataFiles(app, ent) {
  var n = names(ent);
  var f = {};
  f['metadata/FileSourceSystem/' + n.system + '.json'] = JSON.stringify({ name: n.system }, null, 2) + '\n';
  f['metadata/FileSourceCollection/' + n.feed + '.json'] = JSON.stringify({ name: n.feed, sourceSystem: n.system, source: n.source }, null, 2) + '\n';
  f['metadata/DbTargetCollection/' + n.target + '.json'] = JSON.stringify({ name: n.target, target: ent.name }, null, 2) + '\n';
  f['config/DbTargetCollection.Config/' + n.target + '.json'] = JSON.stringify({ name: n.target, createOnly: true }, null, 2) + '\n';
  f['metadata/Transform/' + n.source + '-' + ent.name + '.js'] = [
    'data = {', "  name: '" + n.source + '-' + ent.name + "',", "  source: '" + n.source + "',", "  target: '" + ent.name + "',",
    "  targetCollection: '" + n.target + "',", '  transformer: function (src) {', '    return src.toTargets();', '  },', '};', ''].join('\n');
  f['metadata/Transform/' + n.source + '-' + n.rejection + '.js'] = [
    'data = {', "  name: '" + n.source + '-' + n.rejection + "',", "  source: '" + n.source + "',", "  target: '" + n.rejection + "',",
    '  transformer: function (src) {', '    return src.rejectionTargets();', '  },', '};', ''].join('\n');
  return f;
}

/** A small sample CSV (good rows plus deliberately bad ones) for trying the pipeline. */
function sampleCsv(app, ent) {
  var ig = ent.ingest;
  if (!ig.sample) return null;
  var heads = ig.cols.map(function (c) { return c.header; });
  var esc = function (v) { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  return [heads.join(',')].concat(ig.sample.map(function (r) { return heads.map(function (h) { return esc(r[h]); }).join(','); })).join('\n') + '\n';
}

module.exports = { names: names, normalize: normalize, c3typFiles: c3typFiles, sourceJs: sourceJs, metadataFiles: metadataFiles, sampleCsv: sampleCsv };

// ---------- Imports page ----------

function importsPage(app, ent) {
  var n = names(ent);
  var hdr = app.header ? '/*\n * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.\n * Confidential and Proprietary C3 Materials.\n */\n\n' : '';
  var C = ent.name;
  var heads = ent.ingest.cols.map(function (c) { return c.header; }).join(', ');
  var crumbs = (app.dashboard ? "{ label: 'Dashboard', href: '#/' }, " : '') + "{ label: '" + ent.display + "', href: '#/" + ent.route + "' }, { label: 'Imports' }";
  return hdr + [
    "import React, { useEffect, useRef, useState } from 'react';",
    "import { RefreshCw, Upload } from 'lucide-react';",
    '',
    "import { c3Call } from '@/c3Action';",
    "import { useErrorBoundary } from '@/components/ErrorBoundary/ErrorBoundary';",
    "import PageFrame, { EmptyRows, ErrorState, LoadingState, errorMessage } from '@/components/PageFrame/PageFrame';",
    "import { Badge } from '@/components/ui/badge';",
    "import { Button } from '@/components/ui/button';",
    "import { Container } from '@/components/ui/container';",
    "import { DataGrid, DataGridBody, DataGridCell, DataGridHead, DataGridHeader, DataGridRow } from '@/components/ui/data-grid';",
    "import type { FetchResult } from '@/Interfaces';",
    "import { formatDateTime } from '@/lib/format';",
    '',
    'interface FeedRun {',
    '  file: string;',
    '  state?: string;',
    '  count?: number;',
    '  successful?: number;',
    '  failed?: number;',
    '  started?: string;',
    '}',
    '',
    'interface FeedStatus {',
    '  inboxUrl?: string;',
    '  rejectedCount?: number;',
    '  runs?: FeedRun[];',
    '}',
    '',
    'interface Rejection {',
    '  id: string;',
    '  sourceFile?: string;',
    '  rowKey?: string;',
    '  reason: string;',
    '  meta?: { created?: string };',
    '}',
    '',
    "const FEED = '" + n.feed + "';",
    '',
    '/** CSV imports for ' + ent.display.toLowerCase() + ': upload a file, watch the run, review rejected rows. */',
    'const ' + C + 'Imports: React.FC = () => {',
    '  const { reportError } = useErrorBoundary();',
    '  const fileInput = useRef<HTMLInputElement>(null);',
    '  const [status, setStatus] = useState<FeedStatus | null>(null);',
    '  const [rejections, setRejections] = useState<Rejection[]>([]);',
    '  const [error, setError] = useState<string | null>(null);',
    '  const [busy, setBusy] = useState(false);',
    '  const [notice, setNotice] = useState<string | null>(null);',
    '  const [reloadKey, setReloadKey] = useState(0);',
    '',
    '  useEffect(() => {',
    '    let cancelled = false;',
    '    setError(null);',
    '    Promise.all([',
    "      c3Call('" + n.source + "', 'feedStatus', null, []) as Promise<FeedStatus>,",
    "      c3Call('" + n.rejection + "', 'fetch', null, [",
    "        { include: 'id, sourceFile, rowKey, reason, meta.created', order: 'descending(meta.created)', limit: 50, offset: 0 },",
    '      ]) as Promise<FetchResult<Rejection>>,',
    '    ])',
    '      .then(([s, r]) => {',
    '        if (cancelled) return;',
    '        setStatus(s);',
    '        setRejections(r.objs ?? []);',
    '      })',
    '      .catch((err: unknown) => {',
    '        if (cancelled) return;',
    '        setError(errorMessage(err));',
    '        reportError(err);',
    '      });',
    '    return () => {',
    '      cancelled = true;',
    '    };',
    '  }, [reloadKey, reportError]);',
    '',
    '  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {',
    '    const file = e.target.files?.[0];',
    "    e.target.value = '';",
    '    if (!file) return;',
    '    setBusy(true);',
    '    setNotice(null);',
    '    try {',
    '      const text = await file.text();',
    "      await c3Call('" + n.source + "', 'uploadCsv', null, [file.name, text]);",
    '      setNotice(`${file.name} uploaded; processing runs in the background. Refresh in a few seconds.`);',
    '      window.setTimeout(() => setReloadKey((k) => k + 1), 6000);',
    '    } catch (err) {',
    '      setError(errorMessage(err));',
    '      reportError(err);',
    '    } finally {',
    '      setBusy(false);',
    '    }',
    '  };',
    '',
    '  const actions = (',
    '    <div className="flex flex-wrap gap-2">',
    '      <Button variant="outline" appearance="secondary" leadingIcon={<RefreshCw />} onClick={() => setReloadKey((k) => k + 1)}>',
    '        Refresh',
    '      </Button>',
    '      <Button leadingIcon={<Upload />} loading={busy} onClick={() => fileInput.current?.click()}>',
    '        Upload CSV',
    '      </Button>',
    '      <input ref={fileInput} type="file" accept=".csv,text/csv" className="hidden" aria-label="CSV file" onChange={onFile} />',
    '    </div>',
    '  );',
    '',
    '  return (',
    '    <PageFrame',
    '      title=' + JSON.stringify(ent.singular + ' Imports'),
    '      description=' + JSON.stringify('CSV files for the ' + n.feed + ' feed. Columns: ' + heads + '.'),
    '      breadcrumbs={[' + crumbs + ']}',
    '      actions={actions}',
    '    >',
    '      {error && <ErrorState message={error} onRetry={() => setReloadKey((k) => k + 1)} />}',
    '      {notice && (',
    '        <div role="status" className="rounded-sm border border-[var(--c3-style-basic-border-border)] bg-[var(--c3-style-basic-bg-primary)] p-3 text-c3-regular-body-p2">',
    '          {notice}',
    '        </div>',
    '      )}',
    '      {!status && !error && <LoadingState label="Loading feed status…" />}',
    '      {status && (',
    '        <>',
    '          <p className="text-c3-regular-body-p3 text-[var(--c3-style-basic-fg-secondary)]">',
    '            Inbox (File Explorer upload also works): <code className="break-all">{status.inboxUrl}</code>',
    '          </p>',
    '          <Container contentWidth="full-width" title="Recent files" subtitle={`Feed ${FEED}, newest first`}>',
    '            <div className="overflow-x-auto">',
    '              <DataGrid className="w-full">',
    '                <DataGridHeader>',
    '                  <DataGridRow>',
    '                    <DataGridHead sortable={false} filterable={false}>File</DataGridHead>',
    '                    <DataGridHead sortable={false} filterable={false}>State</DataGridHead>',
    '                    <DataGridHead sortable={false} filterable={false} align="right">Rows</DataGridHead>',
    '                    <DataGridHead sortable={false} filterable={false} align="right">Processed</DataGridHead>',
    '                    <DataGridHead sortable={false} filterable={false} align="right">Failed</DataGridHead>',
    '                    <DataGridHead sortable={false} filterable={false}>Started</DataGridHead>',
    '                  </DataGridRow>',
    '                </DataGridHeader>',
    '                <DataGridBody>',
    '                  {(status.runs ?? []).length === 0 && <EmptyRows colSpan={6} label="No files processed yet." />}',
    '                  {(status.runs ?? []).map((r) => (',
    '                    <DataGridRow key={r.file}>',
    '                      <DataGridCell className="max-w-72 truncate">{r.file.replace(`${FEED}_`, \'\')}</DataGridCell>',
    '                      <DataGridCell>',
    "                        <Badge variant=\"soft\" appearance={r.state === 'completed' ? 'success' : r.state === 'failed' ? 'danger' : 'info'} size=\"sm\" shape=\"rounded\">",
    "                          {r.state ?? 'unknown'}",
    '                        </Badge>',
    '                      </DataGridCell>',
    "                      <DataGridCell align=\"right\">{r.count ?? '—'}</DataGridCell>",
    "                      <DataGridCell align=\"right\">{r.successful ?? '—'}</DataGridCell>",
    "                      <DataGridCell align=\"right\">{r.failed ?? '—'}</DataGridCell>",
    '                      <DataGridCell className="whitespace-nowrap">{formatDateTime(r.started)}</DataGridCell>',
    '                    </DataGridRow>',
    '                  ))}',
    '                </DataGridBody>',
    '              </DataGrid>',
    '            </div>',
    '          </Container>',
    '          <Container contentWidth="full-width" title={`Rejected rows (${status.rejectedCount ?? 0})`} subtitle="Rows that were not loaded, with the reason">',
    '            <div className="overflow-x-auto">',
    '              <DataGrid className="w-full">',
    '                <DataGridHeader>',
    '                  <DataGridRow>',
    '                    <DataGridHead sortable={false} filterable={false}>File</DataGridHead>',
    '                    <DataGridHead sortable={false} filterable={false}>Row</DataGridHead>',
    '                    <DataGridHead sortable={false} filterable={false}>Reason</DataGridHead>',
    '                    <DataGridHead sortable={false} filterable={false}>When</DataGridHead>',
    '                  </DataGridRow>',
    '                </DataGridHeader>',
    '                <DataGridBody>',
    '                  {rejections.length === 0 && <EmptyRows colSpan={4} label="No rejected rows." />}',
    '                  {rejections.map((r) => (',
    '                    <DataGridRow key={r.id}>',
    "                      <DataGridCell className=\"max-w-56 truncate\">{r.sourceFile ?? '—'}</DataGridCell>",
    "                      <DataGridCell className=\"whitespace-nowrap\">{r.rowKey ?? '—'}</DataGridCell>",
    '                      <DataGridCell className="text-[var(--c3-style-basic-fg-danger)]">{r.reason}</DataGridCell>',
    '                      <DataGridCell className="whitespace-nowrap">{formatDateTime(r.meta?.created)}</DataGridCell>',
    '                    </DataGridRow>',
    '                  ))}',
    '                </DataGridBody>',
    '              </DataGrid>',
    '            </div>',
    '          </Container>',
    '        </>',
    '      )}',
    '    </PageFrame>',
    '  );',
    '};',
    '',
    'export default ' + C + 'Imports;',
    '',
  ].join('\n');
}

module.exports.importsPage = importsPage;

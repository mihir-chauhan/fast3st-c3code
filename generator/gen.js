#!/usr/bin/env node
'use strict';

/*
 * c3app-gen: writes a complete C3 Code-style application repo from a compact JSON spec.
 *
 *   node gen.js <spec.json> <outDir> --ui-base <dir> [--ui-vendor <dir>] [--force]
 *
 * <outDir> becomes the repo root (the equivalent of /usr/workspace): it gets a `.gitignore` and the package folder
 * `<package>/`. The UI shell is copied from YOUR OWN C3 Code workspace's `<pkg>/ui/react` (blank template), given by
 * --ui-base or $C3_UI_BASE. --ui-vendor / $C3_UI_VENDOR is an optional folder copied over `ui/react/src` last (the
 * shared components the generated pages import; see README "UI shell and vendored components"). No C3 template
 * files are bundled with this repo.
 */

var fs = require('fs');
var path = require('path');

var M = require('./lib/model');
var B = require('./lib/backend');
var S = require('./lib/seed');
var U = require('./lib/ui');

var HERE = __dirname;
var GITIGNORE = ['node_modules/', 'dist/', 'ui/content/', '*.c3pkg.lock.json', '.env', '.env.*', '.DS_Store', '*.log', ''].join('\n');
// Files the generated pages import that are not part of the blank template (see README).
var VENDOR_FILES = ['components/PageFrame/PageFrame.tsx', 'components/DetailList/DetailList.tsx',
  'components/charts/EChart.tsx', 'components/charts/BarList.tsx', 'hooks/useMediaQuery.ts', 'lib/echarts.ts',
  'lib/echarts-theme.ts', 'lib/echarts-zoom-handles.ts', 'lib/css-var.ts'];

// Template files the C3 Code agent replaces or deletes in every blankPkg app (19-generated-app-backbone.md §5).
var UI_SKIP = ['node_modules', 'src/pages', 'src/shared', 'src/data', 'src/components/PageStates', 'src/components/ItemStatusBadge'];

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function copyTree(src, dst, skip, rel) {
  rel = rel || '';
  fs.mkdirSync(dst, { recursive: true });
  fs.readdirSync(src, { withFileTypes: true }).forEach(function (d) {
    var r = rel ? rel + '/' + d.name : d.name;
    if (skip.indexOf(r) >= 0) return;
    var s = path.join(src, d.name);
    var t = path.join(dst, d.name);
    if (d.isDirectory()) {
      fs.mkdirSync(t, { recursive: true });
      copyTree(s, t, skip, r);
    } else fs.copyFileSync(s, t);
  });
}

function main(argv) {
  var args = argv.slice(2);
  var force = args.indexOf('--force') >= 0;
  var uiBase = process.env.C3_UI_BASE ? path.resolve(process.env.C3_UI_BASE) : null;
  var uiVendor = process.env.C3_UI_VENDOR ? path.resolve(process.env.C3_UI_VENDOR) : null;
  var i = args.indexOf('--ui-base');
  if (i >= 0) {
    uiBase = path.resolve(args[i + 1]);
    args.splice(i, 2);
  }
  i = args.indexOf('--ui-vendor');
  if (i >= 0) {
    uiVendor = path.resolve(args[i + 1]);
    args.splice(i, 2);
  }
  args = args.filter(function (a) { return a !== '--force'; });
  if (args.length < 2) {
    process.stderr.write('Usage: node gen.js <spec.json> <outDir> --ui-base <dir> [--ui-vendor <dir>] [--force]\n');
    process.exitCode = 2;
    return;
  }
  if (!uiBase || !fs.existsSync(path.join(uiBase, 'package.json'))) {
    throw new Error('UI base not found. Pass --ui-base (or set C3_UI_BASE) to the ui/react folder of a blank-template ' +
      'C3 Code workspace you have access to (see README "UI shell and vendored components").');
  }
  var app = M.load(args[0]);
  var out = path.resolve(args[1]);
  var pkgDir = path.join(out, app.pkg);
  if (fs.existsSync(pkgDir)) {
    if (!force) throw new Error(pkgDir + ' exists; pass --force to regenerate (it is deleted first, node_modules kept)');
    var keep = path.join(pkgDir, 'ui/react/node_modules');
    var tmp = path.join(out, '.node_modules.keep');
    if (fs.existsSync(keep)) fs.renameSync(keep, tmp);
    fs.rmSync(pkgDir, { recursive: true, force: true });
    if (fs.existsSync(tmp)) {
      fs.mkdirSync(path.join(pkgDir, 'ui/react'), { recursive: true });
      fs.renameSync(tmp, keep);
    }
  }
  var files = [];
  function emit(rel, content) {
    write(path.join(out, rel), content);
    files.push(rel);
  }
  var P = app.pkg + '/';

  // repo root
  emit('.gitignore', GITIGNORE);

  // package manifest + steering
  emit(P + app.pkg + '.c3pkg.json', B.manifest(app));
  if (app.agentNotes) emit(P + 'CLAUDE.md', B.pkgClaude(app));

  // backend types
  app.entities.forEach(function (e) {
    emit(P + 'src/' + e.name + '.c3typ', B.entityTyp(app, e));
    e.enumsLocal.forEach(function (en) { emit(P + 'src/' + en.name + '.c3typ', B.enumTyp(en)); });
  });
  if (app.dashboard) {
    var dt = B.dashboardTypes(app);
    Object.keys(dt).forEach(function (n) { emit(P + 'src/' + n + '.c3typ', dt[n]); });
    emit(P + 'src/' + app.dashboard.entity.name + '.js', B.dashboardJs(app));
    if (app.tests) emit(P + 'test/js-rhino/test_' + app.dashboard.entity.name + '.js', B.testJs(app));
  }
  // lab6: role-based access (metadata/Role, data/UserGroup, <Access>.mine) and its UI hook
  if (app.access) {
    var af = B.accessFiles(app);
    Object.keys(af).forEach(function (f) { emit(P + f, af[f]); });
  }
  // lab6: CSV ingestion pipelines (lib/ingest.js): Source type, collection, transforms, rejections, Imports page
  var I = require('./lib/ingest');
  app.entities.filter(function (e) { return e.ingest; }).forEach(function (e) {
    var ig = Object.assign({}, I.c3typFiles(app, e), I.metadataFiles(app, e));
    ig['src/source/' + I.names(e).source + '.js'] = I.sourceJs(app, e);
    Object.keys(ig).forEach(function (f) { emit(P + f, ig[f]); });
    var csv = I.sampleCsv(app, e);
    if (csv) emit('samples/' + I.names(e).feed + '-sample.csv', csv);
    emit(P + 'ui/react/src/pages/' + e.area + '/' + e.name + 'Imports.tsx', I.importsPage(app, e));
  });

  // seed rows
  var rows = S.generateAll(app);
  var counts = {};
  app.entities.forEach(function (e) {
    counts[e.name] = rows[e.name].rows.length;
    emit(P + app.dataDir + '/' + e.name + '/' + e.name + '.json', JSON.stringify(rows[e.name].rows, null, 2) + '\n');
  });

  // summaries
  // the template's own summary, if the UI base sits inside a workspace package (<pkg>/ui/react -> <pkg>/src)
  var tplSummary = path.resolve(uiBase, '../../src/TEMPLATE_SUMMARY.md');
  if (fs.existsSync(tplSummary)) emit(P + 'src/TEMPLATE_SUMMARY.md', fs.readFileSync(tplSummary, 'utf8'));
  emit(P + 'src/WORKSPACE_SUMMARY.md', B.workspaceSummary(app, counts));

  // UI: template shell, then vendored lab4 components, then generated files
  var ui = path.join(pkgDir, 'ui/react');
  copyTree(uiBase, ui, UI_SKIP);
  if (uiVendor) copyTree(uiVendor, path.join(ui, 'src'), []);
  var missing = VENDOR_FILES.filter(function (f) { return !fs.existsSync(path.join(ui, 'src', f)); });
  if (missing.length) process.stderr.write('warning: generated pages import files not present in the UI shell (the UI ' +
    'build will fail until you add them, e.g. with --ui-vendor):\n  ' + missing.join('\n  ') + '\n');
  var R = P + 'ui/react/';
  var pj = JSON.parse(fs.readFileSync(path.join(ui, 'package.json'), 'utf8'));
  pj.name = app.pkg;
  emit(R + 'package.json', JSON.stringify(pj, null, 2) + '\n');
  var lock = JSON.parse(fs.readFileSync(path.join(HERE, 'assets/ui/package-lock.json'), 'utf8'));
  lock.name = app.pkg;
  lock.packages[''].name = app.pkg;
  emit(R + 'package-lock.json', JSON.stringify(lock, null, 2) + '\n');
  emit(R + 'index.html', fs.readFileSync(path.join(ui, 'index.html'), 'utf8').replace(/<title>[^<]*<\/title>/, '<title>' + app.title.replace(/</g, '&lt;') + '</title>'));
  emit(R + 'src/styles/manual-tokens.css', fs.readFileSync(path.join(uiBase, 'src/styles/manual-tokens.css'), 'utf8') + [
    '',
    '/* c3app-gen: @fontsource-variable/inter registers the face as "Inter Variable", while tokens.css asks for',
    '   "Inter", so every page silently fell back to system-ui (14-lab4-clean-ui.md). Point the font token at the',
    '   face that is actually loaded. tokens.css stays untouched. */',
    ':root {',
    "  --theme-font-family-font-sans: 'Inter Variable', Inter, system-ui, sans-serif;",
    '}',
    '',
  ].join('\n'));
  emit(R + 'src/globals.css', fs.readFileSync(path.join(uiBase, 'src/globals.css'), 'utf8') + fs.readFileSync(path.join(HERE, 'assets/ui/src/globals.app.css'), 'utf8'));
  emit(R + 'src/App.tsx', U.appTsx(app));
  emit(R + 'src/config/navigation.ts', U.navigation(app));
  emit(R + 'src/Interfaces.tsx', U.interfaces(app));
  emit(R + 'src/lib/format.ts', U.format(app));
  emit(R + 'src/components/StatusBadges/StatusBadges.tsx', U.statusBadges(app));
  var lookups = U.useLookups(app);
  if (lookups) emit(R + 'src/hooks/useLookups.ts', lookups);
  if (app.access) {
    emit(R + 'src/hooks/useAccess.ts', U.useAccessTs(app));
    emit(R + 'src/components/AccessBadge/AccessBadge.tsx', U.accessBadgeTsx(app));
  }
  if (app.dashboard) emit(R + 'src/pages/Dashboard/Dashboard.tsx', U.dashboardPage(app));
  app.entities.forEach(function (e) {
    var dir = R + 'src/pages/' + e.area + '/';
    if (U.hasPage(e, 'list')) emit(dir + e.name + 'List.tsx', U.listPage(app, e));
    if (U.hasPage(e, 'detail')) emit(dir + e.name + 'Detail.tsx', U.detailPage(app, e));
    if (U.hasPage(e, 'form')) emit(dir + e.name + 'Form.tsx', U.formPage(app, e));
    if (e.map) emit(dir + e.name + 'Map.tsx', U.mapPage(app, e)); // lab6: lat/long map page
  });

  // --- lab7: optional in-app AI agent (spec.agent) -> lib/agent.js. Runs last: it also patches the manifest,
  // App.tsx, navigation.ts and the summaries written above.
  var agent = require('./lib/agent');
  var ag = agent.normalize(JSON.parse(fs.readFileSync(args[0], 'utf8')), app);
  if (ag) agent.emit(app, ag, { out: out, emit: emit });
  // --- end lab7

  process.stdout.write('Generated ' + app.pkg + ' into ' + out + ' (' + files.length + ' generated files, UI shell from ' + uiBase + ')\n');
  app.entities.forEach(function (e) { process.stdout.write('  ' + e.name + ': ' + counts[e.name] + ' rows\n'); });
}

if (require.main === module) {
  try {
    main(process.argv);
  } catch (e) {
    process.stderr.write((e && e.message ? e.message : String(e)) + '\n');
    process.exitCode = 1;
  }
}

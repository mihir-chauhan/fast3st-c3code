#!/usr/bin/env node
'use strict';
// usage: node pkg-mirror.js <appName> <destRoot>
// READ-ONLY mirror of a C3 Code application's workspace package to <destRoot>/<appName>/ (e.g. to diff what the
// agent wrote against your generator output). Needs a logged-in Chrome and C3_BASE_URL (see session.js).
// Method: cookie session of that Chrome (no tab, no navigation):
//   1. Studio API Genesis.Application/fetch + Genesis.Workspace/fetch -> pkgName + workspace env
//   2. <env>/liveapp/api/8/Pkg/paths('/<pkg>/')   -> file list (server-side package view, no node_modules)
//   3. <env>/liveapp/api/8/Pkg/content(path)       -> ContentValue with base64 content
//   4. code-server vscode-remote-resource GET     -> dotfiles / workspace-root files Pkg.paths does not list
// Never writes anything to the workspace.
const { connect, baseUrl } = require('./session');
const fs = require('fs'); const P = require('path');
const app = process.argv[2];
if (!app || !process.argv[3]) { console.log('usage: node pkg-mirror.js <appName> <destRoot>'); process.exit(2); }
const DEST = P.join(P.resolve(process.argv[3]), app);
const HOST = baseUrl();
const SKIP = [
  [/\/gen\//, 'generated: platform gen/cache'],
  [/\/node_modules\//, 'dependency install output'],
  [/\/(dist|build|coverage|\.vite)\//, 'bundle/build output'],
  [/\/ui\/content\//, 'UI bundle output (vite build -> ui/content/<pkg>)'],
  [/\.c3pkg\.lock\.json$/, 'generated lock (gitignored by C3 Code)'],
  [/\/package-lock\.json$/, 'npm lockfile (generated, large)'],
];
const SECRETISH = /(^|\/)\.env(\.|$)|\.(pem|key)$/;
(async () => {
  const c = await connect();
  try {
    const A = await c.resolveApp(app);
    const env = A.env, pkg = A.pkg, B = A.live;
    console.log(`app=${app} pkg=${pkg}`);
    const pl = await c.call(B, 'Pkg', 'paths', `${pkg}#dev`, [`/${pkg}/`]);
    if (pl.status !== 200 || !Array.isArray(pl.body)) throw new Error('Pkg.paths failed ' + pl.status + ' ' + JSON.stringify(pl.body).slice(0, 300));
    const all = pl.body.map(x => decodeURIComponent(x)).sort();
    const keep = [], skipped = [];
    for (const p of all) { const s = SKIP.find(([re]) => re.test(p)); if (s) skipped.push({ path: p, reason: s[1] }); else keep.push(p); }
    // fresh mirror dir (only this app's dir is replaced)
    fs.rmSync(DEST, { recursive: true, force: true }); fs.mkdirSync(DEST, { recursive: true });
    const files = []; let i = 0;
    const worker = async () => {
      while (i < keep.length) {
        const p = keep[i++]; const rel = p.replace(`/${pkg}/`, `${pkg}/`);
        if (SECRETISH.test(p)) { skipped.push({ path: p, reason: 'possible secrets, not copied' }); continue; }
        const r = await c.call(B, 'Pkg', 'content', `${pkg}#dev`, [p]);
        if (r.status !== 200 || !r.body || r.body.content === undefined) { skipped.push({ path: p, reason: 'read failed ' + r.status }); continue; }
        const buf = Buffer.from(r.body.content, 'base64');
        const out = P.join(DEST, rel); fs.mkdirSync(P.dirname(out), { recursive: true }); fs.writeFileSync(out, buf);
        files.push({ path: rel, bytes: buf.length });
      }
    };
    await Promise.all(Array.from({ length: 8 }, worker));
    // extras through code-server (dotfiles + workspace root); 404 = absent
    const home = await c.get(`${HOST}/${env}/liveapp/codeservice/?folder=/usr/workspace`);
    const m = home.body.toString().match(/stable-[0-9a-f]{40}/);
    const extras = [];
    if (m) {
      const base = `${HOST}/${env}/liveapp/codeservice/${m[0]}/vscode-remote-resource?path=`;
      const cands = ['.gitignore', 'README.md', 'AGENTS.md', 'CLAUDE.md', '.claude/CLAUDE.md', '.claude/settings.json', '.github/copilot-instructions.md', '.gitattributes', '.editorconfig', '.cursorignore', '.cursorindexingignore']
        .map(f => `/usr/workspace/${f}`)
        .concat(['.gitignore', 'README.md', 'AGENTS.md', 'CLAUDE.md', '.claude/CLAUDE.md', '.c3ignore', 'ui/react/.gitignore', 'ui/react/.prettierrc', 'ui/react/.prettierrc.json', 'ui/react/.eslintrc.json', 'ui/react/.nvmrc', 'ui/react/.npmrc', 'ui/react/AGENTS.md', 'ui/react/CLAUDE.md', 'resource/TEMPLATE_SUMMARY.md', 'resource/WORKSPACE_SUMMARY.md'].map(f => `/usr/workspace/${pkg}/${f}`));
      for (const p of cands) {
        const r = await c.get(base + encodeURIComponent(p) + '&tkn=');
        if (r.status !== 200) continue;
        const rel = p.startsWith(`/usr/workspace/${pkg}/`) ? p.replace('/usr/workspace/', '') : '_workspace_root/' + p.replace('/usr/workspace/', '');
        const out = P.join(DEST, rel); if (fs.existsSync(out)) continue;
        fs.mkdirSync(P.dirname(out), { recursive: true }); fs.writeFileSync(out, r.body); extras.push({ path: rel, bytes: r.body.length });
      }
      // Pkg.paths silently omits any `lib/` directory (e.g. ui/react/src/lib/utils.ts). Recover UI sources by
      // crawling the vite dev server module graph from src/main.tsx, then read each raw file via code-server.
      const UI = `${HOST}/${env}/liveapp/uiservice/`;
      const seen = new Set(), queue = ['src/main.tsx']; let crawled = 0;
      while (queue.length) {
        const batch = queue.splice(0, 8);
        await Promise.all(batch.map(async (mod) => {
          const r = await c.get(UI + mod); if (r.status !== 200) return; crawled++;
          const re = new RegExp(`/${env}/liveapp/uiservice/([^"'?\\s]+)`, 'g'); let mm;
          const t = r.body.toString();
          while ((mm = re.exec(t))) {
            const d = mm[1];
            if (d.startsWith('node_modules/') || d.startsWith('@vite') || d.startsWith('@react-refresh') || d.startsWith('@id/')) continue;
            if (!seen.has(d)) { seen.add(d); queue.push(d); }
          }
        }));
      }
      const uiRoot = `/usr/workspace/${pkg}/ui/react/`;
      for (const d of [...seen].sort()) {
        const abs = d.startsWith('@fs/') ? d.slice(3) : uiRoot + d;
        if (!abs.startsWith(`/usr/workspace/${pkg}/`)) continue;
        const rel = abs.replace('/usr/workspace/', '');
        const out = P.join(DEST, rel); if (fs.existsSync(out)) continue;
        const r = await c.get(base + encodeURIComponent(abs) + '&tkn=');
        if (r.status !== 200) continue;
        fs.mkdirSync(P.dirname(out), { recursive: true }); fs.writeFileSync(out, r.body); extras.push({ path: rel, bytes: r.body.length, via: 'vite module graph (missing from Pkg.paths)' });
      }
      extras.push({ note: `vite crawl: ${crawled} modules fetched, ${seen.size} local module paths seen` });
    } else extras.push({ note: 'code-server not reachable; dotfiles/root files not fetched' });
    const manifest = { app, pkg, syncedAt: new Date().toISOString(),
      method: 'Pkg.paths + Pkg.content on <env>/liveapp/api/8 (x-request-envelope:true, session cookie); extras via code-server vscode-remote-resource',
      description: A.description || null, fileCount: files.length, files: files.sort((x, y) => x.path < y.path ? -1 : 1), extras,
      skipped: skipped.sort((x, y) => x.path < y.path ? -1 : 1) };
    fs.writeFileSync(P.join(DEST, 'MANIFEST.json'), JSON.stringify(manifest, null, 1));
    console.log(`files=${files.length} extras=${extras.length} skipped=${skipped.length} -> ${DEST}`);
  } catch (e) { console.log('ERROR', e.message); process.exitCode = 1; }
  await c.end();
})();

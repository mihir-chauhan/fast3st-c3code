'use strict';
// Cookie-session HTTP to a C3 AI cluster, borrowed from a Chrome you are already logged in to.
// No navigation, no UI: requests go through the browser context's request API, so they carry its session cookie.
//
// Start Chrome with remote debugging and log in to C3 Code once:
//   google-chrome --remote-debugging-port=9222 --user-data-dir=$HOME/.c3-chrome
// Then set:
//   C3_BASE_URL  https://<your-cluster-host>     (required, no trailing slash)
//   C3_CDP_URL   http://127.0.0.1:9222           (optional)
const { chromium } = require('playwright-core');

const CDP_URL = process.env.C3_CDP_URL || 'http://127.0.0.1:9222';
const STUDIO = 'misc/studio'; // C3 Code (Studio) API base path on the cluster

function baseUrl() {
  const b = process.env.C3_BASE_URL;
  if (!b) throw new Error('Set C3_BASE_URL to your C3 cluster URL, e.g. https://<host>');
  return b.replace(/\/+$/, '');
}

exports.STUDIO = STUDIO;
exports.baseUrl = baseUrl;

exports.connect = async () => {
  const base = baseUrl();
  const br = await chromium.connectOverCDP(CDP_URL, { timeout: 60000 });
  const ctx = br.contexts()[0];
  const req = ctx.request;
  const H = { 'content-type': 'application/json', accept: 'application/json', 'x-request-envelope': 'true' };
  // POST <base>/<path>/api/8/<Type>/<method> {thisArg, args, kwargs}. `path` is STUDIO or '<env>/liveapp'.
  const call = async (path, type, method, thisArg, args = [], kwargs) => {
    const data = { thisArg: thisArg === undefined ? type : thisArg, args };
    if (kwargs) data.kwargs = kwargs;
    const r = await req.post(`${base}/${path}/api/8/${type}/${method}`, { headers: H, data });
    const t = await r.text();
    let j;
    try { j = t ? JSON.parse(t) : null; } catch (e) { j = t; }
    return { status: r.status(), body: j };
  };
  const get = async (url) => {
    const r = await req.get(url.startsWith('http') ? url : `${base}/${url.replace(/^\//, '')}`);
    return { status: r.status(), body: await r.body() };
  };
  // Resolve an application by name: app id, package, workspaces, and the workspace env path ('<env>/liveapp').
  const resolveApp = async (appName, workspaceId) => {
    const a = await call(STUDIO, 'Genesis.Application', 'fetch', 'Genesis.Application',
      [{ filter: `name=="${appName.replace(/"/g, '')}"`, include: 'id,name,pkgName,{workspaces:[id,name]}' }]);
    const app = a.body && a.body.objs && a.body.objs[0];
    if (!app) throw new Error(`application not found: ${appName} (HTTP ${a.status})`);
    const wsId = workspaceId || (app.workspaces && app.workspaces[0] && app.workspaces[0].id);
    if (!wsId) throw new Error('application has no workspace');
    const w = await call(STUDIO, 'Genesis.Workspace', 'fetch', 'Genesis.Workspace', [{ filter: `id=="${wsId}"` }]);
    const ws = w.body && w.body.objs && w.body.objs[0];
    // workspace env ids look like "<cluster>-<env>"; the URL path uses "<env>"
    const env = ws && ws.env && ws.env.id ? ws.env.id.replace(/^[^-]+-/, '') : null;
    return { id: app.id, name: app.name, pkg: app.pkgName, workspaces: app.workspaces || [], wsId, env,
      live: env ? `${env}/liveapp` : null };
  };
  return { br, ctx, call, get, resolveApp, end: () => br.close() }; // close() only disconnects from Chrome
};

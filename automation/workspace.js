#!/usr/bin/env node
'use strict';
// Drive a C3 Code workspace through the same APIs its UI uses, with no chat turn (no LLM cost).
// Needs a logged-in Chrome and C3_BASE_URL (see session.js). The app is found by name; the first workspace is used
// unless --workspace <id> is given.
//
//   node workspace.js info   <app>                       app id, package, workspaces, env path
//   node workspace.js pull   <app> [branch]              Genesis.Workspace.Service.Agent.gitPull, then active branch
//   node workspace.js seed   <app>                       C3.pkg().upsertAllSeed(true) on the workspace app
//   node workspace.js issues <app>                       package issues (type errors with file/line/col)
//   node workspace.js js     <app> '<server js>'         Js.exec on the workspace app (like the C3 Console)
//   node workspace.js add-collaborators <app> <USER|ADMIN> <email>... [--notify]
//
// pull/seed/add-collaborators change state; info/issues are read-only. js runs whatever you pass.
const { connect, STUDIO } = require('./session');

const USAGE = 'usage: node workspace.js <info|pull|seed|issues|js|add-collaborators> <app> [...] [--workspace <id>]';

function take(args, flag, hasValue) {
  const i = args.indexOf(flag);
  if (i < 0) return hasValue ? null : false;
  const v = hasValue ? args[i + 1] : true;
  args.splice(i, hasValue ? 2 : 1);
  return v;
}

const show = (label, r) => console.log(label, r.status, JSON.stringify(r.body, null, 1).slice(0, 4000));

async function main() {
  const args = process.argv.slice(2);
  const wsOpt = take(args, '--workspace', true);
  const notify = take(args, '--notify', false);
  const [cmd, appName, ...rest] = args;
  if (!cmd || !appName) { console.log(USAGE); process.exitCode = 2; return; }
  const c = await connect();
  try {
    const app = await c.resolveApp(appName, wsOpt);
    const W = { workspace: { id: app.wsId } };
    switch (cmd) {
      case 'info':
        console.log(JSON.stringify(app, null, 1));
        break;
      case 'pull': {
        // The Git popover's Pull button runs the pull as a chat-agent turn; this API call is synchronous (~1 s).
        // Observed arguments: a branch name, or `false` (= no rebase) for the linked default branch.
        const r = await c.call(STUDIO, 'Genesis.Workspace.Service.Agent', 'gitPull', W, [rest[0] || false]);
        show('gitPull', r);
        const b = await c.call(STUDIO, 'Genesis.Workspace.Service.Agent', 'gitBranches', W, []);
        show('active branch', { status: b.status, body: Array.isArray(b.body) ? b.body.filter((x) => x.active) : b.body });
        break;
      }
      case 'seed': {
        // Nothing loads data/ or seed/ files automatically: run after the first checkout and after any data change.
        const r = await c.call(app.live, 'Js', 'exec', 'Js', ['C3.pkg().upsertAllSeed(true)']);
        show('upsertAllSeed', r);
        break;
      }
      case 'issues':
        show('pkgIssuesStatus', await c.call(STUDIO, 'Genesis.Workspace', 'pkgIssuesStatus', { id: app.wsId }, [false, false]));
        break;
      case 'js':
        if (!rest[0]) throw new Error('js needs a code string');
        show('Js.exec', await c.call(app.live, 'Js', 'exec', 'Js', [rest[0]]));
        break;
      case 'add-collaborators': {
        // Application-level roles: USER (can create own workspaces and build) or ADMIN.
        const role = (rest[0] || '').toUpperCase();
        const emails = rest.slice(1);
        if (!['USER', 'ADMIN'].includes(role) || !emails.length) throw new Error('add-collaborators <app> <USER|ADMIN> <email>...');
        const list = emails.map((e) => ({ user: { id: e }, email: e, role }));
        const r = await c.call(STUDIO, 'Genesis.Application', 'addCollaborators', { id: app.id }, [list],
          { emailTemplate: 'collaborator-added-application', notify: !!notify });
        show('addCollaborators', r);
        break;
      }
      default:
        console.log(USAGE);
        process.exitCode = 2;
    }
  } catch (e) {
    console.error('ERROR', e.message);
    process.exitCode = 1;
  } finally {
    await c.end();
  }
}

main();

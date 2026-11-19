# c3code-wrapper

Code-first toolkit for building C3 AI apps the way C3 Code writes them.

C3 Code is C3 AI's agentic app builder: you prompt it and its agent writes a C3 package (`.c3typ` types, `js-server`
methods, seed data, a React UI) into a cloud workspace. This repo lets you produce the same package **locally and
deterministically** from a JSON spec, push it to GitHub, and pull it into a C3 Code workspace through the platform API,
without spending a chat turn per change.

> **Unofficial.** Not affiliated with, endorsed by, or supported by C3 AI. "C3 AI" and "C3 Code" are names of their
> owner. This repo contains no C3 source, template, documentation or agent material; you need your own C3 Code access
> and supply your own workspace's template files (see below).

## What's inside

| Path | What |
|---|---|
| `generator/` | `gen.js` (spec -> package), `validate.js` (offline checks: `.c3typ` grammar subset, seed rows, UI `c3Call` targets, routes), `tools/selftest.js` + `tools/mock-c3.js` (determinism, dashboard numbers recomputed from seed rows), example specs. Node 18+, no npm dependencies. Full spec reference in `generator/README.md`. |
| `automation/` | `workspace.js` CLI (`info`, `pull`, `seed`, `issues`, `js`, `add-collaborators`) calling the APIs the Studio UI uses, `pkg-mirror.js` (read-only mirror of a workspace package), `session.js` / `tab.js` (borrow a logged-in Chrome session over CDP via `playwright-core`). |
| `docs/` | `workflow.md` (generate -> push -> link -> pull -> seed -> verify), `gotchas.md`, `ui-polish.md`. |

The generator emits, per spec: the manifest, entity and enum types with docs and indexes, a `dashboardSummary()`
server method with KPIs and chart groupings, deterministic seed rows (or CSV/literal rows), list/detail/form/dashboard
pages, routes and nav, a Jasmine test, `WORKSPACE_SUMMARY.md`, and a short `CLAUDE.md` that steers C3 Code's agent if
you later continue in chat. Optional: role-based access, CSV ingestion pipelines, map pages, an in-app agent.

## Quickstart

```sh
git clone https://github.com/<you>/c3code-wrapper && cd c3code-wrapper/generator

# 1. Your own copy of a blank-template workspace's UI (download <pkg>/ui/react from the Code tab)
export C3_UI_BASE=/path/to/<pkg>/ui/react
# optional: shared components the generated pages import (see generator/README.md)
export C3_UI_VENDOR=/path/to/vendor

# 2. Generate and check
node gen.js examples/fieldops.spec.json ../out
node validate.js ../out/fieldops
node tools/selftest.js examples/fieldops.spec.json ../out
(cd ../out/fieldops/ui/react && npm ci && VITE_C3_PKG=fieldops npm run build)

# 3. Push ../out to a GitHub repo, link it to a workspace once (Connect to GitHub > Select Existing Repository),
#    then iterate without chat turns:
cd ../automation && npm install
export C3_BASE_URL=https://<your-cluster-host>     # and a Chrome with --remote-debugging-port=9222, logged in
node workspace.js pull <appName> <branch>
node workspace.js seed <appName>
node workspace.js issues <appName>
```

To update an existing app, set `"package"` in the spec to that app's package name (`pkg` + 8 hex characters). See
`docs/workflow.md` for the full loop and timings (about 20 s per UI change, 1 min per backend change, $0 LLM).

## Limitations

- **Bring your own template.** The UI shell (C3 Design System kit, `c3Action.ts`, tokens) and the shared
  page components are C3-owned files and are not included. `gen.js` requires `--ui-base`; the UI build fails until the
  vendored components listed in `generator/README.md` are present. Backend, seed data and validation work without them.
- **Observed, not documented.** The Studio API calls (`gitPull`, `addCollaborators`, `pkgIssuesStatus`, `Js.exec`,
  `Pkg.paths`) were taken from what the C3 Code UI sends, on one cluster, in November 2026. They are not a public API
  and may change.
- `validate.js` checks a subset of the `.c3typ` grammar; the platform compiler is the authority. Platform type-name
  checks need a type list you provide (`--types-index`).
- The generated SideNav does not collapse at phone width unless your vendored shell handles it.
- **Create from Git** (new app from a repo) was not exercised.
- Automation authenticates by borrowing your browser session. Run it only against a browser profile you control.

## License

MIT for the code and docs in this repo (see `LICENSE`). It does not cover any C3 AI material you supply or generate
into, such as the workspace template you pass as `--ui-base`.

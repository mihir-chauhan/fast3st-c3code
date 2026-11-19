# Gotchas

Things that cost us a failed run or a wrong answer while building C3 Code apps code-first. Observed in November 2026;
re-check on your cluster.

## Package and repo

- An app's package name (`pkg<8hex>`) can never change. Generate with the target app's exact name.
- **Select Existing Repository** imports a branch over the workspace; it does not push the workspace into an empty
  repo. The branch must already contain `<pkg>/<pkg>.c3pkg.json` (optionally under an Application Path).
- `Pkg.paths` / `Pkg.content` silently omit any `lib/` directory under `ui/react/src` (e.g. `src/lib/utils.ts`). Read
  those files through the Code tab, the Vite dev server (`.../uiservice/src/lib/x.ts?raw`) or `automation/pkg-mirror.js`
  (which crawls the Vite module graph to recover them). If you seed a repo from a workspace, don't lose them.
- Ship `ui/react/package-lock.json`: the UI service runs `npm ci`.
- Pin `testtools` to major.minor (`"8.10"`). `"*"` raises a package issue warning.
- A shallow clone in the workspace means a pull after both sides changed can report conflicts on non-overlapping edits,
  and the conflict resolver may change content. Push from one side only.

## Backend (`.c3typ` / `js-server`)

- One type per file; inner types and enums as `<Type>.<Sub>.c3typ`. Don't redeclare inherited `name`; don't name
  fields `type`, `version`, `id`, `meta`.
- References: child `site: ServiceSite` plus parent inverse `workOrders: [WorkOrder](site)`.
- Don't reimplement `fetch`/`create`/`merge`/`remove`/`get`: every entity has them. Server-side `Type.get(id)` is a
  member function; use `Type.forId(id).get()`.
- Compute KPIs and chart aggregations on the server (`fetchCount`, `evaluate` with `group`/`order`), returning a small
  value type, instead of fetching all rows into the browser.
- Treat every `evaluate` tuple cell as nullable (`c == null ? null : c.value()`); a null group key comes back as a
  null cell.
- Filter syntax that works: `==`, `&&`, `||`, `!( )`, `contains(lowerCase(f), "x")`, `intersects(f, [..])`,
  `exists(f)`, `dateTime('yyyy-mm-dd')`, reference paths `asset.region`. `in` is not supported. `fetch().count` is the
  page size, not the total: use a parallel `fetchCount`. Stable paging: `order: '<sort>, ascending(id)'`.
- The platform rejects non-ISO dates, currency symbols in numbers, `yes` booleans and wrong-case enum values, but
  **accepts dangling references**. Check foreign keys yourself.
- Adding a `stored calc` field to a populated type needs a backfill:
  `<Type>.refreshCalcFields({calcFieldsToRefresh: [...], sync: true})`.
- Smoke-call every `js-server` method once on the live app. A local mock will not reproduce null semantics.

## Seed data

- Rows go in `data/<Type>/<Type>.json`: a JSON array, explicit `id`, references as `{ "id": "..." }`, ISO dates, no
  `meta`. Nothing loads them automatically; run `C3.pkg().upsertAllSeed(true)` (`workspace.js seed`).
- `upsertAllSeed` re-upserts every seed record and overwrites in-app edits to those records.
- Generate time-based sample data relative to an anchor date, or "overdue" views drift empty.
- Don't put `remove()` calls on real ids in probe scripts.

## UI

- The app UI is a Vite + React + Tailwind v4 SPA in `<pkg>/ui/react`, with hash routes. All backend calls go through
  `c3Call(type, action, thisArg, args)`.
- Remove the blank template's `src/shared/api.ts` and `src/data/sampleData.ts` when you replace the pages; the former
  imports a legacy export and breaks the build.
- The dev server lints on start. A lint/compile error at startup makes it exit and nothing restarts it; ask the agent
  for `uiServiceEnsure` or stop/start the workspace.
- Don't trust the C3 Code agent's own browser check: its browser is not logged in (API 401) and it may stub data.
  Check pages yourself after a real reload.

## Agent and automation

- The Git popover's buttons run as chat-agent turns (cost, and they fail if the chat is in Ask mode or on a model that
  isn't routable). Use the API (`workspace.js pull`).
- End change requests to the agent with a scope sentence ("Only change X. Do not change existing pages, records or
  data. Do not commit or push.").
- A nested `ui/react/AGENTS.md` is not auto-loaded; a workspace-root `AGENTS.md` is. Point the root file at the
  detailed one.
- Automating the Studio UI: name your tab (`window.name`) right after `goto` if the browser is shared; in the Add
  Collaborators dialog, Escape closes the whole dialog and drops the selection, and the search input loses its
  placeholder after the first chip (select by `[role=dialog] input`). Prefer the APIs in `automation/`.
- Studio API calls need the header `x-request-envelope: true`, or `{thisArg, args}` bodies are rejected.

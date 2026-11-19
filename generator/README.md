# c3app-gen — write a C3 Code app locally, code-first

`c3app-gen` turns a compact JSON spec into a complete C3 application package, laid out the way the C3 Code agent
lays it out. You get the `.c3typ` types, the `js-server` methods, seed data, the React pages, the routes and nav, the
summaries, and a Jasmine test. You can drop the output into a C3 Code workspace, or into a Git repo linked to one.

The conventions were learned by studying apps the C3 Code agent generated in our own workspaces during an
evaluation ("lab1" CRUD app, "lab2" data app, "lab4ui" polished field-service app, etc. in the notes below). The pages
are the lab4ui page patterns made generic. No C3 template, skill or documentation text is included in this repo; see
`../docs/` for the workflow and gotchas.

Requirements: Node 18+ (no npm dependencies for the generator). Building the UI needs `npm` and access to
registry.npmjs.org.

```
c3app-gen/
  gen.js                 CLI: spec -> repo
  validate.js            offline checks (.c3typ grammar subset, data, UI c3Call/include paths, routes)
  tools/mock-c3.js       runs a generated <Type>.js method against the seed rows with stand-in platform APIs
  tools/selftest.js      determinism check + dashboard KPIs/charts recomputed independently from the seed rows
  lib/                   model / backend / seed / ui generators
  assets/ui/             globals.app.css (our app-layer CSS) and a package-lock.json resolved from public npm for the
                         blank template's package.json (C3 Code's UI service runs `npm ci`, so a lock must ship)
  examples/*.spec.json   fieldops (field service: sites, technicians, work orders, dashboard), supportdesk
```

## Usage

```sh
cd generator
export C3_UI_BASE=/path/to/your-workspace-copy/<pkg>/ui/react   # see "UI shell and vendored components"
export C3_UI_VENDOR=/path/to/vendor                              # optional, see below
node gen.js examples/fieldops.spec.json ../out/fieldops         # add --force to regenerate (keeps node_modules)
node validate.js ../out/fieldops/fieldops                       # 0 errors expected
node tools/selftest.js examples/fieldops.spec.json ../out/fieldops
cd ../out/fieldops/fieldops/ui/react && npm ci && VITE_C3_PKG=fieldops npm run build   # lint + tsc + vite
```

`validate.js` can also check type names against the platform's type list (`--types-index <dir>` with
`<pkg>/_index.tsv` files, tab-separated, type name in the first column). Without it, that check is skipped.

## UI shell and vendored components

This repo does **not** ship any C3 template files. The generator needs two inputs from your own C3 Code environment:

1. **`--ui-base` / `C3_UI_BASE`** (required): the `ui/react` folder of a C3 Code workspace created from the default
   blank template (download it from the workspace **Code** tab, or pull it from a GitHub repo the workspace pushed to).
   The generator copies it (minus `node_modules`, `src/pages`, `src/shared`, `src/data` and the template's example
   components, which the C3 Code agent also drops), takes `src/styles/manual-tokens.css` and `src/globals.css` from it,
   and, if the folder sits in a package (`<pkg>/ui/react`), copies `<pkg>/src/TEMPLATE_SUMMARY.md` too.
2. **`--ui-vendor` / `C3_UI_VENDOR`** (optional): a folder copied over `ui/react/src` last. The generated pages import a
   few shared components that are not in the blank template:
   `components/PageFrame/PageFrame.tsx`, `components/DetailList/DetailList.tsx`, `components/charts/EChart.tsx`,
   `components/charts/BarList.tsx`, `hooks/useMediaQuery.ts`, and the eCharts helpers `lib/echarts.ts`,
   `lib/echarts-theme.ts`, `lib/echarts-zoom-handles.ts`, `lib/css-var.ts`. The eCharts helpers come with C3 Code's
   own frontend examples (the agent copies them into `src/lib/` when it builds charts); the components are ones the
   C3 Code agent writes when you ask it for a page-header/detail-list/chart layout. Ask the agent in one of your
   workspaces to create them, then copy them out. `gen.js` warns about any that are missing; the backend, seed data
   and validator do not need them.

`<outDir>` is the repo root, the equivalent of `/usr/workspace`. It holds the C3 Code `.gitignore` and the package
folder:

```
<outDir>/.gitignore
<outDir>/<pkg>/
  <pkg>.c3pkg.json                       mcpServer 8.10 (+ testtools "8.10" when tests are on)
  CLAUDE.md                              short conventions note that steers C3 Code's agent when it edits the package later
  src/<Type>.c3typ, src/<Type>.<Enum>.c3typ, src/<Type>.DashboardSummary|CountBucket|MonthBucket.c3typ, src/<Type>.js
  src/WORKSPACE_SUMMARY.md, src/TEMPLATE_SUMMARY.md     (blankPkg keeps both in src/)
  data/<Type>/<Type>.json                (or test/data/... with "dataDir": "test/data")
  test/js-rhino/test_<Type>.js
  ui/react/                              blankPkg shell + generated src/{App.tsx, config/navigation.ts, Interfaces.tsx,
                                         lib/format.ts, hooks/useLookups.ts, components/StatusBadges, pages/**}
```

The UI shell is copied from your `--ui-base` (a blank-template workspace's `ui/react`), which includes the C3 Design
System kit and `c3Action.ts`. Template placeholders (`pages/Dashboard`, `data/sampleData.ts`, `shared/api.ts`) are
dropped, as the agent drops them.

## Spec format (JSON)

```jsonc
{
  "package": "fieldops",            // camelCase; must equal the workspace package (C3 Code: pkg<8hex>) if you overlay
  "title": "Field Service Operations",   // TopNav title, index.html <title>
  "description": "...",             // manifest description
  "asOf": "2026-11-19",             // anchor date for relative seed dates (keeps reruns byte-identical)
  "seed": "fieldops-v1",            // PRNG seed
  "dataDir": "data",                // "data" (agent default for sample rows) | "test/data" (synthetic-data skill default)
  "tests": true,                    // Jasmine test for the dashboard method + testtools dependency
  "copyrightHeader": true,          // the short C3 header C3 Code puts on generated files
  "agentNotes": true,               // emit <pkg>/CLAUDE.md
  "entities": [ /* parents before children */ {
    "name": "WorkOrder",            // PascalCase, not a platform type (Batch, Tenant, Unit, Alert, Site, ... are refused)
    "doc": "...",                   // type doc ({@link X#y} allowed)
    "plural": "Work Orders", "singular": "Work Order", "route": "work-orders", "icon": "ClipboardList",  // lucide name
    "label": "number",              // display field; default "name" = the inherited `name` (never declared)
    "subtitle": "title",            // optional second field in the detail title
    "pages": ["list", "detail", "form"], "nav": true,
    "index": ["..."],               // @db(index=[...]); default = label + enum + ref + datetime fields
    "enums": [ { "name": "Status", "doc": "...", "values": [
        { "key": "IN_PROGRESS", "label": "In Progress", "doc": "...", "appearance": "warning", "weight": 9 } ] } ],
        // -> src/WorkOrder.Status.c3typ; appearance = badge + chart color
        //    (primary|secondary|accent|success|warning|danger|info); weight = seed frequency; "values": ["A","B"] also works
    "fields": [
      { "name": "number", "required": true, "auto": "seq", "gen": { "kind": "seq", "format": "WO-{n}", "start": 10001 } },
      { "name": "title", "required": true, "doc": "..." },                 // type defaults to string
      { "name": "description", "multiline": true },
      { "name": "status", "enum": "Status" },                              // or "ServiceSite.Region" (another entity's enum)
      { "name": "site", "ref": "ServiceSite", "inverse": "workOrders" },   // adds workOrders: [WorkOrder](site) on the parent
      { "name": "createdDate", "type": "datetime", "auto": "now" },        // auto: set on create, hidden in the form
      { "name": "cost", "type": "double", "format": "currency" }           // types: string|int|double|boolean|datetime
    ],                                                                     // format: currency|hours|percent|date
    "list":   { "columns": [...], "search": ["number", "site.name"], "filters": ["status", "site.region", "site"],
                "sort": { "field": "createdDate", "dir": "desc" }, "pageSize": 20 },
    "detail": { "actions": [ { "label": "Complete", "icon": "CheckCircle2", "appearance": "success",
                "set": { "status": "Completed", "completedDate": "$now" }, "when": { "status": ["Open", "In Progress"] } } ] },
    "form":   { "defaults": { "priority": "Medium" }, "sections": [ { "title": "Work", "fields": ["title", "status"] } ] },
    "seed":   { "count": 200, "idPrefix": "wo_", "idStart": 10001 }       // or "rows": [...] or "csv": "file.csv"
  } ],
  "dashboard": {
    "entity": "WorkOrder", "title": "...", "description": "...",
    "kpis": [   // max 4 per row on screen; each becomes a field of WorkOrder.DashboardSummary
      { "key": "openCount", "label": "Open", "agg": "count", "where": { "status": ["Open", "Scheduled"] }, "caption": "..." },
      { "key": "overdueCount", "label": "Overdue", "agg": "count", "where": {...}, "before": "scheduledDate", "alert": "danger" },
      { "key": "totalCost", "label": "Total Cost", "agg": "sum", "field": "cost", "format": "currency" },   // sum | avg
      { "key": "completionRate", "agg": "ratio", "of": "completedCount", "over": "totalCount", "format": "percent", "goodAbove": 0.5 }
    ],          // format: number|currency|percent|hours|days; KPI tiles link to the list with the same filter
    "charts": [
      { "key": "monthly", "kind": "monthly", "months": 6, "span": 2, "series": [ { "label": "Created", "dateField": "createdDate", "appearance": "accent" } ] },
      { "key": "byStatus", "kind": "donut", "groupBy": "status" },                       // enum -> every value, enum colors
      { "key": "byRegion", "kind": "hbar", "groupBy": "site.region" },                   // path through a reference
      { "key": "byTechnician", "kind": "hbar", "groupBy": "technician", "top": 10 },     // reference -> top N by count
      { "key": "costByType", "kind": "bar", "groupBy": "workType", "metric": "value",
        "measure": { "agg": "sum", "field": "cost", "label": "Cost", "format": "currency" } }
    ],          // kind: donut|bar|hbar|monthly; span 1-3 (3-column grid); height: Tailwind class; click -> filtered list
    "recent": { "columns": ["number", "title", "status"], "limit": 8 }
  },
  "nav": null   // optional explicit [{ "id", "path", "icon", "label", "tooltip" }]
}
```

### Seed generators (`fields[].gen`, or omit for defaults)

The rules come from c3-synthetic-data. Generation is deterministic (fixed seed, one PRNG stream per entity). Free
text comes from lists you write, and references are drawn only from parent rows that already exist. Rows have
explicit ids, references are written as `{ "id": ... }`, datetimes are ISO-8601, and there is no `meta`.

| kind | parameters |
|---|---|
| (default) | enum → weighted by value `weight`; ref → uniform over parent rows; numbers uniform 0-100; datetime in the last 180 days |
| `seq` | `format` (`WO-{n}`), `start` |
| `pick` | `values`: list of values, or `{ value, weight }` objects |
| `pickBy` | `field` (a path, e.g. `workType`), `values`: `{ "<value>": [...], "*": [...] }` |
| `number` / `int` | `dist` normal (`mean`, `stdDev`) or uniform; `min`, `max`, `decimals`, `times` (multiply by another field) |
| `datetime` | `fromDays`/`toDays` relative to `asOf`, or `after` (field), `minDays`, `maxDays`, `notAfterAsOf` |
| `ref` | `match`: `{ "<parentField>": "<path on this row>" }` (e.g. a technician in the site's region) |
| `pattern` | `#` → digit (`(555) ###-####`) |
| `bool` | `rate` |
| any | `when: { "<path>": [values] }` (generate only if it holds), `nullRate`; `gen` may be a list (first matching `when` wins) |

Literal rows: `seed.rows` (one per record; `count` must match unless you set `cycleRows`). Field values you give
there win over `gen`.
CSV: `seed.csv` (relative to the spec) plus `seed.columns` (`{ "csv header": "field" }`, with `id` and `name`
allowed). Values are converted to each field's type, and reference columns hold the parent id. CSV rows are written as
JSON, as the C3 Code agent did in our lab2 app. For real customer files, the c3-data-ingestion skill prefers a FileSourceCollection pipeline when
the rows need mapping.

## What the generated app looks like (and why)

- Pages follow lab4ui. Every page sits in `PageFrame` (`PageHeader` with breadcrumbs, title, badges, actions and
  tabs over a `p-6` content stack). Pages use `Container` cards, `DataGrid` + `Pagination` with server-side
  filter/sort/paging and filters kept in URL params, `MetricCard` KPI tiles, and eCharts through
  `components/charts/EChart.tsx` with the vendored token theme. Detail pages have DetailLists, reference cards, tabs
  for related records, status actions (`merge`) and delete (`remove`) behind a `Modal`. Forms use `Field` with label,
  required star, hint or error, and the `Input`/`Textarea`/`InputNumber`/`DatePicker`/`Combobox`/`Checkbox`
  components. Create uses `create`. Edit uses `merge` with a merge include, so cleared fields are saved (the lab1
  pattern).
- Data access matches what all three labs did. Every call is `c3Call` and every fetch is bounded. Effects use
  `useEffect` with a `cancelled` flag, `reportError` from `useErrorBoundary`, and `LoadingState`/`ErrorState`/
  `EmptyRows`. There is no mock data and no react-query.
- Look fixes (see `../docs/ui-polish.md`), limited to files the template lets you change:
  - Font: `styles/manual-tokens.css` points `--theme-font-family-font-sans` at `Inter Variable`, the face
    `@fontsource-variable/inter` actually registers, so pages no longer fall back to system-ui. `tokens.css` is not
    touched.
  - KPI rows have at most 4 tiles.
  - Every enum uses the same soft badge.
  - Chart colors are semantic: each enum value's badge appearance maps to `--c3-style-chart-{accent,success,
    warning,danger,info,neutral}`, so the 8-hue rainbow is gone. Other charts use one accent color.
  - Table cells are single-line and truncated.
  - Forms are wider.

  No new npm dependencies are added.
- Not changed: the SideNav still does not collapse at phone width. That would mean editing the template's own
  component.

## What is verified locally vs. only on a live env

Verified locally on 2026-11-19, for `examples/fieldops`:

| Check | Result |
|---|---|
| `npm ci` with the shipped `package-lock.json` (registry.npmjs.org, no private registry needed; `.npmrc` is only `fund=false`) | OK, 1180 packages |
| `VITE_C3_PKG=fieldops npm run build` (eslint error level, `tsc -p tsconfig.build.json`, `vite build`) | green; 0 lint warnings in generated files |
| A second spec covering CSV loading, a required reference, no dashboard and a subset of pages | builds green, validates clean |
| `validate.js`: `.c3typ` header, field, method and enum forms; claims; docs; `@db` index fields; inverse fkeys match the child field; type names checked against the platform type list (optional `--types-index`); seed rows checked for ids, required fields, enum values, ISO dates and references; UI `c3Call` targets and `include`/`order` paths; nav paths routed | 0 errors. It also passes with 0 errors on C3 Code's own lab4ui and lab3 output. lab2 and lab1 each get one warning: an undocumented member, and a redeclared `name`. In a mutation test it caught 9 of 9 injected faults |
| `tools/selftest.js`: two generations are byte-identical; `WorkOrder.dashboardSummary()` runs under `mock-c3.js`, and its 8 KPIs and 7 charts equal values recomputed independently from the seed rows | all pass |
| Seed coherence: scheduled date after created date, completed date between scheduled date and `asOf`, technician in the site's region | 0 violations |

**Live update (lab5, 2026-11-19).** Items 1-5 and 7 below are now VERIFIED
on a live workspace, with two generator fixes. (a) A null group key comes back as a null tuple cell, which crashed
`groupBuckets`. The generator now emits a `cellValue()` helper, and the mock reproduces the null cell. (b)
`"testtools": "*"` raised a Pkg.Issue WARNING (INVALID_FIELD, SemanticVersion.MajorMinor), so it is now `"8.10"`.
Item 6 is only partly checked: the Preview served the UI after a checkout that included the shipped lock, with no
error seen. Phone-width layout (SideNav) is still not handled.

These can only be verified on a live C3 env or workspace (original list, kept for reference):

1. **Type compilation.** The platform accepts every `.c3typ`, with no `Pkg.Issue`. Check `isValidationComplete` and
   `issuesForPkg`, or `gen/cache/Pkg.Issue/`. The validator is a subset parser, not ANTLR.
2. **Seed load.** `C3.pkg().upsertAllSeed(true)` loads the rows with no `SeedData.Issue`.
3. **Platform semantics the mock only imitates:**
   - `Filter.intersects(field, [..]).and().intersects(..)` and `.and("<expr>")`
   - `evaluate` with `group` on a reference path (`technician.id, technician.name`) and `order: 'descending(count())'`
   - `limit` on grouped `evaluate`
   - null group keys
   - `dateTime('YYYY-MM-DD')` in filters
   - plain objects passed to `DashboardSummary.make` for `[CountBucket]`
   - `fetchObjStream(...).each`, which lab4 relied on

   The first smoke call to run is `WorkOrder.dashboardSummary()`.
4. **The UI against real data.** The `fetch`/`get`/`create`/`merge`/`remove` envelopes, a `merge` include that
   clears a field, and the dev server picking up the files. Check `uiServiceStatus` for `appPhase: 'running'`.
   Charts and colors in light and dark mode are also unchecked.
5. **The Jasmine test.** Run it in a DEV test app with the c3-env-apps skill, or with
   `TestRunner.make().withTestNameGlob('test_WorkOrder.js').run()`. Adding `"testtools": "*"` triggers dependency
   resolution, and its behavior in a workspace has not been seen.
6. **The lock file.** The shipped `package-lock.json` comes from public npm with the same semver ranges. It is not
   blankPkg's own lock, which the mirrors never contained, so dependency patch versions may differ. If the UI service's
   `npm ci` rejects it, delete it and use the workspace's own lock: `package.json` is identical to the template's.
7. **The Git path.** How a GitHub repo maps onto a workspace (`gitRepo.pkgsPath`, repo root = `/usr/workspace`) is
   still unconfirmed at the time; lab5 then confirmed repo root = workspace root with `<pkg>/` inside.

## Loading the output into a C3 Code workspace

C3 Code's own rules (CLAUDE.md, c3-frontend `code-frontend.md`, c3-env-apps) describe what happens after a file
changes:

- A file saved in the workspace goes live through **C3 Code auto-sync**. Agent, UI service and app share one
  filesystem. There is no manual sync or deploy step, and saving does not auto-commit to git. Changed `.c3typ`/`.js`
  files are revalidated by the package store. Check `gen/cache/Pkg.Issue/`, or ask the agent to run
  `isValidationComplete` + `issuesForPkg`.
- The **UI** dev server (`npm run dev`, Vite) hot-reloads `ui/react/src` changes **while it is running**. It lints on
  start, so a lint or compile error at startup makes it exit, and nothing restarts it. Recover with
  `uiServiceEnsure`, then check with `uiServiceStatus`: ask the C3 Code agent to do this, or Stop and Start the
  workspace from the header ⋯ menu. `uiServiceEnsure` also runs `npm ci` when `package-lock.json` changed.
- **Seed and data files are not loaded automatically.** Run this once after copying, and again after any change to
  `data/`:
  `C3.pkg().upsertAllSeed(true)`. It returns the issues it hit. The older form is
  `App.State.inst().get().withFields({ pkgFingerprint: -1, seeded: false }).update(); C3.pkg().upsertAllSeed()`.
  Run it in the C3 Console (**Configure → + → Development Tools → C3 Console**, needs a running workspace), or ask the
  agent to run it with `runJsOnLiveApp`.

### Path A — overlay onto a fresh blankPkg workspace (fastest, no Git)

1. In C3 Code, create an app with the default blank template. Note its package name: it is the folder next to
   `.gitignore` in the **Code** tab, `pkg` + 8 hex characters.
2. Set `"package"` in your spec to that name, then run `node gen.js spec.json out`.
3. In the **Code** tab (VS Code in the browser), drag in, or create and paste, everything under `out/<pkg>/` **except**
   `ui/react/package.json`, `ui/react/package-lock.json` and `ui/react/node_modules`. Keep the workspace's own copies:
   the dependencies are identical. Let the generated files overwrite `ui/react/src/App.tsx`, `config/navigation.ts`,
   `Interfaces.tsx`, `c3Action.ts`, `pages/Dashboard/Dashboard.tsx`, `styles/manual-tokens.css` and `index.html`.
4. **Delete** the template's `ui/react/src/shared/api.ts` and `ui/react/src/data/sampleData.ts`. `shared/api.ts`
   imports the legacy `c3Action` export, which the canonical `c3Action.ts` no longer has, so the build breaks if you
   keep it. C3 Code's agent deletes these files too. If your spec has no dashboard, also delete the template's
   `pages/Dashboard/`.
5. Wait for validation, then load the data (`C3.pkg().upsertAllSeed(true)`). As smoke checks, run
   `WorkOrder.dashboardSummary()` and `WorkOrder.fetch({ limit: 1, include: 'id, site.name' })`.
6. Open **Preview**. If it is blank or shows 504, the dev server exited during the copy: run `uiServiceEnsure`, or
   Stop and Start the workspace.
7. Alternatively, upload the files and prompt the C3 Code agent: *"Files for this app were added. Read
   `<pkg>/src/WORKSPACE_SUMMARY.md` and `<pkg>/CLAUDE.md`, delete `ui/react/src/shared/api.ts` and
   `src/data/sampleData.ts`, check `issuesForPkg`, upsert the seed data, smoke-test `WorkOrder.dashboardSummary()`,
   run `npm run build`, and confirm `uiServiceStatus` is running."* That is exactly its Tier-1 verification loop.

### Path B — through Git (verified live in lab5, 2026-11-19; fastest path, $0 LLM)

Details, timings and scripts: `../docs/workflow.md` and `../automation/`.

1. Generate with `"package"` = the target app's package (`pkg<8hex>`). An app's package name can never change: with a
   different name, Connect offers only **Create from Git** (a new application).
2. Commit `out/` as the repo root (`.gitignore` + `<pkg>/`; no `ui/content/`, no `node_modules/`) and push a branch.
3. Workspace header **Connect to GitHub** > **Select Existing Repository** > repo, **Branch to pull**, Application Path
   empty, Package Name `<pkg>` > **Connect Repository** (needs the GitHub provider connected in Settings). Within ~2 min
   the platform checks the branch out and **replaces** the workspace package (old types and files are gone); types
   compile and the Preview serves the new UI with no manual restart.
4. Load the seed once: `C3.pkg().upsertAllSeed(true)` (C3 Console, or `Js.exec` on `/<env>/liveapp`).
5. Edit loop: change spec or generator, `gen.js --force`, push, then Pull. The cheapest Pull is the API the Git control
   uses: `POST /misc/studio/api/8/Genesis.Workspace.Service.Agent/gitPull` (`node ../automation/workspace.js pull`) with `thisArg {workspace:{id}}` and
   `args ["<branch>"]` (1 s, no LLM). The Git popover's **Pull** button sends the pull through the chat agent instead
   (it costs LLM tokens). The UI updates in about 20 s. The server took about 60 s to show a changed `.js`.
6. Tests: the workspace app runs in `dev` mode, so `TestRunner.make().withTestNameGlob('test_<Type>.js').run()` works
   directly in it. Read the result with `toYamlString()`.

## Extending the generator

Keep changes copy-first. A new pattern should come from a real C3 Code-generated file or a skill rule, not be
invented. After any change, rerun `gen.js`, then `validate.js`, then `tools/selftest.js`, then `npm run build`.

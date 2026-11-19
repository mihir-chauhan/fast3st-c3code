# Workflow: generate, push, pull, seed, verify

The fastest reliable way we found to build a C3 Code app: write (or generate) the package locally, keep it in a GitHub
repo, and pull it into a C3 Code workspace through the API instead of through the chat agent. A UI change takes about
20 s end to end and a backend change about 1 min, with no LLM spend. Keep the chat agent for work the generator does
not cover.

Measured on one cluster in November 2026. C3 Code changes often; treat timings and API names as observations.

## 0. One-time setup

1. A Chrome you are logged in to C3 Code with, started with `--remote-debugging-port=9222` (the helpers in
   `automation/` borrow its session cookie). `export C3_BASE_URL=https://<your-cluster-host>`.
2. In C3 Code **Settings**, connect the GitHub provider. Give its token **Contents: write** on your repo, or pushes
   from the workspace fail with 403. Anyone with shell access in the workspace can read that token from the git
   remote URL, so scope it to the repos you use.
3. A copy of your blank-template workspace's `<pkg>/ui/react` for `gen.js --ui-base` (see `generator/README.md`).

## 1. Generate and check locally

```sh
cd generator
node gen.js my.spec.json ../out --ui-base /path/to/ui/react [--ui-vendor /path/to/vendor]
node validate.js ../out/<pkg>                 # .c3typ grammar subset, seed rows, c3Call targets, routes
node tools/selftest.js my.spec.json ../out    # determinism + dashboard numbers recomputed from the seed rows
cd ../out/<pkg>/ui/react && npm ci && VITE_C3_PKG=<pkg> npm run build
```

Package name: an existing app's package (`pkg` + 8 hex characters, the folder next to `.gitignore` in the Code tab)
can never be renamed. Generate with that exact name to update an existing app; any other name means a new app.

## 2. Push

Commit the output folder as the repo root: `.gitignore` plus `<pkg>/`. No `ui/content/` (build output), no
`node_modules/`. Ship `ui/react/package-lock.json`: the workspace UI service installs with `npm ci`.

## 3. Link the repo to a workspace (once)

- **Existing app** (package name matches): workspace header **Connect to GitHub** > **Select Existing Repository** >
  repo, **Branch to pull**, Application Path empty, Package Name `<pkg>` > **Connect Repository**. This is an
  *import*: the branch is checked out over the workspace and **replaces** the package (old files are gone). Types
  compile and Preview serves the new UI within about 2 minutes, with no restart.
  - The repo must already contain `<pkg>/<pkg>.c3pkg.json` on that branch; an empty repo cannot be selected.
- **New app**: Home > create > **Git** (**Create from Git**) takes any repo/package. We did not exercise it (app
  quota), so check whether it loads seed data by itself.

## 4. Load seed data

Nothing loads `data/` or `seed/` files automatically, not on checkout and not on pull.

```sh
node automation/workspace.js seed <appName>        # C3.pkg().upsertAllSeed(true), ~6 s, returns issues
```

Run it after the first checkout and after any change under `data/`. It re-upserts every seed record, so it overwrites
edits made in the app to records that also exist in seed files.

## 5. Edit loop

```sh
# edit spec or code -> gen.js --force -> validate -> commit -> push
node automation/workspace.js pull <appName> <branch>     # ~1 s, synchronous, no chat turn
node automation/workspace.js issues <appName>            # type errors with file/line/col within ~10 s
```

- The Git popover's **Pull** button sends the pull through the chat agent: 30-40 s and LLM tokens. Use the API.
- UI changes hot-reload in Preview in ~20 s. Changed server `.js` took ~60 s to show up.
- Don't let the workspace and the remote diverge. With unpushed workspace commits plus new remote commits, the
  shallow clone reported conflicts on edits that did not overlap.

## 6. Verify

- Open Preview yourself in a logged-in browser: `<cluster>/<env>/liveapp/uiservice/#/<route>` (hash routes; the env
  path is printed by `workspace.js info`). Do a real reload: a same-route hash navigation does not remount the page.
- Smoke-call every `js-server` method once through REST (`workspace.js js <app> '<Type>.<method>()'`); local mocks
  do not reproduce platform null semantics.
- Tests: the workspace app runs in `dev` mode, so `TestRunner.make().withTestNameGlob('test_<Type>.js').run()` works
  there (first run ~70 s warm-up). Read the result with `toYamlString()`.
- `automation/pkg-mirror.js <app> <dir>` mirrors what is actually in the workspace package (read-only), handy for
  diffing against what you pushed or what the agent changed.

## Sharing an app

`node automation/workspace.js add-collaborators <app> USER a@example.com b@example.com [--notify]` grants
application roles (USER = can create their own workspaces and build; ADMIN = everything). The workspace header
**Share** dialog is different: it grants preview-only access to one workspace.

# UI polish method

How to get from the blank template's "decent enterprise" look to a clean app, either by hand or by prompting the C3
Code agent. The generator applies the first four fixes automatically.

## What you are styling

`<pkg>/ui/react` is Vite + React 18 + Tailwind v4 with vendored design-system primitives in `src/components/ui/*`
(BEM classes plus SCSS), design tokens in `src/styles/tokens.css` (generated, don't edit), ECharts through a
token-driven theme, and the shell in `App.tsx` (TopNav + SideNav + `<main>`).

Out-of-the-box defects to always fix:

1. **The font never loads.** The token says `Inter`; `@fontsource-variable/inter` registers `Inter Variable`. Point
   the font token at `'Inter Variable'` in `src/styles/manual-tokens.css`. Biggest single improvement, zero risk.
2. Headings render at weight 400. Set semibold weights via the `--text-c3-*--font-weight` theme keys.
3. Rainbow chart palette. Use one accent for single-series charts and semantic colors for statuses.
4. KPI rows with 8 tiles. Use at most 4 per row.
5. No responsive shell: the SideNav never collapses, so 390 px is unusable.

## Where each change goes

| Change | File |
|---|---|
| Font, type weights, brand accent, chart palette (light + `.dark`) | `src/styles/manual-tokens.css` |
| Card, KPI tile, table density, page header, active nav item | an unlayered `:root .<bem-class> {}` block at the end of `src/globals.css` |
| Status badge colors | one soft badge style; value-to-appearance maps in `src/lib/format.ts` |
| Page max-width, padding, toolbar, loading/empty/error states | one shared `PageFrame` component |
| Responsive shell | `App.tsx`, `SideNav`, `TopNav`, a `useMediaQuery` hook (not per page) |
| Never edit | `src/styles/tokens.css`, `src/components/ui/*` |

Plain Tailwind utilities on vendored components lose to their unlayered SCSS. Use `utility!` (important) or a
`:root .bem-class {}` rule. Every color override needs a `.dark` twin.

## Prompting the agent

- Send a design brief as its own turn right after the first build, and name the files above as the only places to
  change. In our test that reached ~90% of the brief in one turn.
- A brief that worked: calm neutral greys, white cards with a 1 px border and 8 px radius, one accent color only for
  primary buttons/links/active nav/focus; type scale 24 / 15-16 / 14 / 12-13 px with semibold headings and 28 px
  tabular KPI numbers; 4 px grid, 24 px page padding, 16 px gaps, max-width 1440 px; 40 px single-line table rows;
  soft status badges; semantic chart colors, no dual axes or smoothing.
- Specify dashboards row by row: tile count, width fractions, chart type per card, what to delete.
- Say where responsive logic belongs ("in the shell, not per page").
- Add "Keep verification cheap: one screenshot per page at 1600 px and 390 px." The agent's browser loops dominate
  cost.
- Keep the rules in files: a short workspace-root `AGENTS.md` (auto-loaded) pointing at detailed UI rules, plus a
  "Design system" section in `src/WORKSPACE_SUMMARY.md`. Start new chats for new features once rules are in files.
- A mockup image plus "as closely as the design system allows" works for new screens.
- Avoid big multi-page structural prompts with two-width verification (expensive, with side effects), and hand-tuning
  fixed table column widths (headers truncate).

## Checklist (in order)

1. `[...document.fonts].map(f => f.family + ':' + f.status)` shows `Inter Variable:loaded`.
2. Headings semibold; one type scale.
3. One accent hue; one badge style; no solid red badges.
4. Charts: semantic status colors, single hue for single series, at most 4 slices (else a bar list).
5. Dashboard: at most 4 KPI tiles, one-line captions, a deliberate row grid, equal card heights.
6. Every page uses the shared frame; the filter toolbar is one row.
7. Tables: 40 px rows, no wrapped cells, right-aligned numbers, no horizontal scroll at 1280 px.
8. Forms: labels above, 2-column sections, inline errors.
9. Loading, empty and error states on every data view.
10. At 390 px: `document.documentElement.scrollWidth === 390`, the nav is a drawer.
11. Dark mode on every page; charts re-theme.
12. No new console errors.

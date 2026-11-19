/**
 * C3 eCharts theme — token-driven, runtime-resolved.
 *
 * eCharts themes are normally JSON files registered at build time. We can't do
 * that because every color in this design system flows through CSS custom
 * properties (`--c3-style-*`) that change at runtime when the `.dark` class
 * on <html> flips (see `.storybook/preview.tsx`'s `withThemeByClassName`).
 *
 * Instead: we read the CSS vars off `<html>` via `getComputedStyle`, build a
 * theme object, register it as `'c3'`, and re-register + notify subscribed
 * chart instances whenever the class changes. Each `ui/chart` instance
 * disposes and re-inits on the notification — eCharts's `theme` param is
 * sticky to `init()` and can't be swapped on a live instance.
 *
 * This module imports eCharts as a TYPE only: `ensureC3Theme` receives the
 * loaded module from `ui/chart` (which `import()`s `./echarts` on mount), so
 * `readColor` and the theme builder stay usable — e.g. by `chart-options.ts` —
 * without pulling the ~700 kB eCharts runtime into every bundle.
 */
import type * as EChartsCore from 'echarts/core';

const THEME_NAME = 'c3';

const readVar = (name: string): string => readCssVar(name);

/**
 * Resolve a color token to a normalized `rgb()/rgba()` string. Some tokens
 * (e.g. `--c3-style-opacity-accent-30`) are authored in CSS Color 4 syntax
 * (`rgb(37 99 235 / 0.3)`), which zrender's color parser can't read for its
 * emphasis/lerp math. Letting the browser compute `color` normalizes it.
 */
export function readColor(name: string): string {
  if (typeof document === 'undefined') return '';
  const probe = document.createElement('span');
  probe.style.color = `var(${name})`;
  probe.style.display = 'none';
  document.documentElement.appendChild(probe);
  const value = getComputedStyle(probe).color;
  probe.remove();
  return value;
}

/** Data-zoom handle geometry + placement live in ./echarts-zoom-handles
 *  (Figma `_Data Zoom` 43965-2905 → Handle). */
import { ZOOM_HANDLE_ICON, ZOOM_HANDLE_SIZE } from './echarts-zoom-handles';
import { readCssVar } from './css-var';

function buildTheme() {
  // Categorical palette — `--c3-style-chart-chart-1..8` are the C3 token
  // system's chart accents. Add semantic accents at the tail so 6+ series
  // fall back to them rather than cycling.
  const palette = [
    readVar('--c3-style-chart-chart-1'),
    readVar('--c3-style-chart-chart-2'),
    readVar('--c3-style-chart-chart-3'),
    readVar('--c3-style-chart-chart-4'),
    readVar('--c3-style-chart-chart-5'),
    readVar('--c3-style-chart-chart-6'),
    readVar('--c3-style-chart-chart-7'),
    readVar('--c3-style-chart-chart-8'),
    readVar('--c3-style-chart-info'),
    readVar('--c3-style-chart-success'),
    readVar('--c3-style-chart-warning'),
    readVar('--c3-style-chart-danger'),
  ].filter(Boolean);

  const fg = readVar('--c3-style-basic-fg-primary');
  const fgMuted = readVar('--c3-style-basic-fg-secondary');
  const border = readVar('--c3-style-basic-border-border');
  const tooltipBg = readVar('--c3-style-basic-bg-primary');
  const tooltipFg = readVar('--c3-style-basic-fg-primary');
  const zoomTrack = readColor('--c3-style-basic-bg-input');
  const zoomFiller = readColor('--c3-style-opacity-accent-30');
  const zoomHandle = readColor('--c3-style-basic-bg-primary');
  const zoomHandleBorder = readColor('--c3-style-basic-border-accent');
  // eCharts' own default is `fontFamily: 'sans-serif'` — a generic fallback
  // that doesn't pick up Inter. Every text surface (axis labels, legend,
  // tooltip) needs this set explicitly since eCharts renders to canvas /
  // its own tooltip DOM, neither of which inherits the page's font-family.
  //
  // CRITICAL: the token resolves to the bare family name `Inter`, but the only
  // Inter this app actually loads as a web font is `@fontsource-variable/inter`
  // whose `@font-face` family is **`Inter Variable`** (see src/index.css). On
  // canvas (unlike the DOM), an unknown family like a bare `Inter` gets no
  // lenient matching — with no system-installed `Inter` it falls through to the
  // browser default *serif*, so charts render in Times while the rest of the UI
  // stays in Inter. Prepend the real loaded family so canvas paints Inter.
  const tokenFamily = readVar('--c3-style-font-family-font-family');
  const fontFamily = [`'Inter Variable'`, tokenFamily, 'system-ui', 'sans-serif']
    .filter(Boolean)
    .join(', ');

  const axisLabelStyle = { color: fgMuted, fontFamily, fontSize: 12, fontWeight: 400, lineHeight: 16, margin: 8 };
  const axisNameStyle = { color: fg, fontFamily, fontSize: 12, fontWeight: 600, lineHeight: 12 };

  return {
    color: palette,
    backgroundColor: 'transparent',
    textStyle: { color: fg, fontFamily },
    title: {
      textStyle: { color: fg, fontWeight: 500, fontFamily },
      subtextStyle: { color: fgMuted, fontFamily },
    },
    legend: {
      // Never drawn: <Chart> hides the canvas legend and renders an Ion
      // ChartLegend (Figma 43930-9760) below it. These only apply if a consumer
      // calls echarts directly without <Chart>.
      textStyle: { color: fgMuted, fontFamily },
      icon: 'circle',
      itemWidth: 10,
      itemHeight: 10,
    },
    tooltip: {
      backgroundColor: tooltipBg,
      borderColor: border,
      textStyle: { color: tooltipFg, fontFamily, fontWeight: 400 },
      // shadcn-ish radius (matches `--c3-style-border-radius-8`)
      extraCssText: 'border-radius: 6px;',
    },
    // bottom 0: Figma Chart Examples (e.g. 46463:72037) end the chart frame at
    // the x labels' line box, then a 16px gap to the legend (<Chart>'s gap).
    // A non-zero bottom here adds dead space between the labels and legend.
    // left/right 0: Figma categorical vertical (43930:9943) puts the y labels
    // at the frame's x=0 and runs the plot to the frame's right edge — no side
    // padding. Charts whose node draws a right pad (time series 43930:10493,
    // histogram 44167:10511, horizontal 43930:9989 — all 16) set it themselves.
    grid: { containLabel: true, top: 24, right: 0, bottom: 0, left: 0 },
    // Figma (Charts page, every `Grid`): gridlines are SOLID 1px
    // basic/border/border; the bottom grid line doubles as the baseline and no
    // chart on the page draws axis ticks except Parallel Coordinates.
    //
    // Tick labels = `_Vertical Axis Label` / `_Horizontal Axis Label`
    // (43936:9294 / 43936:7802): C3 Regular/Body/P3 — 400 12/16,
    // basic/fg-secondary, 8px from the plot. Without the 16px line height
    // eCharts sizes the label box to the glyphs (~12px), which shifts the
    // containLabel layout and the plot's top edge.
    //
    // Axis titles = `_ Y Axis Label` / `_X Axis Label` (43930:9512 /
    // 43936:9290): C3 Bold/Label/L3 — 600 12/12, basic/fg-primary. The option
    // builders (src/components/ui/chart-options.ts) draw the y title in its
    // Figma position (top-left row, not over the axis); `nameTextStyle` here
    // only gives a raw `yAxis.name` the right text style.
    categoryAxis: {
      axisLine: { lineStyle: { color: border } },
      axisTick: { show: false },
      axisLabel: axisLabelStyle,
      nameTextStyle: axisNameStyle,
      splitLine: { show: false, lineStyle: { color: border } },
    },
    valueAxis: {
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: axisLabelStyle,
      nameTextStyle: axisNameStyle,
      splitLine: { lineStyle: { color: border, type: 'solid', width: 1 } },
    },
    // Figma `_lineBarChartTimeseriesType` (43930-10855) line types: 1px
    // strokes, no point markers. Markers still appear on hover (emphasis).
    line: { smooth: false, symbol: 'circle', symbolSize: 6, showSymbol: false, lineStyle: { width: 1 } },
    // Data zoom — Figma `_Data Zoom` (43965-2905). Track: fill basic/bg/input,
    // 1px basic/border/border, radius rounded-selector (2). Selection:
    // opacity/accent/30. Handles: 4×16 basic/bg/primary + 1px OUTSIDE
    // basic/border/accent (6×18 outer), radius 2, inside the selection —
    // see ./echarts-zoom-handles. No data-shadow preview, no move-handle bar,
    // no range labels (none is drawn). Track THICKNESS (16px) is
    // per-orientation, so it is set on the dataZoom option (`height` on x,
    // `width` on y), not here. Every option builder uses this styling as-is.
    // Handle value tooltip: `showDetail` keeps eCharts computing the range
    // text, but its canvas labels are never shown (`handleLabel` off in both
    // states) — <Chart> renders an Ion Tooltip with that text instead.
    dataZoom: {
      backgroundColor: zoomTrack,
      borderColor: border,
      borderRadius: 2,
      fillerColor: zoomFiller,
      showDataShadow: false,
      showDetail: true,
      handleLabel: { show: false },
      brushSelect: false,
      handleIcon: ZOOM_HANDLE_ICON,
      handleSize: ZOOM_HANDLE_SIZE,
      handleStyle: { color: zoomHandle, borderColor: zoomHandleBorder, borderWidth: 1 },
      moveHandleSize: 0,
      emphasis: { handleStyle: { borderColor: zoomHandleBorder }, handleLabel: { show: false } },
      textStyle: { color: fgMuted, fontFamily },
    },
    // Bars stay square — keeps stacked columns reading as one solid bar
    // instead of stacked tiles each with their own rounded top.
    bar: { itemStyle: { borderRadius: 0 } },
    // Heat Map tiles — Figma `_heatmapType` (43930-14329) `tile node`: 1px
    // CENTER stroke basic/border/border, radius 0. Set here (not in
    // heatmapChartOption) so the border re-resolves on a theme flip.
    heatmap: { itemStyle: { borderColor: border, borderWidth: 1, borderRadius: 0 } },
    // Pie — Figma `_pieChartType` (44523-6269): every slice has a 2px CENTER
    // stroke basic/border/border. `_pieChartLabel` (45829-5699): text
    // C3 Regular/Label/L3 (Inter Medium 500 12/12) basic/fg/primary; pointer
    // 1px basic/border/neutral, round caps. Set here so they re-resolve on a
    // theme flip.
    pie: {
      itemStyle: { borderColor: border, borderWidth: 2 },
      label: { color: fg, fontFamily, fontSize: 12, fontWeight: 500, lineHeight: 12 },
      labelLine: { lineStyle: { color: readColor('--c3-style-basic-border-neutral'), width: 1, cap: 'round' } },
    },
  };
}

const subscribers = new Set<() => void>();
let observer: MutationObserver | null = null;

/**
 * Register the C3 theme and start watching the `.dark` class for changes.
 * Idempotent — safe to call from every chart's mount effect. Pass the eCharts
 * module from `./echarts` (`const { echarts } = await import('./echarts')`).
 */
export function ensureC3Theme(echarts: Pick<typeof EChartsCore, 'registerTheme'>): void {
  echarts.registerTheme(THEME_NAME, buildTheme());

  if (observer || typeof window === 'undefined') return;

  observer = new MutationObserver(() => {
    echarts.registerTheme(THEME_NAME, buildTheme());
    subscribers.forEach((cb) => cb());
  });
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class', 'data-theme'],
  });
}

/**
 * Subscribe to theme changes. Returns an unsubscribe fn.
 * Chart instances dispose + re-init on each notification so the new theme
 * takes effect.
 */
export function subscribeToThemeChanges(cb: () => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

export const C3_THEME_NAME = THEME_NAME;

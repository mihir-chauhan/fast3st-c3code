/**
 * Custom data-zoom handles — Figma `_Data Zoom` (43965-2905) → Handle.
 *
 * Figma handle: a 4×16 fill (basic/bg/primary), radius 2, with a 1px OUTSIDE
 * stroke (basic/border/accent) → 6×18 outer box that overhangs the 16px track
 * by 1px top and bottom. Both handles sit INSIDE the selection, flush to its
 * ends (the selection frame is `space-between` with no padding).
 *
 * eCharts differs on two counts, both fixed here:
 *   1. Size — eCharts strokes on the path's centerline, so the icon is a 5×17
 *      rounded rect (centerline radius 2.5) at `handleSize` 17: centered 1px
 *      stroke → 4×16 white interior + 6×18 outer, exactly Figma.
 *   2. Position — eCharts centers BOTH handles on their range edge (it uses one
 *      icon for both, so an offset path can't fix it). We patch the slider
 *      view's `_updateView` to move each handle inward by half its width so the
 *      low handle's fill spans [edge, edge + 4] and the high one [edge − 4, edge].
 *      The center is snapped to a whole pixel so the 1px stroke lands crisp.
 *
 * The patch only touches sliders whose `handleIcon` is ZOOM_HANDLE_ICON (the
 * C3 theme default), so a chart that supplies its own icon is left alone.
 * Dragging is unchanged: eCharts' handle `drift` reads the pointer delta, not
 * the handle position.
 */
import type * as EChartsCore from 'echarts/core';

/** 5×17 rounded rect, radius 2.5 — the stroke centerline of Figma's handle. */
export const ZOOM_HANDLE_ICON =
  'path://M2.5,0a2.5,2.5 0 0 1 2.5,2.5v12a2.5,2.5 0 0 1 -2.5,2.5a2.5,2.5 0 0 1 -2.5,-2.5v-12a2.5,2.5 0 0 1 2.5,-2.5z';

/** Handle length in px (eCharts scales the icon's height to this). 16 fill + 1 stroke. */
export const ZOOM_HANDLE_SIZE = 17;

/** How far the handle's outside stroke overhangs the track (px). Option
 *  builders inset rails by this from the canvas edge so it isn't clipped. */
export const ZOOM_HANDLE_OVERHANG = 1;

/** Edge → handle-center offset: centerline half-width (2.5) − half the stroke (0.5). */
const HANDLE_INSET = 2;

/** Visible handle box (px): 4×16 fill + 1px stroke all round. */
const VISIBLE_WIDTH = 6;
const VISIBLE_LENGTH = 18;

type Matrix = [number, number, number, number, number, number];

interface BoundingRect {
  x: number;
  y: number;
  width: number;
  height: number;
  clone(): BoundingRect;
  applyTransform(m: Matrix): void;
}

interface HandleEl {
  x: number;
  y: number;
  parent?: { getComputedTransform(): Matrix | null } | null;
  attr(props: { x: number }): void;
  on(event: string, handler: () => void): void;
  getBoundingRect(): BoundingRect;
  getComputedTransform(): Matrix | null;
}

interface TipState {
  hovered: number | null;
  dragging: number | null;
  shown: boolean;
}

interface SliderView {
  _handleEnds?: [number, number];
  _orient?: 'horizontal' | 'vertical';
  _displayables?: {
    handles?: (HandleEl | null)[];
    /** eCharts' own range labels — index 0 = low end, 1 = high end. Never
     *  drawn (theme hides them); we read their text for the tooltip. */
    handleLabels?: ({ style?: { text?: unknown } } | null)[];
  };
  dataZoomModel?: { get(path: string): unknown };
  api?: { getDom(): HTMLElement; getWidth(): number };
  __c3Tip?: TipState;
  _updateView(nonRealtime?: boolean): void;
  _renderHandle(): void;
}

type SliderViewClass = { prototype: SliderView };

/* ── Handle tooltip ──────────────────────────────────────────────────────
 * Hovering a handle shows the value at that end of the range; while the
 * handle is dragged the tooltip stays up and tracks the new value. The view
 * only publishes state — <Chart> (ui/chart.tsx) renders the Ion Tooltip
 * (ui/tooltip.tsx, Figma 15139-15897) anchored to `rect`. */

export interface ZoomHandleTip {
  /** The value at the handle's end of the range (eCharts' slider label text,
   *  so `labelFormatter` / `labelPrecision` on the dataZoom option apply). */
  text: string;
  /** The handle's box in container (CSS px) coordinates. */
  rect: { x: number; y: number; width: number; height: number };
  /** Tooltip side: above x rails; toward the plot for y rails. */
  side: 'top' | 'right' | 'left';
}

type TipListener = (tip: ZoomHandleTip | null) => void;
const tipListeners = new WeakMap<HTMLElement, TipListener>();

/** Subscribe to handle-tooltip state for the chart rendered into `dom`. */
export function subscribeZoomHandleTip(dom: HTMLElement, listener: TipListener): () => void {
  tipListeners.set(dom, listener);
  return () => {
    if (tipListeners.get(dom) === listener) tipListeners.delete(dom);
  };
}

const tipState = (view: SliderView): TipState =>
  (view.__c3Tip ??= { hovered: null, dragging: null, shown: false });

const isLowHandle = (ends: [number, number], i: number) =>
  ends[i] < ends[1 - i] || (ends[i] === ends[1 - i] && i === 0);

function publishTip(view: SliderView): void {
  const st = tipState(view);
  const dom = view.api?.getDom();
  const listener = dom ? tipListeners.get(dom) : undefined;
  if (!listener) return;
  const active = st.dragging ?? st.hovered;
  const handle = active == null ? null : view._displayables?.handles?.[active];
  const ends = view._handleEnds;
  if (active == null || !handle || !ends || view.dataZoomModel?.get('handleIcon') !== ZOOM_HANDLE_ICON) {
    if (st.shown) listener(null);
    st.shown = false;
    return;
  }
  const label = view._displayables?.handleLabels?.[isLowHandle(ends, active) ? 0 : 1];
  const text = String(label?.style?.text ?? '');
  const m = handle.getComputedTransform();
  const r = handle.getBoundingRect().clone();
  if (m) r.applyTransform(m);
  const vertical = view._orient === 'vertical';
  // getBoundingRect pads for the stroke / hover area — anchor to the visible
  // 6×18 handle (4×16 fill + 1px stroke) centred on the same point.
  const cx = r.x + r.width / 2;
  const cy = r.y + r.height / 2;
  const [w, h] = vertical ? [VISIBLE_LENGTH, VISIBLE_WIDTH] : [VISIBLE_WIDTH, VISIBLE_LENGTH];
  const side: ZoomHandleTip['side'] = !vertical
    ? 'top'
    : cx < (view.api?.getWidth() ?? 0) / 2
      ? 'right'
      : 'left';
  listener(text ? { text, rect: { x: cx - w / 2, y: cy - h / 2, width: w, height: h }, side } : null);
  st.shown = !!text;
}

let installed = false;

/** Snap the handle center (local `x`) to a whole global pixel along the slider axis. */
function snap(handle: HandleEl, localX: number): number {
  const m = handle.parent?.getComputedTransform();
  if (!m) return Math.round(localX);
  const [a, b, c, d, e, f] = m;
  const horizontal = Math.abs(a) >= Math.abs(b);
  const scale = horizontal ? a : b;
  if (!scale) return localX;
  const global = horizontal ? a * localX + c * handle.y + e : b * localX + d * handle.y + f;
  return localX + (Math.round(global) - global) / scale;
}

/**
 * Idempotent. Call once after `echarts.use([... DataZoomComponent ...])`.
 * Takes the eCharts module as an argument (rather than importing it) so this
 * file — and the constants above, which `chart-options.ts` reads — never pull
 * the eCharts runtime into a bundle that doesn't render a chart.
 */
export function installZoomHandles(echarts: typeof EChartsCore): void {
  if (installed) return;
  const View = (
    echarts.ComponentView as unknown as {
      getClass(mainType: string, subType?: string): SliderViewClass | undefined;
    }
  ).getClass('dataZoom', 'slider');
  if (!View) return;
  const original = View.prototype._updateView;
  View.prototype._updateView = function patchedUpdateView(this: SliderView, nonRealtime?: boolean) {
    original.call(this, nonRealtime);
    if (this.dataZoomModel?.get('handleIcon') !== ZOOM_HANDLE_ICON) return;
    const ends = this._handleEnds;
    const handles = this._displayables?.handles;
    if (!ends || !handles) return;
    handles.forEach((handle, i) => {
      if (!handle) return;
      const edge = ends[i];
      // Equal ends: handle 0 takes the low side, handle 1 the high side.
      const isLow = isLowHandle(ends, i);
      handle.attr({ x: snap(handle, edge + (isLow ? HANDLE_INSET : -HANDLE_INSET)) });
    });
    // Runs after eCharts' _updateDataInfo, so the label text is current —
    // this is what keeps the tooltip tracking the value mid-drag.
    publishTip(this);
  };

  // Handles are rebuilt on every full render — (re)attach the hover / drag
  // listeners each time. eCharts' own on* handlers are left in place.
  const originalRenderHandle = View.prototype._renderHandle;
  View.prototype._renderHandle = function patchedRenderHandle(this: SliderView) {
    originalRenderHandle.call(this);
    const st = tipState(this);
    this._displayables?.handles?.forEach((handle, i) => {
      if (!handle) return;
      handle.on('mouseover', () => {
        st.hovered = i;
        publishTip(this);
      });
      handle.on('mouseout', () => {
        if (st.hovered === i) st.hovered = null;
        publishTip(this);
      });
      handle.on('dragstart', () => {
        st.dragging = i;
        publishTip(this);
      });
      handle.on('dragend', () => {
        st.dragging = null;
        publishTip(this);
      });
    });
  };
  installed = true;
}

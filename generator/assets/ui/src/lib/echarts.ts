/**
 * Centralized eCharts registration module.
 *
 * Every chart import in the codebase routes through THIS file — never directly
 * from `echarts` or `echarts/core`. This keeps lazy chart-type registration
 * enforceable: if someone needs a new chart type (heatmap, sankey, radar, …),
 * they add it here, not in the consuming component.
 *
 * Bundle impact: importing from `echarts/core` + per-type registration is
 * substantially smaller than `import * as echarts from 'echarts'`, which pulls
 * the full bundle (~1 MB minified).
 */
import * as echarts from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import {
  BarChart,
  CustomChart,
  GaugeChart,
  HeatmapChart,
  LineChart,
  PieChart,
  SankeyChart,
  ScatterChart,
} from 'echarts/charts';
import {
  DatasetComponent,
  DataZoomComponent,
  GraphicComponent,
  GridComponent,
  LegendComponent,
  MarkAreaComponent,
  MarkLineComponent,
  TitleComponent,
  TooltipComponent,
  TransformComponent,
  VisualMapComponent,
} from 'echarts/components';
import { installZoomHandles } from './echarts-zoom-handles';

echarts.use([
  // Renderer
  CanvasRenderer,
  // Chart types — extend here as new types ship
  BarChart,
  // custom draws the waterfall blocks + connectors (waterfallChartOption).
  CustomChart,
  GaugeChart,
  HeatmapChart,
  LineChart,
  PieChart,
  SankeyChart,
  ScatterChart,
  // Components — graphic draws the axis titles placed by the option builders
  // (chart-options.ts: y-axis title row, time-series titles).
  DatasetComponent,
  DataZoomComponent,
  GraphicComponent,
  GridComponent,
  LegendComponent,
  // markArea draws the scatter plot range bands (scatterChartOption `ranges`).
  MarkAreaComponent,
  // markLine draws the time-series "now line" (timeSeriesChartOption).
  MarkLineComponent,
  TitleComponent,
  TooltipComponent,
  TransformComponent,
  // visualMap maps heatmap cell values to colors.
  VisualMapComponent,
]);

// Figma `_Data Zoom` handles: 4×16 inside the selection, not centered on the
// range edge (eCharts' default). Must run after DataZoomComponent is registered.
installZoomHandles(echarts);

export { echarts };
export type { EChartsCoreOption, ECharts } from 'echarts/core';

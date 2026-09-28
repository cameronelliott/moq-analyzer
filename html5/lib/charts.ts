// The ECharts build the page draws with. From ../html3/site/charts.js.
//
// A tree-shaken ECharts only knows what is registered here, so this file is the
// list of chart types a page may use. A chart asking for anything else renders
// nothing and logs nothing -- which is why <app-echart> checks series types
// against REGISTERED_SERIES.
//
// Adding a chart type means adding it twice: the import below, and
// REGISTERED_SERIES. ECharts has no runtime way to ask which are installed.

import { use, init } from 'echarts/core';
import { BarChart, LineChart } from 'echarts/charts';
import {
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  MarkAreaComponent,
  MarkLineComponent,
  MarkPointComponent,
  TitleComponent,
  TooltipComponent,
} from 'echarts/components';
// `grid.containLabel` is legacy in ECharts 6 and silently does nothing unless
// this feature is registered. PROSE_GRID and CARD set it on every chart.
import { LabelLayout, LegacyGridContainLabel } from 'echarts/features';
import { CanvasRenderer } from 'echarts/renderers';

// Registers 'dark' without dragging the full library back in; see the file.
import './echarts-dark';

use([
  BarChart,
  LineChart,
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  MarkAreaComponent,
  MarkLineComponent,
  MarkPointComponent,
  TitleComponent,
  TooltipComponent,
  LabelLayout,
  LegacyGridContainLabel,
  CanvasRenderer,
]);

export const REGISTERED_SERIES: ReadonlySet<string> = new Set(['bar', 'line']);

export { init };

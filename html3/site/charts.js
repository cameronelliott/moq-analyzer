// This site's chart provider: the ECharts build its documents draw with in the
// browser. Ported from ../html/site.
//
// A tree-shaken ECharts only knows what is registered here, so this file is the
// list of chart types a document is allowed to use. A chart asking for anything
// else renders nothing and logs nothing -- which is why the build and
// <app-echart> both check series types against REGISTERED_SERIES.
//
// Adding a chart type means adding it in two places: the import below, and
// registered-series.js. They are separate because ECharts has no runtime way
// to ask which series types are installed.

import { use, init, registerTheme } from 'echarts/core';
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
// this feature is registered. PROSE_GRID sets it on every chart.
import { LabelLayout, LegacyGridContainLabel } from 'echarts/features';
import { CanvasRenderer } from 'echarts/renderers';

// Registers 'dark' without dragging the full library back in; see the file.
import '../lib/echarts-dark.js';

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

export { REGISTERED_SERIES } from './registered-series.js';

export { init, registerTheme };

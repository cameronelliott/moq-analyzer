// This site's chart provider: the ECharts build its documents draw with.
//
// A tree-shaken ECharts only knows what is registered here, so this file is the
// list of chart types a document is allowed to use. A fence asking for anything
// else renders nothing and logs nothing -- which is why <app-echart> checks the
// series types against REGISTERED_SERIES and fails loudly instead.
//
// It lives in site/ rather than lib/ because the right list depends on what
// this site's documents draw, which is not a question a library can answer.
// lib/ui.js takes it through configureCharts() and never imports it.
//
// Adding a chart type means adding it in two places: the import below, and
// REGISTERED_SERIES. They are separate because ECharts has no runtime way to
// ask which series types are installed.
//
// Longer term the build should read the fences, collect the series types the
// corpus actually uses, and generate this list. Until then it is hand-kept.

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

// Data only, so the build can read the same list in node without importing
// ECharts. Keep it in step with the use() call above.
export { REGISTERED_SERIES } from './registered-series.js';

export { init, registerTheme };

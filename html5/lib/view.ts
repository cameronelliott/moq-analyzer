import type { EChartsOption } from 'echarts';
import type { SafeHtml } from './html';

/** A view's markup, and apart from it each chart's option. mountCharts() joins the two. */
export interface View {
  readonly html: SafeHtml;
  /** Chart options by the `data-chart` id of the element that shows them. */
  readonly charts: Readonly<Record<string, EChartsOption>>;
}

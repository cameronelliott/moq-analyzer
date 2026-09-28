// A 'dark' theme for charts sitting on a dark Web Awesome surface. From
// ../html3/lib/echarts-dark.js.
//
// Not ECharts' own dark theme. That one is published as a UMD file requiring
// 'echarts/lib/echarts' -- the whole library -- so using it undoes the
// tree-shaking in the chart provider.
//
// Charts here are transparent and sit on the page's own surface, so the stock
// theme's background and its palette tuned for that background were never
// wanted -- only readable text and axes were. The default series colors are
// legible on both schemes and are left alone.

import { registerTheme } from 'echarts/core';

const TEXT = '#c9c8d3';    // labels, titles, legend
const LINE = '#55555f';    // axis lines and ticks
const SPLIT = '#35353d';   // grid lines behind the data

const axis = {
  axisLine: { lineStyle: { color: LINE } },
  axisTick: { lineStyle: { color: LINE } },
  axisLabel: { color: TEXT },
  splitLine: { lineStyle: { color: SPLIT } },
  splitArea: { areaStyle: { color: ['transparent', 'transparent'] } },
};

registerTheme('dark', {
  textStyle: { color: TEXT },
  title: { textStyle: { color: TEXT }, subtextStyle: { color: LINE } },
  legend: { textStyle: { color: TEXT } },
  categoryAxis: axis,
  valueAxis: axis,
  logAxis: axis,
  timeAxis: axis,
  // The slider draws its own frame and handles, which default to near-white.
  dataZoom: {
    borderColor: LINE,
    textStyle: { color: TEXT },
    handleStyle: { color: LINE, borderColor: TEXT },
    moveHandleStyle: { color: LINE },
    fillerColor: 'rgba(200, 200, 220, 0.12)',
    dataBackground: {
      lineStyle: { color: LINE },
      areaStyle: { color: SPLIT },
    },
  },
});

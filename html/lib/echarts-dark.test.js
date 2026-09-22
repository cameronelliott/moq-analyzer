import { expect, test, describe, mock } from 'bun:test';

// echarts-dark.js registers a theme as an import side effect, and a browser
// never complains if the theme object is shaped wrong -- ECharts takes what it
// recognises and silently ignores the rest. So the registration is captured
// here with echarts/core stubbed, and the keys that matter are asserted.
//
// Stubbing also keeps this test out of ECharts entirely, so it runs in node
// without a DOM.

const registrations = [];
mock.module('echarts/core', () => ({
  registerTheme: (name, theme) => registrations.push({ name, theme }),
}));

await import('./echarts-dark.js');

describe('the dark theme', () => {
  test('registers exactly one theme, named dark', () => {
    expect(registrations).toHaveLength(1);
    expect(registrations[0].name).toBe('dark');
  });

  const { theme } = registrations[0];

  test('sets a readable color on every axis kind', () => {
    // Miss one and that axis renders near-black text on a dark surface.
    for (const axis of ['categoryAxis', 'valueAxis', 'logAxis', 'timeAxis']) {
      expect(theme[axis]?.axisLabel?.color).toBeTruthy();
      expect(theme[axis]?.axisLine?.lineStyle?.color).toBeTruthy();
      expect(theme[axis]?.splitLine?.lineStyle?.color).toBeTruthy();
    }
  });

  test('colors title, legend and general text', () => {
    expect(theme.textStyle?.color).toBeTruthy();
    expect(theme.title?.textStyle?.color).toBeTruthy();
    expect(theme.legend?.textStyle?.color).toBeTruthy();
  });

  test('styles the dataZoom slider, which draws its own frame', () => {
    expect(theme.dataZoom?.borderColor).toBeTruthy();
    expect(theme.dataZoom?.handleStyle?.color).toBeTruthy();
    expect(theme.dataZoom?.dataBackground?.lineStyle?.color).toBeTruthy();
  });

  test('sets no background: charts sit on the page surface', () => {
    // withDefaults() forces backgroundColor: transparent, and a theme that
    // painted its own would be fighting it.
    expect(theme.backgroundColor).toBeUndefined();
  });

  test('leaves the series palette alone', () => {
    // The stock ECharts colors are legible on both schemes. Overriding them
    // here would mean maintaining a palette for no reason.
    expect(theme.color).toBeUndefined();
  });
});

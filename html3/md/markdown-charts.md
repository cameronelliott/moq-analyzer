---
title: Markdown Charts
tags: doc
---

# Markdown Charts

Everything below is one markdown file. The build turns it into this page: prose
becomes prose, an `echarts` fence becomes a live chart, and every other fence
stays code. The page around it -- header, typography, dark mode -- is Web
Awesome's defaults, and the charts follow the theme with it.

The sidebar is not written anywhere either. It is the `##` headings below,
collected while this document rendered, so a section cannot exist without a link
to it or be renamed out from under one.

None of the text you are reading needed JavaScript to appear. It was rendered
before the file was written; only the charts wake up when the page loads.

## Throughput

The first chart, written as strict JSON. Nothing in the fence knows it is on a
Web Awesome page, or which color scheme is showing.

{% echart %}
{
  "title": { "text": "Monthly Throughput" },
  "tooltip": { "trigger": "axis" },
  "xAxis": { "type": "category", "data": ["Jan", "Feb", "Mar", "Apr", "May"] },
  "yAxis": { "type": "value" },
  "series": [{ "data": [150, 230, 224, 218, 135], "type": "line" }]
}
{% endechart %}

## By region

The same fence, written as a JS object literal instead: unquoted keys, a
trailing comma, and a comment. This is the shape you actually want to type.

{% echart %}
{
  title: { text: 'Requests by Region' },
  tooltip: {},
  xAxis: { type: 'category', data: ['us-east', 'us-west', 'eu', 'apac'] },
  yAxis: { type: 'value' },
  series: [
    // one bar per region
    { type: 'bar', data: [820, 432, 601, 294] },
  ],
}
{% endechart %}

## A thousand points

The fence generates its own data rather than listing a thousand numbers, and
opens zoomed to the first fifth so the slider visibly has somewhere to go.

{% echart %}
{
  title: { text: '1000 Samples' },
  tooltip: { trigger: 'axis' },
  xAxis: {
    type: 'category',
    boundaryGap: false,
    data: Array.from({ length: 1000 }, (_, i) => i),
  },
  yAxis: { type: 'value', name: 'ms' },
  dataZoom: [
    { type: 'slider', xAxisIndex: 0, start: 0, end: 20 },
    { type: 'inside', xAxisIndex: 0 },
  ],
  series: [{
    type: 'line',
    showSymbol: false,
    sampling: 'lttb',
    data: Array.from({ length: 1000 }, (_, i) =>
      +(50 + 20 * Math.sin(i / 40) + 8 * Math.sin(i / 7) + 5 * Math.sin(i / 2.3)).toFixed(2)),
  }],
}
{% endechart %}

## What the fence costs

That generated data is worth being precise about, because it is not lenient
parsing -- it is execution. Strict JSON is tried first; anything else is
compiled and run.

| Written as | Parsed by | Can generate data | Safe for untrusted input |
| --- | --- | --- | --- |
| Strict JSON | `JSON.parse` | no | yes |
| JS object literal | `Function` | yes | no |

The second row is an eval, and it trusts the markdown exactly as much as
rendering that markdown to HTML already does. Fine for documents we author.
Not fine for documents we receive.

An ordinary fence is untouched, which is how you can tell the interception is
narrow:

```js
code({ text, lang }) {
  if (lang !== 'echarts') return false;   // fall through to the default
  return `<app-echart config="${encodeURIComponent(text)}"></app-echart>`;
}
```

## How a chart follows the page

The dark toggle in the header sets two classes on `<html>` and does nothing
else -- it has no list of charts to notify. Each chart watches the class list
and rebuilds itself, because an ECharts theme is fixed at init:

```js
const observer = new MutationObserver(() => {
  if (dark === isDark()) return;   // some other class changed
  dark = !dark;
  onChange();
});
observer.observe(document.documentElement, { attributeFilter: ['class'] });
```

Which means a chart dropped on any Web Awesome page follows that page, with no
wiring to remember.

## When a chart fails

> A broken chart should cost you the chart, not the page.

A fence that parses in neither dialect renders as an error in place, and
everything after it is unaffected. That mattered when documents were parsed in
the browser. It matters less now, because this fence never reaches a reader:

```text
{ this is not valid in any dialect ]]
```

The build parses every `echarts` fence before it writes anything, and a fence
that throws stops the build with the file and the line. So the failure this
section describes is one an authored page can no longer ship -- which is why the
example above is a `text` fence rather than a real one.

The error path still earns its place. A live analyzer builds charts from a
capture file it has never seen, and a chart that cannot be drawn there should
cost the chart, not the page.

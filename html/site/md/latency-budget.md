# Latency Budget

A second document over the same `lib/`. Different title, different sections,
different charts -- and the page around it is a copy of experiment 5's with the
document swapped. Whatever is identical between the two files is what a page
template would have to own.

## Where the time goes

A budget is only useful if the parts add up to the whole, so this is a stacked
bar rather than a set of independent series.

```echarts
{
  tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
  legend: {},
  xAxis: { type: 'category', data: ['ingest', 'relay 1', 'relay 2', 'egress'] },
  yAxis: { type: 'value', name: 'ms' },
  series: [
    { name: 'queue', type: 'bar', stack: 'total', data: [2, 11, 9, 3] },
    { name: 'transfer', type: 'bar', stack: 'total', data: [8, 24, 22, 7] },
    { name: 'process', type: 'bar', stack: 'total', data: [4, 6, 5, 4] },
  ],
}
```

## The tail is the story

Averages hide the thing you care about. The same data as percentiles, with the
median drawn flat for reference.

```echarts
{
  tooltip: { trigger: 'axis' },
  legend: {},
  xAxis: { type: 'category', data: ['p50', 'p75', 'p90', 'p95', 'p99', 'p99.9'] },
  yAxis: { type: 'value', name: 'ms' },
  series: [
    {
      name: 'observed',
      type: 'line',
      data: [48, 61, 84, 103, 188, 412],
      markLine: { data: [{ type: 'average', name: 'mean' }] },
    },
  ],
}
```

## What this page proves

Nothing about charts -- experiment 5 already proved those. It proves that
adding a page currently means copying a head, a shell and six lines of wiring,
and that the only part anyone wants to write is the markdown below the fold.

---
title: Interarrival
order: 3
---

# Interarrival

The gap between an object arriving and the one before it on the same track,
at the subscriber that decoded it. rtcstats calls this Latency,
chrome://webrtc-internals calls it Jitter. Chart 2 of the mlog schema, the
`interarrival` view.

## Video, two subscribers

A steady 30 fps source should sit near 33.3 ms. Spikes are objects that
arrived in a burst after a stall.

{% echart %}
{
  tooltip: { trigger: 'axis' },
  legend: {},
  xAxis: {
    type: 'category',
    name: 'object',
    boundaryGap: false,
    data: Array.from({ length: 600 }, (_, i) => i),
  },
  yAxis: { type: 'value', name: 'ms' },
  dataZoom: [{ type: 'inside' }, { type: 'slider' }],
  series: [
    {
      name: 'sub-1', type: 'line', showSymbol: false, sampling: 'lttb',
      data: Array.from({ length: 600 }, (_, i) =>
        +(33.3 + 2.5 * Math.sin(i / 3.1) + (i % 97 === 0 ? 40 : 0)).toFixed(1)),
    },
    {
      name: 'sub-3', type: 'line', showSymbol: false, sampling: 'lttb',
      data: Array.from({ length: 600 }, (_, i) =>
        +(33.3 + 5 * Math.sin(i / 1.7) + (i % 61 === 0 ? 70 : 0)).toFixed(1)),
    },
  ],
}
{% endechart %}

## Reading it

- The first object on each track has no predecessor, so it has no value.
- A late joiner's catch-up burst shows as a run of near-zero gaps. Whether it
  belongs in this chart is still open.

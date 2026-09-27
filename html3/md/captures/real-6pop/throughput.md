---
title: Throughput
order: 4
---

# Throughput

Media bytes per track per second, at one subscriber. Chart 3 of the mlog
schema, the `throughput` view.

This is payload only: no QUIC or MoQ framing, no retransmission. A second
with no object has no row rather than a zero.

## sub-1, first minute

{% echart %}
{
  tooltip: { trigger: 'axis' },
  legend: {},
  xAxis: {
    type: 'category',
    name: 's',
    boundaryGap: false,
    data: Array.from({ length: 60 }, (_, i) => i),
  },
  yAxis: { type: 'value', name: 'kbit/s' },
  series: [
    {
      name: 'video', type: 'line', showSymbol: false,
      data: Array.from({ length: 60 }, (_, i) =>
        Math.round(2400 + 300 * Math.sin(i / 4) + (i % 10 === 0 ? 900 : 0))),
    },
    {
      name: 'audio', type: 'line', showSymbol: false,
      data: Array.from({ length: 60 }, (_, i) => Math.round(128 + 4 * Math.sin(i))),
    },
  ],
}
{% endechart %}

The spikes every ten seconds are keyframes: the start of each video group.

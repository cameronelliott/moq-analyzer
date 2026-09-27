---
title: Latency
order: 2
---

# Latency

Every object that reached a subscriber crossed three legs: into the relay,
through it, and out to that subscriber. Chart 1 of the mlog schema, the `leg`
view.

## Per-leg means

Means rather than medians, because means sum to the end-to-end figure and
medians do not.

{% echart %}
{
  tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
  legend: {},
  xAxis: { type: 'value', name: 'ms' },
  yAxis: { type: 'category', data: ['sub-4', 'sub-3', 'sub-2', 'sub-1'] },
  series: [
    { name: 'pub -> relay', type: 'bar', stack: 'leg', data: [74.9, 75.0, 74.9, 74.9] },
    { name: 'relay dwell',  type: 'bar', stack: 'leg', data: [1.2, 3.1, 0.5, 1.9] },
    { name: 'relay -> sub', type: 'bar', stack: 'leg', data: [140.2, 88.1, 12.4, 55.8] },
  ],
}
{% endechart %}

## Leg 1 is the check

The publisher's leg is one physical hop, measured once per subscriber, so the
four numbers must agree. Here they land within 0.1 ms of each other.

| Subscriber | pub -> relay | relay dwell | relay -> sub | End to end |
| --- | --- | --- | --- | --- |
| sub-1 | 74.9 | 1.9 | 55.8 | 132.6 |
| sub-2 | 74.9 | 0.5 | 12.4 | 87.8 |
| sub-3 | 75.0 | 3.1 | 88.1 | 166.2 |
| sub-4 | 74.9 | 1.2 | 140.2 | 216.3 |

## Relay dwell is all tail

The median is a sliver; the mean is several times larger. A median-only bar
would draw the relay as nothing.

{% echart '300px' %}
{
  tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
  legend: {},
  xAxis: { type: 'category', data: ['sub-1', 'sub-2', 'sub-3', 'sub-4'] },
  yAxis: { type: 'value', name: 'ms' },
  series: [
    { name: 'median', type: 'bar', data: [0.31, 0.26, 0.43, 0.29] },
    { name: 'mean',   type: 'bar', data: [1.9, 0.5, 3.1, 1.2] },
  ],
}
{% endechart %}

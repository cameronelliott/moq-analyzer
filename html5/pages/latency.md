# Object latency

Every object that reached a subscriber crossed three legs: into the relay,
through it, and out to that subscriber.

## Per-leg means

Means rather than medians, because means sum to the end-to-end figure and
medians do not.

<app-echart data-chart="leg-means" height="300px"></app-echart>

## Leg 1 is the check

The publisher's leg is one physical hop, measured once per subscriber, so the
numbers in its column must agree.

<div data-block="leg-means-table"></div>

## Relay dwell: median and mean

A mean well above the median means the relay holds some objects much longer
than most.

<app-echart data-chart="dwell" height="300px"></app-echart>

## Every leg

<div data-block="leg-table"></div>

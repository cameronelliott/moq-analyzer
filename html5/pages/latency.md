# Object latency

Every object that reached a subscriber crossed three legs: into the relay,
through it, and out to that subscriber.

<div data-block="recovery"></div>

## Per-leg means


<app-echart data-chart="leg-means" height="300px"></app-echart>

## Leg means per subscriber


<div data-block="leg-means-table"></div>

## Relay dwell: median and mean

A mean well above the median means the relay holds some objects much longer
than most.

<app-echart data-chart="dwell" height="300px"></app-echart>

## Every leg

<div data-block="leg-table"></div>

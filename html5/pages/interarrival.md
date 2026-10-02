# Object Interarrival Period

The gap between an object arriving at a subscriber and the one before it on
the same track, pooled over every subscriber. rtcstats calls this latency. It
includes the publisher's pacing, so on its own it is not a network measure.

Each track is its own distribution. A gap on one track and a gap on another
mean different things, and pooled together they blur both.

<div data-block="track-table"></div>

## Each track

<div data-block="track-charts"></div>

## Reading it

- The first object on each track has no predecessor, so it has no gap.
- A late joiner's catch-up burst shows as a run of near-zero gaps. Whether
  those belong here is still open.

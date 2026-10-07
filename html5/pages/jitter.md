# Object jitter

Delay variation is how much longer or shorter one object took on a leg than
the object before it. It is always shown as a positive number, in ms. 0 means
the two took the same time.

It needs no clock sync, because a constant offset between two clocks cancels.

## Per leg

The mean delay variation of each leg, for each subscriber.

<app-echart data-chart="leg-means" height="300px"></app-echart>

## Over time

The mean delay variation of each second on the relay → subscriber leg. Drag
the slider to zoom.

<app-echart data-chart="series" height="380px"></app-echart>

## Summary

In ms.

<div data-block="summary-table"></div>

## Reading it

- A keyframe is much larger than the frames around it and takes longer to
  deliver. Expect a spike at each keyframe. It is not a network problem.
- These numbers will not match the jitter that RTP tools report. RTP jitter
  (RFC 3550) is smoothed over many packets. This is a plain average.

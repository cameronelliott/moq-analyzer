# Object jitter

How steady each leg is. For each object, D is its transit time on a leg minus
the transit time of the object before it: RFC 3550's D, per object. The charts
show |D|, so 0 means this object took exactly as long as the one before.

A constant clock offset between two ends cancels in D, so this needs no clock
sync. Retransmits, flow control and head-of-line blocking all land in D: this
is the object delivery jitter a player sees, not IP packet jitter, which an
mlog cannot show.

## Per leg

The mean |D| of each leg, for each subscriber.

<app-echart data-chart="leg-means" height="300px"></app-echart>

## Over time

The mean |D| of each second on the relay → subscriber leg. Drag the slider to
zoom.

<app-echart data-chart="series" height="380px"></app-echart>

## Summary

In ms.

<div data-block="summary-table"></div>

## Reading it

- A keyframe takes longer to send than the objects around it, so D jumps
  where a keyframe starts and ends.
- RFC 3550's J is a running 1/16 average. A mean of |D| is comparable to it,
  not the same.

# Object bitrate

Payload bits per second: no QUIC or MoQ framing, no retransmissions. This is
not bandwidth, which is the capacity of a link and which an mlog cannot show.
A second with no object has no point rather than a zero.

## Every subscriber

What each subscriber received, all tracks together, next to what the
publisher sent. Drag the slider to zoom.

<app-echart data-chart="received" height="380px"></app-echart>

## One subscriber, each track

<app-echart data-chart="tracks" height="380px"></app-echart>

## Summary

In kbit/s. The first and last second of each log are partial and left out.
The track means add up to the mean for all tracks.

<div data-block="summary-table"></div>

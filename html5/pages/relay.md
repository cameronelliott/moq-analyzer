# Relay

How long the relay holds each object, how steady that time is, and how steady
delivery is at each subscriber. One dot is one second.

## Dwell and object jitter over time

The left axis is relay dwell: the mean time from the relay receiving an object
to sending it to a subscriber, for all subscribers and tracks together.

The right axis is jitter, as the mean |D| of each second:

- Relay egress jitter is the change in dwell from one object to the next. It
  shows how steady the relay is. It needs only the relay's logs.
- Each subscriber has its own jitter series, on the relay → subscriber leg. It
  needs that subscriber's log.

Both axes are in ms, at different scales. Read each dot against its own axis.
Drag the bottom slider to zoom in time, and the right slider to zoom the
jitter axis: a few large spikes can flatten the small values.

<app-echart data-chart="relay-series" height="420px"></app-echart>

<div data-block="note"></div>

## Reading it

- Held objects are left out: the relay had them before the subscriber asked,
  so their dwell measures the subscriber arriving, not the relay.
- A second with no sample has no dot.

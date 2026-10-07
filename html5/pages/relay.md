# Relay

One dot is one second.

## Dwell and object jitter over time

Left axis: relay dwell, the mean time the relay held an object, all
subscribers and tracks together.

Right axis: mean delay variation.

- Relay egress jitter: the change in dwell from one object to the next. Needs
  only the relay's logs.
- Subscriber jitter: the relay → subscriber leg, one series per subscriber.
  Needs that subscriber's log.

The right slider zooms the right axis. A few large spikes can flatten the
small values.

<app-echart data-chart="relay-series" height="420px"></app-echart>

<div data-block="note"></div>

## Reading it

- Held objects are left out: the relay had them before the subscriber asked,
  so their dwell measures the subscriber arriving, not the relay.
- A second with no sample has no dot.

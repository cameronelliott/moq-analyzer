# Connections

What a chart is allowed to claim, per connection, counted from the mlogs with
nothing inferred.

<div data-block="trust-table"></div>

## Lost is not outside the window

An object only counts as lost if both ends were still recording when it was
sent. An object sent after the receiving end's log stopped never joins, which
looks like loss and is not: it is outside the window.

The objects on each connection that never joined, split into the two. Joined
objects are in the table above.

<app-echart data-chart="not-joined" height="260px"></app-echart>

## Clocks

A negative hop is an object logged as arriving before it was sent. Only clock
error makes one. Zero negative hops rules out clock error larger than the
transit time, and nothing finer.

## Traces

One row for each log file. Stock moq-rs logs no stream ids and no
reference_time. The analyzer recovers the stream ids, and lines up the relay's
own traces on the fastest object. The last two columns say how many objects
that used, and how many came within 50 µs of the fastest.

<div data-block="recovery-table"></div>

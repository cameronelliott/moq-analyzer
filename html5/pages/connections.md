# Connections

What a chart is allowed to claim, per connection, counted from the mlogs with
nothing inferred.

<div data-block="trust-table"></div>

## Lost is not outside the window

An object only counts as lost if both ends were still recording when it was
sent. An object sent after the receiving end's log stopped never joins, which
looks like loss and is not: it is outside the window.

## Clocks

A negative hop is an object logged as arriving before it was sent. Only clock
error makes one. Zero negative hops rules out clock error larger than the
transit time, and nothing finer.

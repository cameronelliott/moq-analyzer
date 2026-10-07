# Connections

Object counts for each connection.

<div data-block="trust-table"></div>

## Lost and outside the window

An object counts as lost only if the receiving end was still logging when it
was sent. One sent after that log stopped is outside the window.

<app-echart data-chart="not-joined" height="260px"></app-echart>

## Clocks

A negative hop is an object logged as arriving before it was sent. Only clock
error causes one. Zero means clock error is below the transit time.

## Traces

One row for each log file. On a stock moq-rs capture, the last two columns
count the objects used to line up the relay's traces, and those within 50 µs
of the fastest.

<div data-block="recovery-table"></div>

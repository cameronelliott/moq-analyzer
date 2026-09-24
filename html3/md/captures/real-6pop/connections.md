---
title: Connections
order: 5
---

# Connections

What a chart is allowed to claim, per connection, counted from the mlogs with
nothing inferred. The mlog schema's `trust` view.

| Connection | Sender | Sent | Received | Joined | Lost | Outside window | Negative hops |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `c45a526b` | publisher | 50,112 | 50,112 | 50,112 | 0 | 0 | 0 |
| `1f0e93aa` | relay | 50,860 | 50,104 | 50,104 | 0 | 756 | 0 |
| `7b21c0d4` | relay | 50,851 | 50,098 | 50,098 | 0 | 753 | 0 |
| `a9e4f512` | relay | 50,847 | 50,099 | 50,099 | 0 | 748 | 0 |
| `e03d6c7f` | relay | 50,858 | 50,101 | 50,101 | 0 | 757 | 0 |

## Lost is not outside the window

Each subscriber's log stopped about ten seconds before the relay's. Objects
the relay sent after that never joined, which looks like 1% loss and is not:
every one falls after the last object that did join. An object only counts as
lost if both ends were still recording when it was sent.

## Clocks

Zero negative hops proves nothing on its own: it only rules out clock error
larger than the transit time. These captures were built to hold reference time
error under 10 µs, which is a property of how they were made, not something
the data can show.

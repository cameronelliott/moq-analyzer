# Measures

The four measures are object bitrate, object jitter, object loss, and object
latency. Each measure is for a MoQ object, not for a QUIC packet.

The View column gives the rows. The Summary and Series columns give the frame
view, and then the Capture function that reads it.

| Measure        | Shows                                  | View             | Summary                                          | Series                                         |
| -------------- | -------------------------------------- | ---------------- | ------------------------------------------------ | ---------------------------------------------- |
| Object latency | where the end-to-end time goes         | `leg`            | `leg_summary`, `legSummary`                      | --                                             |
| Object jitter  | how steady each leg is                 | `jitter`         | `jitter_summary`, `jitterSummary`                | `jitter_series`, `jitterSeries`                |
| Object loss    | if an object was really lost           | `trust`          | `trust`, `trust`                                 | --                                             |
| Object bitrate | media bits for each track, each second | `object_bitrate` | `object_bitrate_summary`, `objectBitrateSummary` | `object_bitrate_series`, `objectBitrateSeries` |

Every series counts `t_s` from `capture_start`, so all series share one time
axis.

## Relay series

`relay_series` and `relaySeries` give the frame for one chart with two y axes.
One axis shows relay dwell. The other axis shows relay egress jitter and
subscriber jitter. One row is one dot: one series in one second.

- Relay dwell is the mean dwell of all subscribers and tracks together.
- Relay egress jitter is the mean |D| of relay dwell, for all subscribers and
  tracks together. Both times of dwell come from the relay's clock. Thus D is
  the change in dwell from one object to the next. It shows how steady the
  relay is.
- Subscriber jitter is the mean |D| on the relay to subscriber leg. Each
  subscriber has its own series, because each subscriber can have a different
  network.
- Relay dwell and relay egress jitter need only the relay's logs. Subscriber
  jitter also needs the subscribers' logs.
- The rows do not include held objects, as in `leg`.

## Coverage

A measure has rows only when the logs it needs are loaded. The `coverage` view
and the `coverage` function tell which ends of each connection are loaded. Use
them to tell a missing log from an empty result.

| Logs loaded                   | Measures                        |
| ----------------------------- | ------------------------------- |
| one end of a connection       | object bitrate, interarrival    |
| the relay's in and out traces | relay dwell (leg 2), its jitter |
| both ends of a connection     | object loss (`trust`)           |
| both ends of both connections | legs 1 and 3, end to end        |

A relay operator has only the relay's logs. That gives object bitrate,
interarrival at the relay, and relay dwell. It does not give object loss or
the latency of the network legs.

## Distributions

`distribution(measure, track?)` gives the quantiles and a histogram of one
measure. The views are `distribution_sample`, `distribution_summary`, and
`distribution_bin`. The samples of all subscribers are put together, so the
result has the same size for 4 subscribers or 5,000. The views are the reason:
a chart with one bar for each subscriber does not scale.

The measures are end to end, relay dwell, interarrival, and bitrate. A bitrate
sample is one second that one subscriber received. When you do not give a
track, bitrate uses the `all` second, not the track seconds together. Video
seconds and audio seconds together do not mean anything.

The quantiles include p1 and p5, because a low bitrate is the problem. For
latency, a high value is the problem.

- Object latency: The view gives one value for each leg. The means of the legs
  add up to the end-to-end mean. The medians do not. The view does not include
  held objects. Latency is correct only when the clocks agree.
  - Relay dwell uses only the relay's clock, so it needs only the relay's
    logs. When a far end is loaded, `leg` keeps an object only if that end
    shows it too. Thus all legs use the same objects.
- Object jitter: The view uses RFC 3550 D for each object, leg, and track. It
  is not packet jitter. Refer to
  [RFC-3550-explained.md](RFC-3550-explained.md). A constant clock offset
  cancels. A keyframe causes a high D. Use `payload_length` to separate
  keyframes. Only the summary has p99.
- Object loss: A lost object is an object that did not arrive at the far end.
  It is not packet loss. QUIC sends a lost packet again, so an mlog cannot show
  packet loss. `lost` and `outside_window` are different. Refer to "Cameron's
  decisions" in AGENTS.md.
  - Object loss needs both ends of a connection. With one end, `joined` and
    `negative_hops` are NULL, not 0. A 0 would say that nothing was lost.
  - `lost` and `outside_window` are NULL when nothing joined. Then no window
    tells which objects count as lost.
- Object bitrate: The view counts only payload bytes. An mlog does not log other
  sizes. It is not bandwidth: bandwidth is the capacity of a link, and an mlog
  cannot show capacity.
  - `direction` is `created` for the rate that an end sent, and `parsed` for
    the rate that an end received. Compare the relay's `created` rate with a
    subscriber's `parsed` rate on the same connection. A gap that closes is
    delay. A gap that stays is loss.
  - A row with `scope = 'all'` adds all tracks for one second. Filter on
    `scope` before you add a column, or you count bytes two times.
  - When a second has no object, the series has no row for that second.
  - The summary does not use the first and the last second of each log,
    because they are partial seconds. The track means add up to the `all`
    mean.
- `interarrival`: This view gives the time between arrivals at the player. It
  is not a measure, because it includes the send rate of the publisher. Open
  item: include or exclude catch-up bursts.

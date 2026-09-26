# Measures

The four measures are bitrate, jitter, loss, and latency.

The View column gives the rows. The Summary and Series columns give the frame
view, and then the Capture function that reads it.

| Measure | Shows                                  | View             | Summary                                          | Series                                         |
|---------|----------------------------------------|------------------|--------------------------------------------------|------------------------------------------------|
| Latency | where the end-to-end time goes         | `leg`            | `leg_summary`, `legSummary`                      | --                                             |
| Jitter  | how steady each leg is                 | `jitter`         | `jitter_summary`, `jitterSummary`                | `jitter_series`, `jitterSeries`                |
| Loss    | if an object was really lost           | `trust`          | `trust`, `trust`                                 | --                                             |
| Bitrate | media bits for each track, each second | `object_bitrate` | `object_bitrate_summary`, `objectBitrateSummary` | `object_bitrate_series`, `objectBitrateSeries` |

Every series counts `t_s` from `capture_start`, so all series share one time
axis.

- Latency: The view gives one value for each leg. The means of the legs add up
  to the end-to-end mean. The medians do not. The view does not include held
  objects. Latency is correct only when the clocks agree.
- Jitter: The view uses RFC 3550 D for each object, leg, and track. Refer to
  [RFC-3550-explained.md](RFC-3550-explained.md). A constant clock offset
  cancels. A keyframe causes a high D. Use `payload_length` to separate
  keyframes. Only the summary has p99.
- Loss: `lost` and `outside_window` are different. Refer to "Cameron's
  decisions" in AGENTS.md.
- Bitrate: The view counts only payload bytes. An mlog does not log other
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

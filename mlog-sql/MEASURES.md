# Measures

The four measures are bandwidth, jitter, loss, and latency.

The View column gives the rows. The Summary and Series columns give the frame
view, and then the Capture function that reads it.

| Measure   | Shows                                  | View         | Summary                            | Series                           |
|-----------|----------------------------------------|--------------|------------------------------------|----------------------------------|
| Latency   | where the end-to-end time goes         | `leg`        | `leg_summary`, `legSummary`        | --                               |
| Jitter    | how steady each leg is                 | `jitter`     | `jitter_summary`, `jitterSummary`  | `jitter_series`, `jitterSeries`  |
| Loss      | if an object was really lost           | `trust`      | `trust`, `trust`                   | --                               |
| Bandwidth | media bits for each track, each second | `throughput` | --                                 | `throughput`, --                 |

- Latency: The view gives one value for each leg. The means of the legs add up
  to the end-to-end mean. The medians do not. The view does not include held
  objects. Latency is correct only when the clocks agree.
- Jitter: The view uses RFC 3550 D for each object, leg, and track. Refer to
  [RFC-3550-explained.md](RFC-3550-explained.md). A constant clock offset
  cancels. A keyframe causes a high D. Use `payload_length` to separate
  keyframes. Only the summary has p99.
- Loss: `lost` and `outside_window` are different. Refer to "Cameron's
  decisions" in AGENTS.md.
- Bandwidth: The view counts only payload bytes. When a second has no object,
  the view has no row for that second. There is no Capture function yet.
- `interarrival`: This view gives the time between arrivals at the player. It
  is not a measure, because it includes the send rate of the publisher. Open
  item: include or exclude catch-up bursts.

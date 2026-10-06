# about this directory

This directory defines the database schema and typescript interfaces to use it.


# per-subscriber views

- we need to think carefully about when per-subscriber views are okay, and when they are not. if operator capture 100 or 10,000 subscriber views, maybe the data will be prefiltered before the files are supplied to the analyzer, and maybe they won't. I suppose what I am saying, is the current design seems to assume a small set of end-subscribers. I am not sure that is a good assumption.
- as devils avocate, it could be a good and accurate assumption analyzer operators want to per-subscriber details/metrics/and graphs. this should be explored and answered. 
- we may or may not reduce per-subscriber views. it's not clear right now. on a case by case basic we will evaluate the utility of each going forward.


# reminders for Cameron

- bandwidth, jitter, loss, latency are measures
- why the `jitter` view uses RFC 3550 D: [RFC-3550-explained.md](RFC-3550-explained.md)
- if i have 500 values each would be data points
- all 500 values would be the bandwidth time series
- if i have: bandwidth max, min, 95th percentile, median, those are called summary stats.

# what this directory makes available to consumers

1. one single overall session summary, stuff like start-time, number of cid's, maybe locations if availabe? 
2. a number


# rules-1

- Markdown lists measures and why, never columns or types.
- [MEASURES.md](MEASURES.md) lists the measures and the reasons for them. When
  you add a view or a Capture function, update MEASURES.md in the same commit.
- A chart's frame (summary or series) is a SQL view: named, commented, with a
  fixture test. CLI users get the same frames the analyzer draws.
- `QUERIES` holds only `SELECT` + casts + `ORDER BY` from one view, plus the
  column spec. Casts to INTEGER/DOUBLE live here, not in the view: BIGINT is a
  JS transport problem.
- The column spec is the only place columns are listed, except the public
  header. It gives the row type, the row check, and the DESCRIBE contract.


# rules-2

- `api.ts` is the whole public interface (package.json `exports`). Everything
  else, `QUERIES` included, lives in api-internal.ts. api.test.ts pins the
  exported values.
- mlog-sql.d.ts is the public header. Consumers get it under the `types`
  condition, so they never see an internal type. It is written by hand.
  api.ts imports its public types from the header and declares none of its own.
  header-check.ts makes `bun run typecheck` fail when the header's rows or
  values disagree with the code.
- mlog-sql throws only CaptureError. An engine error is wrapped, with the
  original as `cause`.
- A column with a fixed set of values lists them in its spec. The header gives
  it a union type, and validateRows refuses any other value.
- The views are the source of truth: api.ts runs a SELECT over one view per
  query and writes no joins.
- The .sql files must run in duckdb-wasm: plain SQL, no dot commands. wasm
  fetches `icu` and `json` at runtime while the CLI has them built in, so a CLI
  check says nothing about the browser -- wasm.test.ts is the check.
- Tests are `bun test`. streaming.test.ts needs a local mlog.jsonl (gitignored).

# Incremental View Maintenance (IVM)

- when designing streaming or chunking type interfaces, we want to consider whether IVM can be achieved at the database view level. it is not a requirement, but if easy or cheap, we do it.
- see IVM.md




# open, not decided

**Round-tripping.** Should mlog json -> duckdb -> mlog json come back arguably
correct (not byte-identical)? Decide before more of the loader hardens. What the
loader drops or alters today:

    time             DOUBLE ms -> (time*1000)::BIGINT us. Sub-microsecond gone.
    reference_time   same, via TIMESTAMPTZ.
    extension_headers  only extension_count survives. Zero on all 605,048
                     objects of real-6pop, but the one true data loss.
    parameters       [[k,v],...] -> MAP. Array order gone. A repeated key errors.
    event_type       not stored; derivable from event name and direction.
    group_id,
    subgroup_id      dropped from objects; recoverable via stream_id ->
                     subgroup_stream.
    key order        within `data`, not preserved.
    line order       among events sharing one timestamp, not preserved.

Unknown events keep `data` verbatim in event_other, so those round-trip already.

# Cameron's decisions

- json shape drift is caught in production, in load.sql. Too early to remove
  that.
- trace_id identifies a trace; cid is just an optional connection id on the
  trace row.
- these are mlog files. The header shape came from qlog, so qlog_version /
  qlog_format keep their names; nothing else says qlog.
- duplicate prevention deferred until streaming ships; only chunked feeding can
  duplicate rows, and a PK on subgroup_object costs 7.6x db size vs 0.21s to run
  test-duplicated-mlog.sql.
- one capture per database file. group_id overlaps between runs, so the object
  join key collides across captures: two captures in one file left every leg
  median right while relay dwell's mean went out by 7x. Compare runs with ATTACH
  -- a view resolves against its own database's tables.
- `hop` is the one place the cross-connection join is written; hand-rolling it
  is how the above goes wrong silently. `dwell` joins the relay's own in and out
  traces, so it needs no far-end log. `leg` is where hops and dwell meet.
- partial captures are supported by building each view from only the traces
  its measure needs; `coverage` says which ends were loaded. A count the loaded
  logs cannot back is NULL, never 0.
- no clock table. No mlog records clock quality, so `trust` counts only what
  the logs show. `negative_hops` is the one clock signal and it is one-way:
  nonzero proves disagreement, zero proves nothing.
- `trust.lost` vs `trust.outside_window` keeps charts honest. Their sum is not
  loss: real-6pop's relay has ~750 unjoined sends per subscriber, all after that
  subscriber's log stopped. An object is lost only if sent between the first and
  last join on its connection.
- no role column. `vantage_point` carries it: client->server hops are the
  publisher's leg, server->client the subscribers'. Assumes one relay at the
  server end of every connection. A chained relay would read as a publisher,
  since nothing in an mlog says two traces share a host.

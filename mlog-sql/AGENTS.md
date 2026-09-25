# files

    schema.sql          tables + object/event views; idempotent, run it first
    load.sql            loads the mlog (or chunk) named by `src`

    duckdb t.db -f mlog-sql/schema.sql \
      -c "set variable src='mlog.jsonl';" -f mlog-sql/load.sql

The database assigns `trace_id`; the caller only names a file. To feed one trace
as chunks, give each chunk its own `src` and set the same `trace_name` before
each.

    api.ts              the one file html4 imports: openCapture(engine, traces)
                        streams each trace in whole-record chunks through
                        load.sql, then returns typed
                        rows from the views (QUERIES). api-internal.ts holds
                        the chunker and row checks; api.test.ts holds the
                        DESCRIBE contract test.

    test-duplicated-mlog.sql    audits a loaded database for double-inserted
                                rows; no rows means clean

    fixtures/vanilla-stock.mlog stock moq-rs relay mlog (no reference_time,
                                stream_id 0 everywhere); guards.test.ts
                                proves the loader refuses it.

Tests are `bun test`. streaming.test.ts reads mlog.jsonl, which is gitignored --
supply one locally.

# the .sql files must run in duckdb-wasm

- Plain SQL only: no dot commands, nothing that assumes a terminal. wasm.test.ts
  runs the real wasm engine under node and compares a load against the CLI row
  for row.
- wasm fetches `icu` and `json` from extensions.duckdb.org on first use; the CLI
  has them built in. A CLI check says nothing about the browser -- verify
  against wasm.
- `schema.sql` opens with `LOAD icu; SET TimeZone='UTC';`. The explicit LOAD is
  required: an operator overload never autoloads, so `TIMESTAMPTZ + INTERVAL`
  otherwise fails to bind with an error that names neither ICU nor the fix.
- Session variables and the load's `BEGIN`/`COMMIT` are connection-scoped. A
  whole load must run on one connection; spreading it across connections gives
  NULLs, not errors.

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

- json shape drift is caught in production, in the load*.sql files. Too early to
  remove that.
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
- `hop` is the one place the cross-trace join is written; hand-rolling it is how
  the above goes wrong silently. `dwell` is built from a pair of hops.
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

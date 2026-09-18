# files

Each file's own first line says what it does. What no single file can say is how
they compose:

    schema.sql          tables + object/event views; idempotent, run it first

    load_file.sql       whole file  \
                                     >  load_common.sql   the ingest itself
    load_lines.sql      one chunk   /

An input file only defines the `raw` view -- it does not run the ingest. Pass
both, in order, in one invocation. They do not pull each other in, because
DuckDB's `.read` resolves against the working directory rather than the
including script, so the caller resolves the paths:

    duckdb t.db -f mlog-sql/schema.sql -c "<variables>" \
      -f mlog-sql/load_file.sql -f mlog-sql/load_common.sql

`trace_id` is not an input: the caller names a file, the database assigns the
integer. `load_file.sql` files under `src`; `load_lines.sql` requires
`filename`, same value every chunk.

    test-duplicated-mlog.sql    audits an already-loaded database for
                                double-inserted rows; no rows means clean

    myload.sh                   loads mlog.jsonl into a fresh t.db

    fixtures/vanilla-stock.mlog first 12 lines of a stock moq-rs relay mlog:
                                no reference_time, stream_id 0 everywhere.
                                guards.test.ts proves the loader refuses it.

Tests are `bun test`. streaming.test.ts reads mlog.jsonl, which is gitignored --
supply one locally to run it.


# Cameron's decisions

- json shape drift should be caught during regular production use. in the load*.sql files.
- cameron considered removing shape drift from production usage, but it's too early to do that. 
- trace_id identifies a trace; cid is just an optional connection id recorded on the trace row.
- these are mlog files. the header shape was inherited from qlog, and that is all
  qlog about them -- so qlog_version/qlog_format keep their names, nothing else says qlog.
- duplicate prevention deferred until streaming ships; only chunked feeding can duplicate rows, and a PK on subgroup_object costs 7.6x db size vs 0.21s to run test-duplicated-mlog.sql.
- one capture per database file. group_id overlaps between runs, so the object
  join key collides across captures: two capture dirs in one file left every leg
  median right to two decimals while relay dwell's mean went out by 7x. Nothing in
  the schema scopes a capture, so nothing has to remember to. Compare runs with
  ATTACH -- a view resolves against its own database's tables.
- `hop` is the one place the cross-trace join is written. Hand-rolling it is how
  the above goes wrong silently. `dwell` is built from a pair of hops.
- no clock table. No mlog records clock quality, and it generally will not be
  available, so `trust` counts what the logs show and says nothing it cannot
  count. `negative_hops` is the one clock signal and it is one-way: nonzero
  proves disagreement, zero proves nothing.
- `trust.lost` vs `trust.outside_window` is the distinction that keeps a chart
  honest. Their sum is not loss: the relay has ~750 unjoined sends per
  subscriber in real-6pop, every one of them after that subscriber's log
  stopped. An object counts as lost only if it was sent between the first and
  last join on its connection, when both ends were demonstrably recording.
- no role column. `vantage_point` already carries it: client->server hops are the
  publisher's leg, server->client hops the subscribers'. Assumes one relay at the
  server end of every connection -- the v1 capture exactly. A chained relay would
  read as a publisher, since nothing in an mlog says two traces share a host, and
  that is the capture that turns role from assumption into data.

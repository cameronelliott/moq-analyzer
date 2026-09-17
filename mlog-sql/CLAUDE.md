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

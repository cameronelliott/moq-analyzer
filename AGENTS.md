# what this is

- Cameron is building a MoQ (media over quic) mlog and qlog file analyzer.
- mlog and qlog are RFC 7464 json nl files with trace event records.
- The analyzer ships two ways: an empty tool page that waits for dropped mlog/qlog files, and server-rendered analysis pages that search engines can index. Like https://rtcstats.com/showcase, there will be a showcase of other people's sessions.


# presentation demo

- Cameron hopefully has a 5 minute lightning presentation to give on the "MoQ Analyzer" on 10/8/26
- everything is focused on getting that ready much earlier than 10/8/26
- the trick will be the right tradeoff by cameron between long-term software creation and prepping for the demo

# tests and contracts first

- Types, DDL, and tests before code.
- No `any`; casts only where untyped data enters (`JSON.parse`, subprocess output), each with a comment saying what it assumes.
- Wrap multi-statement SQL ingest in a transaction, since the DuckDB CLI keeps going after an error and half-commits.
- Verify SQL with `EXCEPT ALL` against the source in both directions.
- Break the code once to watch each test fail.


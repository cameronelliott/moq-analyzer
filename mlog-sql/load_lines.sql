-- Streamed input for load_common.sql: one chunk of mlog lines held in a variable,
-- rather than a file. Pass both, in this order:
--
--   duckdb t.db -f mlog-sql/schema.sql -c "set variable trace_id=1;" \
--     -c "set variable lines='<chunk>';" \
--     -f mlog-sql/load_lines.sql -f mlog-sql/load_common.sql \
--     -c "set variable lines='<chunk>';" \
--     -f mlog-sql/load_lines.sql -f mlog-sql/load_common.sql
--
-- The caller resolves both paths, so this works from any directory.
--
-- Expects:
--   lines     one or more newline-separated JSON lines. Single quotes must be
--             doubled by the caller, since this arrives as SQL text.
--   trace_id  id to assign this trace (required)
--   cid       optional connection id, recorded on the trace row
--   src_name  optional; path to record in trace.source_file
--
-- Chunks may be fed repeatedly into the same database for one trace_id; the
-- result matches loading the whole log at once. Feed them in time order, and
-- include the mlog header line in the first chunk. The drift report is
-- suppressed per chunk -- query `shape` once at the end instead.
--
-- Blank lines are dropped, so a trailing newline on a chunk is harmless.

CREATE OR REPLACE TEMP VIEW raw AS
SELECT line::JSON AS j
FROM (SELECT unnest(string_split(getvariable('lines'), chr(10))) AS line)
WHERE trim(line) <> '';

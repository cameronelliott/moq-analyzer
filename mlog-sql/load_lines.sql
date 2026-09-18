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
--   filename  required; what this trace is filed under. There is no file here to
--             take a name from, so the caller supplies one -- the same value for
--             every chunk of one trace, since that is what ties them together.
--   cid       optional connection id, recorded on the trace row
--
-- Chunks may be fed repeatedly into the same database for one trace_id; the
-- result matches loading the whole log at once. Feed them in time order, and
-- include the mlog header line in the first chunk. The drift report is
-- suppressed per chunk -- query `shape` once at the end instead.
--
-- Blank lines are dropped, so a trailing newline on a chunk is harmless.

-- Checked before a line is read, because the failure is otherwise confusing: a
-- nameless stream reaches trace.filename NOT NULL and reports a column, not the
-- missing variable. Wrapped in a CTAS for the same reason capture_guard is --
-- a bare SELECT prints its header on every healthy load.
CREATE OR REPLACE TEMP TABLE filename_guard AS
SELECT error('load_lines.sql needs a filename: set variable filename=''...'';'
             || ' it is what every chunk of this trace is filed under') AS abort
WHERE getvariable('filename') IS NULL;

CREATE OR REPLACE TEMP VIEW raw AS
SELECT line::JSON AS j
FROM (SELECT unnest(string_split(getvariable('lines'), chr(10))) AS line)
WHERE trim(line) <> '';

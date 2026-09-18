-- File input for load_common.sql. Pass both, in this order:
--
--   duckdb t.db -f mlog-sql/schema.sql \
--     -c "set variable src='mlog.jsonl'; set variable trace_id=1;" \
--     -f mlog-sql/load_file.sql -f mlog-sql/load_common.sql
--
-- The caller resolves both paths, so this works from any directory. (DuckDB's
-- .read is relative to the working directory, not to the including script, so
-- one file cannot portably pull in the other.)
--
-- Expects:
--   src       path to read. Also becomes trace.filename, which identifies the
--             trace, so pass a path distinct enough to tell two captures apart --
--             loading one file twice into one database is refused.
--   cid       optional connection id, recorded on the trace row
--
-- To feed a stream of lines instead of a file, use load_lines.sql in place of
-- this file.
--
-- Lines are read as raw JSON rather than letting read_json_auto infer a schema.
-- Inference unions the header line with the event lines and every event shape
-- with every other, which is what produced the sparse 16-field `data` struct in
-- the first place.
--
-- read_csv with quoting and escaping disabled is used purely as a line splitter:
-- it hands back one row per line without interpreting the JSON's own quotes and
-- commas. That lets ltrim strip RFC 7464 record separators, so .jsonseq and
-- .jsonl load through one path -- ltrim is a no-op when there is no separator --
-- and it is no slower than read_ndjson_objects. read_ndjson_objects itself
-- rejects a separator outright, in every format mode.
--
-- delim is a character that cannot occur in valid JSON text, so each line stays
-- a single field. Raw newlines inside a line are impossible for the same reason:
-- JSON requires them escaped inside strings.

CREATE OR REPLACE TEMP VIEW raw AS
SELECT j FROM (
    SELECT try_cast(ltrim(line, chr(30)) AS JSON) AS j,
           ltrim(line, chr(30))                   AS raw_line
    FROM read_csv(getvariable('src'),
                  columns = {'line': 'VARCHAR'},
                  delim = chr(1), quote = '', escape = '', header = false)
    WHERE trim(ltrim(line, chr(30))) <> ''
)
-- try_cast yields NULL rather than aborting, so the offending line can be named.
-- error() is only reached for a line that failed to parse; it reports the text
-- itself, which locates the problem better than a byte offset.
WHERE CASE
    WHEN j IS NULL
        THEN error('Malformed JSON in file "' || getvariable('src') || '": '
                   || left(raw_line, 120))
    ELSE true
END;

-- load_common.sql prints the drift report when `lines` is unset, so clear any
-- value left over from an earlier streamed load in the same session.
SET VARIABLE lines = NULL;

-- A file names itself. Assigned rather than defaulted, so a filename left over
-- from an earlier load in the same session cannot leak into this one.
SET VARIABLE filename = getvariable('src');

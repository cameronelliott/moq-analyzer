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
--   src        what read_csv should open. A filesystem path under the CLI. In
--              duckdb-wasm there is no filesystem, so it is the name a buffer was
--              registered under -- registerFileBuffer, registerFileHandle or
--              registerFileURL -- and nothing here touches the OS either way:
--                  db.registerFileBuffer('sub1.mlog', bytes);
--                  conn.query("SET VARIABLE src = 'sub1.mlog'");
--              The name is arbitrary, but read_csv reads compression from its
--              extension, so keep .gz on a gzipped buffer.
--   trace_name optional; what to record as trace.filename instead of src. Only
--              needed when src cannot serve as the trace's identity -- feeding
--              one trace as several registered buffers, where src changes per
--              chunk and the identity must not. Consumed below, so it cannot
--              leak into the next load.
--   cid        optional connection id, recorded on the trace row
--
-- trace.filename is what identifies a trace and refuses a second copy of it, so
-- whichever of the two supplies it must be distinct enough to tell two captures
-- apart.
--
-- This is the only input path, whole file or chunked. For chunks, register each
-- under its own src with the same trace_name, feed them in time order, and put
-- the mlog header line in the first.
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

-- A file names itself unless the caller says otherwise. Both lines matter: the
-- first assigns rather than defaults, so a filename left from an earlier load
-- cannot leak in; the second spends trace_name, so an override cannot silently
-- apply to the next load either. A caller feeding several buffers into one trace
-- sets trace_name before each of them.
-- The cast is load-bearing: a bare NULL types the variable INTEGER, and the next
-- coalesce then tries to read a filename as an INT32.
SET VARIABLE filename   = coalesce(getvariable('trace_name'), getvariable('src'));
SET VARIABLE trace_name = NULL::VARCHAR;

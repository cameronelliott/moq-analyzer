-- Load one mlog, or one chunk of one, into a database schema.sql has set up.
--
--   duckdb t.db -f mlog-sql/schema.sql \
--     -c "set variable src='mlog.jsonl';" -f mlog-sql/load.sql
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
-- apart. trace_id is not an input -- the database assigns it and this script
-- resolves it from filename below.
--
-- Every statement here is safe to run repeatedly against a growing trace, so a
-- log can arrive as one file or as a stream of chunks and land identically. For
-- chunks, register each under its own src with the same trace_name, feed them in
-- time order, and put the mlog header line in the first.
--
-- ONE CONNECTION, whole file, in order. Session variables and the transaction
-- below both belong to a connection, and `trace_id` is set here and then read by
-- every statement after it. `duckdb -f` gives this for free. A caller driving
-- duckdb-wasm must not spread these statements across a pool: getvariable()
-- yields NULL for a name the connection never saw, and NULL is not an error.
-- The NOT NULLs on trace_id in schema.sql are what turn that into a failure
-- rather than a table full of rows belonging to no trace.
--
-- A caller that stops on the first exception must also ROLLBACK itself. The CLI
-- keeps going after an error, so the COMMIT at the end fails and nothing lands;
-- a browser caller that simply throws leaves the transaction open.
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

-- All or nothing: a failure partway through must not leave a half-loaded chunk.
BEGIN TRANSACTION;

CREATE OR REPLACE TEMP VIEW ev AS
SELECT
    j ->> '$.name'                        AS name,
    ((j ->> '$.time')::DOUBLE * 1000)::BIGINT AS time_us,
    j -> '$.data'                         AS d
FROM raw
WHERE j ->> '$.name' IS NOT NULL;

-- Refuse a stock-moq-rs capture before any INSERT. Stock writes stream_id 0 on
-- every subgroup header, so objects cannot be tied to a group. The primary key
-- on subgroup_stream would reject it anyway, but as "duplicate key", which reads
-- as a loader bug; naming the real cause here is the whole point.
-- Wrapped in a CTAS rather than left as a bare SELECT: a zero-row SELECT still
-- prints its column header, and that header is the whole error() expression, so
-- every healthy load announced what looked like a failure. CTAS prints nothing
-- on success and still evaluates error() when the guard matches.
CREATE OR REPLACE TEMP TABLE capture_guard AS
SELECT error('unsupported capture: every subgroup header carries the same stream_id'
             || ' (stock moq-rs writes 0 for all).'
             || ' Record with a relay build that plumbs real QUIC stream ids.') AS abort
FROM (
    SELECT count(*) AS headers, count(DISTINCT d ->> '$.stream_id') AS ids
    FROM ev
    WHERE name IN ('moqt:subgroup_header_parsed', 'moqt:subgroup_header_created')
)
WHERE headers > 1 AND ids = 1;

-- Only the chunk carrying the mlog header inserts this; the rest are no-ops.
-- Columns are named rather than positional so trace_id can take its DEFAULT.
--
-- Stock moq-rs writes no reference_time and no time_format. Its times are
-- relative all the same, so the trace gets the 2000-01-01 stand-in and
-- `relative`, and reference_time_source says `none`. recover.sql, run after the
-- last load, lines up what it can.
--
-- The three moq_stream_id_* keys are not moq-rs's. recover-stream-ids.ts adds
-- them when it puts stream ids back on a stock trace.
INSERT INTO trace (cid, filename, loaded_at, title, description, vantage_point,
                   reference_time, reference_time_source,
                   stream_id_source, stream_id_uncertain, stream_id_unresolved,
                   time_format, flush_policy, qlog_version,
                   qlog_format, event_schemas)
SELECT
    getvariable('cid'),
    getvariable('filename'),
    now(),
    j ->> '$.title',
    j ->> '$.description',
    j ->> '$.trace.vantage_point.type',
    coalesce(to_timestamp((j ->> '$.trace.common_fields.reference_time')::DOUBLE / 1000),
             TIMESTAMPTZ '2000-01-01 00:00:00+00'),
    CASE WHEN j ->> '$.trace.common_fields.reference_time' IS NULL
         THEN 'none' ELSE 'logged' END,
    coalesce(j ->> '$.trace.moq_stream_id_source', 'logged'),
    (j ->> '$.trace.moq_stream_id_uncertain')::INTEGER,
    (j ->> '$.trace.moq_stream_id_unresolved')::INTEGER,
    coalesce(j ->> '$.trace.common_fields.time_format',
             CASE WHEN j ->> '$.trace.common_fields.reference_time' IS NULL
                  THEN 'relative' END),
    j ->> '$.trace.moq_rs_flush_policy',
    j ->> '$.qlog_version',
    j ->> '$.qlog_format',
    list_transform((j -> '$.trace.event_schemas')::JSON[], lambda x: x ->> '$')
FROM raw
WHERE j ->> '$.qlog_version' IS NOT NULL;

-- Resolve the surrogate for every statement below. A later chunk finds the row
-- its header chunk inserted, so a streamed load keys on what a file load keys on.
-- Erroring beats the old behaviour for a chunk fed ahead of its header: that
-- wrote child rows under a trace_id with no parent, and said nothing.
SET VARIABLE trace_id = (
    SELECT coalesce(
        (SELECT trace_id FROM trace WHERE filename = getvariable('filename')),
        error('no trace row for "' || getvariable('filename') || '": feed the '
              || 'chunk holding the mlog header first')::USMALLINT
    )
);

-- One stream_id must not appear in both directions -- see the key note in
-- schema.sql. That key would reject it anyway, but as "duplicate key", which
-- reads as a loader bug; naming the cause is the point, as for the guard above.
-- Checks this chunk against itself and against what the trace already holds.
CREATE OR REPLACE TEMP TABLE direction_guard AS
SELECT error('unsupported capture: stream_id ' || sid || ' carries both a sent and'
             || ' a received subgroup header, so the stream cannot be attributed'
             || ' to one end. Expected disjoint QUIC stream id spaces.') AS abort
FROM (
    SELECT sid FROM (
        SELECT (d ->> '$.stream_id')::UINTEGER AS sid,
               CASE WHEN name = 'moqt:subgroup_header_created'
                    THEN 'created' ELSE 'parsed' END AS dir
        FROM ev
        WHERE name IN ('moqt:subgroup_header_created', 'moqt:subgroup_header_parsed')
        UNION ALL
        SELECT stream_id, direction::VARCHAR
        FROM subgroup_stream
        WHERE trace_id = getvariable('trace_id')::USMALLINT
    )
    GROUP BY sid
    HAVING count(DISTINCT dir) > 1
);

INSERT INTO control_message
SELECT
    getvariable('trace_id')::USMALLINT,
    time_us,
    CASE WHEN name = 'moqt:control_message_created' THEN 'created' ELSE 'parsed' END,
    d ->> '$.message_type',
    (d ->> '$.stream_id')::UINTEGER,
    (d ->> '$.subscribe_id')::UINTEGER,
    (d ->> '$.request_id')::UINTEGER,
    d ->> '$.request_kind',
    (d ->> '$.track_alias')::UINTEGER,
    d ->> '$.track_namespace',
    d ->> '$.track_name',
    -- errors loudly on a repeated parameter key rather than dropping one
    map_from_entries(list_transform(
        COALESCE((d -> '$.parameters')::JSON[], []),
        lambda p: struct_pack(key := p ->> '$[0]', value := p ->> '$[1]')
    )),
    d -> '$.track_extensions'
FROM ev
WHERE name IN ('moqt:control_message_created', 'moqt:control_message_parsed');

-- Both directions. A relay's own send side is half of every latency leg, so
-- keeping only what arrived left the sent timestamps unreachable in event_other.
INSERT INTO subgroup_stream
SELECT
    getvariable('trace_id')::USMALLINT,
    (d ->> '$.stream_id')::UINTEGER,
    CASE WHEN name = 'moqt:subgroup_header_created' THEN 'created' ELSE 'parsed' END,
    time_us,
    d ->> '$.header_type',
    (d ->> '$.track_alias')::UINTEGER,
    (d ->> '$.group_id')::UINTEGER,
    (d ->> '$.subgroup_id')::UINTEGER,
    (d ->> '$.publisher_priority')::UTINYINT
FROM ev
WHERE name IN ('moqt:subgroup_header_created', 'moqt:subgroup_header_parsed')
ORDER BY time_us;

-- Sorted on insert so DuckDB's zone maps can prune time ranges. Chunks arrive in
-- time order, so appending keeps the table sorted overall.
INSERT INTO subgroup_object
SELECT
    getvariable('trace_id')::USMALLINT,
    (d ->> '$.stream_id')::UINTEGER,
    (d ->> '$.object_id')::UINTEGER,
    time_us,
    (d ->> '$.object_payload_length')::UINTEGER,
    json_array_length(d -> '$.extension_headers')::USMALLINT
FROM ev
WHERE name IN ('moqt:subgroup_object_created', 'moqt:subgroup_object_parsed')
ORDER BY time_us;

INSERT INTO event_other
SELECT getvariable('trace_id')::USMALLINT, time_us, name, d
FROM ev
WHERE name NOT IN (
    'moqt:control_message_created',  'moqt:control_message_parsed',
    'moqt:subgroup_header_created',  'moqt:subgroup_header_parsed',
    'moqt:subgroup_object_created',  'moqt:subgroup_object_parsed'
);

-- track_alias is announced in subscribe_ok; the namespace and name come from the
-- matching subscribe. Re-derived from the whole trace on every chunk rather than
-- appended: a subscribe and its subscribe_ok can straddle a chunk boundary, and
-- an append would collide on (trace_id, track_alias). The table is three rows.
DELETE FROM track WHERE trace_id = getvariable('trace_id')::USMALLINT;

INSERT INTO track
SELECT
    getvariable('trace_id')::USMALLINT,
    ok.track_alias,
    ok.subscribe_id,
    s.track_namespace,
    s.track_name
FROM (
    SELECT DISTINCT ON (track_alias) track_alias, subscribe_id
    FROM control_message
    WHERE trace_id = getvariable('trace_id')::USMALLINT
      AND message_type = 'subscribe_ok' AND track_alias IS NOT NULL
    ORDER BY track_alias, time_us
) ok
LEFT JOIN (
    SELECT DISTINCT ON (subscribe_id) subscribe_id, track_namespace, track_name
    FROM control_message
    WHERE trace_id = getvariable('trace_id')::USMALLINT
      AND message_type = 'subscribe'
    ORDER BY subscribe_id, time_us
) s USING (subscribe_id);

-- Shape census. json_structure is a recursive type fingerprint, so this one
-- GROUP BY catches added keys, removed keys and changed types in every event.
-- Upserted, so a shape split across chunks accumulates into one row.
INSERT INTO shape (trace_id, name, fingerprint, n, first_time_us, unconsumed)
WITH per_line AS (
    SELECT
        name,
        time_us,
        json_structure(d)::VARCHAR AS fingerprint,
        list_filter(json_keys(d), lambda k: NOT list_contains(
            CASE
                WHEN name IN ('moqt:control_message_created',
                              'moqt:control_message_parsed')
                    THEN ['event_type', 'stream_id', 'message_type', 'subscribe_id',
                          'request_id', 'request_kind',
                          'track_namespace', 'track_name', 'track_alias',
                          'parameters', 'track_extensions']
                WHEN name IN ('moqt:subgroup_header_created',
                              'moqt:subgroup_header_parsed')
                    THEN ['event_type', 'stream_id', 'header_type', 'track_alias',
                          'group_id', 'subgroup_id', 'publisher_priority']
                WHEN name IN ('moqt:subgroup_object_created',
                              'moqt:subgroup_object_parsed')
                    THEN ['event_type', 'stream_id', 'group_id', 'subgroup_id',
                          'object_id', 'extension_headers', 'object_payload_length']
                ELSE json_keys(d)   -- unknown event: event_other keeps it whole
            END, k)) AS unconsumed
    FROM ev
)
SELECT
    getvariable('trace_id')::USMALLINT,
    name,
    fingerprint,
    count(*),
    min(time_us),
    any_value(unconsumed)
FROM per_line
GROUP BY 1, 2, 3
ON CONFLICT (trace_id, name, fingerprint) DO UPDATE SET
    n             = shape.n + excluded.n,
    first_time_us = least(shape.first_time_us, excluded.first_time_us);

COMMIT;

-- Drift report. No rows means every shape in the log matched the baseline and
-- every key was read. Any row is advisory: the ingest above has already
-- committed, so this never blocks a load -- it is there for an operator to read
-- and judge. A chunked load prints it once per chunk; query shape_drift once at
-- the end instead.
SELECT name, warning, lines, first_time_us, fingerprint
FROM shape_drift
WHERE trace_id = getvariable('trace_id')::USMALLINT;

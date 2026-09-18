-- Shared ingest body. Not run alone: it reads a `raw` view that an input file
-- defines first, so pass one of those ahead of it in the same invocation --
-- load_file.sql for a file, load_lines.sql for a string of lines.
--
--   duckdb t.db -f mlog-sql/schema.sql -c "<variables>" \
--     -f mlog-sql/load_file.sql -f mlog-sql/load_common.sql
--
-- Every statement here is safe to run repeatedly against a growing trace, so a
-- log can arrive as one file or as a stream of chunks and land identically.
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
-- Expects:
--   filename  what this trace is filed under, and its identity. The input file
--             sets it: load_file.sql from the path it read, load_lines.sql from
--             the caller. trace_id is not an input -- the database assigns it and
--             this script resolves it from filename below.
--   cid       optional connection id, recorded on the trace row

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
INSERT INTO trace (cid, filename, loaded_at, title, description, vantage_point,
                   reference_time, time_format, flush_policy, qlog_version,
                   qlog_format, event_schemas)
SELECT
    getvariable('cid'),
    getvariable('filename'),
    now(),
    j ->> '$.title',
    j ->> '$.description',
    j ->> '$.trace.vantage_point.type',
    to_timestamp((j ->> '$.trace.common_fields.reference_time')::DOUBLE / 1000),
    j ->> '$.trace.common_fields.time_format',
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
-- and judge.
--
-- Suppressed for streamed chunks, which would otherwise print it once per chunk;
-- those callers query shape_drift once at the end instead.
SELECT name, warning, lines, first_time_us, fingerprint
FROM shape_drift
WHERE trace_id = getvariable('trace_id')::USMALLINT
  AND getvariable('lines') IS NULL;

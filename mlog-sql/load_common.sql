-- Shared ingest body. Not run alone: it reads a `raw` view that an input file
-- defines first, so pass one of those ahead of it in the same invocation --
-- load_file.sql for a file, load_lines.sql for a string of lines.
--
--   duckdb t.db -f mlog-sql/schema.sql -c "<variables>" \
--     -f mlog-sql/load_file.sql -f mlog-sql/load_common.sql
--
-- Every statement here is safe to run repeatedly against a growing trace, so a
-- log can arrive as one file or as a stream of chunks and land identically.
-- Expects:
--   trace_id  id to assign this trace. Required -- trace.trace_id is the primary
--             key, so an unset trace_id fails the load rather than writing an
--             anonymous trace.
--   cid       optional connection id, recorded on the trace row
--   src_name  optional; path to record in trace.source_file

-- All or nothing: a failure partway through must not leave a half-loaded chunk.
BEGIN TRANSACTION;

CREATE OR REPLACE TEMP VIEW ev AS
SELECT
    j ->> '$.name'                        AS name,
    ((j ->> '$.time')::DOUBLE * 1000)::BIGINT AS time_us,
    j -> '$.data'                         AS d
FROM raw
WHERE j ->> '$.name' IS NOT NULL;

-- Only the chunk carrying the mlog header inserts this; the rest are no-ops.
INSERT INTO trace
SELECT
    getvariable('trace_id')::USMALLINT,
    getvariable('cid'),
    coalesce(getvariable('src_name'), getvariable('src')),
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

INSERT INTO control_message
SELECT
    getvariable('trace_id')::USMALLINT,
    time_us,
    CASE WHEN name = 'moqt:control_message_created' THEN 'created' ELSE 'parsed' END,
    d ->> '$.message_type',
    (d ->> '$.stream_id')::UINTEGER,
    (d ->> '$.subscribe_id')::UINTEGER,
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

INSERT INTO subgroup_stream
SELECT
    getvariable('trace_id')::USMALLINT,
    (d ->> '$.stream_id')::UINTEGER,
    time_us,
    d ->> '$.header_type',
    (d ->> '$.track_alias')::UINTEGER,
    (d ->> '$.group_id')::UINTEGER,
    (d ->> '$.subgroup_id')::UINTEGER,
    (d ->> '$.publisher_priority')::UTINYINT
FROM ev
WHERE name = 'moqt:subgroup_header_parsed'
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
WHERE name = 'moqt:subgroup_object_parsed'
ORDER BY time_us;

INSERT INTO event_other
SELECT getvariable('trace_id')::USMALLINT, time_us, name, d
FROM ev
WHERE name NOT IN (
    'moqt:control_message_created', 'moqt:control_message_parsed',
    'moqt:subgroup_header_parsed',   'moqt:subgroup_object_parsed'
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
                          'track_namespace', 'track_name', 'track_alias',
                          'parameters', 'track_extensions']
                WHEN name = 'moqt:subgroup_header_parsed'
                    THEN ['event_type', 'stream_id', 'header_type', 'track_alias',
                          'group_id', 'subgroup_id', 'publisher_priority']
                WHEN name = 'moqt:subgroup_object_parsed'
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

-- Drift report: empty means every key in the log is accounted for. Suppressed
-- for streamed chunks, which would otherwise print it once per chunk; those
-- callers query `shape` once at the end instead.
SELECT name, unconsumed, n AS lines, first_time_us
FROM shape
WHERE trace_id = getvariable('trace_id')::USMALLINT
  AND len(unconsumed) > 0
  AND getvariable('lines') IS NULL;

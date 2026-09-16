-- moq-rs mlog -> DuckDB. Idempotent; safe to re-run.
--
-- Types are VARCHAR rather than ENUM for message_type/header_type/direction:
-- moq-rs is a moving target, and a new message type should land in the table,
-- not abort the load. DuckDB dictionary-compresses these anyway.

-- qlog_version and qlog_format keep their names because that is literally what
-- the mlog header carries: the header shape was inherited from qlog, and nothing
-- else about these files is qlog.
CREATE TABLE IF NOT EXISTS trace (
    trace_id       USMALLINT PRIMARY KEY,
    cid            VARCHAR,       -- optional connection id, supplied at load time
    source_file    VARCHAR,
    loaded_at      TIMESTAMPTZ,
    title          VARCHAR,
    description    VARCHAR,
    vantage_point  VARCHAR,
    reference_time TIMESTAMPTZ,
    time_format    VARCHAR,
    flush_policy   VARCHAR,
    qlog_version   VARCHAR,
    qlog_format    VARCHAR,
    event_schemas  VARCHAR[]
);

-- subscribe joined to subscribe_ok, so objects can reach a track name in one hop.
CREATE TABLE IF NOT EXISTS track (
    trace_id        USMALLINT,
    track_alias     UINTEGER,
    subscribe_id    UINTEGER,
    track_namespace VARCHAR,
    track_name      VARCHAR,
    PRIMARY KEY (trace_id, track_alias)
);

CREATE TABLE IF NOT EXISTS control_message (
    trace_id        USMALLINT,
    time_us         BIGINT,
    direction       VARCHAR,   -- created (sent) | parsed (received)
    message_type    VARCHAR,
    stream_id       UINTEGER,
    subscribe_id    UINTEGER,
    track_alias     UINTEGER,
    track_namespace VARCHAR,
    track_name      VARCHAR,
    parameters      MAP(VARCHAR, VARCHAR),
    track_extensions JSON
);

-- One row per subgroup stream. group_id/subgroup_id/track_alias live here only;
-- subgroup_object reaches them through stream_id.
CREATE TABLE IF NOT EXISTS subgroup_stream (
    trace_id           USMALLINT,
    stream_id          UINTEGER,
    time_us            BIGINT,
    header_type        VARCHAR,
    track_alias        UINTEGER,
    group_id           UINTEGER,
    subgroup_id        UINTEGER,
    publisher_priority UTINYINT,
    PRIMARY KEY (trace_id, stream_id)
);

CREATE TABLE IF NOT EXISTS subgroup_object (
    trace_id        USMALLINT,
    stream_id       UINTEGER,
    object_id       UINTEGER,
    time_us         BIGINT,
    payload_length  UINTEGER,
    extension_count USMALLINT
);

-- Anything the loader does not recognise, kept verbatim rather than dropped.
CREATE TABLE IF NOT EXISTS event_other (
    trace_id USMALLINT,
    time_us  BIGINT,
    name     VARCHAR,
    data     JSON
);

-- One row per (event name, recursive type fingerprint). json_structure walks
-- the whole `data` object, so a new field, a dropped field, or a field that
-- changes type each produce a new row -- which is the drift signal. The census
-- is tiny: 62k event lines collapse to four rows.
--
-- `unconsumed` lists keys present in the log that no INSERT in load_file.sql reads.
-- Keys the loader knowingly drops as redundant (group_id/subgroup_id on
-- objects, which subgroup_stream already carries) count as consumed -- they are
-- accounted for, not unseen.
-- fingerprint is VARCHAR, not JSON, so it can carry the primary key that makes
-- the census upsertable -- a shape split across chunks accumulates into one row
-- instead of one row per chunk. Cast it back with fingerprint::JSON to query it.
CREATE TABLE IF NOT EXISTS shape (
    trace_id      USMALLINT,
    name          VARCHAR,
    fingerprint   VARCHAR,
    n             BIGINT,
    first_time_us BIGINT,
    unconsumed    VARCHAR[],
    PRIMARY KEY (trace_id, name, fingerprint)
);

-- OR REPLACE, not IF NOT EXISTS: re-running this file should update a view
-- definition, not silently keep the old one.

-- The workhorse. Puts back what normalisation took out, at no storage cost:
-- group/subgroup from the stream header, track name from the subscribe, and
-- wall-clock time from the trace. LEFT joins so a log that missed its
-- subscribe_ok still shows its objects, with a null track_name.
CREATE OR REPLACE VIEW object AS
SELECT
    o.trace_id,
    o.time_us,
    CASE WHEN tr.time_format = 'relative'
         THEN tr.reference_time + to_microseconds(o.time_us) END AS wall_time,
    t.track_namespace,
    t.track_name,
    s.group_id,
    s.subgroup_id,
    s.publisher_priority,
    o.object_id,
    o.payload_length,
    o.extension_count,
    o.stream_id,
    s.track_alias
FROM subgroup_object o
JOIN      subgroup_stream s USING (trace_id, stream_id)
LEFT JOIN track           t USING (trace_id, track_alias)
LEFT JOIN trace          tr USING (trace_id);

-- Every event in one shape, the way my_table looked, but with real columns
-- instead of a sparse struct. For reading a trace in order -- add
-- ORDER BY time_us -- rather than for aggregation; prefer `object` for that.
CREATE OR REPLACE VIEW event AS
SELECT trace_id, time_us, wall_time, name, stream_id, track_name,
       group_id, subgroup_id, object_id, payload_length,
       message_type, subscribe_id
FROM (
    SELECT c.trace_id, c.time_us,
           CASE WHEN tr.time_format = 'relative'
                THEN tr.reference_time + to_microseconds(c.time_us) END AS wall_time,
           'control_message_' || c.direction        AS name,
           c.stream_id,
           coalesce(c.track_name, t.track_name)     AS track_name,
           NULL::UINTEGER AS group_id, NULL::UINTEGER AS subgroup_id,
           NULL::UINTEGER AS object_id, NULL::UINTEGER AS payload_length,
           c.message_type, c.subscribe_id
    FROM control_message c
    LEFT JOIN track      t ON t.trace_id = c.trace_id AND t.track_alias = c.track_alias
    LEFT JOIN trace     tr ON tr.trace_id = c.trace_id

    UNION ALL
    SELECT s.trace_id, s.time_us,
           CASE WHEN tr.time_format = 'relative'
                THEN tr.reference_time + to_microseconds(s.time_us) END,
           'subgroup_header_parsed', s.stream_id, t.track_name,
           s.group_id, s.subgroup_id, NULL, NULL, NULL, NULL
    FROM subgroup_stream s
    LEFT JOIN track      t USING (trace_id, track_alias)
    LEFT JOIN trace     tr USING (trace_id)

    UNION ALL
    SELECT trace_id, time_us, wall_time,
           'subgroup_object_parsed', stream_id, track_name,
           group_id, subgroup_id, object_id, payload_length, NULL, NULL
    FROM object

    UNION ALL
    SELECT e.trace_id, e.time_us,
           CASE WHEN tr.time_format = 'relative'
                THEN tr.reference_time + to_microseconds(e.time_us) END,
           e.name, (e.data ->> '$.stream_id')::UINTEGER, NULL,
           NULL, NULL, NULL, NULL, NULL, NULL
    FROM event_other e
    LEFT JOIN trace tr USING (trace_id)
);

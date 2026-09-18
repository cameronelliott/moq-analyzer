-- moq-rs mlog -> DuckDB. Idempotent; safe to re-run: tables are IF NOT EXISTS,
-- views are OR REPLACE so a re-run updates a stale definition rather than
-- silently keeping it, and shape_baseline is rewritten from this file each time.
--
-- Types are VARCHAR rather than ENUM for message_type and header_type: moq-rs is
-- a moving target, and a new message type should land in the table, not abort the
-- load. DuckDB dictionary-compresses these anyway.
--
-- direction is the exception, and an ENUM. moq-rs never writes it: the loader
-- synthesises it from which of a `_created`/`_parsed` event pair the line carried,
-- and routes on an explicit list of names, so an unfamiliar suffix lands in
-- event_other rather than becoming a third direction. Nothing moq-rs does can
-- drift this column -- only a loader bug can, which is what the type catches.
CREATE TYPE IF NOT EXISTS direction AS ENUM ('created', 'parsed');

-- qlog_version and qlog_format keep their names because that is literally what
-- the mlog header carries: the header shape was inherited from qlog, and nothing
-- else about these files is qlog.
CREATE SEQUENCE IF NOT EXISTS trace_id_seq START 1;

CREATE TABLE IF NOT EXISTS trace (
    -- Surrogate, assigned here rather than by the caller, and narrow because every
    -- child table carries it on every row. Load order decides it, so it is stable
    -- only within one database: anything outside must reference filename, not this.
    trace_id       USMALLINT PRIMARY KEY DEFAULT nextval('trace_id_seq'),
    cid            VARCHAR,       -- optional connection id, supplied at load time
    -- What identifies an mlog source, and the duplicate guard: loading one file
    -- twice fails here rather than silently doubling every row. It catches a
    -- repeated file, not a repeated chunk -- chunks are not individually
    -- identified -- so test-duplicated-mlog.sql still has work to do.
    filename       VARCHAR NOT NULL UNIQUE,
    loaded_at      TIMESTAMPTZ,
    title          VARCHAR,
    description    VARCHAR,
    vantage_point  VARCHAR,
    -- NOT NULL is the input contract: without it every wall_time is NULL and a
    -- chart draws nothing, or worse, draws relative times as if they were wall.
    reference_time TIMESTAMPTZ NOT NULL,
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

-- subscribe_id and request_id are both request identifiers, kept apart on
-- purpose. They are not one field under two names: in the six-POP captures
-- subscribe/subscribe_ok/unsubscribe carry subscribe_id while
-- publish_namespace/request_ok carry request_id, so one log holds both
-- vocabularies. Merging them would name half the rows wrongly and erase the
-- evidence that moq-rs is mid-transition -- which is what shape drift is for.
CREATE TABLE IF NOT EXISTS control_message (
    trace_id        USMALLINT,
    time_us         BIGINT,
    direction       direction, -- this endpoint built it | decoded one it received
    message_type    VARCHAR,
    stream_id       UINTEGER,
    subscribe_id    UINTEGER,
    request_id      UINTEGER,
    request_kind    VARCHAR,
    track_alias     UINTEGER,
    track_namespace VARCHAR,
    track_name      VARCHAR,
    parameters      MAP(VARCHAR, VARCHAR),
    track_extensions JSON
);

-- One row per subgroup stream. group_id/subgroup_id/track_alias live here only;
-- subgroup_object reaches them through stream_id.
--
-- direction lives here, not on the object: a subgroup stream is a QUIC
-- unidirectional stream, so every object riding it inherits the stream's
-- direction. The two directions get disjoint id spaces (client-initiated streams
-- are 2 mod 4, server-initiated 3 mod 4) -- across 8,298 streams in the six-POP
-- captures, no id appeared in both.
--
-- The key does not assume that, it enforces it: a capture reusing one id both
-- ways fails at load rather than matching each object to two stream rows and
-- doubling the `object` view. load_common.sql names the cause first.
CREATE TABLE IF NOT EXISTS subgroup_stream (
    trace_id           USMALLINT,
    stream_id          UINTEGER,
    direction          direction,
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

-- What moq-rs is expected to emit, as opposed to `shape`, which records what a
-- trace actually contained. A shape observed during a load and not listed here
-- is drift.
--
-- This catches what `unconsumed` cannot. A field that merely changes type --
-- stream_id going from a number to a string -- leaves the key set identical, so
-- nothing is unconsumed and the loader would otherwise say nothing at all.
--
-- Rewritten from this file on every run, so the checked-in list is the only
-- source of truth and a removed entry really disappears. To bless a new shape,
-- paste the fingerprint that shape_drift reports into the list below; the git
-- history of these rows is then the record of when moq-rs changed what it emits.
CREATE TABLE IF NOT EXISTS shape_baseline (
    name        VARCHAR,
    fingerprint VARCHAR,
    PRIMARY KEY (name, fingerprint)
);

DELETE FROM shape_baseline;

INSERT INTO shape_baseline (name, fingerprint) VALUES
    -- A control message's fingerprint is its exact key set, so every message type
    -- has its own -- subscribe carries namespace and name, subscribe_ok carries
    -- track_alias, unsubscribe carries neither, setup carries only parameters.
    -- The first two lines below were all a single-trace baseline could know;
    -- the rest came from a capture holding a whole session.
    ('moqt:control_message_created', '{"event_type":"VARCHAR","stream_id":"UBIGINT","message_type":"VARCHAR","subscribe_id":"UBIGINT","track_namespace":"VARCHAR","track_name":"VARCHAR","parameters":["NULL"]}'),
    ('moqt:control_message_parsed',  '{"event_type":"VARCHAR","stream_id":"UBIGINT","message_type":"VARCHAR","subscribe_id":"UBIGINT","track_alias":"UBIGINT","parameters":[["VARCHAR"]],"track_extensions":["NULL"]}'),
    -- client_setup / server_setup
    ('moqt:control_message_created', '{"event_type":"VARCHAR","stream_id":"UBIGINT","message_type":"VARCHAR","parameters":[["VARCHAR"]]}'),
    ('moqt:control_message_parsed',  '{"event_type":"VARCHAR","stream_id":"UBIGINT","message_type":"VARCHAR","parameters":[["VARCHAR"]]}'),
    -- request_ok and publish_namespace: the newer request_id vocabulary, which
    -- this build emits alongside the older subscribe_id one
    ('moqt:control_message_created', '{"event_type":"VARCHAR","stream_id":"UBIGINT","message_type":"VARCHAR","request_id":"UBIGINT","request_kind":"VARCHAR","parameters":["NULL"]}'),
    ('moqt:control_message_parsed',  '{"event_type":"VARCHAR","stream_id":"UBIGINT","message_type":"VARCHAR","request_id":"UBIGINT","request_kind":"VARCHAR","parameters":["NULL"]}'),
    ('moqt:control_message_created', '{"event_type":"VARCHAR","stream_id":"UBIGINT","message_type":"VARCHAR","request_id":"UBIGINT","track_namespace":"VARCHAR","parameters":["NULL"]}'),
    ('moqt:control_message_parsed',  '{"event_type":"VARCHAR","stream_id":"UBIGINT","message_type":"VARCHAR","request_id":"UBIGINT","track_namespace":"VARCHAR","parameters":["NULL"]}'),
    -- subscribe_ok, with and without parameters
    ('moqt:control_message_created', '{"event_type":"VARCHAR","stream_id":"UBIGINT","message_type":"VARCHAR","subscribe_id":"UBIGINT","track_alias":"UBIGINT","parameters":["NULL"],"track_extensions":["NULL"]}'),
    ('moqt:control_message_parsed',  '{"event_type":"VARCHAR","stream_id":"UBIGINT","message_type":"VARCHAR","subscribe_id":"UBIGINT","track_alias":"UBIGINT","parameters":["NULL"],"track_extensions":["NULL"]}'),
    ('moqt:control_message_created', '{"event_type":"VARCHAR","stream_id":"UBIGINT","message_type":"VARCHAR","subscribe_id":"UBIGINT","track_alias":"UBIGINT","parameters":[["VARCHAR"]],"track_extensions":["NULL"]}'),
    -- subscribe, seen from the receiving end
    ('moqt:control_message_parsed',  '{"event_type":"VARCHAR","stream_id":"UBIGINT","message_type":"VARCHAR","subscribe_id":"UBIGINT","track_namespace":"VARCHAR","track_name":"VARCHAR","parameters":["NULL"]}'),
    -- unsubscribe
    ('moqt:control_message_created', '{"event_type":"VARCHAR","stream_id":"UBIGINT","message_type":"VARCHAR","subscribe_id":"UBIGINT"}'),
    ('moqt:subgroup_header_parsed',  '{"event_type":"VARCHAR","stream_id":"UBIGINT","header_type":"VARCHAR","track_alias":"UBIGINT","group_id":"UBIGINT","publisher_priority":"UBIGINT","subgroup_id":"UBIGINT"}'),
    ('moqt:subgroup_object_parsed',  '{"event_type":"VARCHAR","stream_id":"UBIGINT","group_id":"UBIGINT","subgroup_id":"UBIGINT","object_id":"UBIGINT","extension_headers":["NULL"],"object_payload_length":"UBIGINT"}'),
    -- The send side carries a fingerprint byte-identical to its parsed twin, which
    -- is why ingesting it took a column rather than a parser.
    ('moqt:subgroup_header_created', '{"event_type":"VARCHAR","stream_id":"UBIGINT","header_type":"VARCHAR","track_alias":"UBIGINT","group_id":"UBIGINT","publisher_priority":"UBIGINT","subgroup_id":"UBIGINT"}'),
    ('moqt:subgroup_object_created', '{"event_type":"VARCHAR","stream_id":"UBIGINT","group_id":"UBIGINT","subgroup_id":"UBIGINT","object_id":"UBIGINT","extension_headers":["NULL"],"object_payload_length":"UBIGINT"}');

-- Advisory only. Every row is a warning, never a failure: the load that produced
-- it has already committed, and nothing downstream consults this. An operator
-- reads it, decides whether it matters, and either carries on or reports it.
--
-- Two independent signals, because neither catches the other:
--   * a key the loader does not read, which lands nowhere and is lost
--   * a shape missing from shape_baseline, which catches a field that merely
--     changed type -- the key set is unchanged there, so unconsumed is empty
--
-- load_common.sql selects this at the end of a file load. It is also worth
-- querying directly against an existing database, across every trace at once.
CREATE OR REPLACE VIEW shape_drift AS
SELECT
    s.trace_id,
    s.name,
    CASE
        WHEN b.fingerprint IS NULL AND len(s.unconsumed) > 0
            THEN 'shape not in baseline, and these keys are not read: '
                 || array_to_string(s.unconsumed, ', ')
        WHEN b.fingerprint IS NULL
            THEN 'shape not in baseline'
        ELSE 'keys present but not read: ' || array_to_string(s.unconsumed, ', ')
    END           AS warning,
    s.n           AS lines,
    s.first_time_us,
    s.fingerprint  -- paste into shape_baseline above to bless it
FROM shape s
LEFT JOIN shape_baseline b USING (name, fingerprint)
WHERE b.fingerprint IS NULL OR len(s.unconsumed) > 0;

-- The workhorse. Puts back what normalisation took out, at no storage cost:
-- group/subgroup from the stream header, track name from the subscribe,
-- direction from the stream, and wall-clock time from the trace. LEFT joins so a
-- log that missed its subscribe_ok still shows its objects, with a null
-- track_name.
--
-- direction is what makes a latency leg expressible: one object appears twice,
-- `created` in the sender's log and `parsed` in the receiver's, and the gap
-- between those wall_times is the leg. Join on (track_namespace, track_name,
-- group_id, subgroup_id, object_id) -- track_alias does not survive the hop.
CREATE OR REPLACE VIEW object AS
SELECT
    o.trace_id,
    o.time_us,
    s.direction,
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

-- One object crossing one connection: built at one end, decoded at the other.
-- That is a network leg -- publisher to relay, or relay to subscriber. Relay
-- dwell is not a hop: it spans two connections at one host, so it needs to know
-- which host is the relay, and it is built from a pair of these.
--
-- Written once, here, because getting it wrong is invisible. A hand-rolled
-- version that drops the cid scoping still returns plausible medians while the
-- means and every `n` go wrong -- measured on two capture directories loaded
-- into one database, leg medians held to two decimals while relay dwell's mean
-- was out by 7x. Hence one database per capture, and hence this view.
--
-- Requires cid: it is the only thing tying two traces to one connection. A trace
-- loaded without one produces no hops. Objects whose track never resolved join
-- on NULL and drop out, since two ends cannot be matched without a track name --
-- track_alias is per-connection and differs across the hop.
--
-- us is signed on purpose. Negative means the receiver's clock read earlier than
-- the sender's, i.e. clock error exceeded the real transit -- a finding, not a
-- row to hide. The six-POP captures give 300,996 hops, none negative.
CREATE OR REPLACE VIEW hop AS
SELECT
    ts.cid,
    s.track_namespace,
    s.track_name,
    s.group_id,
    s.subgroup_id,
    s.object_id,
    s.trace_id   AS send_trace,
    r.trace_id   AS recv_trace,
    s.wall_time  AS t_send,
    r.wall_time  AS t_recv,
    datediff('microsecond', s.wall_time, r.wall_time) AS us,
    s.payload_length
FROM object s
JOIN trace ts ON ts.trace_id = s.trace_id
JOIN trace tr ON tr.cid = ts.cid AND tr.trace_id <> ts.trace_id
JOIN object r ON r.trace_id = tr.trace_id
             AND r.direction = 'parsed'
             AND (r.track_namespace, r.track_name,
                  r.group_id, r.subgroup_id, r.object_id)
               = (s.track_namespace, s.track_name,
                  s.group_id, s.subgroup_id, s.object_id)
WHERE s.direction = 'created';

-- Relay dwell: the gap between the relay parsing an object on the way in and
-- creating it again on the way out, once per outbound connection. Not a hop --
-- it spans two connections at one host, so it is built from a pair of them.
--
-- Assumes one relay, sitting at the server end of every connection. That is the
-- v1 capture exactly: one publisher, one relay, four subscribers. A chained
-- relay would break it -- relay A is a client to relay B, so A's outbound trace
-- reads as a publisher -- because nothing in an mlog says two traces are the
-- same host. That is the capture that turns role from assumption into data.
--
-- On the six-POP captures the median is a sliver, 0.26-0.43 ms, and the mean is
-- 1.4x to 15x that. Means sum to end-to-end and medians do not, so a per-leg
-- composition bar has to be built from means.
CREATE OR REPLACE VIEW dwell AS
SELECT
    hin.cid  AS in_cid,
    hout.cid AS out_cid,
    hin.track_namespace,
    hin.track_name,
    hin.group_id,
    hin.subgroup_id,
    hin.object_id,
    hin.recv_trace AS relay_in_trace,
    hout.send_trace AS relay_out_trace,
    hin.t_recv  AS t_in,
    hout.t_send AS t_out,
    datediff('microsecond', hin.t_recv, hout.t_send) AS us
FROM hop hin
JOIN trace sin  ON sin.trace_id  = hin.send_trace  AND sin.vantage_point  = 'client'
JOIN hop hout   ON (hout.track_namespace, hout.track_name,
                    hout.group_id, hout.subgroup_id, hout.object_id)
                 = (hin.track_namespace, hin.track_name,
                    hin.group_id, hin.subgroup_id, hin.object_id)
JOIN trace sout ON sout.trace_id = hout.send_trace AND sout.vantage_point = 'server';

-- What a chart is allowed to claim, per connection. Everything here is counted
-- from the mlogs; nothing is inferred.
--
-- The distinction that matters is `lost` against `outside_window`. Both are
-- objects that did not join, and reporting their sum as loss is wrong. On the
-- six-POP captures the relay has ~750 unjoined sends per subscriber, which looks
-- like 1% loss and is not: every one falls after the last object that did join,
-- because each subscriber's capture stopped about ten seconds before the
-- relay's. Zero were interleaved. So an object only counts as lost if it was
-- sent while both ends were demonstrably still recording -- between the first
-- and last join on that connection. Outside that, the silence is the capture's,
-- not the network's.
--
-- negative_hops is the only thing here that speaks to clocks, and it is one-way:
-- nonzero proves the two clocks disagree by more than the transit between them,
-- zero proves nothing. No mlog records clock quality, so a trust line must say
-- so rather than implying a one-way leg has been verified. These captures were
-- built to hold reference_time error under 10 us; that is a property of how they
-- were made, recorded alongside them, and not something the data can show.
CREATE OR REPLACE VIEW trust AS
WITH win AS (
    SELECT cid,
           min(t_send) AS first_send, max(t_send) AS last_send,
           min(t_recv) AS first_recv, max(t_recv) AS last_recv,
           count(*)                        AS joined,
           count(*) FILTER (WHERE us < 0)  AS negative_hops
    FROM hop GROUP BY cid
),
obj AS (
    SELECT t.cid, t.vantage_point, o.direction, o.wall_time,
           o.track_namespace, o.track_name, o.group_id, o.subgroup_id, o.object_id
    FROM object o JOIN trace t USING (trace_id)
),
unjoined AS (
    SELECT o.cid, o.direction, o.wall_time
    FROM obj o
    WHERE NOT EXISTS (
        SELECT 1 FROM hop h
        WHERE h.cid = o.cid
          AND (h.track_namespace, h.track_name,
               h.group_id, h.subgroup_id, h.object_id)
            = (o.track_namespace, o.track_name,
               o.group_id, o.subgroup_id, o.object_id))
)
SELECT
    o.cid,
    any_value(o.vantage_point) FILTER (WHERE o.direction = 'created') AS sender_is,
    count(*) FILTER (WHERE o.direction = 'created')                   AS sent,
    count(*) FILTER (WHERE o.direction = 'parsed')                    AS received,
    coalesce(any_value(w.joined), 0)                                  AS joined,
    -- sent while both ends were still recording, and never seen to arrive
    (SELECT count(*) FROM unjoined u
      WHERE u.cid = o.cid AND u.direction = 'created'
        AND u.wall_time BETWEEN any_value(w.first_send) AND any_value(w.last_send))
                                                                      AS lost,
    -- unjoined only because one log had already stopped, or had not started
    (SELECT count(*) FROM unjoined u
      WHERE u.cid = o.cid
        AND NOT (u.wall_time BETWEEN any_value(w.first_send) AND any_value(w.last_send)))
                                                                      AS outside_window,
    coalesce(any_value(w.negative_hops), 0)                           AS negative_hops,
    any_value(w.first_send) AS first_send,
    any_value(w.last_send)  AS last_send
FROM obj o LEFT JOIN win w USING (cid)
GROUP BY o.cid;

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
           'subgroup_header_' || s.direction, s.stream_id, t.track_name,
           s.group_id, s.subgroup_id, NULL, NULL, NULL, NULL
    FROM subgroup_stream s
    LEFT JOIN track      t USING (trace_id, track_alias)
    LEFT JOIN trace     tr USING (trace_id)

    UNION ALL
    SELECT trace_id, time_us, wall_time,
           'subgroup_object_' || direction, stream_id, track_name,
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

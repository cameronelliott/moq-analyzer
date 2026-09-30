-- moq-rs mlog -> DuckDB. Idempotent; safe to re-run: tables are IF NOT EXISTS,
-- views are OR REPLACE so a re-run updates a stale definition rather than
-- silently keeping it, and shape_baseline is rewritten from this file each time.
--
-- ICU, and UTC. Both are deliberate.
--
-- ICU because wall_time adds an INTERVAL to a TIMESTAMPTZ, and because a capture
-- spanning six sites will want times read in the relay's zone, or a subscriber's
-- -- that is binning, not formatting, so it belongs in SQL rather than in the
-- client. The CLI already has it. duckdb-wasm does not: it fetches
-- icu.duckdb_extension.wasm (6.2 MB, 1.8 MB gzipped) from extensions.duckdb.org
-- and caches it, so a browser pays that once, at startup rather than stalling on
-- the first timezone call. Self-host it by setting custom_extension_repository.
--
-- Loading it here rather than leaving it to autoload is not optional: an
-- operator overload never triggers autoload, so `reference_time + INTERVAL`
-- fails to bind with a message naming neither ICU nor the fix.
--
-- UTC because the analyst's own zone is the one zone in this picture with no
-- bearing on the data, and because these numbers get quoted -- two people
-- reading one capture should see one timestamp. Without ICU a TIMESTAMPTZ
-- already renders UTC, so this lines the CLI up with a browser rather than
-- letting them diverge.
--
-- It reaches as far as the session, and no further: DuckDB keeps no per-database
-- setting, so a reader who skips this file gets their own zone --
--     duckdb t.db -f schema.sql -c "<query>"   -> 22:13:43.387162+00
--     duckdb t.db               -c "<query>"   -> 15:13:43.387162-07
-- the same instant either way. Running schema.sql first is the documented and
-- idempotent path; an operator who wants local time says so instead:
--     SET TimeZone = 'America/Los_Angeles';
LOAD icu;
SET TimeZone = 'UTC';

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
-- trace_id is NOT NULL here and on the other two keyless tables. getvariable()
-- returns NULL for a name that was never set, so a statement run without its
-- SET VARIABLE writes rows under no trace at all, and nothing notices. Barely
-- reachable under `duckdb -f`, where one connection runs the file in order;
-- ordinary in the browser, where a caller may hand statements to a connection
-- that never saw the variable. The tables with primary keys get this for free.
CREATE TABLE IF NOT EXISTS control_message (
    trace_id        USMALLINT NOT NULL,
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
-- doubling the `object` view. load.sql names the cause first.
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
    trace_id        USMALLINT NOT NULL,
    stream_id       UINTEGER,
    object_id       UINTEGER,
    time_us         BIGINT,
    payload_length  UINTEGER,
    extension_count USMALLINT
);

-- Anything the loader does not recognise, kept verbatim rather than dropped.
CREATE TABLE IF NOT EXISTS event_other (
    trace_id USMALLINT NOT NULL,
    time_us  BIGINT,
    name     VARCHAR,
    data     JSON
);

-- One row per (event name, recursive type fingerprint). json_structure walks
-- the whole `data` object, so a new field, a dropped field, or a field that
-- changes type each produce a new row -- which is the drift signal. The census
-- is tiny: 62k event lines collapse to four rows.
--
-- `unconsumed` lists keys present in the log that no INSERT in load.sql reads.
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
-- load.sql selects this at the end of a file load. It is also worth
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

-- The second the capture's first object falls in. Every series counts t_s from
-- here, so charts of different measures share one time axis.
CREATE OR REPLACE VIEW capture_start AS
SELECT time_bucket(INTERVAL '1 second', min(wall_time)) AS sec
FROM object;

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
-- it spans two connections at one host.
--
-- Built from the relay's own traces and nothing else, because both timestamps
-- are the relay's. It used to be built from a pair of hops, which made it need
-- the publisher's and each subscriber's logs as well, so a relay operator with
-- only the relay's logs got no dwell at all. On real-6pop the two agree on every
-- row the old one had; this one also has the 3,052 objects the relay forwarded
-- after a subscriber's log had stopped. `leg` drops those again (see there).
--
-- Assumes one relay, sitting at the server end of every connection. That is the
-- v1 capture exactly: one publisher, one relay, four subscribers. A chained
-- relay would break it -- relay A is a client to relay B, so A's outbound trace
-- reads as a publisher -- because nothing in an mlog says two traces are the
-- same host. That is the capture that turns role from assumption into data.
-- A server end that both parses and creates one object is not a dwell with
-- itself; a dwell always leaves on a different trace than it arrived on.
--
-- payload_length is the size the relay parsed. It matched the size it created
-- on all 230,968 pairs in real-6pop.
--
-- On the six-POP captures the median is a sliver, 0.26-0.43 ms, and the mean is
-- 1.4x to 15x that. Means sum to end-to-end and medians do not, so a per-leg
-- composition bar has to be built from means.
CREATE OR REPLACE VIEW dwell AS
SELECT
    tin.cid  AS in_cid,
    tout.cid AS out_cid,
    i.track_namespace,
    i.track_name,
    i.group_id,
    i.subgroup_id,
    i.object_id,
    i.trace_id AS relay_in_trace,
    o.trace_id AS relay_out_trace,
    i.wall_time AS t_in,
    o.wall_time AS t_out,
    datediff('microsecond', i.wall_time, o.wall_time) AS us,
    i.payload_length,
    -- The relay already had this object when the subscriber asked for it, so its
    -- dwell is how long the subscriber took to arrive, not how long the relay
    -- took to forward. Both timestamps are the relay's own clock on two of its
    -- traces, so no cross-host sync is involved.
    --
    -- Per track, not per connection: 0.mp4 is acknowledged 112-215 ms before the
    -- media tracks, and the connection's first subscribe_ok would misclassify
    -- anything arriving in that window.
    --
    -- Held is rare and enormous -- 62 to 88 objects per subscriber against
    -- ~50,000, with a median near 700 ms against 0.3 ms, and 60 to 180 seconds
    -- at the top. It is the whole of dwell's tail: excluding it leaves a mean
    -- 1.2x the median rather than 15x. A subscriber that joined first has none.
    -- False rather than NULL when no subscribe_ok was seen: unproven, not held.
    coalesce(i.wall_time < ok.ok_at, false) AS held
FROM object i
JOIN trace tin  ON tin.trace_id  = i.trace_id AND tin.vantage_point  = 'server'
JOIN object o   ON o.direction = 'created'
               AND o.trace_id <> i.trace_id
               AND (o.track_namespace, o.track_name,
                    o.group_id, o.subgroup_id, o.object_id)
                 = (i.track_namespace, i.track_name,
                    i.group_id, i.subgroup_id, i.object_id)
JOIN trace tout ON tout.trace_id = o.trace_id AND tout.vantage_point = 'server'
LEFT JOIN (
    SELECT c.trace_id, k.track_namespace, k.track_name,
           any_value(tr.reference_time) + to_microseconds(min(c.time_us)) AS ok_at
    FROM control_message c
    JOIN track k  ON k.trace_id = c.trace_id AND k.track_alias = c.track_alias
    JOIN trace tr ON tr.trace_id = c.trace_id
    WHERE c.message_type = 'subscribe_ok' AND c.direction = 'created'
    GROUP BY c.trace_id, k.track_namespace, k.track_name
) ok ON  ok.trace_id        = o.trace_id
     AND ok.track_namespace = i.track_namespace
     AND ok.track_name      = i.track_name
WHERE i.direction = 'parsed';

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
--
-- NULL where a count would be a claim the logs cannot back. With only one end
-- of a connection loaded, nothing can join, so joined and negative_hops are
-- NULL rather than 0: a relay operator's logs would otherwise read as a clean
-- network. lost and outside_window are NULL whenever there is no window, which
-- is also the case when both ends are loaded but nothing joined. sent and
-- received are always counts of what the loaded logs show.
CREATE OR REPLACE VIEW trust AS
WITH ends AS (
    SELECT cid, count(*) AS traces FROM trace GROUP BY cid
),
win AS (
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
    CASE WHEN any_value(e.traces) >= 2
         THEN coalesce(any_value(w.joined), 0) END                    AS joined,
    -- sent while both ends were still recording, and never seen to arrive
    CASE WHEN any_value(w.joined) IS NOT NULL THEN
    (SELECT count(*) FROM unjoined u
      WHERE u.cid = o.cid AND u.direction = 'created'
        AND u.wall_time BETWEEN any_value(w.first_send) AND any_value(w.last_send))
    END                                                               AS lost,
    -- unjoined only because one log had already stopped, or had not started
    CASE WHEN any_value(w.joined) IS NOT NULL THEN
    (SELECT count(*) FROM unjoined u
      WHERE u.cid = o.cid
        AND NOT (u.wall_time BETWEEN any_value(w.first_send) AND any_value(w.last_send)))
    END                                                               AS outside_window,
    CASE WHEN any_value(e.traces) >= 2
         THEN coalesce(any_value(w.negative_hops), 0) END             AS negative_hops,
    any_value(w.first_send) AS first_send,
    any_value(w.last_send)  AS last_send
FROM obj o
LEFT JOIN win  w USING (cid)
LEFT JOIN ends e USING (cid)
GROUP BY o.cid;

-- Which ends of each connection were loaded, so a consumer can tell a measure
-- that is absent because a log is missing from one that is empty. Every view
-- returns rows only where its inputs exist; this says which inputs exist.
--
--   one end of a connection         bitrate, interarrival
--   the relay's in and out traces   dwell, leg 2
--   both ends of a connection       hop, trust's joined and lost
--   both ends of both connections   legs 1 and 3, end to end
--
-- A relay operator has server_traces = 1 and client_traces = 0 everywhere.
--
-- sender is the end that sent objects, read from either end: a client that
-- created them, or a server that parsed them, both mean the client sent. That
-- is how it differs from trust's sender_is, which only sees the end that
-- created, and is NULL on a publisher's connection when only the relay's side
-- is loaded. `both` when objects went each way, NULL when none were logged.
--
-- A vantage_point other than client or server counts in neither column. Traces
-- loaded without a cid share one row with a NULL cid; the API always has one.
CREATE OR REPLACE VIEW coverage AS
WITH sends AS (
    SELECT t.cid,
           CASE WHEN (t.vantage_point = 'client') = (o.direction = 'created')
                THEN 'client' ELSE 'server' END AS sender
    FROM object o
    JOIN trace t USING (trace_id)
    WHERE t.vantage_point IN ('client', 'server')
),
snd AS (
    SELECT cid,
           CASE WHEN count(DISTINCT sender) > 1 THEN 'both'
                ELSE any_value(sender) END AS sender
    FROM sends
    GROUP BY cid
)
SELECT t.cid,
       count(*) FILTER (WHERE t.vantage_point = 'client') AS client_traces,
       count(*) FILTER (WHERE t.vantage_point = 'server') AS server_traces,
       any_value(s.sender)                                AS sender
FROM trace t
LEFT JOIN snd s USING (cid)
GROUP BY t.cid;

-- One row per object per leg: the whole of chart 1. Three rows for each object
-- that made it to a subscriber -- into the relay, through it, out to that
-- subscriber -- so a strip chart groups by leg and a composition bar sums means
-- across them.
--
-- The join runs through dwell rather than off hop directly, and that is the
-- point of the view. hop alone cannot say which leg a row belongs to for a
-- given subscriber: the publisher's leg is one connection shared by all of
-- them, so attributing it per path means matching the object through the relay.
-- Doing that by hand is where chart 1 goes quietly wrong.
--
-- Read leg 1 as the check: it is one physical hop measured once per subscriber,
-- so those medians must agree. On the six-POP captures they land within 0.02 ms
-- of each other across all four.
--
-- Means, not medians, for a composition bar. Per-leg means sum to the
-- end-to-end mean and medians do not -- measured there, 74.942 + 1.909 + 55.780
-- comes to the end-to-end 132.631, while the medians make 131.944 against an
-- actual 131.76. The relay is also where that matters most: its mean runs 1.4x
-- to 15x its median, so a median-only bar draws a flat sliver and hides it.
-- Held objects are excluded, whole. Their dwell measures a subscriber arriving
-- rather than a relay forwarding, and dropping only their middle leg would break
-- the property that the three sum to end to end. They stay reachable through
-- `dwell` and `hop`, where catch-up is worth charting on its own.
--
-- Whole paths only, for the same reason. When a connection's client end was
-- logged, a dwell whose object never shows up there is dropped with it: on
-- real-6pop those are the 3,052 objects sent after a subscriber's log stopped,
-- and keeping them would average leg 2 over other objects than legs 1 and 3.
-- When the client end was not logged, there is no leg 1 or 3 to match, and
-- dwell stands alone. So a relay operator's logs give leg 2 and nothing else.
CREATE OR REPLACE VIEW leg AS
WITH far AS (
    SELECT DISTINCT cid FROM trace WHERE vantage_point = 'client'
),
path AS (
    SELECT d.*,
           h1.cid AS cid1, h1.t_send AS t1_send, h1.t_recv AS t1_recv, h1.us AS us1,
           h1.payload_length AS len1,
           h3.cid AS cid3, h3.t_send AS t3_send, h3.t_recv AS t3_recv, h3.us AS us3,
           h3.payload_length AS len3
    FROM dwell d
    LEFT JOIN hop h1 ON h1.cid = d.in_cid
                    AND (h1.track_namespace, h1.track_name,
                         h1.group_id, h1.subgroup_id, h1.object_id)
                      = (d.track_namespace, d.track_name,
                         d.group_id, d.subgroup_id, d.object_id)
    LEFT JOIN hop h3 ON h3.cid = d.out_cid
                    AND (h3.track_namespace, h3.track_name,
                         h3.group_id, h3.subgroup_id, h3.object_id)
                      = (d.track_namespace, d.track_name,
                         d.group_id, d.subgroup_id, d.object_id)
    WHERE NOT d.held
      AND (h1.cid IS NOT NULL OR NOT EXISTS (SELECT 1 FROM far WHERE far.cid = d.in_cid))
      AND (h3.cid IS NOT NULL OR NOT EXISTS (SELECT 1 FROM far WHERE far.cid = d.out_cid))
)
-- cid1 and cid3 say a hop matched; us can be NULL on a matched hop, so it cannot.
SELECT out_cid AS sub_cid, in_cid, 2 AS leg_no, 'relay dwell' AS leg,
       track_namespace, track_name, group_id, subgroup_id, object_id,
       t_in AS t_start, t_out AS t_end, us, payload_length
FROM path
UNION ALL
SELECT out_cid, in_cid, 1, 'pub -> relay',
       track_namespace, track_name, group_id, subgroup_id, object_id,
       t1_send, t1_recv, us1, len1
FROM path
WHERE cid1 IS NOT NULL
UNION ALL
SELECT out_cid, in_cid, 3, 'relay -> sub',
       track_namespace, track_name, group_id, subgroup_id, object_id,
       t3_send, t3_recv, us3, len3
FROM path
WHERE cid3 IS NOT NULL;

-- Latency summary: one row per subscriber and leg, all tracks together, in ms.
-- Means as well as medians, because per-leg means add up to the end-to-end mean
-- and medians do not (see `leg`).
CREATE OR REPLACE VIEW leg_summary AS
SELECT sub_cid, leg_no, leg,
       count(*)                          AS n,
       avg(us) / 1000                    AS mean_ms,
       median(us) / 1000                 AS median_ms,
       quantile_cont(us, 0.95) / 1000    AS p95_ms
FROM leg
GROUP BY ALL;

-- RFC 3550 6.4.1 interarrival jitter, per leg: D is how much an object's transit
-- differs from the previous object's on the same track and leg, taken in order
-- of arrival. One row per object in `leg`; the first per track has no
-- predecessor and comes back NULL rather than zero.
--
-- D is a difference of two transits, so a constant offset between the two
-- clocks cancels. That makes this the one per-leg number that does not rest on
-- clock sync -- `leg` itself does, and `trust` cannot vouch for it.
--
-- d_us is signed, as the RFC defines D: positive means this object took longer
-- than the one before. jitter_us is |D|, the sample the RFC's J averages. The
-- RFC's running 1/16 filter is left to the caller. A windowed mean of jitter_us
-- is comparable to J but not the same: J weights recent samples exponentially,
-- a mean weights them all alike.
--
-- Transit here runs from the sender's log to the receiver's, so it includes
-- serializing the object: a keyframe takes longer than the frame after it, and
-- D jumps at every such boundary whatever the network did. payload_length is
-- carried so a chart can split by size rather than read GOP structure as
-- jitter. Each leg reports the size its own sender logged.
--
-- Built on `leg`, so held objects are already out, and each subscriber gets
-- its own leg 1 series even though that hop is shared.
CREATE OR REPLACE VIEW jitter AS
SELECT sub_cid, leg_no, leg,
       track_namespace, track_name, group_id, subgroup_id, object_id,
       t_end,
       payload_length,
       d_us,
       abs(d_us) AS jitter_us
FROM (
    SELECT *,
           us - lag(us) OVER (PARTITION BY sub_cid, leg_no, track_namespace, track_name
                              ORDER BY t_end, group_id, subgroup_id, object_id) AS d_us
    FROM leg
);

-- Jitter summary: one row per subscriber and leg, all tracks together, in ms of
-- |D|. The first object of each track has no D and is not counted. p99 is here
-- and not in the series: 40k+ samples a session make it mean something, ~70 a
-- second make it the max.
CREATE OR REPLACE VIEW jitter_summary AS
SELECT sub_cid, leg_no, leg,
       count(*)                                AS n,
       avg(jitter_us) / 1000                   AS mean_ms,
       quantile_cont(jitter_us, 0.95) / 1000   AS p95_ms,
       quantile_cont(jitter_us, 0.99) / 1000   AS p99_ms,
       max(jitter_us) / 1000                   AS max_ms
FROM jitter
WHERE jitter_us IS NOT NULL
GROUP BY ALL;

-- Jitter series: the same per second of arrival, for a time chart. t_s counts
-- from `capture_start`, not each subscriber's first sample, so every
-- subscriber and every measure shares one axis and a late joiner starts late.
-- A second with no sample has no row. One second is safe to bucket in any
-- session zone (see `object_bitrate`).
CREATE OR REPLACE VIEW jitter_series AS
SELECT sub_cid, leg_no, leg, sec,
       epoch(sec) - epoch((SELECT sec FROM capture_start)) AS t_s,
       n, mean_ms, max_ms
FROM (
    SELECT sub_cid, leg_no, leg,
           time_bucket(INTERVAL '1 second', t_end) AS sec,
           count(*)                                AS n,
           avg(jitter_us) / 1000                   AS mean_ms,
           max(jitter_us) / 1000                   AS max_ms
    FROM jitter
    WHERE jitter_us IS NOT NULL
    GROUP BY ALL
);

-- Relay series: how long the relay holds objects and how steady that is, next
-- to how steady delivery is at each subscriber, per second. Built for one chart
-- with two y axes: dwell on one, the two jitters on the other. One row is one
-- dot, so the rows are long rather than wide: the number of subscribers varies.
--
--   relay dwell           mean of leg 2, pooled over every subscriber and track
--   relay egress jitter   mean |D| of leg 2, pooled the same way
--   subscriber jitter     mean |D| of leg 3, one row per subscriber (sub_cid)
--
-- Relay egress jitter is RFC 3550 D on the dwell leg. Both of its timestamps are
-- the relay's, so D there is just dwell minus the previous object's dwell: how
-- much the relay's own delay wobbles. Subscriber jitter is leg 3's D, and the
-- same as jitter_series leg 3; it needs the subscribers' logs, and without them
-- it has no rows. sub_cid is NULL on the two pooled series.
--
-- Built on `leg` and `jitter`, so held objects are out. Each dot's second is
-- when its leg ended: the relay sending, for the first two, and the subscriber
-- receiving, on the subscriber's clock, for the third. t_s counts from
-- `capture_start`, as every series does. A second with no sample has no row.
CREATE OR REPLACE VIEW relay_series AS
SELECT series, sub_cid, sec,
       epoch(sec) - epoch((SELECT sec FROM capture_start)) AS t_s,
       n, mean_ms
FROM (
    SELECT 'relay dwell'                             AS series,
           NULL::VARCHAR                             AS sub_cid,
           time_bucket(INTERVAL '1 second', t_end)   AS sec,
           count(*)                                  AS n,
           avg(us) / 1000                            AS mean_ms
    FROM leg
    WHERE leg_no = 2
    GROUP BY ALL
    UNION ALL
    SELECT 'relay egress jitter', NULL::VARCHAR,
           time_bucket(INTERVAL '1 second', t_end), count(*), avg(jitter_us) / 1000
    FROM jitter
    WHERE leg_no = 2 AND jitter_us IS NOT NULL
    GROUP BY ALL
    UNION ALL
    SELECT 'subscriber jitter', sub_cid,
           time_bucket(INTERVAL '1 second', t_end), count(*), avg(jitter_us) / 1000
    FROM jitter
    WHERE leg_no = 3 AND jitter_us IS NOT NULL
    GROUP BY ALL
);

-- Chart 2. The gap between an object arriving and the one before it on the same
-- track, at whichever endpoint decoded it. rtcstats calls this Latency. It is
-- not RFC 3550 jitter: the gap includes the publisher's own pacing, so a steady
-- 30 fps track shows 33 ms here on a perfect network. `jitter` is the RFC one.
--
-- One trace and one track at a time: the window partitions by trace_id, so
-- nothing is ever measured across two endpoints or two tracks. The first object
-- of each has no predecessor and comes back NULL rather than zero.
--
-- vantage_point is carried so a caller can say which end they mean -- `client`
-- is a subscriber here, which is the chart the proposal asks for. Whether a
-- late joiner's catch-up burst belongs in it is not decided; the rows are all
-- present, so filtering is the caller's call for now.
CREATE OR REPLACE VIEW interarrival AS
SELECT
    t.cid,
    o.trace_id,
    t.vantage_point,
    o.track_namespace,
    o.track_name,
    o.group_id,
    o.subgroup_id,
    o.object_id,
    o.wall_time,
    o.payload_length,
    datediff('microsecond',
             lag(o.wall_time) OVER (PARTITION BY o.trace_id, o.track_namespace,
                                                 o.track_name
                                    ORDER BY o.time_us),
             o.wall_time) AS us
FROM object o
JOIN trace t USING (trace_id)
WHERE o.direction = 'parsed';

-- Object bitrate: payload bytes per trace, direction, track and second.
--
-- payload_length only: this is media bytes, not bytes on the wire, so it counts
-- no QUIC or MoQ framing and no retransmission. An mlog logs no other size.
-- A second with no object has no row rather than a zero -- absent, not zero --
-- so a chart that wants a continuous axis fills the gaps itself and can see
-- that it did.
--
-- Both directions. `created` is the rate an end sent -- at the publisher, the
-- closest an mlog gets to the encoder's rate. `parsed` is the rate an end
-- received, bursts after a stall included. A relay's `created` on a
-- subscriber's connection against that subscriber's `parsed` shows delay as a
-- gap that closes and loss as one that stays -- clipped to the window both
-- logs cover, see `trust`.
--
-- One second, fixed. time_bucket on a TIMESTAMPTZ follows the session zone, but
-- whole-minute offsets cannot move a second boundary, so this one is safe where
-- an hourly bucket would not be.
DROP VIEW IF EXISTS throughput;   -- this view's old name
CREATE OR REPLACE VIEW object_bitrate AS
SELECT
    t.cid,
    o.trace_id,
    t.vantage_point,
    o.direction,
    o.track_namespace,
    o.track_name,
    time_bucket(INTERVAL '1 second', o.wall_time) AS sec,
    count(*)                        AS objects,
    sum(o.payload_length)           AS bytes,
    sum(o.payload_length) * 8       AS bits
FROM object o
JOIN trace t USING (trace_id)
GROUP BY ALL;

-- Object bitrate series: one row per end, direction, track and second, plus one
-- `scope = 'all'` row per end, direction and second that sums every track.
-- Totals are their own rows, not a column beside the track rows, so summing a
-- column never counts a byte twice -- filter on scope first. track_name is NULL
-- on `all` rows; it can also be NULL on a `track` row whose alias never
-- resolved, which is why scope exists rather than NULL meaning "all".
CREATE OR REPLACE VIEW object_bitrate_series AS
SELECT cid, vantage_point, direction,
       CASE WHEN grouping(track_name) = 1 THEN 'all' ELSE 'track' END AS scope,
       track_namespace, track_name, sec,
       epoch(sec) - epoch((SELECT sec FROM capture_start)) AS t_s,
       sum(objects)      AS objects,
       sum(bytes)        AS bytes,
       sum(bits) / 1000  AS kbit_s
FROM object_bitrate
GROUP BY GROUPING SETS (
    (cid, vantage_point, direction, track_namespace, track_name, sec),
    (cid, vantage_point, direction, sec)
);

-- Object bitrate summary: one row per series above. bytes is the whole series.
--
-- The rates leave out the first and last second of each end's log -- per cid,
-- vantage point and direction, not per series. A log starts and stops
-- mid-second, so those two are partial and would drag the low end down. A
-- track's own first second is not: on real-6pop a late joiner's first media
-- second is the relay's catch-up burst, about 800 kbit/s against a 334 kbit/s
-- stream, and trimming per series hid it from the track rows while the `all`
-- row, started a second earlier by the init segment, kept it.
--
-- span_s is that interior, gaps included, and the mean is bits over span_s, so
-- a gap counts as zero and the track means add up to the `all` mean -- a track
-- present for part of the log is averaged over all of it, and one with nothing
-- inside the interior, like a lone init segment, has a mean of 0. The
-- percentiles are over seconds that have data; seconds says how many, and they
-- are NULL when it is 0. An end of two seconds or fewer has no interior and
-- NULL rates.
CREATE OR REPLACE VIEW object_bitrate_summary AS
WITH s AS (
    SELECT *,
           min(sec) OVER w AS first_sec,
           max(sec) OVER w AS last_sec
    FROM object_bitrate_series
    WINDOW w AS (PARTITION BY cid, vantage_point, direction)
)
SELECT cid, vantage_point, direction, scope, track_namespace, track_name,
       sum(bytes) AS bytes,
       count(*) FILTER (WHERE sec > first_sec AND sec < last_sec) AS seconds,
       greatest(epoch(any_value(last_sec)) - epoch(any_value(first_sec)) - 1, 0) AS span_s,
       coalesce(sum(kbit_s) FILTER (WHERE sec > first_sec AND sec < last_sec), 0)
           / nullif(greatest(epoch(any_value(last_sec)) - epoch(any_value(first_sec)) - 1, 0), 0)
                                                                                  AS mean_kbit_s,
       quantile_cont(kbit_s, 0.05) FILTER (WHERE sec > first_sec AND sec < last_sec) AS p5_kbit_s,
       quantile_cont(kbit_s, 0.5)  FILTER (WHERE sec > first_sec AND sec < last_sec) AS median_kbit_s,
       quantile_cont(kbit_s, 0.95) FILTER (WHERE sec > first_sec AND sec < last_sec) AS p95_kbit_s,
       max(kbit_s)                 FILTER (WHERE sec > first_sec AND sec < last_sec) AS max_kbit_s
FROM s
GROUP BY cid, vantage_point, direction, scope, track_namespace, track_name;

-- Distribution samples: one row per sample of a measure, pooled over every
-- subscriber, so a chart of them stays one series however many subscribers
-- there are. value is in the measure's unit.
--
-- `track` rows belong to one track; `all` rows pool every track. For the
-- latency measures an `all` row is the same sample again. For bitrate it is
-- the `all` second from object_bitrate_series: pooling video seconds with
-- audio seconds would mean nothing, and their sum does.
--
-- end to end:   the three legs of one object to one subscriber, summed. An
--               object with a leg missing drops out, as held objects already
--               have in `leg`.
-- relay dwell:  leg 2 of `leg`.
-- interarrival: the gap at a subscriber (vantage `client`, direction
--               `parsed`). It includes the publisher's pacing; see
--               `interarrival`.
-- bitrate:      one second a subscriber received, without the first and the
--               last second of its log, as in object_bitrate_summary.
--
-- A sample whose track never resolved is left out of the latency measures;
-- `leg` drops those already.
CREATE OR REPLACE VIEW distribution_sample AS
WITH latency AS (
    SELECT 'end to end' AS measure, track_namespace, track_name,
           sum(us) / 1000 AS value
    FROM leg
    GROUP BY sub_cid, track_namespace, track_name, group_id, subgroup_id, object_id
    HAVING count(*) = 3
    UNION ALL
    SELECT 'relay dwell', track_namespace, track_name, us / 1000
    FROM leg
    WHERE leg_no = 2
    UNION ALL
    SELECT 'interarrival', track_namespace, track_name, us / 1000
    FROM interarrival
    WHERE vantage_point = 'client' AND us IS NOT NULL AND track_name IS NOT NULL
),
received AS (
    SELECT *,
           min(sec) OVER w AS first_sec,
           max(sec) OVER w AS last_sec
    FROM object_bitrate_series
    WHERE vantage_point = 'client' AND direction = 'parsed'
    WINDOW w AS (PARTITION BY cid, vantage_point, direction)
)
SELECT measure, 'ms' AS unit, 'track' AS scope, track_namespace, track_name, value
FROM latency
UNION ALL
SELECT measure, 'ms', 'all', NULL, NULL, value
FROM latency
UNION ALL
SELECT 'bitrate', 'kbit/s', scope, track_namespace, track_name, kbit_s
FROM received
WHERE sec > first_sec AND sec < last_sec
  AND (scope = 'all' OR track_name IS NOT NULL);

-- Distribution summary: one row per measure and track, and one per measure
-- with every track pooled.
CREATE OR REPLACE VIEW distribution_summary AS
SELECT measure, unit, scope, track_namespace, track_name,
       count(*)                     AS n,
       min(value)                   AS min,
       quantile_cont(value, 0.01)   AS p1,
       quantile_cont(value, 0.05)   AS p5,
       quantile_cont(value, 0.5)    AS p50,
       quantile_cont(value, 0.95)   AS p95,
       quantile_cont(value, 0.99)   AS p99,
       max(value)                   AS max
FROM distribution_sample
GROUP BY ALL;

-- Distribution bins: a histogram of each row above, from min to max with no
-- gaps. A bin with no samples is a row with count 0.
--
-- The width is a round number, 1, 2 or 5 times a power of ten, that cuts min
-- to p99 into 20 bins or fewer. Every sample past p99's bin goes in one last
-- bin up to max, so one outlier cannot squash the rest into a single bar.
-- Round edges read well on an axis. The first bin starts at min and the last
-- ends at max, so those two edges are not round. When every sample is the same
-- value there is one bin.
CREATE OR REPLACE VIEW distribution_bin AS
WITH sized AS (
    SELECT *,
           -- min to p99, or min to max when those two are equal
           coalesce(nullif(p99 - min, 0), max - min) / 20 AS raw
    FROM distribution_summary
),
rounded AS (
    SELECT *,
           CASE WHEN raw > 0 THEN
               pow(10, floor(log10(raw))) *
               CASE WHEN raw / pow(10, floor(log10(raw))) <= 1 THEN 1
                    WHEN raw / pow(10, floor(log10(raw))) <= 2 THEN 2
                    WHEN raw / pow(10, floor(log10(raw))) <= 5 THEN 5
                    ELSE 10 END
           END AS width
    FROM sized
),
-- Edges count in widths from zero. The last bin takes p99's edge onward, or
-- the bin max falls in, whichever is lower. A max on an edge joins the bin
-- below it rather than making a bin of its own.
edged AS (
    SELECT measure, scope, track_namespace, track_name, min, max, width,
           coalesce(floor(min / width), 0)                                  AS first_edge,
           coalesce(least(ceil(p99 / width), ceil(max / width) - 1), 0)    AS last_edge
    FROM rounded
),
counted AS (
    SELECT e.measure, e.scope, e.track_namespace, e.track_name,
           coalesce(least(floor(s.value / e.width), e.last_edge) - e.first_edge, 0) AS bin,
           count(*) AS count
    FROM distribution_sample s
    JOIN edged e
      ON s.measure = e.measure AND s.scope = e.scope
     AND s.track_namespace IS NOT DISTINCT FROM e.track_namespace
     AND s.track_name IS NOT DISTINCT FROM e.track_name
    GROUP BY ALL
),
bins AS (
    SELECT *, unnest(range((last_edge - first_edge + 1)::BIGINT)) AS bin
    FROM edged
)
SELECT b.measure, b.scope, b.track_namespace, b.track_name, b.bin,
       CASE WHEN b.bin = 0 THEN b.min
            ELSE (b.first_edge + b.bin) * b.width END                 AS lo,
       CASE WHEN b.first_edge + b.bin = b.last_edge THEN b.max
            ELSE (b.first_edge + b.bin + 1) * b.width END             AS hi,
       coalesce(c.count, 0)                                           AS count
FROM bins b
LEFT JOIN counted c
  ON c.measure = b.measure AND c.scope = b.scope
 AND c.track_namespace IS NOT DISTINCT FROM b.track_namespace
 AND c.track_name IS NOT DISTINCT FROM b.track_name
 AND c.bin = b.bin;

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

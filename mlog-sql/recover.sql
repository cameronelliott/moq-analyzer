-- Line up the relay's traces that have no reference_time. Run once, after the
-- last load.sql of a capture:
--
--   duckdb t.db -f mlog-sql/schema.sql \
--     -c "set variable src='in_server.mlog';"  -f mlog-sql/load.sql \
--     -c "set variable src='out_server.mlog';" -f mlog-sql/load.sql \
--     -f mlog-sql/recover.sql
--
-- It changes nothing in a capture whose traces all logged a reference_time, and
-- running it again changes nothing either.
--
-- What it does. The relay writes one trace per connection, each counting from
-- its own open, all from one clock. So an outbound trace is a constant away
-- from the inbound trace that fed it. Every object the relay forwarded is in
-- both, and out-minus-in is that constant plus the object's dwell. The smallest
-- such gap is the constant plus the fastest dwell. This moves the outbound
-- trace's reference_time by that smallest gap, so the fastest dwell reads 0.
--
-- So a recovered dwell reads low by the fastest real dwell, and never high.
-- clock_recovery in schema.sql says how large that is.
--
-- What it does not do. It lines up no trace of another host: between two hosts
-- the smallest gap is the whole path delay, and taking it away leaves nothing
-- to measure. It also leaves an outbound trace alone when two inbound traces
-- feed it, because the two give two answers.
--
-- The join is `dwell`'s, written on `object` because `dwell` shows only the
-- pairs that are already lined up.

BEGIN TRANSACTION;

INSERT INTO clock_recovery (trace_id, in_trace, offset_us, matched, near_floor)
WITH gap AS (
    SELECT i.trace_id AS in_trace,
           o.trace_id AS out_trace,
           datediff('microsecond', i.wall_time, o.wall_time) AS us
    FROM object i
    JOIN trace tin  ON tin.trace_id  = i.trace_id AND tin.vantage_point  = 'server'
    JOIN object o   ON o.direction = 'created'
                   AND o.trace_id <> i.trace_id
                   AND (o.track_namespace, o.track_name,
                        o.group_id, o.subgroup_id, o.object_id)
                     = (i.track_namespace, i.track_name,
                        i.group_id, i.subgroup_id, i.object_id)
    JOIN trace tout ON tout.trace_id = o.trace_id AND tout.vantage_point = 'server'
    WHERE i.direction = 'parsed'
      AND tout.reference_time_source = 'none'
),
floored AS (
    SELECT *, min(us) OVER (PARTITION BY in_trace, out_trace) AS floor_us
    FROM gap
),
pair AS (
    SELECT out_trace, in_trace,
           any_value(floor_us)                          AS offset_us,
           count(*)                                     AS matched,
           count(*) FILTER (WHERE us - floor_us <= 50)  AS near_floor
    FROM floored
    GROUP BY out_trace, in_trace
)
SELECT out_trace, in_trace, offset_us, matched, near_floor
FROM pair
QUALIFY count(*) OVER (PARTITION BY out_trace) = 1;

UPDATE trace
SET reference_time        = trace.reference_time - to_microseconds(c.offset_us),
    reference_time_source = 'recovered'
FROM clock_recovery c
WHERE trace.trace_id = c.trace_id
  AND trace.reference_time_source = 'none';

COMMIT;

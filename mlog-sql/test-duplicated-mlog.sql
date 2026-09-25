-- Audit a loaded database for double-inserted rows.
--
--   duckdb db.db -f test-duplicated-mlog.sql
--
-- No rows means clean. Every check returns rows only when it finds something,
-- so the whole file is quiet on a healthy database.
--
-- Why this exists: chunks fed through load.sql are not replay-protected.
-- control_message, subgroup_object and event_other carry no primary key, so a
-- re-fed chunk silently duplicates their rows and inflates shape.n. (trace,
-- track and subgroup_stream cannot duplicate -- their primary keys reject it,
-- and the transaction rolls the chunk back.) Rather than pay for prevention on
-- every insert, detect after the fact: this is cheap to run and needs no extra
-- table.
--
-- The signal is that time_us is unique per event in a well-formed mlog -- all
-- 62,217 events in the reference trace have distinct microsecond timestamps.
-- Two rows sharing one is therefore either a replayed line or, far less likely,
-- a genuine collision; the checks below separate those two cases.

WITH
-- MAP and JSON columns are not groupable, so compare them as text.
cm AS (
    SELECT trace_id, time_us, direction, message_type, stream_id, subscribe_id,
           track_alias, track_namespace, track_name,
           parameters::VARCHAR AS parameters, track_extensions::VARCHAR AS track_extensions
    FROM control_message
),
eo AS (
    SELECT trace_id, time_us, name, data::VARCHAR AS data FROM event_other
),
loaded AS (SELECT trace_id, count(*) AS n FROM event GROUP BY 1),
census AS (SELECT trace_id, sum(n) AS n FROM shape GROUP BY 1)

-- 1. Identical rows in a table with no primary key. A replayed line lands here.
SELECT 'control_message: identical rows' AS check_name,
       trace_id,
       message_type || ' @ ' || time_us || 'us' AS detail,
       count(*) AS copies
FROM cm GROUP BY ALL HAVING count(*) > 1

UNION ALL
SELECT 'subgroup_object: identical rows',
       trace_id,
       'stream ' || stream_id || ' object ' || object_id,
       count(*)
FROM subgroup_object GROUP BY ALL HAVING count(*) > 1

UNION ALL
SELECT 'event_other: identical rows', trace_id, name || ' @ ' || time_us || 'us', count(*)
FROM eo GROUP BY ALL HAVING count(*) > 1

-- 2. An object id repeated within a stream. Catches a replay even if the two
--    copies somehow differ, since (stream_id, object_id) is the natural key.
UNION ALL
SELECT 'subgroup_object: repeated (stream_id, object_id)',
       trace_id,
       'stream ' || stream_id || ' object ' || object_id,
       count(*)
FROM subgroup_object GROUP BY trace_id, stream_id, object_id HAVING count(*) > 1

-- 3. Cross-table net: one timestamp, more than one event. Catches duplicates in
--    any event table at once, including tables added later.
UNION ALL
SELECT 'event: timestamp used more than once', trace_id,
       string_agg(DISTINCT name, ', ') || ' @ ' || time_us || 'us', count(*)
FROM event GROUP BY trace_id, time_us HAVING count(*) > 1

-- 4. shape.n is a running count, so no row key protects it. Compare the census
--    against the events actually loaded: a replayed chunk inflates the former.
UNION ALL
SELECT 'shape: census disagrees with loaded events', l.trace_id,
       'census ' || c.n || ' vs ' || l.n || ' events', c.n - l.n
FROM loaded l JOIN census c USING (trace_id)
WHERE c.n <> l.n

ORDER BY check_name, trace_id, detail;

# mlog-sql

mlog-sql loads the mlog files of a Media over QUIC session into DuckDB and gives the measures as SQL views and as typed TypeScript queries.

It is the engine of [MoQ Analyzer](https://moqanalyzer.com/). It has no user interface. It runs in the browser on duckdb-wasm, and its SQL files run in the DuckDB command line too.

There are two ways to use it:

- The TypeScript interface. Call `openCapture` and read typed rows. The analyzer page does this.
- The SQL files. Load a trace with the DuckDB command line and query the views.

The two ways give the same numbers, because each TypeScript query is a `SELECT` on one view.

## The TypeScript interface

[`mlog-sql.d.ts`](mlog-sql.d.ts) is the public header. It declares each function, each row type, and each field, with a comment for each one that needs it. Read it for the columns. This file does not repeat them.

The package has three exported values:

- `openCapture(engine, traces, options?)` loads the traces and returns a `Capture`.
- `CaptureError` is the only error that mlog-sql throws. Its `failure` field tells what failed.
- `RECOVERED_DWELL` gives the size of the error in a recovered relay dwell, and a note that a page can show.

A `Capture` has one function for each query:

| Function | Gives |
| --- | --- |
| `distribution(measure, track?)` | The quantiles and a histogram of one measure: end to end, relay dwell, interarrival, or bitrate. |
| `prepareDistributions(onQuery?)` | Runs the two queries that all distributions read, and reports progress. |
| `legSummary()` | Object latency on each leg, for each subscriber. |
| `trust()` | Object loss on each connection, and the counts that back it. |
| `coverage()` | Which ends of each connection are loaded. |
| `recovery()` | What mlog-sql recovered on each trace of a stock moq-rs capture. |
| `jitterSummary()`, `jitterSeries()` | Object jitter on each leg, as a summary and for each second. |
| `relaySeries()` | Relay dwell, relay egress jitter, and subscriber jitter for each second. |
| `objectBitrateSummary()`, `objectBitrateSeries()` | Object bitrate for each end and track, as a summary and for each second. |

### Example

You supply an `Engine`: a small adapter on a duckdb-wasm database. You supply each trace as a stream of plain mlog bytes, with gzip already removed.

```ts
import * as duckdb from '@duckdb/duckdb-wasm';
import { CaptureError, openCapture, type Engine } from 'mlog-sql';

// db is an AsyncDuckDB that you have started.
const engine: Engine = {
  registerFileBuffer: (name, bytes) => db.registerFileBuffer(name, bytes),
  dropFile: async (name) => { await db.dropFile(name); },
  connect: async () => {
    const conn = await db.connect();
    return { query: async (sql) => (await conn.query(sql)).toArray().map((r) => r.toJSON()) };
  },
};

try {
  const capture = await openCapture(engine, [
    { name: 'abc_server.mlog', cid: 'abc', stream: file.stream() },
  ]);
  const dwell = await capture.distribution('relay dwell');
  console.log(dwell?.p50, dwell?.p99);
} catch (e) {
  if (e instanceof CaptureError) console.error(e.failure.kind, e.message);
}
```

[`../html5/lib/duckdb-engine.ts`](../html5/lib/duckdb-engine.ts) is a complete browser adapter. [`../csv-dump`](../csv-dump) is a small command-line consumer.

### Rules for a caller

- Use one engine for one capture. `openCapture` refuses an engine that already holds traces. Two captures in one database join incorrectly and give no error.
- After a `CaptureError`, discard the engine. It holds a partial load.
- A trace `name` must be unique in the capture. The `cid` is the only thing that connects the two traces of one connection.
- duckdb-wasm must be able to load its `icu` and `json` extensions.

## The SQL files

| File | Use |
| --- | --- |
| [`schema.sql`](schema.sql) | Creates the tables and the views. Each one has a comment that tells what it is and why. |
| [`load.sql`](load.sql) | Loads one mlog file, or one chunk of one file, in a transaction. |
| [`recover.sql`](recover.sql) | Lines up the relay's traces that have no `reference_time`. Run it one time, after the last load. |

To load the two traces of a relay with the DuckDB command line, and read its dwell:

```sh
duckdb t.db -f schema.sql \
  -c "set variable src='aaa_server.mlog.gz'; set variable cid='aaa';" -f load.sql \
  -c "set variable src='bbb_server.mlog.gz'; set variable cid='bbb';" -f load.sql \
  -f recover.sql \
  -c "select * from coverage; select * from leg_summary;"
```

Run `load.sql` one time for each trace, with a new `src` and `cid`. A file can be plain or gzipped. Use a new database file for each capture.

`load.sql` prints the rows of `shape_drift` after each load. No rows means that it read all of the file.

The command line does not recover stream ids. `load.sql` refuses a trace from stock moq-rs, and tells you the cause. `openCapture` recovers the ids before the load.

### Tables

`load.sql` fills these tables. One row of `trace` is one mlog file.

| Table | Holds |
| --- | --- |
| `trace` | One row for each mlog file: its header, its connection id, and where its stream ids and reference time came from. |
| `track` | Each track that a trace subscribes to: the alias, with the namespace and name. |
| `control_message` | Each MoQT control message. |
| `subgroup_stream` | Each subgroup stream: its track alias, group, and subgroup. |
| `subgroup_object` | Each object on a stream: its time and its payload length. This is the large table. |
| `event_other` | Each event that the loader does not know, with its data unchanged. |
| `clock_recovery` | The time offset that `recover.sql` found for each outbound trace of the relay. |
| `shape`, `shape_baseline` | A count of each JSON shape in the log, and the list of shapes that the loader expects. |

### Views

The views are the source of truth. Add a measure as a view first, and then as a `Capture` function.

These views put the rows together:

| View | Gives |
| --- | --- |
| `object` | Each object with its track name, group, and wall-clock time. An object is in two traces: `created` at the end that sent it, and `parsed` at the end that received it. |
| `event` | Each event of a trace in one shape. Use it to read a trace in time order. |
| `capture_start` | The second of the first object. Each series counts its seconds from there. |
| `hop` | One object at the two ends of one connection. This is the only place that joins traces of two hosts. |
| `dwell` | One object in the relay's inbound trace and outbound trace. It needs only the relay's logs. |
| `leg` | The three legs of the path of an object: publisher to relay, relay dwell, relay to subscriber. |
| `interarrival` | The time between an object and the one before it on the same track. |
| `shape_drift` | Each JSON shape that the loader did not expect. No rows means that the loader read all of the log. |

These views are the frames that charts and tables read. Each one has a `Capture` function.

| View | Function |
| --- | --- |
| `leg_summary` | `legSummary` |
| `trust` | `trust` |
| `coverage` | `coverage` |
| `recovery` | `recovery` |
| `jitter`, `jitter_summary`, `jitter_series` | `jitterSummary`, `jitterSeries` |
| `relay_series` | `relaySeries` |
| `object_bitrate`, `object_bitrate_summary`, `object_bitrate_series` | `objectBitrateSummary`, `objectBitrateSeries` |
| `distribution_sample`, `distribution_summary`, `distribution_bin` | `distribution` |

## What each measure needs

A measure has rows only when the logs that it needs are loaded.

| Logs loaded | Measures |
| --- | --- |
| One end of a connection | Object bitrate, interarrival |
| The relay's inbound and outbound traces | Relay dwell and its jitter |
| Both ends of a connection | Object loss |
| Both ends of both connections, each with a `reference_time` | Latency on the network legs, and end to end |

[`MEASURES.md`](MEASURES.md) tells what each measure is and why it is defined that way. It also tells how mlog-sql recovers stream ids and relay dwell on a stock moq-rs capture, and how large the error is.

## Other documents

- [`MEASURES.md`](MEASURES.md): the measures, coverage, recovery, and distributions.
- [`RFC-3550-explained.md`](RFC-3550-explained.md): why object jitter uses RFC 3550 D.
- [`IVM.md`](IVM.md): notes on incremental view maintenance for streamed input.
- [`MLOG-FILE-REQUIREMENTS.md`](MLOG-FILE-REQUIREMENTS.md): what is tested, and the file name rule.

## Test

```sh
bun install
bun test
bun run typecheck
```

`wasm.test.ts` runs the SQL in duckdb-wasm. The command line has `icu` and `json` built in and duckdb-wasm does not, so a command-line check does not prove that the browser works.

Some tests read large captures that are not in this repository. Those tests skip when the captures are absent.

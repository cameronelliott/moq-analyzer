# MoQ Analyzer

MoQ Analyzer reads the mlog files of a Media over QUIC session and shows object latency, relay dwell, object loss, object bitrate, interarrival and jitter.

It runs in the browser. Your logs stay on your machine.

- Use it: <https://moqanalyzer.com/app/>
- Read about it: <https://moqanalyzer.com/>
- Contact: <hello@moqanalyzer.com>

## What it reads

The analyzer reads mlog files. An mlog file is a qlog-format event log for MoQT, written as RFC 7464 JSON text sequences.

A file name is `<cid>_client.mlog` or `<cid>_server.mlog`. A file can be plain or gzipped.

- The logs of a relay alone give relay dwell, object bitrate and interarrival. This works with stock moq-rs.
- The logs from both ends of a connection add object loss.
- The logs from every host, each with a `reference_time`, add latency on each network leg and end to end. This needs synced clocks.

## Packages

| Directory | Contents |
| --- | --- |
| `mlog-sql` | The loader and the SQL views. It loads mlog files into DuckDB and gives typed queries. `MEASURES.md` lists each measure and the reason for it. |
| `html5` | The analyzer page and the landing page. It runs `mlog-sql` on duckdb-wasm in a worker. |
| `csv-dump` | A small command-line consumer of `mlog-sql`. It writes object bitrate as CSV. |

## Build

You need [Bun](https://bun.sh).

```sh
cd mlog-sql
bun install

cd ../html5
bun install
bun run build   # writes html5/dist, the analyzer
bun run site    # writes site/, the landing page with the analyzer in app/
```

Serve `site/` with a static file server. The pages do not work from a `file://` URL.

```sh
cd site
python3 -m http.server 8000
```

The site asks no other host for scripts, styles or data. It works with no network.

## Test

```sh
cd mlog-sql
bun test

cd ../html5
bun test
bun run typecheck
```

Some `mlog-sql` tests read large captures that are not in this repository. Those tests skip when the captures are absent.

## License

MIT. See `LICENSE`.

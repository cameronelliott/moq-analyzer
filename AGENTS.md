

# CLAUDE.md

## what this is

- Cameron is building a MoQ (media over quic) mlog and qlog file analyzer.
- mlog and qlog are RFC 7464 json nl files with trace event records.

# cameron says about the web-only analyzer and SSR rendered analyzer pages

 I want to index the actual analyzer pages also, so, yes, there is a server-side version of the analyzers page!
  it could be a great way to be found. But there will also be the empty version as a tool until someone drops mlog (or qlog) files
  into it. just like rtcstats.com has https://rtcstats.com/showcase, which allows reviewing other peoples analysis sessions, we are
  going to have that too

## tests and contracts first

- **Rust**: Lock types, error enums, and trait contracts first; enforce zero `.unwrap()` via `cargo clippy --all-targets -- -D warnings` and validate against unit tests before writing implementations.
- **TypeScript**: Define strict interfaces, Discriminated Unions, or Zod schemas before logic; enforce `tsc --noEmit` with zero `any`, and verify behavior via test suites. Casts are allowed only at a parse boundary — `JSON.parse`, subprocess output, anything crossing into the program untyped — and each one carries a comment stating what is being assumed. Prefer validating a shape over asserting it: a generic return type that launders `JSON.parse` is the same unchecked assumption as an `as`, just harder to see.
- **Python**: Define Pydantic models or `Protocol` boundaries with complete type hints first; pass `mypy --strict` (or `pyright`) and satisfy `pytest` suites before considering a task complete.
- **DuckDB SQL**: Write the DDL first, with the narrowest type that fits each column and real primary keys — a constraint is the cheapest bug detector available, and catches at load time what a query would otherwise return wrong forever. Keep every script re-runnable (`CREATE TABLE IF NOT EXISTS`, `CREATE OR REPLACE VIEW`) and wrap any multi-statement ingest in a transaction, since the CLI keeps executing after an error and will otherwise half-commit. Write input fixtures and the assertion queries that must hold before drafting transformations; drive the real `duckdb` binary rather than mocking it, and verify by diffing against the source (`EXCEPT ALL`, both directions) rather than comparing row counts. Then break the code on purpose and confirm the test fails — an assertion never seen red is not evidence.

## Process (gentle defaults, not rules)

- **Plan before editing on bigger changes**: When a task touches more than a file or two, sketch the shape first (types, files, order of steps) and check it against the request before writing code. Small fixes don't need this.
- **Disk and tools outrank the conversation**: When a file on disk or a compiler, linter, or test result disagrees with something said or seen earlier in the chat, trust the current file and the tool output and re-anchor there.
- **Small green steps**: Prefer a series of small changes that each build and pass tests over one large patch, so the checks above catch drift early instead of at the end.
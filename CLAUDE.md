

# CLAUDE.md

- **Rust**: Lock types, error enums, and trait contracts first; enforce zero `.unwrap()` via `cargo clippy --all-targets -- -D warnings` and validate against unit tests before writing implementations.
- **TypeScript**: Define strict interfaces, Discriminated Unions, or Zod schemas before logic; enforce `tsc --noEmit` with zero `any`, and verify behavior via test suites. Casts are allowed only at a parse boundary — `JSON.parse`, subprocess output, anything crossing into the program untyped — and each one carries a comment stating what is being assumed. Prefer validating a shape over asserting it: a generic return type that launders `JSON.parse` is the same unchecked assumption as an `as`, just harder to see.
- **Python**: Define Pydantic models or `Protocol` boundaries with complete type hints first; pass `mypy --strict` (or `pyright`) and satisfy `pytest` suites before considering a task complete.
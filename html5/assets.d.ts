// Our markdown pages, imported `with { type: 'text' }`: the file's text.
declare module '*.md' {
  const text: string;
  export default text;
}

// Files that Bun copies into dist/ on an `import ... with { type: 'file' }`.
// The import gives the copied file's URL.

// generated/duckdb-eh.wasm.gz, which `bun run wasm` makes from the package's
// duckdb-eh.wasm.
declare module '*.wasm.gz' {
  const url: string;
  export default url;
}

declare module '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js' {
  const url: string;
  export default url;
}

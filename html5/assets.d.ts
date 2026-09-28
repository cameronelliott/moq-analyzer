// Files that Bun copies into dist/ on an `import ... with { type: 'file' }`.
// The import gives the copied file's URL.

declare module '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm' {
  const url: string;
  export default url;
}

declare module '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js' {
  const url: string;
  export default url;
}

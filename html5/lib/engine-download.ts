// The duckdb wasm module, downloaded gzipped, and the line that says how far
// along the engine is.
//
// The module is 36 MB and gzips to 8 MB. dist/ holds only the .gz: a host with
// a per-file size limit takes it, and a host that does not compress on the fly
// still sends 8 MB. The page gunzips it and gives duckdb a blob URL.
//
// No DOM and no duckdb imports, so `bun test` runs it.

/** What `fetch` gives fetchWasm: a URL in, a Response out. */
export type Fetcher = (url: string) => Promise<Response>;

/**
 * Download the module and return it as a Blob of plain wasm, typed
 * application/wasm so a worker can compile it as it streams.
 *
 * `onBytes` gets the bytes received so far and the total, or null when the
 * host sent no Content-Length. A host may send a .gz with Content-Encoding:
 * gzip, and the browser then hands over plain bytes, more of them than the
 * Content-Length says: the bytes are used as they are, and the total grows
 * with them, so progress never passes the whole.
 */
export async function fetchWasm(
  url: string,
  fetcher: Fetcher,
  onBytes: (loaded: number, total: number | null) => void,
): Promise<Blob> {
  const response = await fetcher(url);
  if (!response.ok || response.body === null) throw new Error(`HTTP ${response.status} for ${url}`);
  const length = Number(response.headers.get('content-length'));
  const total = Number.isFinite(length) && length > 0 ? length : null;

  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let loaded = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onBytes(loaded, total === null ? null : Math.max(total, loaded));
  }

  const raw = new Blob(chunks);
  const magic = new Uint8Array(await raw.slice(0, 2).arrayBuffer());
  const gzip = magic[0] === 0x1f && magic[1] === 0x8b;
  const wasm = gzip ? raw.stream().pipeThrough(new DecompressionStream('gzip')) : raw.stream();
  // The type is set on a Blob made from the bytes, not from the Response's
  // header: a Response with a stream body does not always pass its type on.
  return new Blob([await new Response(wasm).blob()], { type: 'application/wasm' });
}

/** How far along one engine is. */
export type EngineProgress =
  | { readonly stage: 'download'; readonly loaded: number; readonly total: number | null }
  /** The module is here; the worker is compiling it and loading extensions. */
  | { readonly stage: 'start' }
  | { readonly stage: 'ready' }
  | { readonly stage: 'failed'; readonly message: string };

const MB = new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const megabytes = (bytes: number) => `${MB.format(bytes / 1e6)} MB`;

/**
 * The status line and the bar. `fraction` is 0 to 1, or null when there is
 * nothing to measure and the bar should show that it is busy.
 * The text is shown on the load page. Cameron rewrites it; keep it all here.
 */
export function engineStatus(p: EngineProgress): { text: string; fraction: number | null } {
  switch (p.stage) {
    case 'download':
      return p.total === null
        ? { text: `Analyzer engine: downloading, ${megabytes(p.loaded)}`, fraction: null }
        : {
          text: `Analyzer engine: downloading, ${Math.floor(100 * p.loaded / p.total)}% of ${megabytes(p.total)}`,
          fraction: p.loaded / p.total,
        };
    case 'start':
      return { text: 'Analyzer engine: starting…', fraction: null };
    case 'ready':
      return { text: 'Analyzer engine ready.', fraction: 1 };
    case 'failed':
      return {
        text: `Analyzer engine did not start (${p.message}). It starts again when you load files.`,
        fraction: null,
      };
  }
}

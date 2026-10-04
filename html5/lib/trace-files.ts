// Dropped or picked files to mlog-sql trace sources.
//
// A trace file is named `<cid>_<client|server>.mlog[.gz]`. The cid is the only
// thing that ties a connection's two traces together, so a file whose name
// does not give one is rejected, not guessed at. See AGENTS.md: other names
// will come later.

import type { TraceSource } from 'mlog-sql';

export interface Rejected {
  readonly file: string;
  readonly reason: string;
}

export interface TraceFiles {
  /** Sorted by file name, so a load does not depend on drop order. */
  readonly traces: TraceSource[];
  readonly rejected: Rejected[];
  /** The file behind each trace, in the same order. plainSize() of each is what `onBytes` adds up to. */
  readonly accepted: File[];
}

// Greedy, so a cid may hold underscores and the last one splits off the role.
const NAME = /^([A-Za-z0-9_-]+)_(client|server)\.mlog(\.gz)?$/;

/**
 * How many plain mlog bytes a file holds. For a .gz that is the size gzip
 * wrote in the file's last four bytes (RFC 1952 ISIZE): right for one gzip
 * member under 4 GB, which is what `gzip` writes. A file too short to be gzip
 * counts as its own size.
 */
export async function plainSize(file: File): Promise<number> {
  if (!file.name.endsWith('.gz') || file.size < 18) return file.size;
  const tail = new DataView(await file.slice(file.size - 4).arrayBuffer());
  return tail.getUint32(0, true);
}

/**
 * A file's plain bytes, with gzip removed, and each piece reported as it is
 * taken. Nothing is opened until the first read, and nothing is read ahead:
 * the browser's gunzip reads a whole small file at once, so bytes counted
 * before it would say a load is done when it has hardly begun. Counted after
 * it, a piece is a piece mlog-sql asked for.
 */
function counted(file: File, gz: boolean, onBytes: (bytes: number) => void): ReadableStream<Uint8Array<ArrayBuffer>> {
  let reader: ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>> | undefined;
  return new ReadableStream({
    async pull(controller) {
      reader ??= (gz ? file.stream().pipeThrough(new DecompressionStream('gzip')) : file.stream()).getReader();
      const { done, value } = await reader.read();
      if (done) return controller.close();
      onBytes(value.length);
      controller.enqueue(value);
    },
    cancel: (reason) => reader?.cancel(reason),
  }, { highWaterMark: 0 });
}

/**
 * `onBytes` is called as mlog-sql takes each piece of a trace, with the number
 * of plain bytes in it. Over a whole load they add up to the plainSize() of
 * every accepted file, which gives the load its progress.
 */
export function tracesFromFiles(files: readonly File[], onBytes: (bytes: number) => void = () => {}): TraceFiles {
  const traces: TraceSource[] = [];
  const rejected: Rejected[] = [];
  const accepted: File[] = [];
  const seen = new Set<string>();

  for (const file of [...files].sort((a, b) => a.name.localeCompare(b.name, 'en-US'))) {
    const match = NAME.exec(file.name);
    const cid = match?.[1];
    if (!match || !cid) {
      rejected.push({ file: file.name, reason: 'name is not <cid>_<client|server>.mlog[.gz]' });
      continue;
    }
    const gz = match[3] !== undefined;
    const name = gz ? file.name.slice(0, -'.gz'.length) : file.name;
    if (seen.has(name)) {
      rejected.push({ file: file.name, reason: `another file is already trace ${name}` });
      continue;
    }
    seen.add(name);
    accepted.push(file);
    traces.push({ name, cid, stream: counted(file, gz, onBytes) });
  }
  return { traces, rejected, accepted };
}

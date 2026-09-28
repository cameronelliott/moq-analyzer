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
}

// Greedy, so a cid may hold underscores and the last one splits off the role.
const NAME = /^([A-Za-z0-9_-]+)_(client|server)\.mlog(\.gz)?$/;

export function tracesFromFiles(files: readonly File[]): TraceFiles {
  const traces: TraceSource[] = [];
  const rejected: Rejected[] = [];
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
    const bytes = file.stream();
    traces.push({ name, cid, stream: gz ? bytes.pipeThrough(new DecompressionStream('gzip')) : bytes });
  }
  return { traces, rejected };
}

// The capture's distributions, from `bun run load-mlog`. The build reads the
// file rather than loading the mlogs itself, and fails here, by name, when the
// load has not been run.

import { existsSync, readFileSync } from 'node:fs';

const FILE = new URL('./distributions.json', import.meta.url);

export default () => {
  if (!existsSync(FILE)) {
    throw new Error('md/captures/real-6pop/distributions.json is missing: run `bun run load-mlog` first');
  }
  return { distributions: JSON.parse(readFileSync(FILE, 'utf8')) };
};

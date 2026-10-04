// Sample captures a reader can load without files of their own.
//
// The mlogs are in ../showcase/<id>/ and the build copies that directory to
// dist/showcase/. A showcase is fetched as files and then loaded exactly as
// dropped files are, so it goes through the same name rule and the same loader.

export interface Showcase {
  /** The directory under showcase/, and the `?showcase=` value that loads it. */
  readonly id: string;
  readonly title: string;
  readonly about: string;
  /** File names in showcase/<id>/, each `<cid>_<client|server>.mlog.gz`. */
  readonly files: readonly string[];
}

const ends = (cids: readonly string[], roles: readonly string[]) =>
  cids.flatMap((cid) => roles.map((role) => `${cid}_${role}.mlog.gz`));

// The text here is shown on the load page. Cameron rewrites it; keep it all here.
export const SHOWCASES: readonly Showcase[] = [
  {
    id: 'real-6pop',
    title: 'Six POPs, every log',
    about: 'One publisher, one relay and four subscribers on six AWS hosts, with both ends of every '
      + 'connection logged and the clocks held within 10 µs. Every measure has data. 10 files, 8.4 MB.',
    files: ends([
      'a5163379d342db3bb2e10e6b3db6b598',
      'c45a526b08ad99ea276b9813b0f66ac5',
      'cbdf0223f28262d1bd8e0ea465070b62',
      'd69664a3df26f06f765548d35e4115d2',
      'fb8ac5324b8a68c291bea912edbc0bd0',
    ], ['client', 'server']),
  },
  {
    id: 'vanilla',
    title: 'Stock moq-rs, relay logs only',
    about: 'What a relay operator has: the two logs of a stock moq-rs relay, with no stream ids and no '
      + 'reference_time. The analyzer recovers both, and shows relay dwell, bitrate and interarrival. '
      + '2 files, 40 KB.',
    files: ends(['8dac41349bb96aebec844f3445be943e', 'c8312b9d942b906545e42f9ab799e22b'], ['server']),
  },
];

export function showcaseById(id: string | null): Showcase | undefined {
  return SHOWCASES.find((s) => s.id === id);
}

/** What showcaseFiles needs of `fetch`: a URL in, a Response out. */
export type Fetcher = (url: string) => Promise<Response>;

/**
 * Fetch one showcase as Files, named for the loader. `onFile` is called after
 * each file with how many are done.
 */
export async function showcaseFiles(
  showcase: Showcase,
  fetcher: Fetcher = (url) => fetch(url),
  onFile: (done: number, of: number) => void = () => {},
): Promise<File[]> {
  const files: File[] = [];
  for (const name of showcase.files) {
    const response = await fetcher(`./showcase/${showcase.id}/${name}`);
    if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    // A host may send a .gz with Content-Encoding: gzip, and the browser then
    // hands over plain bytes. The loader picks gzip by name, so the name
    // follows the bytes.
    const gzip = bytes[0] === 0x1f && bytes[1] === 0x8b;
    files.push(new File([bytes], gzip ? name : name.replace(/\.gz$/, '')));
    onFile(files.length, showcase.files.length);
  }
  return files;
}

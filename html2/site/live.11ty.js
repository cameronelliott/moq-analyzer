// One live page per document -- the browser-rendered half of the comparison.
//
// Pagination over the `docs` collection is the capability BRIEF.md says the
// spike is meant to demonstrate: a page per capture, from data, without a
// hand-written file each.

import { shell } from './_shell.js';

export default class Live {
  data() {
    return {
      pagination: { data: 'docs', size: 1, alias: 'doc' },
      permalink: ({ doc }) => `live/${doc.slug}.html`,
      eleventyExcludeFromCollections: true,
    };
  }

  render({ doc }) {
    return shell({ title: doc.title, mode: 'live', src: doc.src });
  }
}

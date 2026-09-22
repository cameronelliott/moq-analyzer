// Bundle entry for the live pages: everything app.js has, plus the markdown
// element and therefore `marked`.
//
// Same two imports in the same order, for the same reason.
import '@lit-labs/ssr-client/lit-element-hydrate-support.js';
import '@awesome.me/webawesome/dist/components/button/button.js';

import '../lib/markdown-element.js';

// The live half: fetch the same markdown file the static page was built from,
// and hand it to <app-markdown> as a property. Setting `content` as a property
// rather than an attribute is deliberate -- an attribute would put the whole
// document in the HTML, which is the thing a live page is avoiding.
const el = document.querySelector('app-markdown');
if (el) {
  const res = await fetch(el.dataset.src);
  el.content = await res.text();
  await el.updateComplete;
  document.documentElement.dataset.rendered = 'live';
}

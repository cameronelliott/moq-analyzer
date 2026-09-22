// This site's bundle entry.
//
// A page used to carry an importmap and six lines of wiring. Neither varied
// between pages, so both live here now and a page is down to one script tag:
//
//   <script type="module" src="dist/app.js"></script>
//
// The wiring runs against whatever the page provides and skips what it does
// not, so a page without a sidebar or without a scheme toggle is a page that
// simply leaves those elements out.
//
// Everything site-specific is here or beside it: which chart types to build
// with, which wa-* components to register, which icons exist. lib/ holds what
// is the same for any site.

// Note what is missing: the markdown element, and so `marked`. These pages
// arrive rendered, with their sidebar already in the HTML, so nothing here
// parses markdown and the parser stays out of the bundle. A page that renders
// markdown while it runs imports lib/markdown-element.js and pays for it.
import { configureCharts } from '../lib/chart-element.js';
import { installSchemeToggle } from '../lib/scheme.js';

// The import() literal stays here rather than in lib/, which is what keeps
// ECharts in its own chunk instead of the entry.
configureCharts(() => import('./charts.js'));

// Web Awesome's loader finds components by scanning the document at runtime,
// which cannot be bundled. Listing them here is what replaces it: these are the
// wa-* elements a page may use.
import '@awesome.me/webawesome/dist/components/page/page.js';
import '@awesome.me/webawesome/dist/components/button/button.js';
import { registerIconLibrary } from '@awesome.me/webawesome/dist/components/icon/library.js';

// wa-page draws its own mobile menu button with <wa-icon name="bars">, and the
// stock 'default' library resolves that to a Font Awesome CDN URL at runtime --
// one more origin, for one glyph. Overriding the library keeps every asset
// local. Icons the page asks for and this does not know about render as
// nothing, which is the trade: a closed icon set for a closed origin list.
const ICONS = {
  bars: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" '
    + 'stroke="currentColor" stroke-width="2" stroke-linecap="round">'
    + '<path d="M3 6h18M3 12h18M3 18h18"/></svg>',
};

registerIconLibrary('default', {
  resolver: (name) => (name in ICONS
    ? `data:image/svg+xml,${encodeURIComponent(ICONS[name])}`
    : ''),
});

const toggle = document.getElementById('scheme');
if (toggle) installSchemeToggle(toggle);

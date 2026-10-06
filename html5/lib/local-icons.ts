// The icons the site draws, kept in the bundle.
//
// wa-page draws its mobile menu button with <wa-icon name="bars">, and the
// stock 'default' library resolves that to a Font Awesome CDN URL at runtime --
// one more origin, for one glyph. Overriding the library keeps every asset
// local; an icon it does not know renders as nothing. Overview cards add
// circle-info, and the header's scheme switch adds sun, moon and
// circle-half-stroke.

import { registerIconLibrary } from '@awesome.me/webawesome/dist/components/icon/library.js';

const ICONS: Record<string, string> = {
  bars: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" '
    + 'stroke="currentColor" stroke-width="2" stroke-linecap="round">'
    + '<path d="M3 6h18M3 12h18M3 18h18"/></svg>',
  'circle-info': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" '
    + 'stroke="currentColor" stroke-width="2" stroke-linecap="round">'
    + '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>',
  sun: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" '
    + 'stroke="currentColor" stroke-width="2" stroke-linecap="round">'
    + '<circle cx="12" cy="12" r="4"/>'
    + '<path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4'
    + 'M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  moon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" '
    + 'stroke="currentColor" stroke-width="2" stroke-linejoin="round">'
    + '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/></svg>',
  'circle-half-stroke': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" '
    + 'fill="none" stroke="currentColor" stroke-width="2">'
    + '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor"/></svg>',
};

/** Makes these icons the 'default' library. Call it once, before any wa-icon draws. */
export function useLocalIcons(): void {
  registerIconLibrary('default', {
    resolver: (name) => {
      const svg = ICONS[name];
      return svg ? `data:image/svg+xml,${encodeURIComponent(svg)}` : '';
    },
  });
}

// The page's color scheme.
//
// Web Awesome drives light/dark with explicit classes on <html>, so anything
// that cannot be themed with CSS alone -- a canvas, for instance -- has to
// notice the change. Watching the class list means noticing is the widget's
// job: nothing has to announce the flip, and nothing has to be told where to
// listen.
//
// Its own file because the chart element needs it and the markdown element does
// not. A page that renders no markdown should not pull a markdown parser into
// its bundle just to follow the theme.

/** True while the page is showing Web Awesome's dark scheme. */
export const isDark = () => document.documentElement.classList.contains('wa-dark');

/** Calls back when <html> flips light/dark. Returns a disposer. */
export function watchScheme(onChange) {
  let dark = isDark();
  const observer = new MutationObserver(() => {
    // Two class mutations per flip, and other code may touch the list for
    // reasons of its own, so report the transition rather than the record.
    if (dark === isDark()) return;
    dark = !dark;
    onChange();
  });
  observer.observe(document.documentElement, { attributeFilter: ['class'] });
  return () => observer.disconnect();
}

/**
 * Wires a button to flip the scheme. It sets two classes and stops there --
 * the icon is CSS, and whatever else needs to follow is watching.
 */
export function installSchemeToggle(button) {
  button.addEventListener('click', () => {
    const root = document.documentElement;
    const dark = root.classList.toggle('wa-dark');
    root.classList.toggle('wa-light', !dark);
  });
}

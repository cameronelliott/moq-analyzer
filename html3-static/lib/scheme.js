// The page's color scheme.
//
// Web Awesome drives light/dark with explicit classes on <html>, so anything
// that cannot be themed with CSS alone -- a canvas, for instance -- has to
// notice the change. Watching the class list means noticing is the widget's
// job: nothing has to announce the flip, and nothing has to be told where to
// listen.
//
// The reader picks 'light', 'dark' or 'auto', kept in localStorage; auto
// follows the system setting, live. An inline script in base.liquid's <head>
// repeats applyScheme's rule before first paint, so a dark page never flashes
// light while this module loads. Keep the two in step.

const KEY = 'scheme';
const SYSTEM_DARK = '(prefers-color-scheme: dark)';

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

/** The stored preference, 'auto' when there is none or storage is blocked. */
export function storedScheme() {
  try {
    const stored = localStorage.getItem(KEY);
    return stored === 'light' || stored === 'dark' ? stored : 'auto';
  } catch {
    return 'auto';
  }
}

/** Sets <html>'s two scheme classes for a preference. */
export function applyScheme(preference) {
  const dark = preference === 'dark'
    || (preference === 'auto' && matchMedia(SYSTEM_DARK).matches);
  const root = document.documentElement;
  root.classList.toggle('wa-dark', dark);
  root.classList.toggle('wa-light', !dark);
}

/**
 * Wires radio inputs valued 'light', 'dark' and 'auto' to the preference:
 * checks the stored one, stores and applies a new pick, and follows the system
 * while on auto. It sets classes and stops there -- whatever else needs to
 * follow is watching.
 */
export function installSchemeSwitch(container) {
  let preference = storedScheme();
  for (const radio of container.querySelectorAll('input[type=radio]')) {
    radio.checked = radio.value === preference;
  }

  container.addEventListener('change', (event) => {
    preference = event.target.value;
    try {
      localStorage.setItem(KEY, preference);
    } catch {
      // Blocked storage: the pick still holds for this page.
    }
    applyScheme(preference);
  });

  matchMedia(SYSTEM_DARK).addEventListener('change', () => {
    if (preference === 'auto') applyScheme('auto');
  });
}

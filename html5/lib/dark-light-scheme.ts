// The page's color scheme. From ../html3/lib/scheme.js.
//
// Web Awesome drives light/dark with explicit classes on <html>, so anything
// that cannot be themed with CSS alone -- a canvas, for instance -- has to
// notice the change. Watching the class list means noticing is the widget's
// job: nothing has to announce the flip, and nothing has to be told where to
// listen.
//
// The reader picks 'light', 'dark' or 'auto', kept in localStorage; auto
// follows the system setting, live. An inline script in index.html's <head>
// repeats applyScheme's rule before first paint, so a dark page never flashes
// light while this module loads. Keep the two in step.

export type Scheme = 'light' | 'dark' | 'auto';

const KEY = 'scheme';
const SYSTEM_DARK = '(prefers-color-scheme: dark)';

const isScheme = (value: unknown): value is Scheme =>
  value === 'light' || value === 'dark' || value === 'auto';

/** True while the page is showing Web Awesome's dark scheme. */
export const isDark = (): boolean => document.documentElement.classList.contains('wa-dark');

/** Calls back when <html> flips light/dark. Returns a disposer. */
export function watchScheme(onChange: () => void): () => void {
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
export function storedScheme(): Scheme {
  try {
    const stored = localStorage.getItem(KEY);
    return stored === 'light' || stored === 'dark' ? stored : 'auto';
  } catch {
    return 'auto';
  }
}

/** Sets <html>'s two scheme classes for a preference. */
export function applyScheme(preference: Scheme): void {
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
export function installSchemeSwitch(container: HTMLElement): void {
  let preference = storedScheme();
  for (const radio of container.querySelectorAll<HTMLInputElement>('input[type=radio]')) {
    radio.checked = radio.value === preference;
  }

  container.addEventListener('change', (event) => {
    const value = event.target instanceof HTMLInputElement ? event.target.value : undefined;
    if (!isScheme(value)) return;
    preference = value;
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

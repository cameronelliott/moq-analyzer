// An `html` tagged template that escapes every value, and the SafeHtml type it
// makes. Mlog data is not trusted -- the showcase will show other people's
// sessions -- so a value becomes markup only by passing through here.

const BRAND: unique symbol = Symbol('SafeHtml');

/** Markup that is safe to put in the page. Only `html` makes one. */
export interface SafeHtml {
  readonly [BRAND]: true;
  readonly text: string;
}

export type HtmlValue = SafeHtml | string | number | null | undefined | readonly HtmlValue[];

const ESCAPES: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
};

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);

function isSafe(value: HtmlValue): value is SafeHtml {
  return typeof value === 'object' && value !== null && BRAND in value;
}

function print(value: HtmlValue): string {
  if (value === null || value === undefined) return '';
  if (isSafe(value)) return value.text;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return escape(value);
  return value.map(print).join('');
}

export function html(strings: TemplateStringsArray, ...values: HtmlValue[]): SafeHtml {
  let text = strings[0] ?? '';
  values.forEach((value, i) => {
    text += print(value) + (strings[i + 1] ?? '');
  });
  return { [BRAND]: true, text };
}

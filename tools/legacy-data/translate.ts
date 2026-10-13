// Spanish → English for the legacy data, using lang-en.js (the legacy runtime translation table)
// first and our own table for everything it doesn't cover. Unknown text is an error, so nothing
// Spanish slips into the generated JSON.
import { EXTRA_TRANSLATIONS } from './translations.js';

export interface Translator {
  (spanish: string): string;
  /** lang-en.js keys used for game data (so they aren't seeded into the UI strings). */
  readonly used: ReadonlySet<string>;
  /** Text that had no translation; the conversion fails if any. */
  readonly missing: ReadonlySet<string>;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function createTranslator(dictionary: Record<string, string>): Translator {
  const table = new Map<string, string>();
  const patternTable = new Map<string, string>();
  const used = new Set<string>();
  const missing = new Set<string>();
  const add = (spanish: string, english: string) => {
    if (spanish.includes('{x}')) patternTable.set(spanish, english);
    else table.set(spanish, english);
  };
  for (const [es, en] of Object.entries(dictionary)) add(es, en);
  // Ours override lang-en.js.
  const overrides = new Set<string>();
  for (const [es, en] of Object.entries(EXTRA_TRANSLATIONS)) {
    add(es, en);
    overrides.add(es);
  }
  // Most specific first: "Vence a los {x} legendarios." must win over "Vence a {x}".
  const patterns = [...patternTable]
    .map(([spanish, english]) => ({
      spanish,
      english,
      re: new RegExp('^' + spanish.split('{x}').map(escape).join('(.+?)') + '$', 'u'),
      literal: spanish.replace(/\{x\}/g, '').length,
    }))
    .sort((a, b) => b.literal - a.literal);

  function translate(spanish: string): string {
    const exact = table.get(spanish);
    if (exact !== undefined) {
      if (!overrides.has(spanish)) used.add(spanish);
      return exact;
    }
    for (const { spanish: key, re, english } of patterns) {
      const m = re.exec(spanish);
      if (!m) continue;
      if (!overrides.has(key)) used.add(key);
      const parts = m.slice(1).map((part) => {
        // Captured text (names, numbers) is translated too when we know it.
        return table.has(part) ? translate(part) : part;
      });
      let i = 0;
      return english.replace(/\{x\}/g, () => parts[i++] ?? '');
    }
    missing.add(spanish);
    return spanish;
  }
  return Object.assign(translate, { used, missing });
}

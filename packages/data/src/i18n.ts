// UI strings. All user-facing text that isn't game data lives in i18n/en.json, grouped by screen;
// other languages can be added later as sibling files with the same keys.
import en from '../i18n/en.json' with { type: 'json' };

type Leaves<T, Prefix extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? `${Prefix}${K}` : Leaves<T[K], `${Prefix}${K}.`>;
}[keyof T & string];

/** Dotted path of a UI string, e.g. `"menu.play"`. */
export type UiStringKey = Leaves<typeof en>;
export type TextParams = Readonly<Record<string, string | number>>;

export const uiStrings = en;

/** Replaces `{name}` placeholders with `params[name]`; unknown placeholders are left as they are. */
export function formatText(template: string, params?: TextParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );
}

/** The English UI string for `key`, with `params` filled in. Unknown keys return the key. */
export function t(key: UiStringKey, params?: TextParams): string {
  let node: unknown = en;
  for (const part of key.split('.')) {
    node =
      typeof node === 'object' && node !== null
        ? (node as Record<string, unknown>)[part]
        : undefined;
  }
  return typeof node === 'string' ? formatText(node, params) : key;
}

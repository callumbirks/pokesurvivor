// The admin page's live-tuning helpers: what changed between two configs, setting by setting,
// and JSON parse errors with their line.
import { TUNABLE_FILES, type TunableConfig } from '@pokesurvivor/data';

/** One changed setting: `file` and `path` (`spawner.cap`), its value before and after. */
export interface ConfigChange {
  file: string;
  path: string;
  from: unknown;
  to: unknown;
}

function at(obj: unknown, path: readonly string[]): unknown {
  let o = obj;
  for (const k of path)
    o = o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined;
  return o;
}

/**
 * The leaves that differ between two values: into objects key by key, and into arrays item by
 * item when both have the same length (a curve point changed); otherwise the whole value.
 */
function leafDiffs(a: unknown, b: unknown, path: string[]): [string[], unknown, unknown][] {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  const both = (f: (v: unknown) => boolean) => f(a) && f(b);
  if (both(Array.isArray) && (a as unknown[]).length === (b as unknown[]).length)
    return (a as unknown[]).flatMap((x, i) =>
      leafDiffs(x, (b as unknown[])[i], [...path, String(i)]),
    );
  const isObject = (v: unknown) => !!v && typeof v === 'object' && !Array.isArray(v);
  if (both(isObject)) {
    const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
    return [...keys].flatMap((k) => leafDiffs(at(a, [k]), at(b, [k]), [...path, k]));
  }
  return [[path, a, b]];
}

/** The settings `to` changes from `from` (each value; a resized array is one setting). */
export function configChanges(from: TunableConfig, to: TunableConfig): ConfigChange[] {
  return TUNABLE_FILES.flatMap((file) =>
    leafDiffs(from[file], to[file], []).map(([path, a, b]) => ({
      file,
      path: path.join('.'),
      from: a,
      to: b,
    })),
  );
}

/** JSON on one line, spaced like the data files (`{ "a": 1, "b": [1, 2] }`). */
function oneLine(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(oneLine).join(', ')}]`;
  if (v && typeof v === 'object') {
    const body = Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${oneLine(x)}`);
    return body.length ? `{ ${body.join(', ')} }` : '{}';
  }
  return JSON.stringify(v);
}

/**
 * JSON laid out like the repo's data files (as Prettier leaves them): an object or array that
 * fits in `width` on one line stays on one line, anything bigger gets a line per entry.
 */
export function formatJson(v: unknown, width = 100, indent = ''): string {
  const flat = oneLine(v);
  if (indent.length + flat.length <= width || !v || typeof v !== 'object') return flat;
  const inner = `${indent}  `;
  const lines = Array.isArray(v)
    ? v.map((x) => inner + formatJson(x, width, inner))
    : Object.entries(v).map(
        ([k, x]) => `${inner}${JSON.stringify(k)}: ${formatJson(x, width - k.length - 4, inner)}`,
      );
  const [open, close] = Array.isArray(v) ? ['[', ']'] : ['{', '}'];
  return `${open}\n${lines.join(',\n')}\n${indent}${close}`;
}

/** A value for the diff list: JSON, on one line. */
export function showValue(v: unknown): string {
  return v === undefined ? '—' : oneLine(v);
}

class JsonStop extends Error {
  constructor(readonly at: number) {
    super(`invalid JSON at ${at}`);
  }
}

/**
 * Where `text` stops being JSON: the offset of the first character a JSON parser can't take (a
 * small recursive-descent scan; browsers' `JSON.parse` messages often don't say where).
 */
export function jsonErrorOffset(text: string): number {
  let i = 0;
  const ws = () => {
    while (i < text.length && ' \t\n\r'.includes(text[i]!)) i++;
  };
  const fail = (): never => {
    throw new JsonStop(i);
  };
  const lit = (word: string) => {
    if (text.startsWith(word, i)) i += word.length;
    else fail();
  };
  const str = () => {
    i++; // the opening quote
    while (i < text.length && text[i] !== '"') {
      if (text[i] === '\\') i++;
      else if (text.charCodeAt(i) < 0x20) fail();
      i++;
    }
    if (i >= text.length) fail();
    i++;
  };
  const num = () => {
    const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i));
    if (!m) fail();
    i += m![0].length;
  };
  const value = (): void => {
    ws();
    const c = text[i];
    if (c === '{') {
      i++;
      ws();
      if (text[i] === '}') return void i++;
      for (;;) {
        ws();
        if (text[i] !== '"') fail();
        str();
        ws();
        if (text[i] !== ':') fail();
        i++;
        value();
        ws();
        if (text[i] === ',') i++;
        else if (text[i] === '}') return void i++;
        else fail();
      }
    }
    if (c === '[') {
      i++;
      ws();
      if (text[i] === ']') return void i++;
      for (;;) {
        value();
        ws();
        if (text[i] === ',') i++;
        else if (text[i] === ']') return void i++;
        else fail();
      }
    }
    if (c === '"') return str();
    if (c === 't') return lit('true');
    if (c === 'f') return lit('false');
    if (c === 'n') return lit('null');
    num();
  };
  try {
    value();
    ws();
    return i < text.length ? i : -1;
  } catch (err) {
    if (err instanceof JsonStop) return err.at;
    throw err;
  }
}

/** `JSON.parse` that says where it failed (line and column) instead of throwing. */
export function parseJson(
  text: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const at = jsonErrorOffset(text);
    if (at < 0) return { ok: false, error: message };
    const before = text.slice(0, at);
    const line = before.split('\n').length;
    const column = at - before.lastIndexOf('\n');
    const short = message.split(/[,:]/)[0] ?? message;
    return { ok: false, error: `${short} (line ${line}, column ${column})` };
  }
}

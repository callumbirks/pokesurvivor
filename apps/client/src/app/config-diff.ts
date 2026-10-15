// The admin page's live-tuning helpers: what changed between two configs, setting by setting,
// and JSON parse errors with their line.
import { diffPatch, patchLeaves, TUNABLE_FILES, type TunableConfig } from '@pokesurvivor/data';

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

/** The settings `to` changes from `from` (each leaf; an array is one setting). */
export function configChanges(from: TunableConfig, to: TunableConfig): ConfigChange[] {
  return TUNABLE_FILES.flatMap((file) => {
    const patch = diffPatch(from[file], to[file]);
    if (patch === undefined) return [];
    return patchLeaves(patch).map(([path]) => ({
      file,
      path: path.join('.'),
      from: at(from[file], path),
      to: at(to[file], path),
    }));
  });
}

/** A value for the diff list: JSON, on one line. */
export function showValue(v: unknown): string {
  return v === undefined ? '—' : JSON.stringify(v);
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
    throw i;
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
  } catch (at) {
    return typeof at === 'number' ? at : 0;
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

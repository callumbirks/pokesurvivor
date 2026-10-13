import type { z } from 'zod';

/** Validates one data file, with the file name in the error. */
export function parseDataFile<S extends z.ZodType>(
  file: string,
  schema: S,
  data: unknown,
): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success)
    throw new Error(`Invalid game data in ${file}.json: ${result.error.message}`);
  return result.data;
}

/** Index `items` by `key`, rejecting duplicates. */
export function indexBy<T, K>(items: readonly T[], key: (item: T) => K, what: string): Map<K, T> {
  const map = new Map<K, T>();
  for (const item of items) {
    const k = key(item);
    if (map.has(k)) throw new Error(`Duplicate ${what}: ${String(k)}`);
    map.set(k, item);
  }
  return map;
}

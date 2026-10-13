/** Postgres SQLSTATE of an error, unwrapping Drizzle's `DrizzleQueryError`. */
function sqlState(err: unknown): string | undefined {
  for (let e: unknown = err; e instanceof Error; e = e.cause) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

export function isUniqueViolation(err: unknown): boolean {
  return sqlState(err) === '23505';
}

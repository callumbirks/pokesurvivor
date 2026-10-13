import { hash, verify } from '@node-rs/argon2';

// `Algorithm` is a `const enum` in @node-rs/argon2's typings, which `isolatedModules` can't
// inline, so use its value. Argon2id is also the library default.
const ARGON2ID = 2;

/** OWASP's recommended minimum for argon2id: 19 MiB, 2 passes, 1 lane. */
const OPTIONS = { algorithm: ARGON2ID, memoryCost: 19_456, timeCost: 2, parallelism: 1 };

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    // A malformed stored hash is a failed login, not a 500.
    return false;
  }
}

/** A real hash to verify against when the username doesn't exist, so timing doesn't leak it. */
let dummyHash: Promise<string> | undefined;
export async function verifyDummyPassword(password: string): Promise<false> {
  dummyHash ??= hashPassword('dummy password for timing');
  await verifyPassword(await dummyHash, password);
  return false;
}

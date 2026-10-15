import { randomInt } from 'node:crypto';

// No vowels, nothing that reads as one in leetspeak (0, 1, 3, 4, 5, 9) and no c/f/k/s/t, so a
// random suffix can't spell a word the server's username filter rejects (`fck`, `a55`, …).
const ALPHABET = 'bdghjmnpqrvwxz2678';

/** A random username suffix, 8 characters. */
export function nameSuffix(): string {
  let out = '';
  for (let i = 0; i < 8; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

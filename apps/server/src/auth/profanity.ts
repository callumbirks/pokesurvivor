import {
  DataSet,
  RegExpMatcher,
  englishDataset,
  englishRecommendedTransformers,
  pattern,
} from 'obscenity';

/**
 * The offensive-word matcher for usernames: obscenity's English dataset and transformers
 * (confusables, case folding, repeated letters), plus a few extra words and names it misses, and
 * whitelisted real words and names that contain a listed word once separators are removed.
 */
const dataset = new DataSet<{ originalWord: string }>()
  .addAll(englishDataset)
  // The dataset only matches `fag` at the start of a word.
  .addPhrase((p) => p.setMetadata({ originalWord: 'fag' }).addPattern(pattern`fag[g]ot`))
  .addPhrase((p) => p.setMetadata({ originalWord: 'hitler' }).addPattern(pattern`hitler`))
  .addPhrase((p) => p.setMetadata({ originalWord: 'nazi' }).addPattern(pattern`nazi`))
  .addPhrase((p) =>
    p
      .setMetadata({ originalWord: 'pedo' })
      .addPattern(pattern`pedo`)
      .addPattern(pattern`paedo`)
      .addWhitelistedTerm('torpedo')
      .addWhitelistedTerm('sharpedo')
      .addWhitelistedTerm('speedo')
      .addWhitelistedTerm('pedometer'),
  )
  // Real names and words the list would flag (obscenity already allows e.g. Scunthorpe, assassin
  // and Cockburn). The matcher applies whitelisted terms to every phrase.
  .addPhrase((p) =>
    p
      .setMetadata({ originalWord: 'whitelist' })
      .addWhitelistedTerm('dickson')
      .addWhitelistedTerm('dickinson')
      .addWhitelistedTerm('penistone')
      .addWhitelistedTerm('shiitake'),
  );

const matcher = new RegExpMatcher({ ...dataset.build(), ...englishRecommendedTransformers });

/** Leetspeak and look-alike symbols. `1` is ambiguous (i or l), so both readings are checked. */
const LEET: Record<string, string> = {
  '0': 'o',
  '2': 'z',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '6': 'g',
  '7': 't',
  '8': 'b',
  '9': 'g',
  '@': 'a',
  $: 's',
  '!': 'i',
  '|': 'l',
  '+': 't',
};

/**
 * The forms of `name` to match: diacritics removed, case folded, leetspeak resolved, and
 * separators (`_`, `-`, `.`, spaces, any other punctuation) both removed (`f_u_c_k` → `fuck`) and
 * turned into spaces (so word-boundary patterns still see `my_sex` as two words). The joined form
 * is also checked with every repeated letter collapsed: obscenity keeps doubles of some letters
 * (`gg`, `oo`, …), which lets `whoooore` through.
 */
function variants(name: string): string[] {
  const base = name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}1]/gu, (c) => LEET[c] ?? (/\p{N}/u.test(c) ? '' : ' '));
  const out: string[] = [];
  for (const one of ['i', 'l']) {
    const spaced = base.replaceAll('1', one).replace(/ +/g, ' ').trim();
    const joined = spaced.replaceAll(' ', '');
    out.push(spaced, joined, joined.replace(/(.)\1+/gu, '$1'));
  }
  return out;
}

/** Whether `name` contains an offensive word, including leetspeak, separator and repeat variants. */
export function isOffensiveUsername(name: string): boolean {
  return variants(name).some((v) => matcher.hasMatch(v));
}

// English names and ids for the legacy data, where lang-en.js doesn't cover them.
// Pokémon, move and item names are the official English ones (checked against PokeAPI).

/** Kebab-case id from an English name: "Mr. Mime" → "mr-mime", "Nidoran♀" → "nidoran-f". */
export function slugify(name: string): string {
  return name
    .replace(/♀/g, '-f')
    .replace(/♂/g, '-m')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’.:]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Pokémon the legacy pokedex.js names in Spanish → official English name (PokeAPI). */
export const POKEMON_NAME_FIXES: Record<number, string> = {
  772: 'Type: Null',
  984: 'Great Tusk',
  985: 'Scream Tail',
  987: 'Flutter Mane',
  988: 'Slither Wing',
  989: 'Sandy Shocks',
  991: 'Iron Bundle',
  992: 'Iron Hands',
  994: 'Iron Moth',
  995: 'Iron Thorns',
  1005: 'Roaring Moon',
  1006: 'Iron Valiant',
  1009: 'Walking Wake',
  1010: 'Iron Leaves',
};

/**
 * Moves whose legacy id no longer matches the move: Giga Drain was reworked into Grass Knot but
 * kept its id for old saves, and "leaf-storm" is Petal Blizzard (Leaf Storm is Razor Leaf's
 * evolution). Every other move keeps its legacy id.
 */
export const MOVE_ID_RENAMES: Record<string, string> = {
  'giga-drain': 'grass-knot',
  'leaf-storm': 'petal-blizzard',
};

export const ITEM_IDS: Record<string, string> = {
  leftovers: 'leftovers',
  choiceband: 'choice-band',
  quickclaw: 'quick-claw',
  focussash: 'focus-sash',
  shellbell: 'shell-bell',
  amuletcoin: 'amulet-coin',
  luckyegg: 'lucky-egg',
  lifeorb: 'life-orb',
  choicescarf: 'choice-scarf',
  rockyhelmet: 'rocky-helmet',
  assaultvest: 'assault-vest',
};

export const UPGRADE_IDS: Record<string, string> = {
  hp: 'max-hp',
  atk: 'attack',
  spd: 'speed',
  cd: 'cooldown',
  def: 'defense',
  regen: 'regen',
  magnet: 'magnet',
  xp: 'experience',
  coins: 'coins',
  moves: 'extra-move',
  crit: 'crit',
  reroll: 'reroll',
  ban: 'ban',
};

export const STAT_CARD_IDS: Record<string, string> = {
  hp: 'max-hp',
  atk: 'attack',
  spd: 'speed',
  cd: 'cooldown',
  def: 'defense',
  rgn: 'regen',
  mag: 'magnet',
  xp: 'experience',
  heal: 'heal',
};

export const MISSION_IDS: Record<string, string> = {
  kill: 'defeat',
  killType: 'defeat-type',
  survive: 'survive',
  level: 'reach-level',
  boss: 'defeat-boss',
  chest: 'open-chest',
  coins: 'collect-coins',
  playType: 'survive-type',
  item: 'find-item',
  evolve: 'evolve-move',
  wkill: 'weekly-defeat',
  wrift: 'weekly-rift-win',
  wboss: 'weekly-defeat-boss',
  wsurvive: 'weekly-survive',
  wevolve: 'weekly-evolve-move',
  wdaily: 'weekly-daily-missions',
};

export const ACHIEVEMENT_IDS: Record<string, string> = {
  own1: 'own-1',
  own10: 'own-10',
  own50: 'own-50',
  own100: 'own-100',
  own250: 'own-250',
  own500: 'own-500',
  ownAll: 'own-all',
  shiny1: 'shiny-1',
  shiny5: 'shiny-5',
  shiny20: 'shiny-20',
  pulls100: 'pulls-100',
  time5: 'survive-5',
  time10: 'survive-10',
  time15: 'survive-15',
  time20: 'survive-20',
  // The legacy ids say 20 and 40 but the goals are 15 and 30.
  lvl20: 'level-15',
  lvl40: 'level-30',
  runs50: 'runs-50',
  kills1k: 'defeat-1k',
  kills10k: 'defeat-10k',
  kills100k: 'defeat-100k',
  boss1: 'boss-1',
  boss25: 'boss-25',
  boss100: 'boss-100',
  evo1: 'evolve-1',
  evo25: 'evolve-25',
  evoAll: 'evolve-all',
  items5: 'items-5',
  itemsAll: 'items-all',
  rift1: 'rift-1',
  rift10: 'rift-10',
  arenas: 'arenas-all',
  leg10: 'legendaries-10',
  leg30: 'legendaries-30',
  legAll: 'legendaries-all',
  mis10: 'missions-10',
  mis50: 'missions-50',
  mis200: 'missions-200',
  group1: 'group-1',
  group10: 'group-10',
};

/** Personality traits (legacy ids are Spanish words). */
export const TRAITS: Record<string, { id: string; name: string }> = {
  valiente: { id: 'brave', name: 'Brave' },
  impulsivo: { id: 'impulsive', name: 'Impulsive' },
  prudente: { id: 'cautious', name: 'Cautious' },
  leal: { id: 'loyal', name: 'Loyal' },
  paciente: { id: 'patient', name: 'Patient' },
  dulce: { id: 'gentle', name: 'Gentle' },
  tímido: { id: 'timid', name: 'Timid' },
  travieso: { id: 'mischievous', name: 'Mischievous' },
  sereno: { id: 'serene', name: 'Serene' },
  astuto: { id: 'clever', name: 'Clever' },
  alegre: { id: 'cheerful', name: 'Cheerful' },
  tenaz: { id: 'tenacious', name: 'Tenacious' },
  orgulloso: { id: 'proud', name: 'Proud' },
  solitario: { id: 'lone-wolf', name: 'Lone Wolf' },
  tranquilo: { id: 'relaxed', name: 'Relaxed' },
  caótico: { id: 'chaotic', name: 'Chaotic' },
};

/** Spanish → English for data text lang-en.js lacks (or gets wrong); these take precedence. */
export const EXTRA_TRANSLATIONS: Record<string, string> = {
  // Region names that are the same in English (lang-en.js only lists the ones that differ).
  ...Object.fromEntries(
    ['Kanto', 'Johto', 'Hoenn', 'Sinnoh', 'Kalos', 'Alola', 'Galar', 'Paldea'].map((r) => [r, r]),
  ),
};

// Nothing Spanish may remain in the game data or the UI strings.
import { describe, expect, it } from 'vitest';
import { formatText, loadGameData, rawData, t, uiStrings } from '../src/index.js';

/** Words that are Spanish and not English (whole words, case-insensitive). */
const SPANISH_WORDS = new RegExp(
  '(?<![\\p{L}-])(' +
    [
      'de',
      'del',
      'el',
      'los',
      'las',
      'la',
      'que',
      'con',
      'por',
      'para',
      'una',
      'uno',
      'unos',
      'sin',
      'muy',
      'cada',
      'todos?',
      'todas?',
      'vida',
      'recarga',
      'movimientos?',
      'enemigos?',
      'tipo',
      'nivel',
      'partida',
      'jugar',
      'tienes',
      'puedes',
      'tus?',
      'pero',
      'ahora',
      'siempre',
      'nunca',
      'hasta',
      'desde',
      'entre',
      'sobre',
      'grietas?',
      'monedas',
      'objetos?',
      'alrededor',
      'cerca',
      'veces',
      'jefes?',
      'derrota',
      'aguanta',
      'consigue',
      'vence',
      'juega',
      'abre',
      'recoge',
      'llega',
      'evoluciona',
      'golpea',
      'dispara',
      'rayo',
      'fuego',
      'agua',
      'hielo',
      'planta',
      'veneno',
      'tierra',
      'roca',
      'bicho',
      'hada',
      'acero',
      'lucha',
      'siniestro',
      'volador',
      'les?',
      'se',
      'es',
      'son',
      'al',
      'lo',
      'y',
      'en',
    ].join('|') +
    ')(?![\\p{L}-])',
  'u',
);
/** Spanish punctuation and letters (accents are fine in a few English words, checked below). */
const SPANISH_CHARS = /[¿¡ñÑáíóúÁÍÓÚ]/;
const ACCENTED_ENGLISH = ['Pokémon', 'Pokédex', 'PokéCoin', 'PokéSurvivor', 'Poké'];

/** Pokémon names with accents or symbols (Flabébé, Nidoran♀…). */
const pokemonNames = loadGameData()
  .pokedex.map((p) => p.name)
  .filter((name) => /[^\x20-\x7e]/.test(name));

/** Every display string under `value` (ids, the kebab-case identifiers, and colours aren't text). */
function strings(value: unknown, path: string, out: [string, string][]) {
  if (typeof value === 'string') {
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(value) && !/^#[0-9a-f]{6}$/i.test(value))
      out.push([path, value]);
  } else if (Array.isArray(value)) value.forEach((v, i) => strings(v, `${path}[${i}]`, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) strings(v, `${path}.${k}`, out);
  }
}

function spanishIn(text: string): string | undefined {
  let rest = text;
  // Pokémon names (Flabébé…) and a few English words legitimately carry accents.
  for (const name of [...pokemonNames, ...ACCENTED_ENGLISH]) rest = rest.split(name).join(' ');
  const accented = /\S*[À-ÖØ-öø-ÿ]\S*/.exec(rest);
  if (accented) return accented[0];
  return rest.match(SPANISH_CHARS)?.[0] ?? rest.match(SPANISH_WORDS)?.[0];
}

describe('no Spanish left', () => {
  const all: [string, string][] = [];
  // Music is note names and drum patterns, not text.
  strings({ ...rawData, music: undefined }, 'data', all);
  strings(uiStrings, 'en', all);

  it('scans a meaningful amount of text', () => {
    expect(all.length).toBeGreaterThan(2000);
  });

  it('in the game data or UI strings', () => {
    const found = all
      .map(([path, text]) => [path, text, spanishIn(text)] as const)
      .filter(([, , hit]) => hit !== undefined)
      .map(([path, text, hit]) => `${path}: "${text}" (${hit})`);
    expect(found).toEqual([]);
  });

  it('catches Spanish text', () => {
    expect(spanishIn('Derrota a 10 jefes')).toBeDefined();
    expect(spanishIn('Bola de fuego al enemigo más cercano.')).toBeDefined();
    expect(spanishIn('¡Nivel 5!')).toBeDefined();
    expect(spanishIn('Recuperas vida con el daño que haces.')).toBeDefined();
    expect(spanishIn('Catch Flabébé and get a PokéCoin!')).toBeUndefined();
    expect(spanishIn('A fireball at the nearest enemy.')).toBeUndefined();
  });
});

describe('t()', () => {
  it('looks up UI strings and fills placeholders', () => {
    expect(t('menu.play')).toBe('Play');
    expect(t('hud.aWildAppeared', { 0: 'Pikachu' })).toBe('A wild Pikachu appeared!');
    expect(formatText('Defeat {count} {type}-type Pokémon', { count: 30, type: 'Fire' })).toBe(
      'Defeat 30 Fire-type Pokémon',
    );
    expect(formatText('Keep {unknown}', {})).toBe('Keep {unknown}');
  });
});

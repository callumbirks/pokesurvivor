// Loads the legacy game's data files (plain scripts that assign globals on `G`) in a Node vm
// sandbox, and reads named constants out of the legacy systems without running them.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { parse } from 'acorn';

export const repoRoot = resolve(import.meta.dirname, '../..');
const legacyJs = resolve(repoRoot, 'legacy/js');

/** Data files, in the order the legacy index.html loads them. */
const DATA_FILES = [
  'core/util.js',
  'data/pokedex.js',
  'data/sprites-meta.js',
  'data/moves.js',
  'data/types.js',
  'data/starters.js',
  'data/enemies.js',
  'data/upgrades.js',
  'data/items.js',
  'data/missions.js',
  'data/achievements.js',
  'data/music.js',
  'data/lang-en.js',
];

// The legacy globals are untyped; this module is the boundary where they get shapes.
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
export type Legacy = any;

export interface LegacyGame {
  G: Legacy;
  /** lang-en.js: Spanish on-screen text → English. */
  dictionary: Record<string, string>;
  /** Evaluates the initialiser of a top-level-in-IIFE `const NAME = …` in a legacy file. */
  constant: (file: string, name: string) => Legacy;
}

export function loadLegacy(): LegacyGame {
  const dictionary: Record<string, string> = {};
  const sandbox: Record<string, unknown> = { console, Math, JSON, performance };
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext('window.G = {}', context);
  const G = sandbox.G as Legacy;
  G.I18n = { add: (dict: Record<string, string>) => Object.assign(dictionary, dict) };
  // world.js reads the sprite scale at load time.
  G.Sprites = { PX: 2 };
  for (const file of DATA_FILES) {
    vm.runInContext(readFileSync(resolve(legacyJs, file), 'utf8'), context, { filename: file });
  }

  const sources = new Map<string, string>();
  function constant(file: string, name: string): Legacy {
    let source = sources.get(file);
    if (!source) {
      source = readFileSync(resolve(legacyJs, file), 'utf8');
      sources.set(file, source);
    }
    const found: string[] = [];
    walk(parse(source, { ecmaVersion: 'latest' }), (node) => {
      if (node.type === 'VariableDeclarator' && node.id?.name === name && node.init) {
        found.push(source.slice(node.init.start, node.init.end));
      }
    });
    if (found.length !== 1)
      throw new Error(`${file}: expected one const ${name}, found ${found.length}`);
    return vm.runInContext(`(${found[0]})`, context);
  }

  return { G, dictionary, constant };
}

function walk(node: any, visit: (node: any) => void): void {
  if (!node || typeof node.type !== 'string') return;
  visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) for (const child of value) walk(child, visit);
    else if (value && typeof value === 'object') walk(value, visit);
  }
}

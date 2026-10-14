// Display text for what the sim sends as ids: level-up cards, moves, items and types.
// The client turns these into titles and descriptions from the data.
import { loadGameData, t } from '@pokesurvivor/data';
import type { CardOption } from '@pokesurvivor/sim';
import { typeColor } from '../icons.js';

export interface CardText {
  title: string;
  description: string;
  /** The chip next to the title. */
  tag: string;
  /** The chip's and icon's colour. */
  color: string;
  icon: string;
  /** Golden card (an evolution). */
  evolution: boolean;
}

const data = () => loadGameData();

export function moveName(id: string): string {
  return data().moveById.get(id)?.name ?? id;
}

export function itemName(id: string): string {
  return data().itemById.get(id)?.name ?? id;
}

export function itemDescription(id: string): string {
  return data().itemById.get(id)?.description ?? '';
}

export function typeName(id: string): string {
  return data().types.types.find((x) => x.id === id)?.name ?? id;
}

/** "+40% damage": what the next level of a move does (moves.json `upgradeLadders`). */
export function upgradeText(moveId: string, toLevel: number): string {
  const m = data().moveById.get(moveId);
  if (!m) return '';
  const ladder = data().moves.upgradeLadders[m.kind] ?? [];
  return ladder[toLevel - 2]?.text ?? '';
}

export function cardText(c: CardOption): CardText {
  const d = data();
  const move = c.moveId ? d.moveById.get(c.moveId) : undefined;
  switch (c.type) {
    case 'new':
      return {
        title: move?.name ?? c.moveId ?? '',
        description: move?.description ?? '',
        tag: t('levelUp.new', { 0: typeName(move?.type ?? 'normal') }),
        color: typeColor(move?.type ?? 'normal'),
        icon: `move:${c.moveId ?? ''}`,
        evolution: false,
      };
    case 'upgrade': {
      const to = c.toLevel ?? 2;
      return {
        title: move?.name ?? c.moveId ?? '',
        description: upgradeText(c.moveId ?? '', to),
        tag: `${t('levelUp.lv')}${to - 1} > ${to}`,
        color: typeColor(move?.type ?? 'normal'),
        icon: `move:${c.moveId ?? ''}`,
        evolution: false,
      };
    }
    case 'evolution':
      return {
        title: `${move?.name ?? ''} → ${move?.evolution?.name ?? ''}`,
        description: move ? (d.moves.evolutionBoosts[move.kind]?.text ?? '') : '',
        tag: t('levelUp.evolution'),
        color: '#ffd23f',
        icon: `move:${c.moveId ?? ''}`,
        evolution: true,
      };
    case 'stat': {
      const s = c.statId ? d.statCardById.get(c.statId) : undefined;
      const evolves = c.unlocksEvolutionOf;
      return {
        title: s?.name ?? c.statId ?? '',
        description: s?.description ?? '',
        tag: evolves ? `${t('levelUp.evolves')} ${moveName(evolves)}` : t('levelUp.upgrade'),
        color: evolves ? '#ffd23f' : '#9fb1c9',
        icon: s?.icon ?? 'star',
        evolution: false,
      };
    }
  }
}

/** "A, B and you": a list of names (original implementation). */
export function nameList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return t('game.listAnd', { 0: names.slice(0, -1).join(', '), 1: names[names.length - 1]! });
}

/** m:ss. */
export function mmss(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

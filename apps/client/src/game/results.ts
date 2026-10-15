// The end-of-run screen (original implementation `showOver`), from `game.results` (co-op, recorded by the
// server from its own sim) or the solo report (`POST /api/runs`, capped by the server). It shows
// what was credited, the reward breakdown, moves, tickets and shinies, the players who left early,
// and the achievements the run unlocked with the rewards they paid (from the solo report, or the
// player's entry in `game.results`), totalled apart from the run's own coins and tickets.
import { loadGameData, t } from '@pokesurvivor/data';
import type { Results } from '@pokesurvivor/netclient';
import type { PlayerLoadout, UnlockedAchievement } from '@pokesurvivor/protocol';
import { audio } from '../audio.js';
import { inputHint } from '../glyphs.js';
import { el, icon, spriteEl } from './dom.js';
import { pokemonName } from './scene/entities.js';
import { isSoloResults } from './solo/connection.js';
import { itemName, mmss, moveName } from './text.js';

export interface ResultsOptions {
  selfId: string;
  /** Died (all down) rather than quitting. */
  dead: boolean;
  /** The player's best time before this run (for "new record"), if known. */
  bestTimeS: number | null;
  /** Did the player own this shiny before the run (null: unknown)? Marks the new ones. */
  ownedShiny?(dex: number): boolean | null;
  /** The run's players (`GameStatic.players`): their Pokémon and its prestige stars. */
  players?: readonly PlayerLoadout[];
  onBack(): void;
}

/** A Pokémon's prestige stars in gold (null without stars). */
export function starsEl(n: number | undefined): HTMLElement | null {
  if (!n) return null;
  return el(
    'span',
    { class: 'stars', title: t('prestige.stars', { 0: n }), data: { testid: 'stars' } },
    '★'.repeat(n),
  );
}

/** "Pikachu ★★": a player's Pokémon and its stars. */
function playedPokemon(info: PlayerLoadout | undefined): HTMLElement | null {
  if (!info) return null;
  const stars = starsEl(info.prestige);
  return el('span', { class: 'ps-played' }, pokemonName(info.dex), stars ? ' ' : null, stars);
}

type AchievementReward = UnlockedAchievement['reward'];

/** The rewards of the achievements a run unlocked, summed per currency (as the server paid them). */
export function achievementRewardTotals(
  unlocked: readonly UnlockedAchievement[],
): Required<AchievementReward> {
  const total = { coins: 0, tickets: 0, tickets10: 0 };
  for (const { reward } of unlocked) {
    total.coins += reward.coins ?? 0;
    total.tickets += reward.tickets ?? 0;
    total.tickets10 += reward.tickets10 ?? 0;
  }
  return total;
}

/** `+200 [coin] +5 [ticket] +1 [×10 ticket]`, skipping the currencies with nothing. */
function rewardParts(reward: AchievementReward, size: number): Node[] {
  const parts: [number | undefined, string][] = [
    [reward.coins, 'coin'],
    [reward.tickets, 'ticket'],
    [reward.tickets10, 'ticket10'],
  ];
  return parts
    .filter(([n]) => n)
    .map(([n, id]) =>
      el('span', { class: 'ps-reward', data: { reward: id } }, `+${n} `, icon(id, size)),
    );
}

function renderAchievements(unlocked: readonly UnlockedAchievement[]): Node[] {
  const byId = loadGameData().achievementById;
  const total = achievementRewardTotals(unlocked);
  const out: Node[] = [
    el('h3', null, t('profile.achievements')),
    el(
      'div',
      { class: 'ps-achievements', data: { testid: 'results-achievements' } },
      unlocked.map((a) =>
        el(
          'div',
          null,
          el('span', null, icon('trophy', 16), ` ${byId.get(a.id)?.name ?? a.id}`),
          el('span', { class: 'muted' }, rewardParts(a.reward, 14)),
        ),
      ),
    ),
  ];
  if (total.coins || total.tickets || total.tickets10)
    out.push(
      el(
        'div',
        { class: 'ps-achievement-rewards', data: { testid: 'results-achievement-rewards' } },
        el('span', null, t('results.achievementRewards')),
        el('b', { class: 'gold' }, rewardParts(total, 18)),
        el('div', { class: 'muted' }, t('results.achievementRewardsNote')),
      ),
    );
  return out;
}

export function renderResults(results: Results, o: ResultsOptions): HTMLElement {
  const mine = results.players.find((p) => p.userId === o.selfId) ?? results.players[0];
  const run = mine?.summary.run;
  const ps = mine?.summary.player ?? null;
  const box = el('div', { class: 'ps-box ps-results', data: { testid: 'results' } });
  box.append(el('h2', null, o.dead ? t('pause.youFell') : t('pause.runOver')));
  const own = playedPokemon(o.players?.find((p) => p.id === (mine?.userId ?? o.selfId)));
  if (own)
    box.append(el('div', { class: 'ps-results-mon', data: { testid: 'results-pokemon' } }, own));
  const stats = el('div', { class: 'stats' });
  const cell = (label: string, value: Node | string, wide = false, extra?: Node) =>
    stats.append(
      el(
        'div',
        { style: wide ? 'grid-column:1/-1' : '' },
        el('span', null, label),
        el('b', null, value),
        extra ?? null,
      ),
    );
  if (run) {
    cell(t('pause.time'), mmss(run.durationS));
    cell(t('pause.level'), String(run.level));
    cell(t('pause.defeated'), String(run.kills));
    cell(t('pause.bosses'), String(run.bosses));
    const parts = ps?.rewardParts;
    const breakdown = parts
      ? [
          parts.time && t('game.partTime', { 0: parts.time }),
          parts.defeated && t('game.partDefeated', { 0: parts.defeated }),
          parts.bosses && t('game.partBosses', { 0: parts.bosses }),
          parts.collected && t('game.partCollected', { 0: parts.collected }),
          parts.rescues && t('game.partRescues', { 0: parts.rescues }),
        ]
          .filter(Boolean)
          .join(' · ') + (ps && ps.coinMul > 1 ? ` · ×${ps.coinMul.toFixed(2)}` : '')
      : '';
    cell(
      t('pause.pokecoinsEarned'),
      el('span', { class: 'gold' }, icon('coin', 18), ` +${run.coins}`),
      true,
      breakdown ? el('div', { class: 'muted' }, breakdown) : undefined,
    );
    if (run.ticketsX1 || run.ticketsX10)
      cell(
        t('pause.gachaTickets'),
        el(
          'span',
          null,
          run.ticketsX1 ? [icon('ticket', 22), ` +${run.ticketsX1} `] : null,
          run.ticketsX10 ? [icon('ticket10', 22), ` +${run.ticketsX10} ×10`] : null,
        ),
        true,
      );
    if (ps?.moves.length)
      cell(
        t('pause.moves'),
        el(
          'span',
          { class: 'moves' },
          ...ps.moves.map((m, i) => [
            i ? ' · ' : '',
            icon(`move:${m.id}`, 16),
            ` ${moveName(m.id)} ${t('levelUp.lv')}${m.level}${m.evolved ? ' ★' : ''}`,
          ]),
        ),
        true,
      );
    if (ps?.item)
      cell(t('game.heldItem'), el('span', null, icon(ps.item, 18), ` ${itemName(ps.item)}`), true);
    if (run.shiniesCaught.length)
      stats.append(
        el(
          'div',
          { class: 'ps-caught', data: { testid: 'results-shinies' } },
          el(
            'span',
            null,
            icon('shiny', 12),
            ` ${t('pause.shiniesCaught', { 0: run.shiniesCaught.length })}`,
          ),
          el(
            'div',
            { class: 'ps-caught-row' },
            run.shiniesCaught.map((d) =>
              el(
                'div',
                null,
                el(
                  'span',
                  { class: 'ps-caught-stage' },
                  spriteEl(d, { shiny: true, scale: 2, fit: { width: 96, height: 72 } }),
                ),
                el(
                  'small',
                  null,
                  pokemonName(d),
                  o.ownedShiny?.(d) === false ? ` · ${t('game.newShiny')}` : '',
                ),
              ),
            ),
          ),
        ),
      );
    if (o.bestTimeS !== null && run.durationS > o.bestTimeS && o.bestTimeS > 0)
      stats.append(
        el(
          'div',
          { class: 'gold', style: 'grid-column:1/-1;text-align:center' },
          t('pause.newTimeRecord'),
        ),
      );
  }
  box.append(stats);

  // Co-op: everyone's result, and who left early (credited with what they had then).
  if (results.players.length > 1) {
    const list = el('div', { class: 'ps-team-results' });
    for (const p of results.players)
      list.append(
        el(
          'div',
          { class: p.left ? 'left' : '' },
          el('b', null, p.username),
          ...(() => {
            const mon = playedPokemon(o.players?.find((x) => x.id === p.userId));
            return mon ? [' · ', mon] : [];
          })(),
          ` · ${mmss(p.summary.run.durationS)} · `,
          icon('coin', 14),
          ` ${p.summary.run.coins}`,
          p.left ? el('span', { class: 'muted' }, ` · ${t('game.leftEarly')}`) : null,
        ),
      );
    box.append(el('h3', null, t('game.team')), list);
  }

  // Credited, or why not.
  const solo = isSoloResults(results) ? results.solo : null;
  if (solo?.timedOut)
    box.append(el('p', { class: 'note warn', data: { testid: 'timed-out' } }, t('game.timedOut')));
  else if (!results.credited)
    box.append(
      el(
        'p',
        { class: 'note warn', data: { testid: 'not-credited' } },
        solo?.error === 'offline' ? t('game.notCreditedOffline') : t('game.notCredited'),
      ),
    );
  else if (solo?.capped) box.append(el('p', { class: 'note' }, t('game.capped')));
  const unlocked = solo ? solo.achievements : (mine?.achievements ?? []);
  if (unlocked.length) box.append(...renderAchievements(unlocked));
  box.append(
    el(
      'button',
      {
        class: 'btn primary',
        type: 'button',
        data: { testid: 'game-exit', sfx: 'none', back: '' },
        on: {
          click: () => {
            audio.sfx('back');
            o.onBack();
          },
        },
      },
      t('pause.backToMenu'),
      ' ',
      inputHint([], ['b']),
    ),
  );
  return el('div', { class: 'ps-screen' }, box);
}

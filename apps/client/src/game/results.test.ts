// @vitest-environment happy-dom
import type { Results } from '@pokesurvivor/netclient';
import { emptyRunProgress, type UnlockedAchievement } from '@pokesurvivor/protocol';
import { describe, expect, it, vi } from 'vitest';
import { achievementRewardTotals, renderResults } from './results.js';

// The pixel icons paint on a canvas, which happy-dom doesn't have.
vi.mock('../icons.js', () => ({
  iconImg: (id: string) => Object.assign(document.createElement('img'), { alt: id }),
  typeColor: () => '#ffffff',
}));

const unlocked: UnlockedAchievement[] = [
  { id: 'own-1', reward: { coins: 100 }, title: null },
  { id: 'own-10', reward: { tickets: 2 }, title: null },
  { id: 'survive-5', reward: { coins: 100, tickets: 3 }, title: null },
];

function player(userId: string, achievements?: UnlockedAchievement[]) {
  return {
    userId,
    username: userId,
    left: false,
    summary: {
      run: {
        durationS: 300,
        level: 10,
        kills: 100,
        bosses: 1,
        coins: 450,
        ticketsX1: 1,
        ticketsX10: 0,
        shiniesCaught: [],
        progress: emptyRunProgress(),
      },
      player: null,
    },
    ...(achievements ? { achievements } : {}),
  };
}

function coop(players: ReturnType<typeof player>[]): Results {
  return { gameId: 'g', runId: 'r', credited: true, reason: 'all-down', players };
}

const render = (r: Results, selfId = 'me') =>
  renderResults(r, { selfId, dead: true, bestTimeS: null, onBack: () => {} });

/** `+200 coin` per reward part, from the mocked icons' alt text. */
const parts = (root: Element | null) =>
  [...(root?.querySelectorAll('.ps-reward') ?? [])].map(
    (e) => `${e.textContent?.trim()} ${e.querySelector('img')?.alt}`,
  );

describe('results: achievement rewards', () => {
  it('sums the rewards per currency', () => {
    expect(achievementRewardTotals(unlocked)).toEqual({ coins: 200, tickets: 5, tickets10: 0 });
    expect(achievementRewardTotals([])).toEqual({ coins: 0, tickets: 0, tickets10: 0 });
  });

  it("shows the player's own co-op unlocks and their totals, apart from the run's coins", () => {
    const root = render(coop([player('me', unlocked), player('friend', [unlocked[0]!])]));
    const list = root.querySelector('[data-testid="results-achievements"]');
    expect(list?.children).toHaveLength(3);
    expect(list?.textContent).toContain('First partner');
    expect(parts(list)).toEqual(['+100 coin', '+2 ticket', '+100 coin', '+3 ticket']);
    const totals = root.querySelector('[data-testid="results-achievement-rewards"]');
    expect(totals?.textContent).toContain('Achievement rewards');
    expect(parts(totals)).toEqual(['+200 coin', '+5 ticket']);
    // The run's own coins are shown as they were, without the achievements' coins.
    expect(root.querySelector('.stats')?.textContent).toContain('+450');
    expect(root.querySelector('.stats')?.textContent).not.toContain('+650');
  });

  it('shows the solo report unlocks', () => {
    const results = {
      ...coop([player('me')]),
      solo: { achievements: [unlocked[1]!], capped: false, error: null, timedOut: false },
    } as Results;
    const totals = render(results).querySelector('[data-testid="results-achievement-rewards"]');
    expect(parts(totals)).toEqual(['+2 ticket']);
  });

  it('has no achievements section when nothing was unlocked', () => {
    const root = render(coop([player('me', []), player('friend', unlocked)]));
    expect(root.querySelector('[data-testid="results-achievements"]')).toBeNull();
    expect(root.querySelector('[data-testid="results-achievement-rewards"]')).toBeNull();
  });

  it('lists unlocks without a reward but no totals', () => {
    const root = render(coop([player('me', [{ id: 'own-1', reward: {}, title: null }])]));
    expect(root.querySelector('[data-testid="results-achievements"]')).not.toBeNull();
    expect(root.querySelector('[data-testid="results-achievement-rewards"]')).toBeNull();
  });
});

describe('results: prestige', () => {
  it("shows each player's Pokémon with its stars", () => {
    const root = renderResults(coop([player('me'), player('friend')]), {
      selfId: 'me',
      dead: true,
      bestTimeS: null,
      players: [
        { id: 'me', username: 'me', index: 0, dex: 25, shiny: false, prestige: 2 },
        { id: 'friend', username: 'friend', index: 1, dex: 4, shiny: false },
      ],
      onBack: () => {},
    });
    const own = root.querySelector('[data-testid="results-pokemon"]');
    expect(own?.textContent).toBe('Pikachu ★★');
    const team = root.querySelector('.ps-team-results')!;
    expect(team.querySelectorAll('[data-testid="stars"]')).toHaveLength(1);
    expect(team.textContent).toContain('Charmander');
  });
});

describe('results: gems', () => {
  it('shows the gems found, and no line without any', () => {
    const withGems = player('me');
    withGems.summary.run = { ...withGems.summary.run, gems: 3 } as typeof withGems.summary.run;
    const line = render(coop([withGems])).querySelector('[data-testid="results-gems"]');
    expect(line?.textContent).toBe(' +3');
    expect(line?.querySelector('img')?.alt).toBe('gem');
    expect(line?.parentElement?.parentElement?.textContent).toContain('Gems');
    expect(render(coop([player('me')])).querySelector('[data-testid="results-gems"]')).toBeNull();
  });
});

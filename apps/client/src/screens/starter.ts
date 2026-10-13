// The first Pokémon: the personality test suggests a starter; the player accepts it or picks
// any other (legacy test.js). The server grants it and stores the personality from the answers.
import { bestStarters, personalityScores, t, topTrait } from '@pokesurvivor/data';
import { audio } from '../audio.js';
import type { App, Screen } from '../app/app.js';
import {
  gameData,
  boxFor,
  h,
  icon,
  pokemonName,
  replace,
  sprite,
  typeChip,
  typeColor,
} from '../app/dom.js';
import { toast } from '../app/toast.js';

export function starterScreen(app: App): Screen {
  const { starters } = gameData();
  const test = starters.personalityTest;
  const answers: number[] = [];
  let suggested: number | null = null;
  const box = h('div', { class: 'box test-box' });
  const el = h(
    'section',
    { class: 'scr dim scr-starter', dataset: { testid: 'screen-starter' } },
    box,
  );

  const choose = (dex: number, button: HTMLButtonElement) =>
    void app.act(button, async () => {
      const res = await app.api.chooseStarter(
        dex,
        answers.length === test.length ? answers : undefined,
      );
      audio.sfx('confirm');
      app.setSave(res.save);
      app.achievements(res.achievements);
      toast(t('login.joinsYou', { 0: pokemonName(dex) }), 'good');
      app.go('menu');
    });

  const question = () => {
    const i = answers.length;
    const q = test[i];
    if (!q) return result();
    replace(
      box,
      h('div', { class: 'progress' }, h('i', { style: { width: `${(i / test.length) * 100}%` } })),
      h('p', { class: 'sub' }, t('login.questionOf', { 0: i + 1, 1: test.length })),
      h('p', { class: 'q' }, q.question),
      h(
        'div',
        { class: 'answers' },
        q.answers.map((a, k) =>
          h(
            'button',
            {
              class: 'answer',
              dataset: { testid: `answer-${k}` },
              on: {
                click: () => {
                  answers.push(k);
                  question();
                },
              },
            },
            a.text,
          ),
        ),
      ),
      h(
        'div',
        { class: 'row end', style: 'margin-top:12px' },
        h(
          'button',
          { class: 'btn small ghost', dataset: { testid: 'skip-test' }, on: { click: grid } },
          t('login.pickAPokemon'),
        ),
      ),
    );
  };

  const result = () => {
    const scores = personalityScores(test, answers) ?? {};
    const trait = starters.traits.find((x) => x.id === topTrait(scores));
    // A suggestion only (legacy picks one of the tied starters at random); the server grants
    // whichever the player confirms.
    const best = bestStarters(starters.starters, scores);
    const pick = best[Math.floor(Math.random() * best.length)] ?? starters.starters[0];
    if (!pick) return grid();
    suggested = pick.dex;
    const mon = gameData().pokemonByDex.get(pick.dex);
    const ok = h(
      'button',
      { class: 'btn gold', dataset: { testid: 'starter-accept', sfx: 'none' } },
      t('login.letSGoTogether'),
    );
    ok.addEventListener('click', () => choose(pick.dex, ok));
    replace(
      box,
      h(
        'div',
        { class: 'result center' },
        h('h2', null, t('login.yourPersonalityIs')),
        h('div', { class: 'trait' }, trait?.name ?? ''),
        h('p', null, trait?.description ?? ''),
        h(
          'div',
          { class: 'stage', style: { '--stage-c': typeColor(mon?.types[0] ?? 'normal') } },
          sprite(pick.dex, {
            scale: 4,
            lively: true,
            fit: boxFor({ width: 216, height: 150 }, { width: 130, height: 96 }),
            feet: true,
          }),
        ),
        h('h3', null, pokemonName(pick.dex)),
        h(
          'div',
          { class: 'row', style: 'justify-content:center' },
          ok,
          h('button', { class: 'btn', on: { click: grid } }, t('login.chooseAnother')),
        ),
      ),
    );
  };

  function grid(): void {
    let picked = suggested;
    const info = h('span', { class: 'grow muted' });
    const ok = h(
      'button',
      {
        class: 'btn gold',
        disabled: picked === null,
        dataset: { testid: 'starter-ok', sfx: 'none' },
      },
      t('login.choose'),
    );
    ok.addEventListener('click', () => picked !== null && choose(picked, ok));
    const cells = starters.starters.map((s) => {
      const mon = gameData().pokemonByDex.get(s.dex);
      const cell = h(
        'button',
        {
          class: ['cell', s.dex === picked && 'on'],
          dataset: { testid: `starter-${s.dex}` },
          on: {
            click: () => {
              picked = s.dex;
              for (const c of cells) c.classList.toggle('on', c === cell);
              ok.disabled = false;
              replace(
                info,
                ...(mon?.types.map(typeChip) ?? []),
                ' ',
                icon(`move:${s.startingMove}`, 16),
                ' ',
                gameData().moveById.get(s.startingMove)?.name ?? s.startingMove,
              );
            },
          },
        },
        sprite(s.dex, { scale: 2, fit: { width: 80, height: 64 }, feet: true }),
        h('b', null, pokemonName(s.dex)),
      );
      return cell;
    });
    replace(
      box,
      h('h2', null, t('login.chooseYourPartner')),
      h('p', { class: 'sub' }, t('login.theStartersFromEveryRegion')),
      h('div', { class: 'grid' }, cells),
      h('div', { class: 'row', style: 'margin-top:12px' }, info, ok),
    );
  }

  question();
  return { el };
}

// The choice overlay in the DOM (legacy run-ui.js level-up cards, item swap and bond screens),
// rendered from `ChoiceState`. Keys 1–4 pick, R rerolls, Backspace/Esc goes back in a bond.
import { t } from '@pokesurvivor/data';
import { audio } from '../audio.js';
import { typeColor } from '../icons.js';
import type { ChoiceState, ChoiceView, WaitingView } from './choices.js';
import { clear, el, icon } from './dom.js';
import { cardText, itemDescription, itemName, moveName, nameList } from './text.js';

export class ChoiceOverlay {
  readonly root: HTMLElement;
  private readonly waitBar: HTMLElement;
  private shown = -1;
  private open = false;
  private details: (moveId: string) => { level: number; type: string } | null = () => null;

  constructor(
    parent: HTMLElement,
    private readonly state: ChoiceState,
  ) {
    this.root = el('div', { class: 'ps-choice hidden', data: { testid: 'choice' } });
    this.waitBar = el('div', { class: 'ps-wait hidden', data: { testid: 'choice-waiting' } });
    parent.append(this.root, this.waitBar);
  }

  /** How to show a bond's moves (their level and type from the player's details). */
  setMoveInfo(fn: (moveId: string) => { level: number; type: string } | null): void {
    this.details = fn;
  }

  get isOpen(): boolean {
    return this.open;
  }

  /** Re-renders if the state changed. */
  update(): void {
    if (this.state.version === this.shown) return;
    this.shown = this.state.version;
    const v = this.state.view();
    const w = this.state.waiting();
    const wasOpen = this.open;
    this.open = !!v;
    if (v) {
      if (!wasOpen) audio.sfx('levelup');
      this.render(v, w);
    } else {
      this.root.classList.add('hidden');
      clear(this.root);
    }
    // Paused for someone else's choice: a bar at the top (our own overlay shows it inside).
    if (!v && w) {
      clear(this.waitBar);
      this.waitBar.append(this.waitText(w, false));
      this.waitBar.classList.remove('hidden');
    } else this.waitBar.classList.add('hidden');
  }

  /** Keys while the overlay is open. Returns true if it used the key. */
  key(code: string): boolean {
    if (!this.open) return false;
    const digit = /^(?:Digit|Numpad)([1-4])$/.exec(code);
    if (digit) {
      this.pick(Number(digit[1]) - 1);
      return true;
    }
    if (code === 'KeyR') {
      if (this.state.reroll()) audio.sfx('select');
      return true;
    }
    if (code === 'Backspace' || code === 'Escape') {
      this.state.back();
      return true;
    }
    return false;
  }

  private pick(i: number): void {
    const v = this.state.view();
    const was = v?.first;
    const intent = this.state.pick(i);
    if (intent) audio.sfx('confirm');
    else if (this.state.view()?.first !== was) audio.sfx('select');
  }

  private waitText(w: WaitingView, mine: boolean): HTMLElement {
    const secs = w.secondsLeft !== null ? ` · ${t('game.secondsShort', { 0: w.secondsLeft })}` : '';
    return el(
      'p',
      { class: 'note' },
      mine
        ? t('levelUp.stillChoosing', { 0: nameList(w.others) })
        : t('levelUp.waitingFor', { 0: nameList(w.others) }),
      secs,
    );
  }

  private render(v: ChoiceView, w: WaitingView | null): void {
    clear(this.root);
    this.root.classList.remove('hidden');
    const c = v.choice;
    const box = el('div', { class: 'ps-box' });
    const countdown =
      v.secondsLeft !== null
        ? el(
            'div',
            {
              class: `ps-deadline${v.secondsLeft <= 5 ? ' soon' : ''}`,
              data: { testid: 'deadline' },
            },
            t('game.secondsShort', { 0: v.secondsLeft }),
          )
        : null;
    const cards = el('div', { class: `ps-cards${v.submitted ? ' done' : ''}` });
    const card = (
      i: number,
      ico: HTMLElement,
      title: (Node | string)[],
      desc: string,
      cls: string,
      tint: string,
    ) => {
      const o = v.options[i];
      const e = el(
        'button',
        {
          class: `ps-card${cls}${o?.picked ? ' picked' : ''}`,
          type: 'button',
          data: { testid: `option-${i}` },
          on: { click: () => this.pick(i) },
        },
        el('div', { class: 'ico', style: `background:${tint}33` }, ico),
        el(
          'div',
          { class: 'txt' },
          el('div', { class: 'nm' }, ...title),
          el('div', { class: 'ds' }, desc),
        ),
        el('div', { class: 'key' }, String(i + 1)),
      );
      cards.append(e);
    };
    const chip = (text: string, color: string) =>
      el('span', { class: 'tag-chip', style: `background:${color}` }, text);

    if (c.kind === 'level-up') {
      box.append(
        el('h2', null, t('levelUp.level2', { 0: c.level })),
        el(
          'p',
          { class: 'sub' },
          t('game.chooseReward'),
          ' · ',
          kbd('1'),
          ' ',
          kbd('2'),
          ' ',
          kbd('3'),
        ),
      );
      c.options.forEach((o, i) => {
        const tx = cardText(o);
        card(
          i,
          icon(tx.icon, 32),
          [tx.title, ' ', chip(tx.tag, tx.color)],
          tx.description,
          tx.evolution ? ' evo' : '',
          tx.color,
        );
      });
      box.append(countdown ?? '', cards);
      if (v.rerollsLeft > 0 && !v.submitted)
        box.append(
          el(
            'button',
            {
              class: 'btn small ghost',
              type: 'button',
              data: { testid: 'reroll' },
              on: {
                click: () => {
                  if (this.state.reroll()) audio.sfx('select');
                },
              },
            },
            t('game.reroll', { 0: v.rerollsLeft }),
            ' · ',
            kbd('R'),
          ),
        );
    } else if (c.kind === 'item') {
      box.append(
        el('h2', null, t('items.anItem')),
        el('p', { class: 'sub' }, t('game.holdOnlyOne'), ' · ', kbd('1'), ' ', kbd('2')),
      );
      [c.held, c.found].forEach((id, i) =>
        card(
          i,
          icon(id, 36),
          [`${i ? t('items.switchTo') : t('items.keep')} ${itemName(id)}`],
          itemDescription(id),
          i === 1 ? ' evo' : '',
          '#ffd23f',
        ),
      );
      box.append(countdown ?? '', cards);
    } else if (c.kind === 'bond') {
      const group = (c.group ?? []).map(moveName).join(' + ');
      const step2 = c.mode === 'pair' && v.first;
      box.append(
        el('h2', { class: 'bond-title' }, t('hud.bond')),
        el('p', { class: 'sub bond-hint' }, t('hud.bondedMovesFireAtThe')),
        el(
          'p',
          { class: 'sub' },
          c.mode === 'add'
            ? t('hud.chooseWhichMoveJoins', { 0: group })
            : step2
              ? t('hud.whichMoveDoYouBond', { 0: moveName(v.first ?? '') })
              : t('hud.chooseTheFirstMoveTo'),
        ),
      );
      v.options.forEach((o, i) => {
        const info = this.details(o.id);
        const col = typeColor(info?.type ?? 'normal');
        const desc =
          c.mode === 'add'
            ? t('hud.itWillFireAtThe2', { 0: group })
            : step2
              ? t('hud.itWillFireAtThe', { 0: moveName(v.first ?? '') })
              : '';
        card(
          i,
          icon(`move:${o.id}`, 32),
          [moveName(o.id), ' ', chip(`${t('levelUp.lv')}${info?.level ?? 1}`, col)],
          desc,
          c.mode === 'add' || step2 ? ' bond' : '',
          col,
        );
      });
      box.append(countdown ?? '', cards);
      if (step2 && !v.submitted)
        box.append(
          el(
            'div',
            { class: 'row' },
            el(
              'button',
              { class: 'btn', type: 'button', on: { click: () => this.state.back() } },
              t('hud.back'),
            ),
          ),
        );
    }
    if (w) box.append(this.waitText(w, true));
    this.root.append(box);
  }
}

function kbd(k: string): HTMLElement {
  return el('kbd', null, k);
}

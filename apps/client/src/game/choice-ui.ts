// The choice overlay in the DOM (original implementation level-up cards, item swap and bond screens),
// rendered from `ChoiceState`. Keys 1–4 pick, R rerolls, Backspace/Esc goes back in a bond. With a
// gamepad the d-pad or the stick moves a highlight and A picks it (B, X and Y do nothing here), Back
// rerolls and Start goes back (`input.ts` turns the pad into these keys). Prompts follow the device
// in use (`inputHint`).
//
// The state is re-derived from every snapshot (20–30 a second), so rendering is incremental: the
// box is created once per choice (its entry animation plays once), the cards are rebuilt only when
// what they show changes (a reroll, a bond's second step, a pick), and the countdown and the list
// of teammates still choosing are updated in place.
import { t } from '@pokesurvivor/data';
import { audio } from '../audio.js';
import { glyph, inputHint } from '../glyphs.js';
import { typeColor } from '../icons.js';
import type { ChoiceState, ChoiceView, WaitingView } from './choices.js';
import { clear, el, icon } from './dom.js';
import { cardText, itemDescription, itemName, moveName, nameList } from './text.js';

/** Drop menu input briefly so gameplay presses cannot pick a newly visible reward. */
export const CHOICE_INPUT_GRACE_MS = 200;

/** Face buttons that don't pick in a choice (only A does, the highlighted card). */
const PAD_IGNORED = new Set(['PadB', 'PadX', 'PadY']);
const PAD_MOVE: Record<string, number> = { PadUp: -1, PadLeft: -1, PadDown: 1, PadRight: 1 };

export class ChoiceOverlay {
  readonly root: HTMLElement;
  private readonly waitBar: HTMLElement;
  private readonly waitBarText: HTMLElement;
  private shown = -1;
  private open = false;
  /** The open choice's box, its id, and what its cards were last built from. */
  private box: HTMLElement | null = null;
  private boxChoice: number | null = null;
  private built = '';
  private deadline: HTMLElement | null = null;
  private waitLine: HTMLElement | null = null;
  private inputChoice: string | null = null;
  private inputReadyAt = Infinity;
  private pointerPress: HTMLButtonElement | null = null;
  /** The gamepad's highlighted option, and the cards and their badges' glyph slots. */
  private highlight = 0;
  private cards: { el: HTMLElement; pad: HTMLElement }[] = [];
  private details: (moveId: string) => { level: number; type: string } | null = () => null;

  constructor(
    parent: HTMLElement,
    private readonly state: ChoiceState,
    private readonly clock: () => number = () => performance.now(),
  ) {
    this.root = el('div', { class: 'ps-choice hidden', data: { testid: 'choice' } });
    this.waitBarText = el('p', { class: 'note' });
    this.waitBar = el(
      'div',
      { class: 'ps-wait hidden', data: { testid: 'choice-waiting' } },
      this.waitBarText,
    );
    parent.append(this.root, this.waitBar);
    // Gate the whole menu, including secondary buttons. A click must come from a press that
    // started after the grace window; releasing a held mouse/touch press cannot choose a card.
    this.root.addEventListener('pointerdown', (e) => {
      this.pointerPress = e.button === 0 && this.inputReady() ? this.button(e.target) : null;
    });
    this.root.addEventListener('pointercancel', () => {
      this.pointerPress = null;
    });
    this.root.addEventListener(
      'click',
      (e) => {
        const button = this.button(e.target);
        if (!button) return;
        const pointer = e.detail > 0 || (e instanceof PointerEvent && !!e.pointerType);
        const allowed = this.inputReady() && (!pointer || this.pointerPress === button);
        this.pointerPress = null;
        if (!allowed) {
          e.preventDefault();
          e.stopImmediatePropagation();
        }
      },
      true,
    );
    // Native Enter/Space activation also needs a fresh press: never defer Space to keyup,
    // and suppress repeats from a key held before the menu appeared.
    this.root.addEventListener('keydown', (e) => {
      if (e.code !== 'Enter' && e.code !== 'NumpadEnter' && e.code !== 'Space') return;
      const button = this.button(e.target);
      if (!button) return;
      e.preventDefault();
      if (!e.repeat && this.inputReady()) button.click();
    });
  }

  private button(target: EventTarget | null): HTMLButtonElement | null {
    return target instanceof Element ? target.closest('button') : null;
  }

  private inputReady(): boolean {
    return this.open && this.clock() >= this.inputReadyAt;
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
      if (!this.box || this.boxChoice !== v.choice.id) {
        // A new choice: a new box, which animates in.
        clear(this.root);
        this.box = el('div', { class: 'ps-box' });
        this.boxChoice = v.choice.id;
        this.built = '';
        this.root.append(this.box);
        this.root.classList.remove('hidden');
      }
      const key = structureKey(v);
      if (key !== this.built) {
        this.built = key;
        this.render(this.box, v);
      }
      // Choice contents identify a new menu (including rerolls and bond steps). Submission,
      // countdown and teammate updates can rebuild/render without restarting the window.
      const inputChoice = JSON.stringify([
        { ...v.choice, deadlineTick: null },
        v.first,
        v.rerollsLeft,
      ]);
      if (inputChoice !== this.inputChoice) {
        this.inputChoice = inputChoice;
        this.inputReadyAt = this.clock() + CHOICE_INPUT_GRACE_MS;
        this.pointerPress = null;
        this.highlight = 0;
        this.showHighlight();
      }
      this.updateLive(v, w);
    } else {
      this.root.classList.add('hidden');
      clear(this.root);
      this.box = this.deadline = this.waitLine = null;
      this.boxChoice = null;
      this.built = '';
      this.inputChoice = null;
      this.inputReadyAt = Infinity;
      this.pointerPress = null;
      this.cards = [];
    }
    // Paused for someone else's choice: a bar at the top (our own overlay shows it inside).
    if (!v && w) {
      const text = this.waitString(w, false);
      if (this.waitBarText.textContent !== text) this.waitBarText.textContent = text;
      this.waitBar.classList.remove('hidden');
    } else this.waitBar.classList.add('hidden');
  }

  /** The parts that change while the cards stay: the countdown and who's still choosing. */
  private updateLive(v: ChoiceView, w: WaitingView | null): void {
    if (this.deadline) {
      const text = v.secondsLeft !== null ? t('game.secondsShort', { 0: v.secondsLeft }) : '';
      if (this.deadline.textContent !== text) this.deadline.textContent = text;
      this.deadline.classList.toggle('hidden', v.secondsLeft === null);
      this.deadline.classList.toggle('soon', v.secondsLeft !== null && v.secondsLeft <= 5);
    }
    if (this.waitLine) {
      const text = w ? this.waitString(w, true) : '';
      if (this.waitLine.textContent !== text) this.waitLine.textContent = text;
      this.waitLine.classList.toggle('hidden', !w);
    }
  }

  /** Keys while the overlay is open. Returns true if it used the key. */
  key(code: string): boolean {
    if (!this.open) return false;
    if (code === 'PadA') {
      if (this.inputReady()) this.pick(this.highlight);
      return true;
    }
    // Consumed, so they can't switch move slots under the menu.
    if (PAD_IGNORED.has(code)) return true;
    const move = PAD_MOVE[code];
    if (move) {
      const n = this.cards.length;
      if (n) {
        this.highlight = (this.highlight + move + n) % n;
        this.showHighlight();
        audio.sfx('hover');
      }
      return true;
    }
    const digit = /^(?:Digit|Numpad)([1-4])$/.exec(code);
    if (digit) {
      if (this.inputReady()) this.pick(Number(digit[1]) - 1);
      return true;
    }
    if (code === 'KeyR') {
      if (this.inputReady() && this.state.reroll()) audio.sfx('select');
      return true;
    }
    if (code === 'Backspace' || code === 'Escape') {
      if (this.inputReady()) this.state.back();
      return true;
    }
    return false;
  }

  /** The highlighted card, and the gamepad's badge: A on it, nothing on the others. */
  private showHighlight(): void {
    if (this.highlight >= this.cards.length) this.highlight = 0;
    this.cards.forEach(({ el, pad }, i) => {
      el.classList.toggle('focus', i === this.highlight);
      pad.replaceChildren(...(i === this.highlight ? [glyph('a', 32)] : []));
    });
  }

  private pick(i: number): void {
    const v = this.state.view();
    const was = v?.first;
    const intent = this.state.pick(i);
    if (intent) audio.sfx('confirm');
    else if (this.state.view()?.first !== was) audio.sfx('select');
  }

  private waitString(w: WaitingView, mine: boolean): string {
    const secs = w.secondsLeft !== null ? ` · ${t('game.secondsShort', { 0: w.secondsLeft })}` : '';
    return (
      (mine
        ? t('levelUp.stillChoosing', { 0: nameList(w.others) })
        : t('levelUp.waitingFor', { 0: nameList(w.others) })) + secs
    );
  }

  /** Builds the box's content (the live parts are filled in by `updateLive`). */
  private render(box: HTMLElement, v: ChoiceView): void {
    clear(box);
    const c = v.choice;
    const countdown = el('div', { class: 'ps-deadline hidden', data: { testid: 'deadline' } });
    this.deadline = countdown;
    const cards = el('div', { class: `ps-cards${v.submitted ? ' done' : ''}` });
    this.cards = [];
    const card = (
      i: number,
      ico: HTMLElement,
      title: (Node | string)[],
      desc: string,
      cls: string,
      tint: string,
    ) => {
      const o = v.options[i];
      const pad = el('span', { class: 'pad-only' });
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
        el('div', { class: 'key' }, el('span', { class: 'kb-only' }, String(i + 1)), pad),
      );
      this.cards.push({ el: e, pad });
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
          inputHint(['1', '2', '3'], ['dpadV', 'a']),
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
      box.append(countdown, cards);
      if (v.rerollsLeft > 0 && !v.submitted)
        box.append(
          el(
            'button',
            {
              class: 'btn small ghost',
              type: 'button',
              data: { testid: 'reroll', sfx: 'none' },
              on: {
                click: () => {
                  if (this.state.reroll()) audio.sfx('select');
                },
              },
            },
            t('game.reroll', { 0: v.rerollsLeft }),
            ' · ',
            inputHint(['R'], ['select']),
          ),
        );
    } else if (c.kind === 'item') {
      box.append(
        el('h2', null, t('items.anItem')),
        el(
          'p',
          { class: 'sub' },
          t('game.holdOnlyOne'),
          ' · ',
          inputHint(['1', '2'], ['dpadV', 'a']),
        ),
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
      box.append(countdown, cards);
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
      box.append(countdown, cards);
      if (step2 && !v.submitted)
        box.append(
          el(
            'div',
            { class: 'row' },
            el(
              'button',
              { class: 'btn', type: 'button', on: { click: () => this.state.back() } },
              t('hud.back'),
              ' · ',
              inputHint(['Esc'], ['start']),
            ),
          ),
        );
    }
    this.waitLine = el('p', { class: 'note hidden' });
    box.append(this.waitLine);
    this.showHighlight();
  }
}

/** What the cards show: everything but the countdown and the waiting list. */
function structureKey(v: ChoiceView): string {
  return JSON.stringify([
    { ...v.choice, deadlineTick: null },
    v.options,
    v.first,
    v.submitted,
    v.rerollsLeft,
  ]);
}

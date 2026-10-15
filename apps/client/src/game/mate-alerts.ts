// Co-op: a teammate going down is easy to miss in the crowd, so it gets its own sound and a
// banner in the middle of the screen ("bork's Pikachu is down!", with "Go revive them!" while
// someone is up to do it); a revive gets a small toast. Our own going down keeps its sound and the
// sim's banner; our own revive gets a (green) banner of its own, "You're back up!", naming who
// revived us (events.ts adds its effect and sound). The HUD's edge arrows already point at a downed
// teammate (see hud.ts).
import { t } from '@pokesurvivor/data';
import type { SimEvent } from '@pokesurvivor/sim';
import type { SfxName } from '../audio.js';
import { el } from './dom.js';
import type { Frame } from './frame.js';

/** The sound plays at most this often (ms), however many go down at once. */
export const MATE_DOWN_SFX_GAP = 2000;
/** How long the banner stays (s). */
export const MATE_BANNER_SECONDS = 2.6;

export interface MateAlertSinks {
  /** The big banner (latest wins); `self` for news about us (our own revive). */
  banner(text: string, hint: string | null, self?: boolean): void;
  /** The small "is back" note. */
  toast(text: string): void;
  sfx(name: SfxName): void;
  /** A clock in ms. */
  now(): number;
  /** A Pokédex number's name. */
  pokemonName(dex: number): string;
}

type MateFrame = Pick<Frame, 'selfId' | 'players' | 'game'>;

export class MateAlerts {
  private lastSfx = -Infinity;

  constructor(private readonly k: MateAlertSinks) {}

  play(events: readonly SimEvent[], frame: MateFrame): void {
    for (const e of events) {
      if (e.type === 'player-down') this.down(e.playerId, frame);
      else if (e.type === 'player-revived') this.revived(e.playerId, frame, e.by);
    }
  }

  /** A teammate's username and Pokémon (none for us, or for someone not in the game). */
  private mate(id: string, frame: MateFrame): { 0: string; 1: string } | null {
    if (id === frame.selfId) return null;
    const info = frame.game.players.find((p) => p.id === id);
    return info ? { 0: info.username, 1: this.k.pokemonName(info.dex) } : null;
  }

  private down(id: string, frame: MateFrame): void {
    const who = this.mate(id, frame);
    if (!who) return;
    const text = t('game.mateDown', who);
    // Someone still up can revive them (us, or another teammate).
    const helper = frame.players.some((p) => p.id !== id && !p.dead && !p.left && p.connected);
    this.k.banner(text, helper ? t('game.mateDownHint') : null);
    const now = this.k.now();
    if (now - this.lastSfx >= MATE_DOWN_SFX_GAP) {
      this.lastSfx = now;
      this.k.sfx('mateDown');
    }
  }

  private revived(id: string, frame: MateFrame, by: string | null): void {
    if (id === frame.selfId) {
      // `by` is null when the sim revives us itself (a rift exit).
      const name = by && frame.game.players.find((p) => p.id === by)?.username;
      this.k.banner(t('game.selfBack'), name ? t('game.selfBackBy', { 0: name }) : null, true);
      return;
    }
    const who = this.mate(id, frame);
    if (who) this.k.toast(t('game.mateBack', who));
  }
}

/** The banner: centred, over the play area but not in the way of input, fading on its own. */
export class MateBanner {
  readonly root: HTMLElement;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(parent: HTMLElement) {
    this.root = el('div', { class: 'ps-mate-alert', data: { testid: 'mate-alert' } });
    this.root.hidden = true;
    parent.append(this.root);
  }

  show(text: string, hint: string | null, seconds = MATE_BANNER_SECONDS, self = false): void {
    this.root.replaceChildren(el('div', { class: 'title' }, text));
    this.root.classList.toggle('self', self);
    if (hint) this.root.append(el('div', { class: 'hint' }, hint));
    this.root.hidden = false;
    // Restart the pop-in animation for a new banner over an old one.
    this.root.classList.remove('in', 'out');
    void this.root.offsetWidth;
    this.root.classList.add('in');
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.root.classList.add('out');
      this.timer = setTimeout(() => {
        this.root.hidden = true;
        this.timer = null;
      }, 400);
    }, seconds * 1000);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.root.remove();
  }
}

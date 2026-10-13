// The state of the choice overlay (level-up cards, item swaps, bonds), separate from the DOM so it
// can be tested. Choices are server state: every snapshot lists ours in full and everyone's as
// `waiting`, so the overlay is derived from the latest snapshot each frame and can never get stuck:
// when our choice leaves the snapshot (picked, auto-resolved at its deadline, or the run ended),
// the overlay closes. Picks are intents; they're idempotent, so a lost reply is simply retried.
import type { ChoiceRef } from '@pokesurvivor/netclient';
import type { IntentResult } from '@pokesurvivor/netclient';
import type { Intent, PendingChoice } from '@pokesurvivor/sim';

/** One option on screen. */
export interface ChoiceOption {
  /** What the option is: a card id, an item id or a move id. */
  id: string;
  /** The option picked (submitted, waiting for the server). */
  picked: boolean;
}

export interface ChoiceView {
  choice: PendingChoice;
  options: ChoiceOption[];
  /** Bond `pair`: the first move picked (the options are then its partners). */
  first: string | null;
  /** A pick was sent and we're waiting for the snapshot to drop the choice. */
  submitted: boolean;
  /** Level-up cards: rerolls left (from the player's details), 0 elsewhere. */
  rerollsLeft: number;
  /** Seconds before it resolves by itself (null: never, e.g. solo). */
  secondsLeft: number | null;
}

export interface WaitingView {
  /** Teammates still choosing (usernames), in join order. */
  others: string[];
  /** The earliest of their deadlines, in seconds (null: none). */
  secondsLeft: number | null;
}

export interface ChoiceSnapshot {
  tick: number;
  /** Our own pending choices, in full. */
  choices: readonly PendingChoice[];
  /** Everyone's pending choices. */
  waiting: readonly ChoiceRef[];
  rerollsLeft: number;
}

/** A pick that got no snapshot change for this long is offered again (its reply may be lost). */
const RETRY_MS = 2500;

export class ChoiceState {
  private current: PendingChoice | null = null;
  private first: string | null = null;
  private pickedId: string | null = null;
  private submittedAt: number | null = null;
  private snap: ChoiceSnapshot | null = null;
  /** Bumped on every change (the DOM re-renders when it changes). */
  version = 0;

  constructor(
    private readonly selfId: string,
    private readonly tickHz: number,
    private readonly names: (playerId: string) => string,
    private readonly send: (intent: Intent) => Promise<IntentResult>,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  /** Follows the newest snapshot. */
  sync(s: ChoiceSnapshot): void {
    const prev = this.snap;
    this.snap = s;
    const next = [...s.choices].sort((a, b) => a.id - b.id)[0] ?? null;
    if (next?.id !== this.current?.id) {
      // Gone (closed) or replaced by the next one: start over.
      this.first = null;
      this.pickedId = null;
      this.submittedAt = null;
      this.version++;
    } else if (next && this.current && JSON.stringify(next) !== JSON.stringify(this.current)) {
      // Same choice, new options (a reroll): nothing is picked any more.
      this.first = null;
      this.pickedId = null;
      this.submittedAt = null;
      this.version++;
    } else if (this.submittedAt !== null && this.clock() - this.submittedAt > RETRY_MS) {
      // Picked a while ago and it's still there: let the player pick again.
      this.pickedId = null;
      this.submittedAt = null;
      this.version++;
    } else if (
      !prev ||
      this.secondsOf(prev) !== this.secondsOf(s) ||
      waitingKey(prev) !== waitingKey(s) ||
      prev.rerollsLeft !== s.rerollsLeft
    )
      this.version++;
    this.current = next;
  }

  private secondsOf(s: ChoiceSnapshot): string {
    return s.waiting
      .map((c) =>
        c.deadlineTick === null ? '-' : Math.ceil((c.deadlineTick - s.tick) / this.tickHz),
      )
      .join(',');
  }

  /** Our open choice, or null. */
  view(): ChoiceView | null {
    const c = this.current;
    const s = this.snap;
    if (!c || !s) return null;
    const ids = this.optionIds(c);
    return {
      choice: c,
      options: ids.map((id) => ({ id, picked: id === this.pickedId })),
      first: this.first,
      submitted: this.submittedAt !== null,
      rerollsLeft: c.kind === 'level-up' ? s.rerollsLeft : 0,
      secondsLeft: secondsLeft(c.deadlineTick, s.tick, this.tickHz),
    };
  }

  /** Teammates still choosing (the game is paused for everyone meanwhile), or null. */
  waiting(): WaitingView | null {
    const s = this.snap;
    if (!s) return null;
    const others: string[] = [];
    let soonest: number | null = null;
    for (const c of s.waiting) {
      if (c.playerId === this.selfId) continue;
      const name = this.names(c.playerId);
      if (!others.includes(name)) others.push(name);
      const left = secondsLeft(c.deadlineTick, s.tick, this.tickHz);
      if (left !== null) soonest = soonest === null ? left : Math.min(soonest, left);
    }
    return others.length ? { others, secondsLeft: soonest } : null;
  }

  private optionIds(c: PendingChoice): string[] {
    switch (c.kind) {
      case 'level-up':
        return c.options.map((o) => o.id);
      case 'item':
        return [c.held, c.found];
      case 'bond':
        return this.first ? c.loose.filter((m) => m !== this.first) : [...c.loose];
      default:
        return [];
    }
  }

  /** Picks option `i` (keys 1–4 or a click). Returns the intent sent, if any. */
  pick(i: number): Intent | null {
    const c = this.current;
    if (!c || this.submittedAt !== null) return null;
    const id = this.optionIds(c)[i];
    if (id === undefined) return null;
    let intent: Intent;
    if (c.kind === 'level-up') intent = { type: 'pickCard', choiceId: c.id, cardId: id };
    else if (c.kind === 'item') intent = { type: 'pickItem', choiceId: c.id, itemId: id };
    else if (c.kind === 'bond') {
      if (c.mode === 'pair' && !this.first) {
        // Two steps: the first move, then the one it bonds with.
        this.first = id;
        this.version++;
        return null;
      }
      intent = {
        type: 'pickBond',
        choiceId: c.id,
        moves: c.mode === 'pair' && this.first ? [this.first, id] : [id],
      };
    } else return null;
    this.submit(intent, id);
    return intent;
  }

  /** Bond `pair`: undo the first pick. */
  back(): void {
    if (this.first === null || this.submittedAt !== null) return;
    this.first = null;
    this.version++;
  }

  /** New level-up cards (if rerolls are left). */
  reroll(): Intent | null {
    const c = this.current;
    if (!c || c.kind !== 'level-up' || this.submittedAt !== null) return null;
    if ((this.snap?.rerollsLeft ?? 0) <= 0) return null;
    const intent: Intent = { type: 'reroll', choiceId: c.id };
    this.submit(intent, null);
    return intent;
  }

  private submit(intent: Intent, id: string | null): void {
    const choiceId = this.current?.id;
    this.pickedId = id;
    this.submittedAt = this.clock();
    this.version++;
    void this.send(intent).then((r) => {
      // Accepted: the next snapshot drops the choice (or shows the new cards). Refused (stale,
      // or no rerolls left): pick again, if it's still the open choice.
      if (r.ok || this.current?.id !== choiceId) return;
      this.pickedId = null;
      this.submittedAt = null;
      this.version++;
    });
  }
}

function secondsLeft(deadlineTick: number | null, tick: number, hz: number): number | null {
  return deadlineTick === null ? null : Math.max(0, Math.ceil((deadlineTick - tick) / hz));
}

function waitingKey(s: ChoiceSnapshot): string {
  return s.waiting.map((c) => `${c.id}:${c.playerId}`).join(',');
}

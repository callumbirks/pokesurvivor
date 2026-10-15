// Spectating while down (co-op): the camera follows another player, and the server centres what
// it sends us on them (`RoomConnection.spectate`). Only the camera and the interest area move; the
// HUD stays ours. Available while we're down and someone else is still in the game; it starts on a
// teammate who is up (the first in the room's order), and left / right cycle through everyone
// present, ourselves included. Players who left or are offline are skipped, and spectating ends
// by itself when we're revived (the server clears its side then too).
import type { NetPlayer } from '@pokesurvivor/netclient';

type SpectatePlayer = Pick<NetPlayer, 'id' | 'index' | 'dead' | 'connected' | 'left'>;

const present = (p: SpectatePlayer) => p.connected && !p.left;

export class Spectator {
  /** Who the camera follows while spectating (possibly ourselves); null: not spectating. */
  private watching: string | null = null;
  private players: readonly SpectatePlayer[] = [];
  /** The target the server was last told (null: ourselves). */
  private sent: string | null = null;

  /**
   * @param selfId our player id
   * @param send tells the server whose surroundings to send (null: ours again); null in solo,
   *   which never spectates (the worker simulates around us)
   */
  constructor(
    private readonly selfId: string,
    private readonly send: ((target: string | null) => void) | null,
  ) {}

  /** Can we spectate now: down, in co-op, with someone else still in the game. */
  get available(): boolean {
    if (!this.send) return false;
    const me = this.players.find((p) => p.id === this.selfId);
    return !!me?.dead && this.players.some((p) => p.id !== this.selfId && present(p));
  }

  get active(): boolean {
    return this.watching !== null;
  }

  /** The player the camera follows: the spectated one, or ourselves. */
  get target(): string {
    return this.watching ?? this.selfId;
  }

  /** Every snapshot: ends spectating on revive, and moves off players who left or went offline. */
  update(players: readonly SpectatePlayer[]): void {
    this.players = [...players].sort((a, b) => a.index - b.index);
    if (this.watching !== null) {
      if (!this.available) this.watching = null;
      else if (!this.valid(this.watching)) this.watching = this.next(this.watching, 1);
    }
    this.sync();
  }

  /** The button / key: start on a teammate who is up (else any present), or stop. */
  toggle(): void {
    if (this.watching !== null) this.watching = null;
    else if (this.available) {
      const mates = this.players.filter((p) => p.id !== this.selfId && present(p));
      this.watching = (mates.find((p) => !p.dead) ?? mates[0])?.id ?? null;
    }
    this.sync();
  }

  /** Left (-1) / right (+1): the previous or next present player in the room's order, us too. */
  cycle(dir: -1 | 1): void {
    if (this.watching === null) return;
    this.watching = this.next(this.watching, dir);
    this.sync();
  }

  /** After a reconnect the server starts on us again: tell it once more. */
  resend(): void {
    this.sent = null;
    this.sync();
  }

  private valid(id: string): boolean {
    if (id === this.selfId) return true;
    const p = this.players.find((q) => q.id === id);
    return !!p && present(p);
  }

  /** From `from` (who may have just left) in direction `dir`, the next valid player. */
  private next(from: string, dir: -1 | 1): string {
    const order = this.players;
    const n = order.length;
    const found = order.findIndex((p) => p.id === from);
    const at = found < 0 ? (dir === 1 ? -1 : n) : found;
    for (let k = 1; k <= n; k++) {
      const p = order[(((at + k * dir) % n) + n) % n]!;
      if (this.valid(p.id)) return p.id;
    }
    return this.selfId;
  }

  private sync(): void {
    const want = this.watching === this.selfId ? null : this.watching;
    if (want === this.sent) return;
    this.sent = want;
    this.send?.(want);
  }
}

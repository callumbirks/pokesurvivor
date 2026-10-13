// Busy status: while a room member is in the gacha, shop, collection or settings, their room
// status is `busy`, so the owner can't start without them (the legacy gacha bug: the game
// started and left them behind). Leaving those screens restores the ready / not-ready status
// they had before.
import type { MemberStatus, RoomView } from '@pokesurvivor/protocol';

export interface BusyDeps {
  /** The current room, or null when not in one. */
  room(): RoomView | null;
  selfId(): string | null;
  /** Sends `room.status`. */
  setStatus(status: MemberStatus): Promise<void>;
}

export class BusyStatus {
  private onBusyScreen = false;
  /** The status to go back to on leaving the busy screens. */
  private restoreTo: Exclude<MemberStatus, 'busy'> | null = null;
  /** The status last sent and not yet seen in a room update. */
  private sent: MemberStatus | null = null;

  constructor(private readonly deps: BusyDeps) {}

  /** The router calls this on every navigation: is the new screen a busy one? */
  setBusyScreen(busy: boolean): void {
    this.onBusyScreen = busy;
    this.sync();
  }

  /** Call on every room update (`room` message), including reconnects. */
  onRoom(): void {
    this.sync();
  }

  get busy(): boolean {
    return this.onBusyScreen;
  }

  private sync(): void {
    const room = this.deps.room();
    const me = room?.members.find((m) => m.userId === this.deps.selfId());
    if (!room || !me) {
      this.restoreTo = null;
      this.sent = null;
      return;
    }
    // A sent status shows up in the room update that confirms it.
    if (this.sent === me.status) this.sent = null;
    // Status only matters while the room is in the lobby (a game sets everyone not-ready).
    if (room.phase !== 'lobby') return;
    if (this.onBusyScreen) {
      if (me.status !== 'busy' && this.sent !== 'busy') {
        this.restoreTo = me.status;
        this.send('busy');
      }
    } else if (this.restoreTo) {
      const target = this.restoreTo;
      if (me.status === 'busy' && this.sent !== target) this.send(target);
      // Done, unless a `busy` is still on its way (a quick return): restore after it lands.
      else if (me.status !== 'busy' && this.sent !== 'busy') this.restoreTo = null;
    }
  }

  private send(status: MemberStatus): void {
    this.sent = status;
    this.deps.setStatus(status).catch(() => {
      // Disconnected or refused: try again on the next room update (reconnects send one).
      if (this.sent === status) this.sent = null;
    });
  }
}

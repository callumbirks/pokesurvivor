import { encode } from '@pokesurvivor/protocol';
import type { ServerMsg } from '@pokesurvivor/netclient';
import type { WebSocket } from 'ws';
import type { SoloActivity } from './activity.js';

/** Snapshots are skipped for a client whose socket has this much unsent data (it can't keep up). */
const MAX_BUFFERED_BYTES = 256 * 1024;

let nextSessionId = 1;

/** One authenticated game socket. A user has at most one live session (a new one supersedes it). */
export class Session {
  readonly id = nextSessionId++;
  lastHeard = Date.now();
  closed = false;
  /** The solo run this user is playing, as their client reports it (for friends' presence). */
  solo: SoloActivity | null = null;
  /** Counts `activity` messages, so a slow database check can't apply an older one. */
  soloSeq = 0;

  constructor(
    readonly userId: string,
    readonly username: string,
    readonly socket: WebSocket,
  ) {}

  get open(): boolean {
    return !this.closed && this.socket.readyState === this.socket.OPEN;
  }

  send(message: ServerMsg): void {
    if (this.open) this.socket.send(encode(message));
  }

  /** Can a snapshot go out now? */
  get writable(): boolean {
    return this.open && this.socket.bufferedAmount < MAX_BUFFERED_BYTES;
  }

  sendBinary(data: Uint8Array): void {
    if (this.open) this.socket.send(data, { binary: true });
  }

  close(code: number, reason: string): void {
    this.closed = true;
    if (
      this.socket.readyState === this.socket.OPEN ||
      this.socket.readyState === this.socket.CONNECTING
    )
      this.socket.close(code, reason);
  }
}

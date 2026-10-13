import { decodeServerMessage, encode } from '@pokesurvivor/protocol';

export type ConnectionState = 'connecting' | 'open' | 'closed';

const PING_INTERVAL_MS = 1000;
const MAX_BACKOFF_MS = 10_000;

/** Delay before reconnect attempt `attempt` (0-based): 0.5 s doubling up to 10 s. */
export function reconnectDelay(attempt: number): number {
  return Math.min(MAX_BACKOFF_MS, 500 * 2 ** attempt);
}

export function socketUrl(location: Pick<Location, 'protocol' | 'host'>): string {
  return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`;
}

/** Keeps a WebSocket to the game server open and measures round-trip time. */
export class Connection {
  state: ConnectionState = 'connecting';
  rttMs: number | null = null;
  private attempt = 0;
  private nextPingId = 0;

  constructor(private readonly url: string) {
    this.connect();
  }

  private connect(): void {
    this.state = 'connecting';
    const ws = new WebSocket(this.url);
    let pingTimer: ReturnType<typeof setInterval> | undefined;

    ws.addEventListener('open', () => {
      this.state = 'open';
      this.attempt = 0;
      const ping = () =>
        ws.send(encode({ type: 'ping', id: this.nextPingId++, sentAt: performance.now() }));
      ping();
      pingTimer = setInterval(ping, PING_INTERVAL_MS);
    });

    ws.addEventListener('message', (event) => {
      const message = decodeServerMessage(String(event.data));
      if (message?.type === 'pong') this.rttMs = performance.now() - message.sentAt;
    });

    ws.addEventListener('close', () => {
      clearInterval(pingTimer);
      this.state = 'closed';
      this.rttMs = null;
      setTimeout(() => this.connect(), reconnectDelay(this.attempt++));
    });
  }
}

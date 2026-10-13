/** Bumped on every breaking change to the wire format. */
export const PROTOCOL_VERSION = 1;

export interface PingMessage {
  type: 'ping';
  id: number;
  /** Client clock, echoed back so the client can compute RTT. */
  sentAt: number;
}

export interface PongMessage {
  type: 'pong';
  id: number;
  sentAt: number;
  serverTime: number;
  protocolVersion: number;
}

export type ClientMessage = PingMessage;
export type ServerMessage = PongMessage;

export function encode(message: ClientMessage | ServerMessage): string {
  return JSON.stringify(message);
}

function parse(raw: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function decodeClientMessage(raw: string): ClientMessage | null {
  const m = parse(raw);
  if (m?.type === 'ping' && typeof m.id === 'number' && typeof m.sentAt === 'number') {
    return { type: 'ping', id: m.id, sentAt: m.sentAt };
  }
  return null;
}

export function decodeServerMessage(raw: string): ServerMessage | null {
  const m = parse(raw);
  if (
    m?.type === 'pong' &&
    typeof m.id === 'number' &&
    typeof m.sentAt === 'number' &&
    typeof m.serverTime === 'number' &&
    typeof m.protocolVersion === 'number'
  ) {
    return {
      type: 'pong',
      id: m.id,
      sentAt: m.sentAt,
      serverTime: m.serverTime,
      protocolVersion: m.protocolVersion,
    };
  }
  return null;
}

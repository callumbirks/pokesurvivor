import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, decodeClientMessage, decodeServerMessage, encode } from './index.js';

describe('protocol', () => {
  it('round-trips a ping', () => {
    const ping = { type: 'ping', id: 7, sentAt: 123.5 } as const;
    expect(decodeClientMessage(encode(ping))).toEqual(ping);
  });

  it('round-trips a pong', () => {
    const pong = {
      type: 'pong',
      id: 7,
      sentAt: 1,
      serverTime: 2,
      protocolVersion: PROTOCOL_VERSION,
    } as const;
    expect(decodeServerMessage(encode(pong))).toEqual(pong);
  });

  it('rejects garbage', () => {
    expect(decodeClientMessage('not json')).toBeNull();
    expect(decodeClientMessage('{"type":"ping"}')).toBeNull();
    expect(decodeServerMessage('null')).toBeNull();
  });
});

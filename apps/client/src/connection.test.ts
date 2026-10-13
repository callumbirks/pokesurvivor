import { describe, expect, it } from 'vitest';
import { reconnectDelay, socketUrl } from './connection.js';

describe('connection helpers', () => {
  it('picks ws/wss from the page protocol', () => {
    expect(socketUrl({ protocol: 'http:', host: 'localhost:5173' })).toBe('ws://localhost:5173/ws');
    expect(socketUrl({ protocol: 'https:', host: 'example.com' })).toBe('wss://example.com/ws');
  });

  it('backs off exponentially up to a cap', () => {
    expect(reconnectDelay(0)).toBe(500);
    expect(reconnectDelay(1)).toBe(1000);
    expect(reconnectDelay(20)).toBe(10_000);
  });
});

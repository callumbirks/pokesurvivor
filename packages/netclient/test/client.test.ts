import { describe, expect, it } from 'vitest';
import { socketUrl } from '../src/client.js';

describe('socketUrl', () => {
  it('picks ws/wss from the page protocol', () => {
    expect(socketUrl({ protocol: 'http:', host: 'localhost:5173' })).toBe('ws://localhost:5173/ws');
    expect(socketUrl({ protocol: 'https:', host: 'example.com' })).toBe('wss://example.com/ws');
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloseCode, PROTOCOL_VERSION } from '@pokesurvivor/protocol';
import { NetClient, socketUrl, type SocketLike } from '../src/client.js';

describe('socketUrl', () => {
  it('picks ws/wss from the page protocol', () => {
    expect(socketUrl({ protocol: 'http:', host: 'localhost:5173' })).toBe('ws://localhost:5173/ws');
    expect(socketUrl({ protocol: 'https:', host: 'example.com' })).toBe('wss://example.com/ws');
  });
});

class Socket implements SocketLike {
  readyState = 0;
  binaryType = '';
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;
  send = vi.fn();
  close = vi.fn();
  welcome(): void {
    this.readyState = 1;
    this.onopen?.({});
    this.onmessage?.({
      data: JSON.stringify({
        type: 'welcome',
        protocolVersion: PROTOCOL_VERSION,
        userId: 'u1',
        username: 'player',
        serverTime: Date.now(),
        heartbeatMs: 2000,
        draining: false,
      }),
    });
  }
}

describe('restart reconnect window', () => {
  afterEach(() => vi.useRealTimers());

  function client(timeoutMs = 3000) {
    vi.useFakeTimers();
    const sockets: Socket[] = [];
    const net = new NetClient({
      url: 'ws://test/ws',
      reconnectTimeoutMs: timeoutMs,
      minBackoffMs: 100,
      maxBackoffMs: 100,
      createSocket: () => {
        const s = new Socket();
        sockets.push(s);
        return s;
      },
    });
    return { net, sockets };
  }

  it('retries failed connections, preserves room state and stops at the total timeout', () => {
    const { net, sockets } = client();
    sockets[0]!.welcome();
    net.invites.set('room', { roomId: 'room', from: 'friend', expiresAt: 99999 });
    sockets[0]!.onclose?.({ code: CloseCode.restarting, reason: 'restarting' });
    expect(net.state).toBe('reconnecting');
    vi.advanceTimersByTime(150);
    expect(sockets).toHaveLength(2);
    sockets[1]!.onclose?.({ code: 1006, reason: 'offline' });
    vi.advanceTimersByTime(150);
    expect(sockets).toHaveLength(3);
    expect(net.invites.has('room')).toBe(true);
    vi.advanceTimersByTime(2700);
    expect(net.state).toBe('failed');
    expect(net.failure?.code).toBe(CloseCode.timeout);
    expect(sockets[2]!.close).toHaveBeenCalled();
    vi.advanceTimersByTime(10000);
    expect(sockets).toHaveLength(3);
    net.close();
  });

  it('a successful welcome resets the window for a later redeploy', () => {
    const { net, sockets } = client();
    sockets[0]!.welcome();
    net.dropConnection();
    vi.advanceTimersByTime(2900);
    sockets[1]!.welcome();
    expect(net.state).toBe('open');
    net.dropConnection();
    vi.advanceTimersByTime(500);
    expect(net.state).toBe('reconnecting');
    net.close();
    vi.advanceTimersByTime(10000);
    expect(net.state).toBe('closed');
    expect(sockets).toHaveLength(3);
  });

  it('retries a stalled handshake instead of waiting forever', () => {
    const { net, sockets } = client(30000);
    vi.advanceTimersByTime(10150);
    expect(net.state).toBe('reconnecting');
    expect(sockets).toHaveLength(2);
    expect(sockets[0]!.close).toHaveBeenCalled();
    net.close();
  });

  it('a new protocol version fails immediately with a reload reason', () => {
    const { net, sockets } = client();
    sockets[0]!.onclose?.({ code: CloseCode.versionMismatch, reason: 'version mismatch' });
    expect(net.state).toBe('failed');
    expect(net.failure?.code).toBe(CloseCode.versionMismatch);
    vi.advanceTimersByTime(10000);
    expect(sockets).toHaveLength(1);
    net.close();
  });
});

describe('network stats hooks', () => {
  it('emits each RTT sample and the server lag', () => {
    const socket = new Socket();
    const net = new NetClient({ url: 'ws://test/ws', createSocket: () => socket, now: () => 1000 });
    socket.welcome();
    const rtts: number[] = [];
    const lags: unknown[] = [];
    net.on('rtt', (ms) => rtts.push(ms));
    net.on('lag', (lag) => lags.push(lag));
    socket.onmessage?.({
      data: JSON.stringify({ type: 'pong', id: 1, sentAt: 960, serverTime: 0 }),
    });
    socket.onmessage?.({
      data: JSON.stringify({ type: 'server.lag', late: 2, skipped: 1, worstMs: 180 }),
    });
    expect(rtts).toEqual([40]);
    expect(net.stats().rttMs).toBe(40);
    expect(lags).toEqual([{ late: 2, skipped: 1, worstMs: 180 }]);
    net.close();
  });
});

describe('online count', () => {
  it('keeps the latest count and emits it; unknown messages are ignored', () => {
    const socket = new Socket();
    const net = new NetClient({ url: 'ws://test/ws', createSocket: () => socket });
    socket.welcome();
    expect(net.onlineCount).toBeNull();
    const counts: number[] = [];
    net.on('online', (n) => counts.push(n));
    socket.onmessage?.({ data: JSON.stringify({ type: 'online', count: 3 }) });
    socket.onmessage?.({ data: JSON.stringify({ type: 'from.the.future', x: 1 }) });
    socket.onmessage?.({ data: JSON.stringify({ type: 'online', count: 4 }) });
    expect(counts).toEqual([3, 4]);
    expect(net.onlineCount).toBe(4);
    net.close();
  });
});

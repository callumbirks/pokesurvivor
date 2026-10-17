import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGameTestServer, sleep, waitFor, type Bot } from '../test/bots.js';
import type { GameTestServer } from '../test/bots.js';

const ONLINE_COUNT_MS = 400;

describe('online player count', () => {
  let t: GameTestServer;
  beforeAll(async () => {
    t = await createGameTestServer({ onlineCountMs: ONLINE_COUNT_MS });
  });
  afterAll(() => t.close());

  /** A connected bot and every `online` count it got, with when (ms). */
  async function watcher(): Promise<{ bot: Bot; got: { count: number; at: number }[] }> {
    const bot = await t.bot();
    const got: { count: number; at: number }[] = [];
    bot.client.on('online', (count) => got.push({ count, at: performance.now() }));
    await bot.connect();
    return { bot, got };
  }

  /** Waits for the server's count to settle (earlier tests' sockets closing). */
  const settled = (n: number) => waitFor(() => t.game.onlineCount === n, `${n} online`);

  it('sends a new session the count right after welcome', async () => {
    await settled(0);
    const a = await watcher();
    await waitFor(() => a.got.length > 0, 'the count');
    expect(a.got[0]!.count).toBe(1);
    expect(a.bot.client.onlineCount).toBe(1);
    a.bot.close();
  });

  it('updates everyone when players connect and disconnect', async () => {
    await settled(0);
    const a = await watcher();
    const b = await watcher();
    await waitFor(() => a.bot.client.onlineCount === 2, 'a sees 2');
    expect(b.bot.client.onlineCount).toBe(2);
    b.bot.close();
    await waitFor(() => a.bot.client.onlineCount === 1, 'a sees 1 again', 5000);
    a.bot.close();
  });

  it('coalesces bursts into one broadcast per interval, only when the count changed', async () => {
    await settled(0);
    const a = await watcher();
    await waitFor(() => a.bot.client.onlineCount === 1, 'a sees itself');
    // Let any broadcast from a's own connect go out, then start a burst.
    await sleep(ONLINE_COUNT_MS * 1.5);
    a.got.length = 0;
    const burst = await Promise.all(Array.from({ length: 6 }, () => t.bot()));
    const extra = await t.bot();
    await Promise.all(burst.map((b) => b.connect()));
    for (const b of burst.slice(0, 3)) b.close();
    await waitFor(() => a.bot.client.onlineCount === 4, 'a sees 4', 5000);
    // Six joins and three leaves reached `a` as at most a couple of messages, spaced out.
    expect(a.got.length).toBeLessThanOrEqual(3);
    for (let i = 1; i < a.got.length; i++)
      expect(a.got[i]!.at - a.got[i - 1]!.at).toBeGreaterThanOrEqual(ONLINE_COUNT_MS - 50);
    // A join and a leave within the interval after that broadcast: the count is back where it
    // was by the time the next one is due, so nothing is sent.
    a.got.length = 0;
    await extra.connect();
    extra.close();
    await settled(4);
    await sleep(ONLINE_COUNT_MS * 2.5);
    expect(a.got).toEqual([]);
    for (const b of burst.slice(3)) b.close();
    a.bot.close();
  });
});

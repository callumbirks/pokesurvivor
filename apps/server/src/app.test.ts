import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROTOCOL_VERSION, decodeServerMessage, encode } from '@pokesurvivor/protocol';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createTestDatabase } from './test/harness.js';
import type { TestDatabase } from './test/harness.js';

describe('server', () => {
  let app: FastifyInstance;
  let baseUrl: string;
  let database: TestDatabase;

  beforeAll(async () => {
    const legacyDir = mkdtempSync(join(tmpdir(), 'legacy-'));
    writeFileSync(join(legacyDir, 'index.html'), '<title>legacy</title>');
    const assetsDir = mkdtempSync(join(tmpdir(), 'assets-'));
    mkdirSync(join(assetsDir, 'pokemon', '25'), { recursive: true });
    writeFileSync(join(assetsDir, 'pokemon', '25', 'Idle.png'), 'png');
    const config = loadConfig({
      PORT: '0',
      HOST: '127.0.0.1',
      LOG_LEVEL: 'silent',
      LEGACY_DIR: legacyDir,
      ASSETS_DIR: assetsDir,
      CLIENT_DIR: join(legacyDir, 'missing'),
    });
    database = await createTestDatabase();
    app = await buildApp({ config, db: database.db });
    baseUrl = await app.listen({ host: config.host, port: config.port });
  });

  afterAll(async () => {
    await app.close();
    await database.drop();
  });

  it('reports health', async () => {
    const res = await app.inject({ url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', database: 'up' });
  });

  it('serves the legacy game under /legacy/', async () => {
    const res = await app.inject({ url: '/legacy/' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('legacy');
    const redirect = await app.inject({ url: '/legacy' });
    expect(redirect.statusCode).toBe(301);
    expect(redirect.headers.location).toBe('/legacy/');
  });

  it('serves sprites with long cache headers, also at the legacy path', async () => {
    for (const url of ['/sprites/25/Idle.png', '/legacy/assets/pokemon/25/Idle.png']) {
      const res = await app.inject({ url });
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe('png');
      expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    }
    expect((await app.inject({ url: '/sprites/25/Missing.png' })).statusCode).toBe(404);
  });

  it('answers pings over the WebSocket', async () => {
    const ws = new WebSocket(`${baseUrl.replace('http', 'ws')}/ws`);
    const reply = await new Promise<string>((resolve, reject) => {
      ws.addEventListener('open', () => ws.send(encode({ type: 'ping', id: 1, sentAt: 42 })));
      ws.addEventListener('message', (event) => resolve(String(event.data)));
      ws.addEventListener('error', () => reject(new Error('WebSocket error')));
    });
    ws.close();
    expect(decodeServerMessage(reply)).toMatchObject({
      type: 'pong',
      id: 1,
      sentAt: 42,
      protocolVersion: PROTOCOL_VERSION,
    });
  });
});

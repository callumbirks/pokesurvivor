import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CloseCode, PROTOCOL_VERSION } from '@pokesurvivor/protocol';
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
    const assetsDir = mkdtempSync(join(tmpdir(), 'assets-'));
    mkdirSync(join(assetsDir, 'pokemon', '25'), { recursive: true });
    writeFileSync(join(assetsDir, 'pokemon', '25', 'Idle.png'), 'png');
    const config = loadConfig({
      PORT: '0',
      HOST: '127.0.0.1',
      LOG_LEVEL: 'silent',
      ASSETS_DIR: assetsDir,
      CLIENT_DIR: join(assetsDir, 'missing'),
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

  it('serves sprites with long cache headers', async () => {
    const res = await app.inject({ url: '/sprites/25/Idle.png' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('png');
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect((await app.inject({ url: '/sprites/25/Missing.png' })).statusCode).toBe(404);
  });

  it('reports the protocol version', async () => {
    const res = await app.inject({ url: '/api/info' });
    expect(res.json()).toEqual({ protocolVersion: PROTOCOL_VERSION, tickHz: 30 });
  });

  it('refuses anonymous WebSockets', async () => {
    const ws = new WebSocket(`${baseUrl.replace('http', 'ws')}/ws`);
    const code = await new Promise<number>((resolve) =>
      ws.addEventListener('close', (event) => resolve(event.code)),
    );
    expect(code).toBe(CloseCode.unauthenticated);
  });
});

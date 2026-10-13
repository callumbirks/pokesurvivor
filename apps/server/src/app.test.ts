import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROTOCOL_VERSION, decodeServerMessage, encode } from '@pokesurvivor/protocol';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

describe('server', () => {
  let app: FastifyInstance;
  let baseUrl: string;

  beforeAll(async () => {
    const legacyDir = mkdtempSync(join(tmpdir(), 'legacy-'));
    writeFileSync(join(legacyDir, 'index.html'), '<title>legacy</title>');
    const config = loadConfig({
      PORT: '0',
      HOST: '127.0.0.1',
      LOG_LEVEL: 'silent',
      LEGACY_DIR: legacyDir,
      CLIENT_DIR: join(legacyDir, 'missing'),
    });
    app = await buildApp({ config, db: { ping: async () => {} } });
    baseUrl = await app.listen({ host: config.host, port: config.port });
  });

  afterAll(async () => {
    await app.close();
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

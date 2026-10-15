import { connect, type Socket } from 'node:net';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadChangelog, versionLabel } from '@pokesurvivor/data';
import { CloseCode, PROTOCOL_VERSION } from '@pokesurvivor/protocol';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from './app.js';
import { loadConfig, readBuild } from './config.js';
import { createTestDatabase } from './test/harness.js';
import type { TestDatabase } from './test/harness.js';
import { createGameTestServer, withTimeout } from './test/bots.js';

describe('server', () => {
  let app: FastifyInstance;
  let baseUrl: string;
  let database: TestDatabase;

  beforeAll(async () => {
    const assetsDir = mkdtempSync(join(tmpdir(), 'assets-'));
    mkdirSync(join(assetsDir, 'pokemon', '25'), { recursive: true });
    writeFileSync(join(assetsDir, 'pokemon', '25', 'Idle.png'), 'png');
    // A built client: its build.json names the deploy.
    const clientDir = join(assetsDir, 'client');
    mkdirSync(clientDir);
    writeFileSync(join(clientDir, 'build.json'), JSON.stringify({ id: 'build-42' }));
    const config = loadConfig({
      PORT: '0',
      HOST: '127.0.0.1',
      LOG_LEVEL: 'silent',
      ASSETS_DIR: assetsDir,
      CLIENT_DIR: clientDir,
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

  it('reports the protocol version and the build', async () => {
    const res = await app.inject({ url: '/api/info' });
    expect(res.json()).toEqual({
      protocolVersion: PROTOCOL_VERSION,
      tickHz: 30,
      build: 'build-42',
      version: versionLabel(loadChangelog()),
    });
  });

  it('names the build on API responses only', async () => {
    const api = await app.inject({ url: '/api/auth/me' });
    expect(api.headers['x-build']).toBe('build-42');
    expect(api.headers['x-build-version']).toBe(versionLabel(loadChangelog()));
    expect((await app.inject({ url: '/healthz' })).headers['x-build']).toBeUndefined();
  });

  it('has no build without a build.json (development)', () => {
    expect(readBuild(join(tmpdir(), 'no-such-client'))).toBeNull();
  });

  it('refuses anonymous WebSockets', async () => {
    const ws = new WebSocket(`${baseUrl.replace('http', 'ws')}/ws`);
    const code = await new Promise<number>((resolve) =>
      ws.addEventListener('close', (event) => resolve(event.code)),
    );
    expect(code).toBe(CloseCode.unauthenticated);
  });
});

it('closes a reconnect rejected while shutdown hooks are still running', async () => {
  const t = await createGameTestServer();
  const app = t.app;
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const stop = app.runSweeper!.stop.bind(app.runSweeper);
  const held = vi.spyOn(app.runSweeper!, 'stop').mockImplementation(async () => {
    entered();
    await gate;
    await stop();
  });
  let serverSocket: Socket | undefined;
  app.server.once('connection', (socket) => {
    serverSocket = socket;
  });
  const closed = app.close();
  await withTimeout(started, 1000, 'shutdown hook');
  const client = connect({ host: '127.0.0.1', port: Number(new URL(t.url).port) });
  const ended = new Promise<void>((resolve) => {
    client.on('error', () => {});
    client.on('data', () => client.end());
    client.on('close', () => resolve());
  });
  client.on('connect', () =>
    client.write(
      [
        'GET /ws HTTP/1.1',
        'Host: localhost',
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        '',
        '',
      ].join('\r\n'),
    ),
  );
  try {
    await withTimeout(ended, 1000, 'rejected reconnect closes');
    release();
    await withTimeout(closed, 1000, 'HTTP server shutdown');
    expect(serverSocket?.destroyed).toBe(true);
  } finally {
    client.destroy();
    serverSocket?.destroy();
    release();
    await closed;
    held.mockRestore();
    await t.close();
  }
});

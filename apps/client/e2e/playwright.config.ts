// Browser end-to-end tests (`pnpm --filter @pokesurvivor/client e2e`): a real game server (on
// Postgres from DATABASE_URL, default the docker compose one) and the Vite dev server, on their
// own ports so they don't clash with `pnpm dev`. Set E2E_BASE_URL to test a running client.
import { defineConfig, devices } from '@playwright/test';

const serverPort = Number(process.env.E2E_SERVER_PORT ?? 3101);
const clientPort = Number(process.env.E2E_CLIENT_PORT ?? 5181);
const external = process.env.E2E_BASE_URL;

export default defineConfig({
  testDir: '.',
  testMatch: '*.e2e.ts',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: external ?? `http://localhost:${clientPort}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: external
    ? undefined
    : [
        {
          command: 'pnpm --filter @pokesurvivor/server exec tsx src/main.ts',
          url: `http://localhost:${serverPort}/healthz`,
          env: {
            PORT: String(serverPort),
            AUTH_RATE_LIMIT_MAX: '1000',
            ACTION_RATE_LIMIT_MAX: '1000',
            LOG_LEVEL: 'warn',
          },
          reuseExistingServer: false,
          timeout: 60_000,
        },
        {
          command: `pnpm exec vite --port ${clientPort} --strictPort`,
          cwd: '..',
          url: `http://localhost:${clientPort}`,
          env: { SERVER_URL: `http://localhost:${serverPort}` },
          reuseExistingServer: false,
          timeout: 60_000,
        },
      ],
});

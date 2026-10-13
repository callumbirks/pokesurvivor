import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Each file creates and migrates its own Postgres database.
    hookTimeout: 30_000,
    // The game server tests run real-time games over real WebSockets.
    testTimeout: 30_000,
  },
});

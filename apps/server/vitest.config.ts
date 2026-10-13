import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Each file creates and migrates its own Postgres database.
    hookTimeout: 30_000,
  },
});

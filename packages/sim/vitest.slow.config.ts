import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['test/*.slow.ts'], pool: 'threads', maxWorkers: 2 },
});

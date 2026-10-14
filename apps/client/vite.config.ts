import { defineConfig } from 'vite';

const server = process.env.SERVER_URL ?? 'http://localhost:3000';

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/api': server,
      '/healthz': server,
      '/sprites': server,
      '/ws': { target: server, ws: true },
    },
  },
});

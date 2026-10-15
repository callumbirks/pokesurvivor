import { defineConfig, type Plugin } from 'vite';

const server = process.env.SERVER_URL ?? 'http://localhost:3000';

/**
 * Writes `build.json` ({id}) next to the bundle. The server serving this bundle reads it and
 * announces the id to clients, which compare it with the one baked into them (`__BUILD_ID__`) to
 * offer a reload after a deploy.
 */
function buildFile(id: string): Plugin {
  return {
    name: 'pokesurvivor-build-id',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'build.json', source: JSON.stringify({ id }) });
    },
  };
}

export default defineConfig(({ command }) => {
  // Unique per production build (`BUILD_ID` overrides it, e.g. with a commit); none in dev.
  const id = command === 'build' ? process.env.BUILD_ID || `${Date.now().toString(36)}` : '';
  return {
    define: { __BUILD_ID__: JSON.stringify(id) },
    plugins: id ? [buildFile(id)] : [],
    server: {
      port: 5173,
      proxy: {
        '/api': server,
        '/healthz': server,
        '/sprites': server,
        '/ws': { target: server, ws: true },
      },
    },
  };
});

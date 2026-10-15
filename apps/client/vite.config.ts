import { defineConfig, type Plugin } from 'vite';
import en from '../../packages/data/i18n/en.json' with { type: 'json' };
import { installLoadRecovery, RECOVERY_OPTIONS } from './src/load-recovery.js';

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

/**
 * Runs `installLoadRecovery` (src/load-recovery.ts) inline, first thing in every page, so a
 * bundle that fails to load (e.g. a 404 during a deploy) reloads once or says so instead of
 * leaving a blank page. It has to be inline: the bundle may be what failed.
 */
function loadRecovery(): Plugin {
  // `<` escaped in the strings, so none can close the script element.
  const options = JSON.stringify({ ...RECOVERY_OPTIONS, message: en.app.loadFailed }).replace(
    /</g,
    '\\u003c',
  );
  const code = `(${installLoadRecovery.toString()})(window, ${options});`;
  if (/<\/script/i.test(code)) throw new Error('load recovery: the script would close early');
  return {
    name: 'pokesurvivor-load-recovery',
    // Where index.html marks it: after `<meta charset>`, which must come first, and before the
    // bundle's script and stylesheet, so their errors are seen.
    transformIndexHtml: (html) =>
      html.replace('<!-- load-recovery -->', `<script>${code}</script>`),
  };
}

export default defineConfig(({ command }) => {
  // Unique per production build (`BUILD_ID` overrides it, e.g. with a commit); none in dev.
  const id = command === 'build' ? process.env.BUILD_ID || `${Date.now().toString(36)}` : '';
  return {
    define: { __BUILD_ID__: JSON.stringify(id) },
    plugins: [loadRecovery(), ...(id ? [buildFile(id)] : [])],
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

// Bundles the server and the workspace packages it imports (they ship TypeScript source)
// into dist/main.js, and the admin re-credit tool into dist/recredit.js (docs/deploy.md). npm
// dependencies stay external and are installed in the image.
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

await build({
  entryPoints: { main: 'src/main.ts', recredit: 'src/recredit-cli.ts' },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  external: Object.keys(pkg.dependencies ?? {}),
  logLevel: 'info',
});

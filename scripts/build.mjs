import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Single build path for the whole app: Electron main, Electron preload and the
 * renderer bundle are all produced here with esbuild, then the static renderer
 * assets are copied into dist/. `npm run dev` uses the same pipeline and only
 * adds Vite for live reload.
 */

const root = process.cwd();
const dist = join(root, 'dist');
const isDev = process.argv.includes('--dev');

rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, 'renderer'), { recursive: true });

const shared = {
  bundle: true,
  target: 'es2022',
  sourcemap: true,
  logLevel: 'warning',
  minify: false,
};

const electronExternals = ['electron'];

await Promise.all([
  build({
    ...shared,
    entryPoints: [join(root, 'src/main/main.ts')],
    outfile: join(dist, 'electron/main.js'),
    platform: 'node',
    format: 'cjs',
    external: electronExternals,
  }),
  build({
    ...shared,
    entryPoints: [join(root, 'src/main/preload.ts')],
    outfile: join(dist, 'electron/preload.js'),
    platform: 'node',
    format: 'cjs',
    external: electronExternals,
  }),
  build({
    ...shared,
    entryPoints: [join(root, 'src/renderer/main.ts')],
    outfile: join(dist, 'renderer/main.js'),
    platform: 'browser',
    format: 'iife',
    define: { __APP_DEV__: isDev ? 'true' : 'false' },
  }),
]);

cpSync(join(root, 'src/renderer/index.html'), join(dist, 'renderer/index.html'));
cpSync(join(root, 'src/renderer/styles.css'), join(dist, 'renderer/styles.css'));

// The shipped index.html must reference the bundle instead of the TS source.
const htmlPath = join(dist, 'renderer/index.html');
const html = readFileSync(htmlPath, 'utf8').replace(
  '<script type="module" src="./main.ts"></script>',
  '<script src="./main.js"></script>',
);
writeFileSync(htmlPath, html);

if (existsSync(join(root, 'assets'))) {
  cpSync(join(root, 'assets'), join(dist, 'renderer/assets'), { recursive: true });
}

console.log('[build] ok ->', dist);

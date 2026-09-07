import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Development launcher.
 *
 *  1. bundles the Electron main + preload with esbuild (they change rarely),
 *  2. starts the Vite dev server so the renderer gets TypeScript + HMR straight
 *     out of src/renderer,
 *  3. waits for the server to answer, then starts Electron against it.
 *
 * Ctrl+C tears both children down.
 */

const root = process.cwd();
const dist = join(root, 'dist');
const port = process.env.PORT ?? '5173';
const url = `http://localhost:${port}`;

rmSync(join(dist, 'electron'), { recursive: true, force: true });
mkdirSync(join(dist, 'electron'), { recursive: true });

console.log('[dev] bundling electron main + preload');
await build({
  bundle: true,
  target: 'es2022',
  sourcemap: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
  outdir: join(dist, 'electron'),
  entryPoints: [join(root, 'src/main/main.ts'), join(root, 'src/main/preload.ts')],
  logLevel: 'warning',
});

let shuttingDown = false;
const children = [];

function run(command, args, env = {}) {
  const child = spawn(command, args, {
    stdio: 'inherit',
    env: { ...process.env, ...env },
    shell: process.platform === 'win32',
  });
  children.push(child);
  child.on('exit', (code) => {
    if (!shuttingDown) shutdown(code ?? 0);
  });
  return child;
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode === null) child.kill('SIGTERM');
  }
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

console.log(`[dev] starting vite on ${url}`);
run('npx', ['--no-install', 'vite', '--port', port, '--strictPort']);

for (let attempt = 0; attempt < 80; attempt++) {
  try {
    const response = await fetch(url);
    if (response.ok) break;
  } catch {
    // server not accepting connections yet
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
}

console.log('[dev] launching electron');
run('npx', ['--no-install', 'electron', '.'], { VITE_DEV_SERVER_URL: url });

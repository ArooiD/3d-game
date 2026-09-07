import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const dir = await mkdtemp(join(tmpdir(), 'dustfall-tests-'));
try {
  const entries = ['tests/gameplay.test.ts', 'tests/physics.test.ts', 'tests/enemy-parts.test.ts'];
  await build({
    entryPoints: entries,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outdir: dir,
    outExtension: { '.js': '.cjs' },
  });
  const suites = ['gameplay.test.cjs', 'physics.test.cjs', 'enemy-parts.test.cjs'].map((name) => join(dir, name));
  const result = spawnSync(process.execPath, ['--test', ...suites], { stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
} finally {
  await rm(dir, { recursive: true, force: true });
}

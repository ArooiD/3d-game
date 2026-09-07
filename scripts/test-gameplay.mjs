import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
const dir = await mkdtemp(join(tmpdir(), 'dustfall-tests-'));
try {
  const outfile = join(dir, 'gameplay.test.cjs');
  await build({ entryPoints: ['tests/gameplay.test.ts'], bundle: true, platform: 'node', format: 'cjs', outfile });
  const result = spawnSync(process.execPath, ['--test', outfile], { stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
} finally { await rm(dir, { recursive: true, force: true }); }

#!/usr/bin/env node
// Thin shim so `harness` works after `npm link` without a build step.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const result = spawnSync(
  process.execPath,
  [join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(root, 'src', 'cli.ts'), ...process.argv.slice(2)],
  { stdio: 'inherit' },
);
process.exit(result.status ?? 0);

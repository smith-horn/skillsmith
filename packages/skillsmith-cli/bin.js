#!/usr/bin/env node
// Convenience wrapper — delegates to @skillsmith/cli
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// Resolve the actual @skillsmith/cli bin path
const require = createRequire(import.meta.url);
const cliPkg = require.resolve('@skillsmith/cli/package.json');
const cliBin = join(dirname(cliPkg), 'dist', 'src', 'index.js');

try {
  execFileSync(process.execPath, [cliBin, ...process.argv.slice(2)], {
    stdio: 'inherit',
  });
} catch (err) {
  process.exitCode = err.status ?? 1;
}

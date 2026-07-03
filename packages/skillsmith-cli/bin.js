#!/usr/bin/env node
// Convenience wrapper — delegates to @skillsmith/cli.
//
// Resolve the CLI's OWN `bin` entry from its package.json rather than
// hardcoding a dist path. The CLI's output layout is not stable across
// versions — 0.6.x shipped the unbundled `dist/src/index.js`, 0.7.0+ ships
// the esbuild bundle `dist/cli.js` — so a hardcoded path silently breaks on
// the next layout change (SMI-5512). Reading `bin.skillsmith` keeps this
// wrapper correct for whatever the installed CLI declares.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const cliPkgPath = require.resolve('@skillsmith/cli/package.json');
const cliPkg = require('@skillsmith/cli/package.json');

const binField = cliPkg.bin;
const binRel =
  typeof binField === 'string' ? binField : binField?.skillsmith ?? Object.values(binField ?? {})[0];
if (!binRel) {
  console.error('skillsmith-cli: @skillsmith/cli declares no `bin` entry to delegate to.');
  process.exit(1);
}
const cliBin = join(dirname(cliPkgPath), binRel);

try {
  execFileSync(process.execPath, [cliBin, ...process.argv.slice(2)], {
    stdio: 'inherit',
  });
} catch (err) {
  process.exitCode = err.status ?? 1;
}

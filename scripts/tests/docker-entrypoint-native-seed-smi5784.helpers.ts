/**
 * SMI-5784 extraction + fixture helpers, split out from the sibling
 * docker-entrypoint-native-seed.helpers.ts (SMI-5650) per CLAUDE.md's
 * 500-line guidance — imports and reuses that file's `findIfBlockAfter`
 * anchor+depth-counting extraction primitive, `substituteFixturePaths`
 * path-rewrite, `Fixture` type, and `makeFixture`/`runBlock` rather than
 * duplicating any of it.
 *
 * This file holds the pieces that are NEW for SMI-5784 (per-package
 * native-module volume seeding): extracting the two new
 * docker-entrypoint.sh blocks (boot-time per-package seed step;
 * per-package validate + self-heal block), and a REAL-node execution path
 * for the tests that must exercise genuine Node module-resolution
 * behavior rather than the SMI-5650 stub's simplistic pattern matcher (see
 * runBlockRealNode's docstring for why).
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  findIfBlockAfter,
  substituteFixturePaths,
  type Fixture,
} from './docker-entrypoint-native-seed.helpers.js'

/**
 * Extract the SMI-5784 PER-PACKAGE boot-time seed step:
 *   if [ -f "/app/.git" ] && [ "${SKILLSMITH_WORKTREE_NATIVE_SEED_DISABLE:-}" != "1" ]; then
 *     for pkg_dir in /app/packages GLOB-STAR-SLASH; do
 *       ...
 *     done
 *   fi
 * block, verbatim from the live source (the loop header above is spelled
 * out to avoid a literal `star-slash` sequence inside this comment, which
 * would otherwise close the JSDoc block early). Same
 * anchor+if/fi-depth-counting technique as the SMI-5650 sibling file's
 * extractBootTimeSeedBlock.
 */
export function extractPackageBootTimeSeedBlock(src: string): string {
  const anchor = '# SMI-5784: seed writable PER-PACKAGE native-module named volumes (worktree'
  const lines = src.split('\n')
  const anchorIdx = lines.findIndex((l) => l.includes(anchor))
  if (anchorIdx === -1) {
    throw new Error(
      `extractPackageBootTimeSeedBlock: anchor not found in docker-entrypoint.sh: ${anchor}`
    )
  }

  const block = findIfBlockAfter(lines, anchorIdx)
  if (!block) {
    throw new Error(
      'extractPackageBootTimeSeedBlock: if/fi block not found after the SMI-5784 anchor'
    )
  }

  return lines.slice(block.startIdx, block.endIdx + 1).join('\n')
}

/**
 * Extract the SMI-5784 PER-PACKAGE validate + self-heal block:
 *   if [ -f "/app/.git" ]; then
 *     ...per-package validate/re-seed/rebuild loop...
 *   fi
 * block, verbatim from the live source. This block nests several inner
 * if/fi pairs of its own (per-target validate check, disable-var-gated
 * re-seed fast path, post-rebuild re-validate), all correctly absorbed by
 * findIfBlockAfter's depth counter since every nested `if`/`fi` is real
 * bash control flow anchored at its line's start.
 */
export function extractPackageValidationRebuildBlock(src: string): string {
  const anchor = '# SMI-5784: validate + self-heal PER-PACKAGE native-module overlays'
  const lines = src.split('\n')
  const anchorIdx = lines.findIndex((l) => l.includes(anchor))
  if (anchorIdx === -1) {
    throw new Error(
      `extractPackageValidationRebuildBlock: anchor not found in docker-entrypoint.sh: ${anchor}`
    )
  }

  const block = findIfBlockAfter(lines, anchorIdx)
  if (!block) {
    throw new Error(
      'extractPackageValidationRebuildBlock: if/fi block not found after the SMI-5784 validate anchor'
    )
  }

  return lines.slice(block.startIdx, block.endIdx + 1).join('\n')
}

/**
 * Create a real, requireable fake native module at `dir` — used only by
 * tests exercising the REAL `node` binary (via runBlockRealNode), since
 * those tests validate genuine Node module-resolution behavior, not an
 * emulation of it. Shape mirrors what validate_native_module()'s dispatch
 * expects per module: better-sqlite3 needs a constructible class
 * (`new X(':memory:').close()`), esbuild needs `.transformSync()`,
 * everything else just needs to be requireable without throwing. `marker`
 * is embedded in the export so a test can assert WHICH copy actually got
 * loaded (e.g. distinguishing a wrong root-level copy from the intended
 * package-local one).
 */
export function makeFakeNativeModule(dir: string, moduleName: string, marker: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: moduleName, main: 'index.js' }),
    'utf8'
  )
  let body: string
  switch (moduleName) {
    case 'better-sqlite3':
      body = `module.exports = class FakeDB { constructor(){this.marker='${marker}'} close(){} }`
      break
    case 'esbuild':
      body = `module.exports = { transformSync: () => ({ marker: '${marker}' }) }`
      break
    default:
      body = `module.exports = { marker: '${marker}' }`
  }
  writeFileSync(join(dir, 'index.js'), body, 'utf8')
}

/**
 * A bin dir containing ONLY the fixture's `npm` rebuild-logging stub
 * (never `node`) — for tests that need the REAL system `node` binary
 * rather than the SMI-5650 sibling file's makeNodeStub simplistic
 * `require('<module>')` pattern matcher. The per-package
 * validate_native_module() branch (docker-entrypoint.sh) runs genuine
 * `require.resolve(..., { paths: [...] })` + `startsWith()` prefix-check
 * JS — the stub's naive "extract the text between require( and the next
 * matching quote" parser cannot interpret that shape at all, so
 * exercising the REAL bug this branch fixes (Blocker #2's false-positive
 * resolution) requires a REAL Node module-resolution algorithm, not an
 * emulation of one — empirically confirmed while writing this plan's
 * implementation (see docs/internal/implementation/
 * smi-5784-native-seed-per-package-volumes.md's Context: emptying a
 * package-local copy and resolving via `require.resolve(..., { paths })`
 * genuinely climbs to a DIFFERENT copy on the real filesystem).
 */
function makeNpmOnlyBinDir(fixture: Fixture): string {
  const dir = join(fixture.root, '_bin_npm_only')
  mkdirSync(dir, { recursive: true })
  copyFileSync(join(fixture.binDir, 'npm'), join(dir, 'npm'))
  chmodSync(join(dir, 'npm'), 0o755)
  return dir
}

/**
 * Execute an already fixture-path-substituted block via `bash -c`, with
 * ONLY the fixture's npm-rebuild-logging stub on PATH ahead of the
 * inherited (real) PATH — so `node` resolves to the REAL system Node
 * binary while `npm rebuild` invocations are still captured/no-op'd rather
 * than genuinely attempting a rebuild. See makeNpmOnlyBinDir's docstring
 * for why this exists as a companion to the SMI-5650 sibling file's
 * runBlock rather than a parameter on it.
 */
export function runBlockRealNode(
  fixture: Fixture,
  blockSrc: string,
  extraEnv: Record<string, string> = {},
  prelude = ''
): { status: number; output: string } {
  const substituted = substituteFixturePaths(blockSrc, fixture.root)
  const script = [
    'set -e',
    "YELLOW=''",
    "GREEN=''",
    "RED=''",
    "NC=''",
    prelude,
    substituted,
    '',
  ].join('\n')
  const npmOnlyBinDir = makeNpmOnlyBinDir(fixture)

  const result = spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    env: {
      PATH: `${npmOnlyBinDir}:${process.env['PATH'] ?? '/usr/bin:/bin'}`,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15_000,
  })
  return { status: result.status ?? 1, output: (result.stdout ?? '') + (result.stderr ?? '') }
}

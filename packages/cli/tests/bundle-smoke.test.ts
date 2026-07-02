/**
 * @fileoverview esbuild-bundle smoke test for the CLI (SMI-5456 follow-up).
 * @module @skillsmith/cli/tests/bundle-smoke
 *
 * `dist/cli.js` is a SEPARATE build output from `dist/src/**`: an esbuild
 * ESM bundle that inlines every workspace dependency not on the build
 * script's `--external` list. Unit tests import source modules directly and
 * therefore CANNOT catch bundle-only failures — the device-login e2e caught
 * exactly that class of bug: a statically-imported CJS dependency (`yaml`,
 * pulled in via `agent.action → @skillsmith/core install barrel →
 * agent-config-merge.yaml.ts`) crashed the bundle AT IMPORT TIME with
 * "Dynamic require of 'process' is not supported" while every unit test
 * stayed green. This test closes that gap by executing the real bundle.
 *
 * Bundle availability: in CI's Docker test job, root `npm run build`
 * (Turborepo → packages/cli's esbuild step) runs BEFORE
 * `npm test --workspace=packages/cli` (ci.yml "Build project (Docker)" step
 * precedes "Run tests"), so `dist/cli.js` always exists there. A missing
 * bundle is therefore a build-order regression and this test FAILS with an
 * actionable message rather than skipping — silent skips on a missing
 * artifact are a known dormant-test landmine (SMI-4961). The ONLY skip path
 * is the explicit `SKILLSMITH_BUNDLE_SMOKE_SKIP=1` env var, and it is LOUD
 * (a warning is printed naming the variable).
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const testDir = dirname(fileURLToPath(import.meta.url))
const bundlePath = join(testDir, '..', 'dist', 'cli.js')

const explicitSkip = process.env['SKILLSMITH_BUNDLE_SMOKE_SKIP'] === '1'
if (explicitSkip) {
  // LOUD skip — never silent (house rule: a silently-skipped dormant test
  // reads as coverage that does not exist).
  console.warn(
    '[bundle-smoke] SKIPPED: SKILLSMITH_BUNDLE_SMOKE_SKIP=1 is set. ' +
      'The esbuild bundle (dist/cli.js) is NOT being smoke-tested in this run.'
  )
}

describe.skipIf(explicitSkip)('CLI esbuild bundle smoke (dist/cli.js)', () => {
  it('starts up and prints its version with exit code 0', () => {
    if (!existsSync(bundlePath)) {
      throw new Error(
        `dist/cli.js not found at ${bundlePath} — build the bundle first: ` +
          '`npm run build -w @skillsmith/cli` (or root `npm run build`). ' +
          'In CI the Docker test job builds before vitest runs, so a missing ' +
          'bundle there indicates a build-order regression, not a local quirk. ' +
          'To intentionally skip (loudly), set SKILLSMITH_BUNDLE_SMOKE_SKIP=1.'
      )
    }

    // execFileSync with array args (house rule — never execSync string
    // interpolation). Throws on non-zero exit, which fails the test with the
    // child's stderr attached — exactly the import-time crash signature this
    // test exists to catch.
    const stdout = execFileSync(process.execPath, [bundlePath, '--version'], {
      encoding: 'utf-8',
      timeout: 30_000,
      env: { ...process.env, SKILLSMITH_AUTO_UPDATE_CHECK: 'false' },
    })

    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/)
  })
})

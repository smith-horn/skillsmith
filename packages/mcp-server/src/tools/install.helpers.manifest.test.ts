/**
 * @fileoverview Tests for install.helpers.manifest.ts's real-home write guard.
 *
 * SMI-6343 Wave 1 follow-up (adversarial review): `saveManifest()` and
 * `updateManifestSafely()` here are a second, complete manifest write stack
 * parallel to `@skillsmith/core`'s `ManifestManager` — `MANIFEST_PATH` is
 * homedir-derived (install.types.ts) with no path-override parameter, so
 * before this fix nothing but the global `$HOME` test sandbox
 * (vitest.setup.ts) protected this write path. This proves the new
 * `assertNotRealUserHome()` guard itself fires, by pointing
 * `SKILLSMITH_TEST_REAL_HOME` at whatever home `MANIFEST_PATH` currently
 * resolves under (the sandbox, in this test run) so the guard treats it as
 * "the real home" for these assertions — the same technique
 * home-sandbox.integration.test.ts uses.
 *
 * SMI-6735: `acquireManifestLock()`/`releaseManifestLock()` were removed
 * when locking moved onto the shared `withFileLock` (owned-lock) primitive —
 * `updateManifestSafely()` is now the only entry point, and (like
 * `ManifestManager.updateSafely()`) it calls the guard FIRST, before
 * `withFileLock` ever attempts to create a lock file.
 */
import { describe, it, expect } from 'vitest'
import * as path from 'path'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { MANIFEST_PATH } from './install.types.js'
import { saveManifest, updateManifestSafely } from './install.helpers.manifest.js'

// MANIFEST_PATH = path.join(SKILLSMITH_DIR, 'manifest.json'), SKILLSMITH_DIR =
// path.join(os.homedir(), '.skillsmith') — two dirname() calls recover homedir().
const simulatedRealHome = path.dirname(path.dirname(MANIFEST_PATH))

async function withSimulatedRealHome(fn: () => Promise<void>): Promise<void> {
  const previous = process.env.SKILLSMITH_TEST_REAL_HOME
  process.env.SKILLSMITH_TEST_REAL_HOME = simulatedRealHome
  try {
    await fn()
  } finally {
    if (previous === undefined) delete process.env.SKILLSMITH_TEST_REAL_HOME
    else process.env.SKILLSMITH_TEST_REAL_HOME = previous
  }
}

describe('SMI-6343: install.helpers.manifest.ts real-home write guard', () => {
  it('saveManifest() refuses to write when MANIFEST_PATH resolves under the (simulated) real home', async () => {
    await withSimulatedRealHome(async () => {
      await expect(saveManifest({ version: '1.0.0', installedSkills: {} })).rejects.toThrow(
        /SMI-6343/
      )
    })
    // The guard fired before any fs call — nothing was written.
    expect(existsSync(MANIFEST_PATH)).toBe(false)
  })

  it('updateManifestSafely() refuses to update when MANIFEST_PATH resolves under the (simulated) real home', async () => {
    await withSimulatedRealHome(async () => {
      await expect(updateManifestSafely((m) => m)).rejects.toThrow(/SMI-6343/)
    })
    // The guard fired before withFileLock() ever attempted to create a lock
    // file — asserted directly so a regression that DOES create one is visible.
    expect(existsSync(MANIFEST_PATH + '.lock')).toBe(false)
  })
})

// SMI-6735. This module and `@skillsmith/core`'s ManifestManager lock the
// BYTE-IDENTICAL path `<homedir>/.skillsmith/manifest.json.lock`, and the MCP
// server runs both in one process. That is what made the defect worse than it
// looked: two protocols on one lock file is not mutual exclusion at all, so
// fixing either site alone would not have closed the issue.
//
// The mirror of this assertion lives in core's skill-manifest.test.ts. Both
// must observe the SAME claim shape, because they are now the same protocol —
// and each derives its lock path as `<manifest>.lock` from the same helper.
describe('SMI-6735: updateManifestSafely() holds an ownership-tokened lock', () => {
  it('writes a versioned owned-lock claim bearing a random per-acquire token for the duration of the update', async () => {
    mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true })

    let raw: string | undefined
    await updateManifestSafely((m) => {
      raw = readFileSync(MANIFEST_PATH + '.lock', 'utf8')
      return m
    })

    expect(raw, 'no lock file existed while the update was running').toBeDefined()

    const claim = JSON.parse(raw as string) as Record<string, unknown>
    // A bare pid parses to a NUMBER, an owned-lock claim to an object — that is
    // the discriminator, and `JSON.parse` itself does not throw on either.
    expect(typeof claim).toBe('object')
    expect(claim.v).toBe(1)
    expect(claim.pid).toBe(process.pid)
    // The old protocol wrote `String(process.pid)` and nothing else, so a
    // release could not tell its own claim from another process's.
    expect(claim.token).toMatch(/^[0-9a-f]{16}$/)
    expect(typeof claim.acquiredAt).toBe('number')

    // Released on success, not left for the next process to age out.
    expect(existsSync(MANIFEST_PATH + '.lock')).toBe(false)
  })
})

// SMI-6746 / SMI-6733 (governance review of the owed-items branch). `saveManifest`
// was changed from its own inline temp write to a delegation to
// `ManifestManager.save()`, and NOTHING observed that it still delegates: with the
// delegation reverted to the pre-fix `MANIFEST_PATH + '.tmp.' + process.pid` body,
// all 49 tests across this file, tests/unit/install-helpers.test.ts and core's
// skill-manifest.test.ts passed. Measured, not argued — that is the same
// invisible-success class the delegation itself was written to remove.
//
// This is NOT a second copy of core's own "a failed save() only removes its own
// temp file" test. That one's subject is `ManifestManager.save()`; this one's is
// whether THIS module's entry point still routes through it. Core's test stays
// green under the revert precisely because the revert does not touch core.
//
// The injected failure is a real one, not a mock: `MANIFEST_PATH` is made a
// non-empty directory, so `writeFile(temp)` succeeds and the final
// `rename(temp, MANIFEST_PATH)` fails (EISDIR on Linux). The temp file therefore
// exists at the moment the write fails, which is the only window in which the
// two implementations differ.
describe('SMI-6746: saveManifest() delegates its temp-file hardening to ManifestManager', () => {
  const manifestDir = path.dirname(MANIFEST_PATH)

  function strayTempFiles(): string[] {
    return readdirSync(manifestDir).filter((f) => f.includes('.tmp.'))
  }

  it('cleans up its own temp file when the write fails, and surfaces the failure', async () => {
    mkdirSync(manifestDir, { recursive: true })
    // The SMI-6735 test above leaves MANIFEST_PATH behind as a FILE, and
    // `mkdirSync(..., { recursive: true })` tolerates an existing directory but
    // not an existing file (EEXIST). Clear it first.
    rmSync(MANIFEST_PATH, { recursive: true, force: true })
    // Occupied so the rename cannot succeed by replacing an empty directory.
    mkdirSync(MANIFEST_PATH, { recursive: true })
    writeFileSync(path.join(MANIFEST_PATH, 'occupant'), 'x')

    try {
      // Fail-closed: the error is surfaced rather than swallowed. This arm does
      // NOT discriminate the two implementations — the pre-fix body rejects here
      // too, because its uncaught rename error propagates. It is asserted anyway
      // because a future "fix" that swallowed the failure would be the fail-open
      // defect this whole branch exists to close.
      await expect(saveManifest({ version: '1.0.0', installedSkills: {} })).rejects.toThrow()

      // THE discriminating assertion. The pre-fix body leaves
      // `manifest.json.tmp.<pid>` behind; the delegation's try/catch unlinks
      // exactly its own temp file before rethrowing.
      expect(strayTempFiles()).toEqual([])

      // The failed write clobbered nothing it did not own.
      expect(readFileSync(path.join(MANIFEST_PATH, 'occupant'), 'utf8')).toBe('x')
    } finally {
      // MANIFEST_PATH must go back to not existing: the assertions earlier in
      // this file require it absent, and a leftover DIRECTORY here would break
      // any later test that expects a file.
      rmSync(MANIFEST_PATH, { recursive: true, force: true })
    }
  })
})

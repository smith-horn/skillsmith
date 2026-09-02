/**
 * @fileoverview Tests for install.helpers.manifest.ts's real-home write guard.
 *
 * SMI-6343 Wave 1 follow-up (adversarial review): `saveManifest()` and
 * `acquireManifestLock()` here are a second, complete manifest write stack
 * parallel to `@skillsmith/core`'s `ManifestManager` — `MANIFEST_PATH` is
 * homedir-derived (install.types.ts) with no path-override parameter, so
 * before this fix nothing but the global `$HOME` test sandbox
 * (vitest.setup.ts) protected this write path. This proves the new
 * `assertNotRealUserHome()` guard itself fires, by pointing
 * `SKILLSMITH_TEST_REAL_HOME` at whatever home `MANIFEST_PATH` currently
 * resolves under (the sandbox, in this test run) so the guard treats it as
 * "the real home" for these assertions — the same technique
 * home-sandbox.integration.test.ts uses.
 */
import { describe, it, expect } from 'vitest'
import * as path from 'path'
import { existsSync } from 'fs'
import { MANIFEST_PATH } from './install.types.js'
import {
  saveManifest,
  acquireManifestLock,
  releaseManifestLock,
} from './install.helpers.manifest.js'

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

  it('acquireManifestLock() refuses to lock when MANIFEST_PATH resolves under the (simulated) real home', async () => {
    await withSimulatedRealHome(async () => {
      await expect(acquireManifestLock()).rejects.toThrow(/SMI-6343/)
    })
    // The guard fired before any lock file was created — clean up is a no-op
    // (releaseManifestLock() ignores a missing lock file), asserted directly
    // so a regression that DOES create the lock is visible.
    expect(existsSync(MANIFEST_PATH + '.lock')).toBe(false)
    await releaseManifestLock()
  })
})

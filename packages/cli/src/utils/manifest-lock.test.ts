/**
 * @fileoverview Tests for the LOCKED write path in manifest.ts (SMI-6358).
 * @module @skillsmith/cli/utils/manifest-lock.test
 *
 * manifest.test.ts mocks fs/promises with an in-memory store that does not
 * honor the `wx` exclusive-create flag `ManifestManager.acquireLock()` relies
 * on for real mutual exclusion — fine for the roundtrip/telemetry-helper
 * tests there, but useless for proving locking actually serializes
 * concurrent writers. These tests use REAL fs/promises instead, following
 * the identical pattern @skillsmith/core's own
 * packages/core/src/services/skill-manifest.test.ts uses for the same
 * reason (see that file's module doc comment).
 *
 * Safety: never touches the developer's real ~/.skillsmith — vitest.setup.ts
 * redirects $HOME to a per-test-FILE sandbox temp directory BEFORE this
 * module graph is evaluated, so manifestPath (homedir-derived) already
 * resolves under the sandbox by the time any test here runs. No per-test
 * temp-HOME plumbing needed; this file just relies on the project-wide
 * sandbox every other vitest file already depends on.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { readFile, writeFile, unlink, mkdir } from 'fs/promises'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'path'
import { ManifestManager } from '@skillsmith/core'
import {
  updateManifestEntry,
  loadManifest,
  type SkillManifest,
  type SkillManifestEntry,
} from './manifest.js'

// An EXPLICIT manifest path, not the homedir-derived default.
//
// `audit:standards` Check 65 requires this of any test naming a
// manifest-writing symbol, and the requirement is not bookkeeping: SMI-6343
// found `test-skill` rows in a real user's ~/.skillsmith/manifest.json,
// because two tests mocked their install-target paths and left the manifest
// path defaulting to `os.homedir()`. vitest.setup.ts's $HOME sandbox is the
// runtime defence against that; naming the path is the review-time one, and
// this file's earlier version relied on the sandbox alone — which is the
// exact reasoning the check exists to reject.
const manifestPath = join(mkdtempSync(join(tmpdir(), 'manifest-lock-')), 'manifest.json')

// ============================================================================
// Helpers
// ============================================================================

function makeEntry(name: string): SkillManifestEntry {
  const now = new Date().toISOString()
  return {
    id: `author/${name}`,
    name,
    version: '1.0.0',
    source: `github:author/${name}`,
    installPath: `/tmp/${name}`,
    installedAt: now,
    lastUpdated: now,
  }
}

async function resetManifest(): Promise<void> {
  await unlink(manifestPath).catch(() => {})
  await unlink(`${manifestPath}.lock`).catch(() => {})
}

// ============================================================================
// Tests
// ============================================================================

describe('updateManifestEntry() locking (SMI-6358)', () => {
  afterEach(async () => {
    await resetManifest()
  })

  // --------------------------------------------------------------------------
  // Concurrency — two overlapping cli writes
  // --------------------------------------------------------------------------

  it('two overlapping updateManifestEntry() calls both survive — no lost update', async () => {
    await Promise.all([
      updateManifestEntry(
        (m: SkillManifest) => ({
          ...m,
          installedSkills: { ...m.installedSkills, 'skill-a': makeEntry('skill-a') },
        }),
        manifestPath
      ),
      updateManifestEntry(
        (m: SkillManifest) => ({
          ...m,
          installedSkills: { ...m.installedSkills, 'skill-b': makeEntry('skill-b') },
        }),
        manifestPath
      ),
    ])

    const loaded = await loadManifest(manifestPath)
    expect(Object.keys(loaded.installedSkills).sort()).toEqual(['skill-a', 'skill-b'])
  })

  // --------------------------------------------------------------------------
  // Concurrency — a cli write racing core's OWN locked writer on the SAME
  // manifest path. This is the exact cross-writer scenario SMI-6358 exists
  // to fix: before this change, updateManifestEntry() took no lock at all,
  // so a pin/unpin/telemetry write racing SkillInstallationService (or any
  // other core caller of ManifestManager.updateSafely()) could lose a side.
  // --------------------------------------------------------------------------

  it('a cli updateManifestEntry() write racing a core ManifestManager.updateSafely() write on the SAME manifest — no lost update', async () => {
    const coreManager = new ManifestManager(manifestPath)

    await Promise.all([
      updateManifestEntry(
        (m: SkillManifest) => ({
          ...m,
          installedSkills: { ...m.installedSkills, 'from-cli': makeEntry('from-cli') },
        }),
        manifestPath
      ),
      coreManager.updateSafely((m) => ({
        ...m,
        installedSkills: { ...m.installedSkills, 'from-core': makeEntry('from-core') },
      })),
    ])

    const loaded = await loadManifest(manifestPath)
    expect(Object.keys(loaded.installedSkills).sort()).toEqual(['from-cli', 'from-core'])
  })

  // --------------------------------------------------------------------------
  // Fail-closed on a corrupt manifest (SMI-5909 gap this fix closes for the
  // WRITE path) — shared by every caller of updateManifestEntry() (pin,
  // unpin, and all six telemetry.action.ts write sites), so one test here
  // covers all of them: they all go through this exact function.
  // --------------------------------------------------------------------------

  it('an unparseable existing manifest fails the write loudly instead of being silently clobbered with an empty manifest', async () => {
    await mkdir(dirname(manifestPath), { recursive: true })
    const corrupt = '{ this is not valid json'
    await writeFile(manifestPath, corrupt)

    await expect(
      updateManifestEntry(
        (m: SkillManifest) => ({
          ...m,
          installedSkills: { ...m.installedSkills, x: makeEntry('x') },
        }),
        manifestPath
      )
    ).rejects.toThrow(/corrupt|unparseable/i)

    // The corrupt file must be left EXACTLY as it was — not replaced with an
    // empty manifest. The OLD updateManifestEntry (built on this file's own
    // loadManifest(), which swallows every read error into `{ version:
    // '1.0.0', installedSkills: {} }`) would have silently written that
    // empty snapshot back out here, erasing every pre-existing entry.
    const raw = await readFile(manifestPath, 'utf-8')
    expect(raw).toBe(corrupt)
  })
})

/**
 * @fileoverview Tests for ManifestManager concurrency hardening (SMI-6007)
 * @module @skillsmith/core/services/skill-manifest.test
 * @see SMI-6007: manifest write-path concurrency hardening — split out of
 *   the flaky-test investigation SMI-6004. Two confirmed hazards:
 *     1. performUninstall() bypassed the lock (fixed in
 *        skill-installation.helpers.ts — see its own test coverage).
 *     2. save() computed a temp filename from `process.pid` alone, so two
 *        concurrent `save()` calls in the same process collided on the
 *        identical `.tmp.<pid>` path.
 *   Plus a load()-hardening item: distinguish "no manifest yet" (ENOENT,
 *   legitimate first run) from "manifest exists but is corrupt/unreadable"
 *   (should throw, not silently return an empty manifest that a later
 *   save() could use to erase real state).
 *
 * These tests use a real temp directory + real fs/promises calls (not an
 * in-memory mock) so the concurrent cases exercise actual OS-level file
 * operations — `acquireLock()`'s `wx`-flag file creation is only
 * meaningfully racy against real fs semantics.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as os from 'os'
import * as path from 'path'

// The Node ESM module namespace object is not configurable, so a plain
// `vi.spyOn(fs, 'readFile')` throws "Cannot redefine property" under this
// runtime. Instead, wrap the specific functions the write/rename-failure
// tests need to override in `vi.fn(actual.fn)` at mock-registration time —
// each defaults to forwarding to the real implementation (so every other
// test that doesn't override them still hits the real filesystem), and
// individual tests can layer a `mockImplementationOnce`/`mockRejectedValueOnce`
// on top without needing `vi.spyOn`.
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  return {
    ...actual,
    readFile: vi.fn(actual.readFile),
    writeFile: vi.fn(actual.writeFile),
    rename: vi.fn(actual.rename),
    unlink: vi.fn(actual.unlink),
  }
})

import * as fs from 'fs/promises'
import { ManifestManager } from './skill-manifest.js'
import type { SkillManifest, SkillManifestEntry } from './skill-installation.types.js'

// ============================================================================
// Helpers
// ============================================================================

function makeEntry(overrides: Partial<SkillManifestEntry> = {}): SkillManifestEntry {
  const now = new Date().toISOString()
  return {
    id: overrides.id ?? 'author/skill',
    name: overrides.name ?? 'skill',
    version: overrides.version ?? '1.0.0',
    source: overrides.source ?? 'github:author/skill',
    installPath: overrides.installPath ?? '/tmp/skill',
    installedAt: overrides.installedAt ?? now,
    lastUpdated: overrides.lastUpdated ?? now,
    ...overrides,
  }
}

// ============================================================================
// Tests
// ============================================================================

describe('ManifestManager concurrency hardening (SMI-6007)', () => {
  let tmpDir: string
  let manifestPath: string
  let manager: ManifestManager

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skillsmith-manifest-test-'))
    manifestPath = path.join(tmpDir, 'manifest.json')
    manager = new ManifestManager(manifestPath)
  })

  afterEach(async () => {
    vi.clearAllMocks()
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  // --------------------------------------------------------------------------
  // Item 1: two direct save() calls overlap; neither throws (temp-file fix)
  // --------------------------------------------------------------------------

  describe('save() same-pid temp-file collision', () => {
    it('two overlapping save() calls both resolve without throwing', async () => {
      const first: SkillManifest = {
        version: '1.0.0',
        installedSkills: { a: makeEntry({ id: 'a' }) },
      }
      const second: SkillManifest = {
        version: '1.0.0',
        installedSkills: { b: makeEntry({ id: 'b' }) },
      }

      await expect(Promise.all([manager.save(first), manager.save(second)])).resolves.toBeDefined()

      // Whichever write landed last, the file must be a full, valid write —
      // never a partial/corrupt mix of the two.
      const loaded = await manager.load()
      expect(Object.keys(loaded.installedSkills)).toHaveLength(1)
    })

    it('does not leave stray .tmp.* files behind after concurrent saves', async () => {
      await Promise.all([
        manager.save({ version: '1.0.0', installedSkills: {} }),
        manager.save({ version: '1.0.0', installedSkills: {} }),
      ])

      const files = await fs.readdir(tmpDir)
      expect(files.some((f) => f.includes('.tmp.'))).toBe(false)
    })
  })

  // --------------------------------------------------------------------------
  // Item 2: two concurrent updateSafely() calls on DISTINCT entries; both
  // survive (validates the lock actually serializes correctly)
  // --------------------------------------------------------------------------

  describe('updateSafely() serializes concurrent updates to distinct entries', () => {
    it('both entries survive when two updateSafely() calls run concurrently', async () => {
      await manager.save({ version: '1.0.0', installedSkills: {} })

      await Promise.all([
        manager.updateSafely((m) => ({
          ...m,
          installedSkills: { ...m.installedSkills, 'skill-a': makeEntry({ id: 'skill-a' }) },
        })),
        manager.updateSafely((m) => ({
          ...m,
          installedSkills: { ...m.installedSkills, 'skill-b': makeEntry({ id: 'skill-b' }) },
        })),
      ])

      const loaded = await manager.load()
      expect(Object.keys(loaded.installedSkills).sort()).toEqual(['skill-a', 'skill-b'])
    })
  })

  // --------------------------------------------------------------------------
  // Item 4: load() distinguishes ENOENT (expected first run) from a
  // corrupt/unreadable manifest (should throw, not silently go empty)
  // --------------------------------------------------------------------------

  describe('load() distinguishes missing vs corrupt manifest', () => {
    it('returns an empty manifest when the file does not exist (ENOENT — expected first run)', async () => {
      const loaded = await manager.load()
      expect(loaded).toEqual({ version: '1.0.0', installedSkills: {} })
    })

    it('throws (does not silently return an empty manifest) when the file contains unparseable JSON', async () => {
      await fs.writeFile(manifestPath, '{ not valid json')
      await expect(manager.load()).rejects.toThrow(/corrupt|unparseable/i)
    })

    it('rethrows a non-ENOENT read error (e.g. EACCES) instead of returning an empty manifest', async () => {
      const permissionError = Object.assign(new Error('EACCES: permission denied'), {
        code: 'EACCES',
      })
      vi.mocked(fs.readFile).mockRejectedValueOnce(permissionError)

      await expect(manager.load()).rejects.toThrow('EACCES')
    })
  })

  // --------------------------------------------------------------------------
  // Item 5: inject a write/rename failure — verify the unique-temp-file
  // cleanup removes only that invocation's own temp file and the original
  // error still propagates (not swallowed)
  // --------------------------------------------------------------------------

  describe('save() write/rename failure cleanup', () => {
    it('on a writeFile failure, the temp file is cleaned up and the original error propagates', async () => {
      const originalError = new Error('ENOSPC: no space left on device')
      vi.mocked(fs.writeFile).mockRejectedValueOnce(originalError)

      await expect(manager.save({ version: '1.0.0', installedSkills: {} })).rejects.toThrow(
        originalError
      )

      const files = await fs.readdir(tmpDir).catch(() => [])
      expect(files.some((f) => f.includes('.tmp.'))).toBe(false)
    })

    it('on a rename failure, the temp file is cleaned up, the original error propagates, and the manifest is untouched', async () => {
      await manager.save({
        version: '1.0.0',
        installedSkills: { existing: makeEntry({ id: 'existing' }) },
      })

      const originalError = new Error('EPERM: operation not permitted')
      vi.mocked(fs.rename).mockRejectedValueOnce(originalError)

      await expect(
        manager.save({ version: '1.0.0', installedSkills: { other: makeEntry({ id: 'other' }) } })
      ).rejects.toThrow(originalError)

      const loaded = await manager.load()
      expect(Object.keys(loaded.installedSkills)).toEqual(['existing'])

      const files = await fs.readdir(tmpDir)
      expect(files.some((f) => f.includes('.tmp.'))).toBe(false)
    })

    it('a failed save() only removes its own temp file, leaving a concurrently in-flight one untouched', async () => {
      // call A's rename fails and must be cleaned up; call B's rename must
      // succeed normally. Because each call's temp filename is now
      // per-invocation-unique (SMI-6007), A's cleanup cannot touch B's file.
      // mockRejectedValueOnce queues exactly one rejection ahead of the
      // default (real) implementation, so whichever of the two concurrent
      // renames happens to run first gets it — order isn't asserted below.
      vi.mocked(fs.rename).mockRejectedValueOnce(new Error('simulated rename failure for call A'))

      const callA = manager.save({
        version: '1.0.0',
        installedSkills: { a: makeEntry({ id: 'a' }) },
      })
      const callB = manager.save({
        version: '1.0.0',
        installedSkills: { b: makeEntry({ id: 'b' }) },
      })

      const results = await Promise.allSettled([callA, callB])

      // Order between the two concurrent calls isn't guaranteed by real fs
      // I/O scheduling — assert the invariant that matters: exactly one
      // call's rename failed (and was cleaned up), the other succeeded, and
      // no cross-contamination between their distinct temp files occurred.
      const rejected = results.filter((r) => r.status === 'rejected')
      const fulfilled = results.filter((r) => r.status === 'fulfilled')
      expect(rejected).toHaveLength(1)
      expect(fulfilled).toHaveLength(1)

      const files = await fs.readdir(tmpDir)
      expect(files.some((f) => f.includes('.tmp.'))).toBe(false)
    })
  })

  // SMI-6343 Wave 1 follow-up (adversarial review): releaseLock() was
  // previously unguarded. save()/acquireLock() already refuse a real-home
  // path (their own guard), so updateSafely() never reaches releaseLock()
  // for a real-home path via that route — this exists for a caller that
  // invokes releaseLock() directly (a cleanup helper, an afterEach) on a
  // real-home-derived path, which would otherwise delete a lock a live
  // skillsmith process is holding.
  describe('releaseLock() real-home write guard', () => {
    it('refuses to unlock when the manifest path resolves under the (simulated) real home', async () => {
      const previous = process.env.SKILLSMITH_TEST_REAL_HOME
      process.env.SKILLSMITH_TEST_REAL_HOME = tmpDir
      try {
        await expect(manager.releaseLock()).rejects.toThrow(/SMI-6343/)
      } finally {
        if (previous === undefined) delete process.env.SKILLSMITH_TEST_REAL_HOME
        else process.env.SKILLSMITH_TEST_REAL_HOME = previous
      }
    })

    it('still unlocks normally when the manifest path is NOT under the real home', async () => {
      await manager.acquireLock()
      await expect(manager.releaseLock()).resolves.toBeUndefined()
      await expect(fs.access(manifestPath + '.lock')).rejects.toThrow()
    })
  })
})

/**
 * @fileoverview Tests for manifest utilities — telemetry block (SMI-5012 W3)
 * @module @skillsmith/cli/utils/manifest.test
 *
 * Tests the TelemetryManifest schema additions and the four helper functions:
 *   generateAnonymousId, shouldRotateAnonymousId, rotateAnonymousId,
 *   sweepExpiredPreviousId
 *
 * Also covers the manifest roundtrip (save → load preserves the telemetry
 * block) and that saveManifest() is core's durable write.
 *
 * Real files in the sandboxed vitest HOME (vitest.setup.ts; asserted at module
 * load, below the imports). SMI-7143: saveManifest() now delegates to core's
 * ManifestManager.save(), whose write opens its temp file rather than calling
 * writeFile, so the in-memory fs/promises fake this file used to install no
 * longer reached it. Core's own tests (skill-manifest.atomic.test.ts,
 * skill-manifest.test.ts) cover that write's failure cleanup.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import { dirname, basename } from 'node:path'
import { ManifestManager } from '@skillsmith/core'

import {
  MANIFEST_PATH,
  loadManifest,
  saveManifest,
  generateAnonymousId,
  shouldRotateAnonymousId,
  rotateAnonymousId,
  sweepExpiredPreviousId,
  type SkillManifest,
  type TelemetryManifest,
} from './manifest.js'

// The $HOME sandbox (vitest.setup.ts) must be in force before any hook runs. A
// failed check inside beforeAll/beforeEach still lets afterEach run, and
// afterEach deletes the manifest; a throw here fails collection instead.
if (
  !MANIFEST_PATH.includes('skillsmith-vitest-home-') ||
  !MANIFEST_PATH.startsWith(process.env['HOME'] ?? '/nonexistent')
) {
  throw new Error(`Refusing to run: ${MANIFEST_PATH} is not inside the vitest HOME sandbox`)
}

// ============================================================================
// Helpers
// ============================================================================

/** Leftover temp files beside the manifest. */
function tempFiles(): string[] {
  const dir = dirname(MANIFEST_PATH)
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).filter((n) => n.startsWith(`${basename(MANIFEST_PATH)}.tmp.`))
}

function clearManifest(): void {
  fs.rmSync(MANIFEST_PATH, { force: true })
  for (const t of tempFiles()) fs.rmSync(`${dirname(MANIFEST_PATH)}/${t}`, { force: true })
}

function makeManifest(telemetry?: TelemetryManifest): SkillManifest {
  return {
    version: '1.0.0',
    installedSkills: {},
    ...(telemetry !== undefined ? { telemetry } : {}),
  }
}

/** Build an ISO string N days in the past */
function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString()
}

/** Build an ISO string N days in the future */
function daysFromNow(n: number): string {
  return new Date(Date.now() + n * 86_400_000).toISOString()
}

// ============================================================================
// Tests
// ============================================================================

describe('telemetry block', () => {
  beforeEach(() => {
    clearManifest()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    clearManifest()
  })

  // --------------------------------------------------------------------------
  // Default: fresh config has no telemetry block
  // --------------------------------------------------------------------------

  describe('default — fresh config', () => {
    it('loadManifest returns a manifest with no telemetry key when file is absent', async () => {
      // No manifest file → readFile throws ENOENT → loadManifest returns default
      const m = await loadManifest()
      expect(m.telemetry).toBeUndefined()
    })

    it('a manifest without telemetry block is treated as enabled: false by helpers', () => {
      const m = makeManifest()
      expect(shouldRotateAnonymousId(m)).toBe(false)
      const swept = sweepExpiredPreviousId(m)
      expect(swept.enabled).toBe(false)
    })
  })

  // --------------------------------------------------------------------------
  // Roundtrip: write then read preserves telemetry block
  // --------------------------------------------------------------------------

  describe('roundtrip', () => {
    it('saves and reloads a full telemetry block with deep equality', async () => {
      const telemetry: TelemetryManifest = {
        enabled: true,
        anonymousId: 'a'.repeat(64),
        anonymousIdCreatedAt: '2026-01-01T00:00:00.000Z',
        scope: 'personal',
      }
      const m = makeManifest(telemetry)
      await saveManifest(m)

      const loaded = await loadManifest()
      expect(loaded.telemetry).toEqual(telemetry)
    })

    it('older configs without a telemetry key continue to load without error', async () => {
      // Write a manifest that has no telemetry key (legacy shape)
      const legacy = { version: '1.0.0', installedSkills: {} }
      fs.mkdirSync(dirname(MANIFEST_PATH), { recursive: true })
      fs.writeFileSync(MANIFEST_PATH, JSON.stringify(legacy, null, 2))

      const m = await loadManifest()
      expect(m.telemetry).toBeUndefined()
      expect(m.version).toBe('1.0.0')
    })
  })

  // --------------------------------------------------------------------------
  // generateAnonymousId
  // --------------------------------------------------------------------------

  describe('generateAnonymousId', () => {
    it('returns a 64-character lowercase hex string (SHA-256 length)', () => {
      const id = generateAnonymousId()
      expect(id).toMatch(/^[0-9a-f]{64}$/)
    })

    it('returns distinct values on successive calls', () => {
      const ids = new Set(Array.from({ length: 5 }, () => generateAnonymousId()))
      expect(ids.size).toBe(5)
    })

    it('never returns the raw UUID (only the hash is exposed)', () => {
      // A UUID has 36 chars including hyphens; our output must be 64 hex chars
      const id = generateAnonymousId()
      expect(id).not.toContain('-')
      expect(id.length).toBe(64)
    })
  })

  // --------------------------------------------------------------------------
  // shouldRotateAnonymousId
  // --------------------------------------------------------------------------

  describe('shouldRotateAnonymousId', () => {
    it('returns true when anonymousIdCreatedAt is 366 days ago', () => {
      const m = makeManifest({ enabled: true, anonymousIdCreatedAt: daysAgo(366) })
      expect(shouldRotateAnonymousId(m)).toBe(true)
    })

    it('returns false when anonymousIdCreatedAt is 364 days ago', () => {
      const m = makeManifest({ enabled: true, anonymousIdCreatedAt: daysAgo(364) })
      expect(shouldRotateAnonymousId(m)).toBe(false)
    })

    it('returns false when anonymousIdCreatedAt is exactly today', () => {
      const m = makeManifest({ enabled: true, anonymousIdCreatedAt: new Date().toISOString() })
      expect(shouldRotateAnonymousId(m)).toBe(false)
    })

    it('returns false when anonymousIdCreatedAt is undefined (id never generated)', () => {
      const m = makeManifest({ enabled: false })
      expect(shouldRotateAnonymousId(m)).toBe(false)
    })

    it('returns false when telemetry block is absent', () => {
      const m = makeManifest()
      expect(shouldRotateAnonymousId(m)).toBe(false)
    })
  })

  // --------------------------------------------------------------------------
  // rotateAnonymousId
  // --------------------------------------------------------------------------

  describe('rotateAnonymousId', () => {
    it('generates a new id distinct from the previous one', () => {
      const oldId = generateAnonymousId()
      const m = makeManifest({
        enabled: true,
        anonymousId: oldId,
        anonymousIdCreatedAt: daysAgo(400),
      })
      const rotated = rotateAnonymousId(m)
      expect(rotated.anonymousId).toBeDefined()
      expect(rotated.anonymousId).not.toBe(oldId)
      expect(rotated.anonymousId).toMatch(/^[0-9a-f]{64}$/)
    })

    it('moves current id to previousAnonymousId', () => {
      const oldId = generateAnonymousId()
      const m = makeManifest({
        enabled: true,
        anonymousId: oldId,
        anonymousIdCreatedAt: daysAgo(400),
      })
      const rotated = rotateAnonymousId(m)
      expect(rotated.previousAnonymousId).toBe(oldId)
    })

    it('sets anonymousIdCreatedAt to approximately now', () => {
      const before = Date.now()
      const m = makeManifest({
        enabled: true,
        anonymousId: 'a'.repeat(64),
        anonymousIdCreatedAt: daysAgo(400),
      })
      const rotated = rotateAnonymousId(m)
      const createdMs = new Date(rotated.anonymousIdCreatedAt!).getTime()
      expect(createdMs).toBeGreaterThanOrEqual(before)
      expect(createdMs).toBeLessThanOrEqual(Date.now())
    })

    it('sets previousAnonymousIdRetiredAt to approximately 7 days from now', () => {
      const before = Date.now()
      const m = makeManifest({
        enabled: true,
        anonymousId: 'a'.repeat(64),
        anonymousIdCreatedAt: daysAgo(400),
      })
      const rotated = rotateAnonymousId(m)
      const retiredMs = new Date(rotated.previousAnonymousIdRetiredAt!).getTime()
      const sevenDaysMs = 7 * 86_400_000
      // Allow 1-second tolerance for test execution time
      expect(retiredMs).toBeGreaterThanOrEqual(before + sevenDaysMs - 1000)
      expect(retiredMs).toBeLessThanOrEqual(Date.now() + sevenDaysMs + 1000)
    })

    it('preserves existing telemetry fields (enabled, scope) across rotation', () => {
      const m = makeManifest({
        enabled: true,
        anonymousId: 'b'.repeat(64),
        anonymousIdCreatedAt: daysAgo(400),
        scope: 'team',
        teamId: 'team-123',
      })
      const rotated = rotateAnonymousId(m)
      expect(rotated.enabled).toBe(true)
      expect(rotated.scope).toBe('team')
      expect(rotated.teamId).toBe('team-123')
    })

    it('handles telemetry block being absent (acts like enabled: false with no prior id)', () => {
      const m = makeManifest() // no telemetry block
      const rotated = rotateAnonymousId(m)
      expect(rotated.anonymousId).toMatch(/^[0-9a-f]{64}$/)
      // previousAnonymousId should be undefined since there was no prior id
      expect(rotated.previousAnonymousId).toBeUndefined()
    })
  })

  // --------------------------------------------------------------------------
  // sweepExpiredPreviousId
  // --------------------------------------------------------------------------

  describe('sweepExpiredPreviousId', () => {
    it('clears previousAnonymousId and previousAnonymousIdRetiredAt when retiredAt is past', () => {
      const m = makeManifest({
        enabled: true,
        anonymousId: 'a'.repeat(64),
        anonymousIdCreatedAt: daysAgo(10),
        previousAnonymousId: 'b'.repeat(64),
        previousAnonymousIdRetiredAt: daysAgo(1), // already past
      })
      const swept = sweepExpiredPreviousId(m)
      expect(swept.previousAnonymousId).toBeUndefined()
      expect(swept.previousAnonymousIdRetiredAt).toBeUndefined()
    })

    it('preserves previousAnonymousId when the overlap window has not elapsed', () => {
      const prevId = 'c'.repeat(64)
      const m = makeManifest({
        enabled: true,
        anonymousId: 'a'.repeat(64),
        anonymousIdCreatedAt: daysAgo(2),
        previousAnonymousId: prevId,
        previousAnonymousIdRetiredAt: daysFromNow(5), // still in window
      })
      const swept = sweepExpiredPreviousId(m)
      expect(swept.previousAnonymousId).toBe(prevId)
      expect(swept.previousAnonymousIdRetiredAt).toBeDefined()
    })

    it('is a no-op when there is no previousAnonymousId', () => {
      const m = makeManifest({ enabled: true, anonymousId: 'a'.repeat(64) })
      const swept = sweepExpiredPreviousId(m)
      expect(swept).toEqual({ enabled: true, anonymousId: 'a'.repeat(64) })
    })

    it('is a no-op when the telemetry block is absent', () => {
      const m = makeManifest()
      const swept = sweepExpiredPreviousId(m)
      expect(swept.enabled).toBe(false)
      expect(swept.previousAnonymousId).toBeUndefined()
    })

    it('preserves all other telemetry fields when sweeping', () => {
      const m = makeManifest({
        enabled: true,
        anonymousId: 'a'.repeat(64),
        anonymousIdCreatedAt: daysAgo(10),
        scope: 'personal',
        endpoint: 'https://staging.example.com',
        previousAnonymousId: 'b'.repeat(64),
        previousAnonymousIdRetiredAt: daysAgo(1),
      })
      const swept = sweepExpiredPreviousId(m)
      expect(swept.scope).toBe('personal')
      expect(swept.endpoint).toBe('https://staging.example.com')
      expect(swept.anonymousId).toBe('a'.repeat(64))
    })
  })

  // --------------------------------------------------------------------------
  // saveManifest() is core's durable write (SMI-7143)
  // --------------------------------------------------------------------------

  describe("saveManifest — core's write", () => {
    it('second save fully replaces first; reader never sees partial state', async () => {
      const first = makeManifest({ enabled: false })
      const second = makeManifest({
        enabled: true,
        anonymousId: 'd'.repeat(64),
        anonymousIdCreatedAt: new Date().toISOString(),
        scope: 'personal',
      })

      await saveManifest(first)
      await saveManifest(second)

      const loaded = await loadManifest()
      expect(loaded.telemetry?.enabled).toBe(true)
      expect(loaded.telemetry?.anonymousId).toBe('d'.repeat(64))
      expect(loaded.telemetry?.scope).toBe('personal')
    })

    it('delegates to ManifestManager.save on MANIFEST_PATH, once, with the manifest', async () => {
      const save = vi.spyOn(ManifestManager.prototype, 'save')
      const m = makeManifest({ enabled: false })

      await saveManifest(m)

      expect(save).toHaveBeenCalledTimes(1)
      expect(save.mock.calls[0]?.[0]).toEqual(m)
      // Saved at MANIFEST_PATH: a ManifestManager built on any other path fails here.
      expect(JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'))).toEqual(m)
    })

    it('leaves no temp file behind, even for two overlapping saves', async () => {
      const a = makeManifest({ enabled: false })
      const b = makeManifest({ enabled: true, anonymousId: 'e'.repeat(64) })

      await Promise.all([saveManifest(a), saveManifest(b)])

      expect(tempFiles()).toEqual([])
      expect([a, b]).toContainEqual(JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8')))
    })

    it("rethrows the error core's save raised, unchanged", async () => {
      // Core's own tests cover what a failed write leaves on disk; this pins
      // only that saveManifest neither swallows nor wraps the failure.
      const originalError = new Error('ENOSPC: no space left on device')
      vi.spyOn(ManifestManager.prototype, 'save').mockRejectedValueOnce(originalError)

      await expect(saveManifest(makeManifest({ enabled: true }))).rejects.toBe(originalError)
    })
  })

  // SMI-6343 Wave 1 follow-up (adversarial review): saveManifest() is
  // homedir-derived with no manifestPath override parameter — the sandbox
  // (vitest.setup.ts) was this write path's only protection until
  // assertNotRealUserHome() was wired in. This proves the guard fires (since
  // SMI-7143 both saveManifest's own call and ManifestManager.save's make the
  // same check, so it cannot tell which one did) — by pointing
  // SKILLSMITH_TEST_REAL_HOME at whatever home MANIFEST_PATH is currently
  // under (the sandbox, in this test run) so the guard treats it as "the
  // real home" for this one assertion, same technique
  // home-sandbox.integration.test.ts uses.
  describe('SMI-6343: real-home write guard', () => {
    it('refuses to write when MANIFEST_PATH resolves under the (simulated) real home', async () => {
      // MANIFEST_PATH = join(homedir(), '.skillsmith', 'manifest.json')
      const simulatedRealHome = dirname(dirname(MANIFEST_PATH))

      const previous = process.env['SKILLSMITH_TEST_REAL_HOME']
      process.env['SKILLSMITH_TEST_REAL_HOME'] = simulatedRealHome
      try {
        await expect(saveManifest(makeManifest({ enabled: false }))).rejects.toThrow(/SMI-6343/)
      } finally {
        if (previous === undefined) delete process.env['SKILLSMITH_TEST_REAL_HOME']
        else process.env['SKILLSMITH_TEST_REAL_HOME'] = previous
      }

      // The guard fired before any write — nothing was saved.
      expect(fs.existsSync(MANIFEST_PATH)).toBe(false)
      expect(tempFiles()).toEqual([])
    })
  })
})

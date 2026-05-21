/**
 * @fileoverview Tests for manifest utilities — telemetry block (SMI-5012 W3)
 * @module @skillsmith/cli/utils/manifest.test
 *
 * Tests the TelemetryManifest schema additions and the four helper functions:
 *   generateAnonymousId, shouldRotateAnonymousId, rotateAnonymousId,
 *   sweepExpiredPreviousId
 *
 * Also covers manifest roundtrip (save → load preserves telemetry block) and
 * the atomic temp-file-rename code path for the sequential-correctness
 * concurrent-writer test.
 *
 * Concurrency note: vitest does not support true OS-level concurrency in a
 * single process. The "concurrent writer" test exercises the temp-file rename
 * code path sequentially — two writes to the same file where the second must
 * fully overwrite the first without leaving partial state. True lock contention
 * is a v2 concern tracked in the shared-state matrix (plan line 715).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdir, writeFile, rename } from 'fs/promises'

// ============================================================================
// In-memory fs mock for isolation — covers save/load roundtrip tests
// ============================================================================

// We mock 'fs/promises' so tests never touch ~/.skillsmith on the developer's machine.
// The mock implements the subset used by manifest.ts: mkdir, writeFile, rename, readFile.
//
// memfs is declared as a module-scope object (not Map) so the vi.mock factory
// closure can reference it even after vi.mock hoisting reorders the declaration.
// Tests clear memfs keys in beforeEach/afterEach for isolation.
const memfs: Record<string, string> = {}

vi.mock('fs/promises', () => ({
  mkdir: vi.fn(async () => undefined),
  writeFile: vi.fn(async (path: string, content: string) => {
    memfs[path] = content
  }),
  rename: vi.fn(async (src: string, dst: string) => {
    const content = memfs[src]
    if (content === undefined) throw new Error(`ENOENT: ${src}`)
    memfs[dst] = content
    delete memfs[src]
  }),
  readFile: vi.fn(async (path: string) => {
    const content = memfs[path]
    if (content === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
    return content
  }),
}))

// Import AFTER mocks are registered
import {
  loadManifest,
  saveManifest,
  generateAnonymousId,
  shouldRotateAnonymousId,
  rotateAnonymousId,
  sweepExpiredPreviousId,
  type SkillManifest,
  type TelemetryManifest,
} from './manifest.js'

// ============================================================================
// Helpers
// ============================================================================

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
    for (const k of Object.keys(memfs)) delete memfs[k]
    vi.clearAllMocks()
  })

  afterEach(() => {
    for (const k of Object.keys(memfs)) delete memfs[k]
  })

  // --------------------------------------------------------------------------
  // Default: fresh config has no telemetry block
  // --------------------------------------------------------------------------

  describe('default — fresh config', () => {
    it('loadManifest returns a manifest with no telemetry key when file is absent', async () => {
      // memfs is empty → readFile throws ENOENT → loadManifest returns default
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
      const { MANIFEST_PATH } = await import('./manifest.js')
      memfs[MANIFEST_PATH] = JSON.stringify(legacy, null, 2)

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
  // Concurrent-writer (sequential atomic correctness)
  //
  // Exercises the temp-file-rename code path: two sequential saves to the
  // same MANIFEST_PATH must result in the second write fully replacing the
  // first without partial state visible to readers.
  //
  // True OS-level concurrent write contention is a v2 concern (plan line 715).
  // --------------------------------------------------------------------------

  describe('atomic write — sequential correctness', () => {
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
      // Reader must see the second write in its entirety
      expect(loaded.telemetry?.enabled).toBe(true)
      expect(loaded.telemetry?.anonymousId).toBe('d'.repeat(64))
      expect(loaded.telemetry?.scope).toBe('personal')
    })

    it('temp file is removed after rename (no stale .tmp artifacts)', async () => {
      const { MANIFEST_PATH } = await import('./manifest.js')
      const tmpPath = `${MANIFEST_PATH}.tmp.${process.pid}`

      await saveManifest(makeManifest({ enabled: false }))

      // The tmp file should have been renamed away — not present in memfs
      expect(memfs[tmpPath]).toBeUndefined()
      // The final path should be present
      expect(memfs[MANIFEST_PATH]).toBeDefined()
    })

    it('the write path exercises mkdir → writeFile(tmp) → rename(tmp → final)', async () => {
      const { MANIFEST_PATH } = await import('./manifest.js')
      await saveManifest(makeManifest({ enabled: false }))

      // Verify the mock call sequence: mkdir was called, then writeFile with tmp path,
      // then rename from tmp to final
      expect(mkdir).toHaveBeenCalled()
      expect(writeFile).toHaveBeenCalledWith(expect.stringContaining('.tmp.'), expect.any(String))
      expect(rename).toHaveBeenCalledWith(expect.stringContaining('.tmp.'), MANIFEST_PATH)
    })
  })
})

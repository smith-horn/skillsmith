/**
 * SMI-5391: Device identity module tests.
 *
 * Uses the same HOME-mutation harness as config/index.test.ts:
 * - `makeTempConfigDir()` creates a unique tmpdir per test suite run
 * - `process.env.HOME = tmpDir` before each test; restored in `afterEach`
 * - Env vars (`SKILLSMITH_INVENTORY_DISABLE`) are also saved/restored in `afterEach`
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as path from 'path'
import * as os from 'os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  getDeviceId,
  getOrCreateDeviceId,
  getOrCreateInstallId,
  setDeviceLabel,
  forgetDevice,
  isInventorySyncDisabledLocally,
  getLastInventoryPushAt,
  recordInventoryPush,
  shouldAutoPush,
} from './device-identity.js'
import { loadConfig } from './index.js'

const execFileAsync = promisify(execFile)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SHA256_HEX_RE = /^[0-9a-f]{64}$/i

function makeTempConfigDir(): string {
  return path.join(
    os.tmpdir(),
    `skillsmith-device-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  )
}

/**
 * Absolute path to this module's source, so a spawned subprocess can import
 * the SAME implementation under test (not a copy/reimplementation) via `tsx`
 * (already a repo devDependency — see CLAUDE.md's `npx tsx` usage).
 */
const DEVICE_IDENTITY_SRC = fileURLToPath(new URL('./device-identity.ts', import.meta.url))

/**
 * Run `exportName()` (a zero-arg, string-returning export of
 * device-identity.ts) in a real, separate OS process with `HOME` pointed at
 * `homeDir`. Used to exercise genuine CROSS-PROCESS races that a single
 * Node process's single-threaded event loop cannot produce on its own —
 * `getOrCreateDeviceId`/`getOrCreateInstallId` are fully synchronous, so two
 * "concurrent" calls within one process never actually interleave.
 */
async function runInSubprocess(exportName: string, homeDir: string): Promise<string> {
  const scriptDir = mkdtempSync(path.join(os.tmpdir(), 'skillsmith-concurrency-'))
  const scriptPath = path.join(scriptDir, 'run.mts')
  writeFileSync(
    scriptPath,
    `import { ${exportName} } from ${JSON.stringify(DEVICE_IDENTITY_SRC)}\n` +
      `process.stdout.write(${exportName}())\n`
  )
  const { stdout } = await execFileAsync('npx', ['tsx', scriptPath], {
    env: { ...process.env, HOME: homeDir },
    timeout: 15_000,
  })
  return stdout.trim()
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let savedHome: string | undefined
let savedInventoryDisable: string | undefined
// SMI-5531: saved/restored so getOrCreateInstallId tests can assert
// unconditional generation under the EXACT conditions of a real end user's
// environment (both unset) without leaking into other tests/files.
let savedTelemetryEnabled: string | undefined
let savedPostHogApiKey: string | undefined

beforeEach(() => {
  savedHome = process.env.HOME
  savedInventoryDisable = process.env.SKILLSMITH_INVENTORY_DISABLE
  savedTelemetryEnabled = process.env.SKILLSMITH_TELEMETRY_ENABLED
  savedPostHogApiKey = process.env.POSTHOG_API_KEY
  // Point HOME at a fresh tmpdir so each test begins with a blank config
  process.env.HOME = makeTempConfigDir()
  delete process.env.SKILLSMITH_INVENTORY_DISABLE
})

afterEach(() => {
  if (savedHome !== undefined) {
    process.env.HOME = savedHome
  } else {
    delete process.env.HOME
  }
  if (savedInventoryDisable !== undefined) {
    process.env.SKILLSMITH_INVENTORY_DISABLE = savedInventoryDisable
  } else {
    delete process.env.SKILLSMITH_INVENTORY_DISABLE
  }
  if (savedTelemetryEnabled !== undefined) {
    process.env.SKILLSMITH_TELEMETRY_ENABLED = savedTelemetryEnabled
  } else {
    delete process.env.SKILLSMITH_TELEMETRY_ENABLED
  }
  if (savedPostHogApiKey !== undefined) {
    process.env.POSTHOG_API_KEY = savedPostHogApiKey
  } else {
    delete process.env.POSTHOG_API_KEY
  }
})

// ---------------------------------------------------------------------------
// getOrCreateDeviceId
// ---------------------------------------------------------------------------

describe('getOrCreateDeviceId', () => {
  it('returns a valid v4 UUID on first call', () => {
    const id = getOrCreateDeviceId()
    expect(UUID_RE.test(id)).toBe(true)
  })

  it('is idempotent — second call returns the same id', () => {
    const first = getOrCreateDeviceId()
    const second = getOrCreateDeviceId()
    expect(second).toBe(first)
  })

  it('persists the id so getDeviceId reads it back', () => {
    const id = getOrCreateDeviceId()
    expect(getDeviceId()).toBe(id)
  })
})

// ---------------------------------------------------------------------------
// getOrCreateInstallId (SMI-5531)
//
// THE MOST IMPORTANT TEST SUITE IN THIS FILE: SMI-5531's root cause was that
// `context.distinctId` was only ever populated when BOTH
// SKILLSMITH_TELEMETRY_ENABLED=true AND a POSTHOG_API_KEY were present —
// conditions never true for a real end-user install. `getOrCreateInstallId`
// exists specifically to be immune to that. If these tests pass while a
// future refactor re-couples generation to that legacy gate, the fix is
// silently inert again under a new field name — the source-text guard test
// below is a second, independent line of defense against exactly that.
// ---------------------------------------------------------------------------

describe('getOrCreateInstallId — unconditional generation (the critical regression test)', () => {
  it('generates and persists an id with SKILLSMITH_TELEMETRY_ENABLED unset and no POSTHOG_API_KEY present', () => {
    delete process.env.SKILLSMITH_TELEMETRY_ENABLED
    delete process.env.POSTHOG_API_KEY
    // Sanity-check the test itself actually reflects a real end user's
    // environment before asserting anything about the function under test.
    expect(process.env.SKILLSMITH_TELEMETRY_ENABLED).toBeUndefined()
    expect(process.env.POSTHOG_API_KEY).toBeUndefined()

    const id = getOrCreateInstallId()

    expect(SHA256_HEX_RE.test(id)).toBe(true)
    // Persisted, not just returned in memory — a fresh read must see it too.
    expect(loadConfig().telemetry?.installId).toBe(id)
  })

  it('still generates unconditionally when SKILLSMITH_TELEMETRY_ENABLED is explicitly "false"', () => {
    process.env.SKILLSMITH_TELEMETRY_ENABLED = 'false'
    delete process.env.POSTHOG_API_KEY

    const id = getOrCreateInstallId()

    expect(SHA256_HEX_RE.test(id)).toBe(true)
  })

  it('is idempotent — second call returns the same id (no regeneration) with no env vars set', () => {
    delete process.env.SKILLSMITH_TELEMETRY_ENABLED
    delete process.env.POSTHOG_API_KEY

    const first = getOrCreateInstallId()
    const second = getOrCreateInstallId()

    expect(second).toBe(first)
  })

  it('generates a DIFFERENT id than getOrCreateDeviceId — distinct namespaces, not aliases', () => {
    delete process.env.SKILLSMITH_TELEMETRY_ENABLED
    delete process.env.POSTHOG_API_KEY

    const installId = getOrCreateInstallId()
    const deviceId = getOrCreateDeviceId()

    expect(installId).not.toBe(deviceId)
  })

  it('does not clobber an existing deviceId when creating an installId, and vice versa', () => {
    delete process.env.SKILLSMITH_TELEMETRY_ENABLED
    delete process.env.POSTHOG_API_KEY

    const deviceId = getOrCreateDeviceId()
    const installId = getOrCreateInstallId()

    expect(getDeviceId()).toBe(deviceId)
    expect(loadConfig().telemetry?.installId).toBe(installId)
  })

  it('the implementation never READS SKILLSMITH_TELEMETRY_ENABLED or POSTHOG_API_KEY (must stay decoupled from the legacy env-gated distinctId path)', () => {
    // Checks for the actual `process.env.X` access pattern, not any textual
    // mention — this module's own doc comments legitimately name these env
    // vars in prose to explain why they're deliberately never read here.
    const source = readFileSync(DEVICE_IDENTITY_SRC, 'utf-8')
    expect(source).not.toMatch(/process\.env(\.|\[['"])SKILLSMITH_TELEMETRY_ENABLED/)
    expect(source).not.toMatch(/process\.env(\.|\[['"])POSTHOG_API_KEY/)
  })
})

// ---------------------------------------------------------------------------
// getOrCreateInstallId — cross-process concurrency (SMI-5531)
//
// getOrCreateDeviceId/getOrCreateInstallId are fully synchronous, so two
// "concurrent" calls WITHIN one Node process never truly interleave — real
// concurrency requires a real second OS process. These tests spawn genuine
// subprocesses (via tsx) pointed at the SAME HOME, so the underlying
// cross-process lock (config-atomic-write.ts) is actually exercised.
// ---------------------------------------------------------------------------

describe('getOrCreateInstallId — cross-process concurrency', () => {
  it('two simultaneous calls from separate processes converge on the same id, with a valid (non-corrupted) config.json', async () => {
    const sharedHome = makeTempConfigDir()
    // No config.json exists yet — both processes race the "create" path.

    const [idA, idB] = await Promise.all([
      runInSubprocess('getOrCreateInstallId', sharedHome),
      runInSubprocess('getOrCreateInstallId', sharedHome),
    ])

    expect(idA).toBe(idB)
    expect(SHA256_HEX_RE.test(idA)).toBe(true)

    const skillsmithDir = path.join(sharedHome, '.skillsmith')
    const configPath = path.join(skillsmithDir, 'config.json')
    const raw = readFileSync(configPath, 'utf-8')
    const parsed = JSON.parse(raw) as { telemetry?: { installId?: string } } // throws if corrupted
    expect(parsed.telemetry?.installId).toBe(idA)

    // No stray lock/temp files left behind after both processes finished.
    const entries = readdirSync(skillsmithDir)
    expect(entries.some((f) => f.endsWith('.lock'))).toBe(false)
    expect(entries.some((f) => f.endsWith('.tmp'))).toBe(false)
  }, 20_000)

  it('a concurrent saveConfig write for a sibling key is never dropped (no lost update)', async () => {
    const sharedHome = makeTempConfigDir()

    const [installId] = await Promise.all([
      runInSubprocess('getOrCreateInstallId', sharedHome),
      runInSubprocess('getOrCreateDeviceId', sharedHome),
    ])

    const configPath = path.join(sharedHome, '.skillsmith', 'config.json')
    const parsed = JSON.parse(readFileSync(configPath, 'utf-8')) as {
      telemetry?: { installId?: string }
      inventory?: { deviceId?: string }
    }

    // BOTH concurrently-written keys must be present — neither write may
    // have silently clobbered the other's.
    expect(parsed.telemetry?.installId).toBe(installId)
    expect(SHA256_HEX_RE.test(parsed.telemetry?.installId ?? '')).toBe(true)
    expect(UUID_RE.test(parsed.inventory?.deviceId ?? '')).toBe(true)
  }, 20_000)
})

// ---------------------------------------------------------------------------
// getDeviceId (pure read)
// ---------------------------------------------------------------------------

describe('getDeviceId', () => {
  it('returns undefined before any id has been created', () => {
    expect(getDeviceId()).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// forgetDevice
// ---------------------------------------------------------------------------

describe('forgetDevice', () => {
  it('clears deviceId so getDeviceId returns undefined', () => {
    getOrCreateDeviceId()
    forgetDevice()
    expect(getDeviceId()).toBeUndefined()
  })

  it('causes getOrCreateDeviceId to generate a DIFFERENT id after forget', () => {
    const before = getOrCreateDeviceId()
    forgetDevice()
    const after = getOrCreateDeviceId()
    expect(after).not.toBe(before)
    expect(UUID_RE.test(after)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// setDeviceLabel
// ---------------------------------------------------------------------------

describe('setDeviceLabel', () => {
  it('persists a label without clobbering deviceId', () => {
    const id = getOrCreateDeviceId()
    setDeviceLabel('my-laptop')
    expect(getDeviceId()).toBe(id)
  })

  it('clears the label when called with undefined while preserving deviceId', () => {
    const id = getOrCreateDeviceId()
    setDeviceLabel('my-laptop')
    setDeviceLabel(undefined)
    // deviceId must still be present
    expect(getDeviceId()).toBe(id)
  })

  it('preserves lastPushAt when setting a label', () => {
    const ts = new Date().toISOString()
    recordInventoryPush(ts)
    setDeviceLabel('desk-machine')
    expect(getLastInventoryPushAt()).toBe(ts)
  })
})

// ---------------------------------------------------------------------------
// isInventorySyncDisabledLocally
// ---------------------------------------------------------------------------

describe('isInventorySyncDisabledLocally', () => {
  it('returns false when env var is unset', () => {
    delete process.env.SKILLSMITH_INVENTORY_DISABLE
    expect(isInventorySyncDisabledLocally()).toBe(false)
  })

  it('returns true when env var is "1"', () => {
    process.env.SKILLSMITH_INVENTORY_DISABLE = '1'
    expect(isInventorySyncDisabledLocally()).toBe(true)
  })

  it('returns true when env var is "true"', () => {
    process.env.SKILLSMITH_INVENTORY_DISABLE = 'true'
    expect(isInventorySyncDisabledLocally()).toBe(true)
  })

  it('returns true when env var is "TRUE" (case-insensitive)', () => {
    process.env.SKILLSMITH_INVENTORY_DISABLE = 'TRUE'
    expect(isInventorySyncDisabledLocally()).toBe(true)
  })

  it('returns false when env var is "false"', () => {
    process.env.SKILLSMITH_INVENTORY_DISABLE = 'false'
    expect(isInventorySyncDisabledLocally()).toBe(false)
  })

  it('returns false when env var is "0"', () => {
    process.env.SKILLSMITH_INVENTORY_DISABLE = '0'
    expect(isInventorySyncDisabledLocally()).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// shouldAutoPush
// ---------------------------------------------------------------------------

describe('shouldAutoPush', () => {
  const ONE_HOUR_MS = 60 * 60 * 1000
  const DEFAULT_THROTTLE_MS = 24 * ONE_HOUR_MS

  it('returns true when lastPushAt is undefined (never pushed)', () => {
    expect(shouldAutoPush(Date.now(), undefined)).toBe(true)
  })

  it('returns false when last push was 1 hour ago (within 24 h throttle)', () => {
    const now = Date.now()
    const oneHourAgo = new Date(now - ONE_HOUR_MS).toISOString()
    expect(shouldAutoPush(now, oneHourAgo)).toBe(false)
  })

  it('returns true when last push was 25 hours ago (beyond 24 h throttle)', () => {
    const now = Date.now()
    const twentyFiveHoursAgo = new Date(now - 25 * ONE_HOUR_MS).toISOString()
    expect(shouldAutoPush(now, twentyFiveHoursAgo)).toBe(true)
  })

  it('returns true at exactly the throttle boundary (>= semantics)', () => {
    // Use integer epoch values to avoid ISO round-trip sub-ms rounding
    const fixedNow = 1_000_000_000_000
    const customThrottle = 86_400_000 // 24 h in ms
    const exactBoundary = new Date(fixedNow - customThrottle).toISOString()
    expect(shouldAutoPush(fixedNow, exactBoundary, customThrottle)).toBe(true)
  })

  it('returns true when lastPushAt is an invalid date string', () => {
    expect(shouldAutoPush(Date.now(), 'not-a-date')).toBe(true)
  })

  it('respects a custom throttleMs (smaller window)', () => {
    const now = Date.now()
    const fiveMinutesAgo = new Date(now - 5 * 60 * 1000).toISOString()
    // 2-minute throttle: 5 min ago is past threshold → should push
    expect(shouldAutoPush(now, fiveMinutesAgo, 2 * 60 * 1000)).toBe(true)
    // 10-minute throttle: 5 min ago is within threshold → skip
    expect(shouldAutoPush(now, fiveMinutesAgo, 10 * 60 * 1000)).toBe(false)
  })

  it('default throttleMs is 24 hours', () => {
    const now = Date.now()
    // 23h59m ago — just inside the window
    const justInside = new Date(now - (DEFAULT_THROTTLE_MS - 60_000)).toISOString()
    expect(shouldAutoPush(now, justInside)).toBe(false)
    // 24h01m ago — just outside the window
    const justOutside = new Date(now - (DEFAULT_THROTTLE_MS + 60_000)).toISOString()
    expect(shouldAutoPush(now, justOutside)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// recordInventoryPush + getLastInventoryPushAt
// ---------------------------------------------------------------------------

describe('recordInventoryPush + getLastInventoryPushAt', () => {
  it('returns undefined before any push is recorded', () => {
    expect(getLastInventoryPushAt()).toBeUndefined()
  })

  it('round-trips an ISO timestamp', () => {
    const ts = new Date().toISOString()
    recordInventoryPush(ts)
    expect(getLastInventoryPushAt()).toBe(ts)
  })

  it('preserves deviceId when recording a push', () => {
    const id = getOrCreateDeviceId()
    recordInventoryPush(new Date().toISOString())
    expect(getDeviceId()).toBe(id)
  })

  it('overwrites a prior timestamp with the latest one', () => {
    const first = new Date(Date.now() - 1000).toISOString()
    const second = new Date().toISOString()
    recordInventoryPush(first)
    recordInventoryPush(second)
    expect(getLastInventoryPushAt()).toBe(second)
  })
})

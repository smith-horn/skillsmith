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

import {
  getDeviceId,
  getOrCreateDeviceId,
  setDeviceLabel,
  forgetDevice,
  isInventorySyncDisabledLocally,
  getLastInventoryPushAt,
  recordInventoryPush,
  shouldAutoPush,
} from './device-identity.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function makeTempConfigDir(): string {
  return path.join(
    os.tmpdir(),
    `skillsmith-device-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  )
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let savedHome: string | undefined
let savedInventoryDisable: string | undefined

beforeEach(() => {
  savedHome = process.env.HOME
  savedInventoryDisable = process.env.SKILLSMITH_INVENTORY_DISABLE
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

/**
 * Device Identity Module
 * @module @skillsmith/core/config/device-identity
 *
 * SMI-5391: Cross-harness inventory sync — device identity and push throttle.
 *
 * Manages a stable client-generated device UUID persisted in ~/.skillsmith/config.json
 * under the `inventory` namespace. Provides helpers for labelling the device, tracking
 * the last inventory push timestamp, and determining when an auto-push is due.
 *
 * The SERVER (`user_telemetry_preferences.inventory_sync_enabled`) remains the source
 * of truth for consent. `isInventorySyncDisabledLocally()` is a fast-path LOCAL
 * opt-out that short-circuits the upload before it starts.
 *
 * @example
 * ```typescript
 * import {
 *   getOrCreateDeviceId,
 *   getLastInventoryPushAt,
 *   shouldAutoPush,
 *   recordInventoryPush,
 * } from './device-identity.js'
 *
 * const deviceId = getOrCreateDeviceId()
 * if (shouldAutoPush(Date.now(), getLastInventoryPushAt())) {
 *   // ...build + upload the snapshot for `deviceId`...
 *   recordInventoryPush(new Date().toISOString())
 * }
 * ```
 */

import { randomUUID, createHash } from 'node:crypto'
import { chmodSync } from 'node:fs'
import { loadConfig, saveConfig, getConfigPath, ensureConfigDir } from './index.js'
import type { SkillsmithConfig } from './index.js'
import { acquireConfigLock, atomicWriteFile } from './config-atomic-write.js'

// ============================================================================
// Shared create-if-absent primitive (SMI-5531)
// ============================================================================

/**
 * Create-if-absent primitive shared by `getOrCreateDeviceId` and
 * `getOrCreateInstallId`.
 *
 * An unguarded fast-path read (`getExisting(loadConfig())`) covers the
 * common case cheaply. Only on a miss do we pay for
 * {@link acquireConfigLock} — and, critically, RE-READ config state after
 * acquiring it: another process may have created the value in the window
 * between our fast-path read and lock acquisition. Skipping that re-check
 * (e.g. by calling the plain `saveConfig()` with a value already decided
 * before the lock was held) is exactly the TOCTOU shape that let two
 * concurrent callers generate and persist two DIFFERENT ids — whichever
 * wrote last would win on disk, but the loser's caller would still return
 * its own (now-orphaned) generated value, so the two callers would never
 * converge. `saveConfig()` itself is deliberately NOT used inside the
 * locked section below: it would try to (re-)acquire this same
 * non-reentrant lock and deadlock.
 *
 * @param getExisting - Reads the target id out of a config snapshot.
 * @param generate - Produces a new id when none exists.
 * @param merge - Returns a new full config with the id applied on top of `latest`.
 */
function getOrCreatePersistedId(
  getExisting: (config: SkillsmithConfig) => string | undefined,
  generate: () => string,
  merge: (latest: SkillsmithConfig, id: string) => SkillsmithConfig
): string {
  const fastPathExisting = getExisting(loadConfig())
  if (fastPathExisting) return fastPathExisting

  // The lock file lives alongside config.json — the directory must exist
  // BEFORE we try to create it, not after acquiring the lock.
  ensureConfigDir()
  const configPath = getConfigPath()
  const release = acquireConfigLock(configPath)
  try {
    const latest = loadConfig()
    const alreadyCreated = getExisting(latest)
    if (alreadyCreated) return alreadyCreated

    const id = generate()
    atomicWriteFile(configPath, JSON.stringify(merge(latest, id), null, 2), 0o600)
    try {
      chmodSync(configPath, 0o600)
    } catch {
      // Ignore chmod errors on Windows.
    }
    return id
  } finally {
    release()
  }
}

// ============================================================================
// Device identity
// ============================================================================

/**
 * Return the persisted device UUID, or `undefined` if none has been created yet.
 *
 * Pure read — no side effects.
 *
 * SMI-5391
 */
export function getDeviceId(): string | undefined {
  return loadConfig().inventory?.deviceId
}

/**
 * Return the persisted device UUID, creating and persisting a new v4 UUID if none exists.
 *
 * The generated UUID satisfies the edge-function validator regex:
 * `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`
 *
 * Preserves any existing `deviceLabel` and `lastPushAt` during the write.
 * Concurrency-safe across processes (SMI-5531) — see
 * {@link getOrCreatePersistedId}.
 *
 * SMI-5391
 */
export function getOrCreateDeviceId(): string {
  return getOrCreatePersistedId(
    (config) => config.inventory?.deviceId,
    () => randomUUID(),
    (latest, deviceId) => ({
      ...latest,
      inventory: { ...latest.inventory, deviceId },
    })
  )
}

/**
 * Return the persisted per-install telemetry identifier, creating and
 * persisting a new one (`sha256(randomUUID())`) if none exists yet.
 *
 * SMI-5531: generated and persisted UNCONDITIONALLY — this call must
 * succeed and persist an id regardless of `SKILLSMITH_TELEMETRY_ENABLED` /
 * `POSTHOG_API_KEY`, which is exactly the env-gated condition that made the
 * legacy `context.distinctId` inert for virtually every real user. If a
 * future refactor re-couples this to that legacy gate, this fix is inert
 * again under a new field name — do not add any env/flag check here.
 *
 * Concurrency-safe across processes — see {@link getOrCreatePersistedId}.
 */
export function getOrCreateInstallId(): string {
  return getOrCreatePersistedId(
    (config) => config.telemetry?.installId,
    () => createHash('sha256').update(randomUUID()).digest('hex'),
    (latest, installId) => ({
      ...latest,
      telemetry: { ...latest.telemetry, installId },
    })
  )
}

/**
 * Set (or clear) the optional user-facing label for this device.
 *
 * Passing `undefined` removes `deviceLabel` from the persisted block while
 * preserving `deviceId` and `lastPushAt`.
 *
 * SMI-5391
 *
 * @param label - Human-readable device name, or `undefined` to clear.
 */
export function setDeviceLabel(label: string | undefined): void {
  const config = loadConfig()
  saveConfig({
    inventory: {
      ...config.inventory,
      deviceLabel: label,
    },
  })
}

/**
 * Clear the device identity so the next inventory push registers a fresh device.
 *
 * Implementation note: delegates to `saveConfig({ inventory: undefined })`, which
 * removes the entire `inventory` block (including `deviceLabel` if set). This is the
 * simplest correct approach and is explicitly acceptable per the SMI-5391 spec. A
 * subsequent `getOrCreateDeviceId()` call will generate a new UUID.
 *
 * SMI-5391
 */
export function forgetDevice(): void {
  saveConfig({ inventory: undefined })
}

// ============================================================================
// Sync disable flag
// ============================================================================

/**
 * Return `true` when the local env flag opts this device out of inventory sync.
 *
 * Checks `SKILLSMITH_INVENTORY_DISABLE` — accepts `'1'` or `'true'`
 * (case-insensitive). This is a LOCAL fast-path opt-out only; the SERVER
 * (`user_telemetry_preferences.inventory_sync_enabled`) remains the authoritative
 * consent gate.
 *
 * SMI-5391
 */
export function isInventorySyncDisabledLocally(): boolean {
  const val = process.env.SKILLSMITH_INVENTORY_DISABLE
  if (!val) return false
  return val === '1' || val.toLowerCase() === 'true'
}

// ============================================================================
// Push throttle
// ============================================================================

/**
 * Return the ISO timestamp of the last successful inventory push, or `undefined`.
 *
 * SMI-5391
 */
export function getLastInventoryPushAt(): string | undefined {
  return loadConfig().inventory?.lastPushAt
}

/**
 * Persist an ISO timestamp marking a successful inventory push.
 *
 * Preserves any existing `deviceId` and `deviceLabel` during the write.
 *
 * SMI-5391
 *
 * @param timestampIso - ISO 8601 timestamp (e.g. `new Date().toISOString()`).
 */
export function recordInventoryPush(timestampIso: string): void {
  const config = loadConfig()
  saveConfig({
    inventory: {
      ...config.inventory,
      lastPushAt: timestampIso,
    },
  })
}

/**
 * Return `true` when an auto-push is due.
 *
 * Pure function — `now` is injected for deterministic tests (reuses the
 * SMI-4590 session-throttle convention).
 *
 * @param now - Current Unix epoch in milliseconds (e.g. `Date.now()`).
 * @param lastPushAt - ISO timestamp of the previous push; `undefined` means never pushed.
 * @param throttleMs - Minimum gap between pushes in milliseconds (default: 24 h).
 * @returns `true` if `lastPushAt` is absent, unparseable, or at/beyond `throttleMs` ago.
 *
 * SMI-5391
 */
export function shouldAutoPush(
  now: number,
  lastPushAt?: string,
  throttleMs = 24 * 60 * 60 * 1000
): boolean {
  if (!lastPushAt) return true
  const last = Date.parse(lastPushAt)
  if (Number.isNaN(last)) return true
  return now - last >= throttleMs
}

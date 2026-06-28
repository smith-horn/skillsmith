/**
 * Inventory push orchestrator (SMI-5392, umbrella SMI-5382).
 *
 * The single entry point both the CLI command and the MCP tool call to push this
 * device's inventory. Wires together the local opt-out gate, the payload builder,
 * the upload client, and the auto-push throttle.
 *
 * @module @skillsmith/core/sync/inventory-push
 */

import {
  getLastInventoryPushAt,
  isInventorySyncDisabledLocally,
  recordInventoryPush,
  shouldAutoPush,
} from '../config/device-identity.js'
import { buildInventoryPayload } from './inventory-builder.js'
import { uploadInventory } from './inventory-client.js'
import type { BuildInventoryDeviceOptions } from './inventory-device.js'
import type { InventoryUploadResult } from './inventory-types.js'

/** Options accepted by {@link pushInventory}. */
export type PushInventoryOptions = BuildInventoryDeviceOptions

/** Options accepted by {@link maybeAutoPush}. */
export interface MaybeAutoPushOptions extends BuildInventoryDeviceOptions {
  /** Injectable clock for deterministic throttle tests (defaults to `Date.now()`). */
  now?: number
}

/**
 * Build and upload this device's inventory snapshot.
 *
 * When the local opt-out flag (`SKILLSMITH_INVENTORY_DISABLE`) is set, this is a
 * pure no-op: NO network call, and NO device-id creation. On a server-applied
 * upload, the last-push timestamp is persisted for the auto-push throttle. A
 * consent-off `{ applied: false, reason: 'consent_disabled' }` result is returned
 * as-is and does NOT advance the throttle (so consent re-enablement pushes promptly).
 *
 * @param opts - Optional CLI version to stamp on the snapshot.
 * @returns The upload result (or the local-disable no-op).
 * @see SMI-5392
 */
export async function pushInventory(opts?: PushInventoryOptions): Promise<InventoryUploadResult> {
  if (isInventorySyncDisabledLocally()) {
    return { ok: true, applied: false, reason: 'disabled_locally' }
  }

  const payload = await buildInventoryPayload(opts)
  const result = await uploadInventory(payload)

  if (result.applied) {
    recordInventoryPush(new Date().toISOString())
  }

  return result
}

/**
 * Auto-push entry point for the session-start hook.
 *
 * Returns `null` (without pushing) when sync is locally disabled or the throttle
 * window has not elapsed. Upload errors are SWALLOWED — an auto-push must never
 * throw into a session hook — logged to `console.error` and reported as `null`.
 *
 * @param opts - Optional CLI version + injectable clock.
 * @returns The upload result, or `null` when skipped / throttled / errored.
 * @see SMI-5392
 */
export async function maybeAutoPush(
  opts?: MaybeAutoPushOptions
): Promise<InventoryUploadResult | null> {
  if (isInventorySyncDisabledLocally()) return null

  const now = opts?.now ?? Date.now()
  if (!shouldAutoPush(now, getLastInventoryPushAt())) return null

  try {
    return await pushInventory(opts)
  } catch (error) {
    console.error('[skillsmith] inventory auto-push failed:', error)
    return null
  }
}

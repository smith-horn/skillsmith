/**
 * Device-identity builder for the cross-harness inventory payload
 * (SMI-5392, umbrella SMI-5382).
 *
 * Produces the {@link InventoryDevice} half of an {@link InventoryUploadPayload}.
 * Field minimization follows ADR-124: the raw hostname is NEVER sent by default
 * (`hostname_display` is `null` this wave); only a salt-free sha256 `hostname_hash`
 * is included as a soft duplicate-device hint. The hash is not trivially
 * reversible, but a low-entropy hostname is dictionary-recoverable — this is
 * acceptable per ADR-124 because the hash is scoped to the user's own
 * authenticated account, never exposed cross-tenant.
 *
 * @module @skillsmith/core/sync/inventory-device
 */

import { hostname } from 'node:os'
import { createHash } from 'node:crypto'
import { getOrCreateDeviceId } from '../config/device-identity.js'
import { loadConfig } from '../config/index.js'
import { INVENTORY_LIMITS, type InventoryDevice } from './inventory-types.js'

/** Options accepted by {@link buildInventoryDevice}. */
export interface BuildInventoryDeviceOptions {
  /** Skillsmith CLI version that produced the snapshot (defaults to `null`). */
  cliVersion?: string | null
}

/**
 * Truncate `value` to at most `max` characters, returning `null` for nullish
 * input. Guards every length-capped column so a malformed local value can't
 * trip a DB CHECK constraint mid-reconcile.
 */
function capped(value: string | null | undefined, max: number): string | null {
  if (value == null) return null
  return value.length > max ? value.slice(0, max) : value
}

/**
 * Build the {@link InventoryDevice} descriptor for this machine.
 *
 * - `device_id` is the stable client-generated UUID (created on first call).
 * - `label` is the user's optional device label from `~/.skillsmith/config.json`
 *   (`inventory.deviceLabel`); there is no dedicated getter in `device-identity`,
 *   so it is read directly from config and capped to `LABEL_MAX`.
 * - `hostname_display` is always `null` this wave (ADR-124 minimization).
 * - `hostname_hash` is the sha256 hex of `os.hostname()` — a soft duplicate hint.
 *
 * @param opts - Optional CLI version to stamp on the snapshot.
 * @returns A fully-minimized device descriptor.
 * @see SMI-5392
 */
export function buildInventoryDevice(opts?: BuildInventoryDeviceOptions): InventoryDevice {
  const deviceId = getOrCreateDeviceId()
  const deviceLabel = loadConfig().inventory?.deviceLabel
  const hostnameHash = createHash('sha256').update(hostname(), 'utf8').digest('hex')

  return {
    device_id: deviceId,
    label: capped(deviceLabel, INVENTORY_LIMITS.LABEL_MAX),
    hostname_display: null,
    hostname_hash: capped(hostnameHash, INVENTORY_LIMITS.HOSTNAME_HASH_MAX),
    platform: capped(process.platform, INVENTORY_LIMITS.PLATFORM_MAX),
    arch: capped(process.arch, INVENTORY_LIMITS.ARCH_MAX),
    cli_version: capped(opts?.cliVersion, INVENTORY_LIMITS.CLI_VERSION_MAX),
  }
}

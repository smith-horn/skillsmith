/**
 * Cross-harness inventory payload contract (SMI-5389, umbrella SMI-5382).
 *
 * This is the SINGLE canonical declaration of the wire shape that the local
 * agent pushes to `POST /functions/v1/inventory-upload`. The CLI (Wave 3) and
 * website (Wave 4) import these types directly. The Deno edge function cannot
 * import a Node package, so `supabase/functions/inventory-upload/payload.ts`
 * mirrors this shape structurally and validates it at runtime — keep the two in
 * lock-step (the edge validator references this module by path in its header).
 *
 * ADR-125 (control plane + data model), ADR-124 (consent + field minimization).
 */

/**
 * Per-machine identity + metadata. `device_id` is a client-generated UUID
 * persisted in `~/.skillsmith/config.json` (ADR-125 Spike S2). Every other field
 * is optional and minimized by default (ADR-124): a raw hostname is only sent on
 * explicit opt-in; otherwise send a label and/or `hostname_hash`.
 */
export interface InventoryDevice {
  /** Client-generated stable UUID. Required. */
  device_id: string
  /** User-facing label (e.g. "work laptop"). */
  label?: string | null
  /** Display hostname — truncated/redacted by default. */
  hostname_display?: string | null
  /** Hash of the raw hostname for a soft duplicate-device hint (no auto-merge). */
  hostname_hash?: string | null
  /** `process.platform` (e.g. "darwin", "linux", "win32"). */
  platform?: string | null
  /** `process.arch` (e.g. "arm64", "x64"). */
  arch?: string | null
  /** Skillsmith CLI version that produced the snapshot. */
  cli_version?: string | null
}

/** What the local agent does with a skill when the registry advances. */
export type InventoryUpdatePolicy = 'auto' | 'manual' | 'never'

/**
 * One observed skill on one harness on this device. `skill_id` is the registry
 * id (`author/name`); local/unmatched skills still report their best id and
 * resolve to the `unknown` drift state server-side.
 */
export interface InventorySkillEntry {
  /** Harness slug (e.g. "claude-code", "opencode"). Required. */
  harness: string
  /** Skill id, conventionally `author/name`. Required. */
  skill_id: string
  /** Installed version string, if known. */
  version?: string | null
  /** Where it was installed from (registry, local path, git, …). */
  source?: string | null
  /** Content hash of the installed skill, for registry drift detection. */
  content_hash?: string | null
  /** Pinned version, if the user pinned it (suppresses drift/stale flags). */
  pinned_version?: string | null
  /** Update policy for this skill. */
  update_policy?: InventoryUpdatePolicy | null
}

/** Full request body for `POST /functions/v1/inventory-upload`. */
export interface InventoryUploadPayload {
  device: InventoryDevice
  skills: InventorySkillEntry[]
}

/**
 * Response body from `inventory-upload` (mirrors the `reconcile_device_inventory`
 * RPC return). `applied: false` with `reason: 'consent_disabled'` is the
 * consent-off no-op — a success, not an error.
 */
export interface InventoryUploadResult {
  ok: boolean
  applied: boolean
  reason?: string
  device_id?: string
  skills_present?: number
  skills_absent?: number
}

/**
 * Shared caps. Mirrors the column CHECK constraints in
 * `20260626000001_user_inventory.sql` and the payload bound in
 * `reconcile_device_inventory`. The edge validator and the local agent both
 * enforce these so a malformed push fails fast with a 400 rather than tripping a
 * DB constraint mid-reconcile.
 */
export const INVENTORY_LIMITS = {
  MAX_SKILLS: 5000,
  LABEL_MAX: 100,
  HOSTNAME_DISPLAY_MAX: 100,
  HOSTNAME_HASH_MAX: 64,
  PLATFORM_MAX: 32,
  ARCH_MAX: 32,
  CLI_VERSION_MAX: 32,
  HARNESS_MAX: 32,
  SKILL_ID_MAX: 255,
  VERSION_MAX: 64,
  SOURCE_MAX: 255,
  CONTENT_HASH_MAX: 128,
  PINNED_VERSION_MAX: 64,
  UPDATE_POLICY_MAX: 16,
} as const

/** Allowed `update_policy` values (mirrors the DB CHECK constraint). */
export const INVENTORY_UPDATE_POLICIES: readonly InventoryUpdatePolicy[] = [
  'auto',
  'manual',
  'never',
] as const

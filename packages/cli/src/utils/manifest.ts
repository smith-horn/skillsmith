/**
 * @fileoverview Thin manifest reader for the Skillsmith CLI
 * @module @skillsmith/cli/utils/manifest
 * @see SMI-skill-version-tracking Wave 2
 * @see SMI-5012 Wave 3: telemetry block + annual anonymous_id rotation
 *
 * Reads (and optionally writes) the ~/.skillsmith/manifest.json file.
 * This mirrors the SkillManifest types defined in
 * @skillsmith/mcp-server/tools/install.types without creating a cross-package
 * dependency on mcp-server.
 *
 * The CLI owns its own read path; write operations (pin/unpin) use
 * updateManifestEntry below which does an atomic temp-file rename.
 *
 * Concurrency note (v1): the atomic temp-file rename guarantees readers never
 * see partial writes (POSIX rename(2) is atomic). A full file-lock (proper-lockfile)
 * is NOT used here because proper-lockfile is not in the CLI's dependencies.
 * v1 assumes single-writer-per-process; concurrent writers from the same machine
 * (e.g., two concurrent `skillsmith telemetry` calls) may last-write-wins.
 * This matches the shared-state matrix entry (plan line 715) which notes the
 * proper-lockfile pattern but is aspirational for v2.
 */

import { createHash, randomUUID } from 'crypto'
import { readFile, writeFile, mkdir, rename } from 'fs/promises'
import { join, dirname } from 'path'
import { homedir } from 'os'

// ============================================================================
// Types (mirrors install.types.ts from mcp-server — kept in sync manually)
// ============================================================================

export interface SkillManifestEntry {
  id: string
  name: string
  version: string
  source: string
  installPath: string
  installedAt: string
  lastUpdated: string
  originalContentHash?: string
  contentHash?: string
  /** Wave 2: pinned content hash (8-char truncation of full SHA-256) */
  pinnedVersion?: string
  updatePolicy?: 'auto' | 'manual' | 'never'
}

export interface SkillManifest {
  version: string
  installedSkills: Record<string, SkillManifestEntry>
  /** SMI-5012 W3: telemetry opt-in block. Absent on older configs; treated as { enabled: false }. */
  telemetry?: TelemetryManifest
}

// ============================================================================
// Telemetry manifest types (SMI-5012 Wave 3)
// ============================================================================

/**
 * Telemetry configuration stored in ~/.skillsmith/manifest.json.
 *
 * Schema is additive: older configs without this block continue to load
 * (missing block is treated as { enabled: false } everywhere it is read).
 *
 * anonymous_id rotation policy (U6 / M7):
 *   - Generated via SHA-256(crypto.randomUUID()) on first opt-in
 *   - Auto-rotates after 365 days (checked on `skillsmith telemetry status`)
 *   - One-week overlap window: previous id is retained in previousAnonymousId
 *     until previousAnonymousIdRetiredAt so cross-rotation events can be joined
 *   - Manual rotation: `skillsmith telemetry reset-id` (SMI-5021)
 */
export interface TelemetryManifest {
  /** Whether telemetry is enabled. Always opt-in; default false. */
  enabled: boolean
  /** SHA-256 hex of a random UUID; 64 hex chars. Present only when enabled. */
  anonymousId?: string
  /** ISO-8601 date when anonymousId was generated. Enables annual rotation check. */
  anonymousIdCreatedAt?: string
  /** Previous anonymousId retained for one-week overlap window after rotation. */
  previousAnonymousId?: string
  /** ISO-8601 date after which previousAnonymousId can be swept. */
  previousAnonymousIdRetiredAt?: string
  /** Telemetry scope. Default 'personal'. */
  scope?: 'personal' | 'team'
  /** Present when scope === 'team'. */
  teamId?: string
  /** Override for staging. Default: prod events endpoint. */
  endpoint?: string
  /** ISO-8601 date when the Claude Code hook was last installed. */
  installedAt?: string
}

// ============================================================================
// Paths
// ============================================================================

const SKILLSMITH_DIR = join(homedir(), '.skillsmith')
export const MANIFEST_PATH = join(SKILLSMITH_DIR, 'manifest.json')

// ============================================================================
// Read / Write
// ============================================================================

/**
 * Load the manifest from disk.
 * Returns an empty manifest if the file does not exist.
 */
export async function loadManifest(): Promise<SkillManifest> {
  try {
    const content = await readFile(MANIFEST_PATH, 'utf-8')
    return JSON.parse(content) as SkillManifest
  } catch {
    return { version: '1.0.0', installedSkills: {} }
  }
}

/**
 * Save the manifest atomically (temp file → rename).
 */
export async function saveManifest(manifest: SkillManifest): Promise<void> {
  await mkdir(dirname(MANIFEST_PATH), { recursive: true })
  const tmpPath = `${MANIFEST_PATH}.tmp.${process.pid}`
  await writeFile(tmpPath, JSON.stringify(manifest, null, 2))
  await rename(tmpPath, MANIFEST_PATH)
}

/**
 * Load the manifest, apply an update function, and save atomically.
 */
export async function updateManifestEntry(
  updateFn: (manifest: SkillManifest) => SkillManifest
): Promise<void> {
  const manifest = await loadManifest()
  const updated = updateFn(manifest)
  await saveManifest(updated)
}

// ============================================================================
// Telemetry helpers (SMI-5012 Wave 3)
// ============================================================================

const ROTATION_DAYS = 365
const OVERLAP_DAYS = 7
const MS_PER_DAY = 86_400_000

/**
 * Generate a new anonymous telemetry id.
 *
 * Returns SHA-256(crypto.randomUUID()) as a 64-character lowercase hex string.
 * The UUID is not stored; only the hash reaches the wire (plan line 719).
 */
export function generateAnonymousId(): string {
  return createHash('sha256').update(randomUUID()).digest('hex')
}

/**
 * Returns true if the manifest's anonymousId should be rotated.
 *
 * Rotation is triggered when anonymousIdCreatedAt is older than 365 days.
 * Returns false if the field is absent (id was never generated).
 */
export function shouldRotateAnonymousId(manifest: SkillManifest): boolean {
  const createdAt = manifest.telemetry?.anonymousIdCreatedAt
  if (!createdAt) return false
  const ageMs = Date.now() - new Date(createdAt).getTime()
  return ageMs > ROTATION_DAYS * MS_PER_DAY
}

/**
 * Rotate the anonymous id.
 *
 * Moves the current id to previousAnonymousId with a 7-day retirement window,
 * generates a fresh id, and updates anonymousIdCreatedAt to now.
 * Returns a new TelemetryManifest — does NOT write to disk.
 * Callers must persist via saveManifest / updateManifestEntry.
 */
export function rotateAnonymousId(manifest: SkillManifest): TelemetryManifest {
  const current: TelemetryManifest = manifest.telemetry ?? { enabled: false }
  const now = new Date()
  const retiredAt = new Date(now.getTime() + OVERLAP_DAYS * MS_PER_DAY)
  return {
    ...current,
    anonymousId: generateAnonymousId(),
    anonymousIdCreatedAt: now.toISOString(),
    previousAnonymousId: current.anonymousId,
    previousAnonymousIdRetiredAt: retiredAt.toISOString(),
  }
}

/**
 * Remove previousAnonymousId once its retirement window has passed.
 *
 * Should be called on every `skillsmith telemetry status` run and before
 * each hook-script read. No-op if the window has not yet elapsed or if
 * there is no previous id. Returns a new TelemetryManifest.
 */
export function sweepExpiredPreviousId(manifest: SkillManifest): TelemetryManifest {
  const t: TelemetryManifest = manifest.telemetry ?? { enabled: false }
  if (!t.previousAnonymousIdRetiredAt) return t
  const retiredAt = new Date(t.previousAnonymousIdRetiredAt).getTime()
  if (Date.now() < retiredAt) return t
  const { previousAnonymousId: _a, previousAnonymousIdRetiredAt: _b, ...rest } = t
  return rest
}

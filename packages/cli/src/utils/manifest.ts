/**
 * @fileoverview Thin manifest reader for the Skillsmith CLI
 * @module @skillsmith/cli/utils/manifest
 * @see SMI-skill-version-tracking Wave 2
 * @see SMI-5012 Wave 3: telemetry block + annual anonymous_id rotation
 * @see SMI-6358: updateManifestEntry() now locks (below)
 *
 * Reads (and optionally writes) the ~/.skillsmith/manifest.json file.
 * This mirrors the SkillManifest types defined in
 * @skillsmith/mcp-server/tools/install.types without creating a cross-package
 * dependency on mcp-server.
 *
 * The CLI owns its own read path; write operations (pin/unpin/telemetry) go
 * through updateManifestEntry below, which now delegates the actual
 * lock+load+save cycle to @skillsmith/core's ManifestManager.updateSafely()
 * (SMI-6358) rather than reimplementing a fourth lock. This file's own
 * loadManifest()/saveManifest() stay as they were (SMI-6360 governs NOT
 * merging the three manifest *implementations* into one) — only the write
 * PATH used by every caller in this package now shares core's lock.
 *
 * Concurrency note (SMI-6358 supersedes the v1 note this replaced): every
 * caller of updateManifestEntry() now takes the SAME cross-process file
 * lock (`<MANIFEST_PATH>.lock`, wx-flag exclusive create) that
 * @skillsmith/core's ManifestManager uses for SkillInstallationService,
 * apply_manifest_reconcile, and manage.update.helpers.ts's adoption path —
 * and that @skillsmith/mcp-server's install.helpers.manifest.ts's
 * updateManifestSafely() ALSO already used (independently implemented, but
 * the identical target path + wx-flag protocol makes it interoperable with
 * this lock without any code sharing). A direct saveManifest() call
 * (bypassing updateManifestEntry) is still NOT locked and must never be used
 * for a read-modify-write sequence — see saveManifest()'s own doc comment.
 */

import { createHash, randomUUID } from 'crypto'
import { readFile, writeFile, mkdir, rename, unlink } from 'fs/promises'
import { join, dirname } from 'path'
import { homedir } from 'os'
import { assertNotRealUserHome, ManifestManager } from '@skillsmith/core'
import type { SkillManifest as CoreSkillManifest } from '@skillsmith/core'
import type { ClientId } from '@skillsmith/core/install'

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
  /** SMI-5894: which client this installation targets. See core's `SkillManifestEntry`. */
  client?: ClientId
  /**
   * ADR-145 §1 (SMI-6529 sync): who asserts this entry's identity —
   * `'local'` is a positive user assertion ("this is my own skill, not
   * registry-tracked") that `getSkillDiff` must never chase a source for.
   * See core's `SkillManifestEntry` for the full doc comment.
   */
  provenance?: 'local' | 'registry'
  /** ADR-145 §3 / ADR-144 §6: last successful re-verification timestamp. See core's `SkillManifestEntry`. */
  verifiedAt?: string
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
 *
 * @param manifestPath ADR-139 (SMI-6274 Wave 4): optional override, so a
 *   scope-aware caller (`manage.update.ts`'s `getSkillDiff`) can read the
 *   RESOLVED manifest (global or workspace-local) instead of always the
 *   global `MANIFEST_PATH`. Defaults to `MANIFEST_PATH` so every existing
 *   caller (`pin.ts`, `diff.ts`, `telemetry.action.ts`,
 *   `audit-sources.action.ts`) keeps working unmodified — the same
 *   backward-compatibility carve-out `manifestKeyFor()` established for the
 *   canonical client (SMI-5894 precedent).
 */
export async function loadManifest(manifestPath: string = MANIFEST_PATH): Promise<SkillManifest> {
  try {
    const content = await readFile(manifestPath, 'utf-8')
    return JSON.parse(content) as SkillManifest
  } catch {
    return { version: '1.0.0', installedSkills: {} }
  }
}

/**
 * Save the manifest atomically (temp file → rename).
 *
 * SMI-6007: the temp filename includes a `randomUUID()` suffix (not just
 * `process.pid`) — two concurrent `saveManifest()` calls in the same process
 * previously collided on an identical `.tmp.<pid>` path. Each call now owns
 * a uniquely-named temp file, and the write+rename is wrapped in try/catch
 * so a failure best-effort removes only *this invocation's* temp file
 * before rethrowing the original error (mirrors `ManifestManager.save()` in
 * `@skillsmith/core`, and `sqljsDriver.ts`'s `persist()`, SMI-5997) — the
 * error is never swallowed.
 *
 * SMI-6358: this function on its own provides NO locking — it is safe as a
 * one-shot write of a manifest you already hold exclusively (e.g. inside a
 * ManifestManager.updateSafely() callback), but a caller that does
 * `loadManifest()` then computes an update then calls `saveManifest()`
 * directly has an unlocked read-modify-write and can lose a concurrent
 * writer's update. Use updateManifestEntry() below for that shape instead.
 */
export async function saveManifest(manifest: SkillManifest): Promise<void> {
  // SMI-6343 follow-up (adversarial review): a third parallel manifest-write
  // implementation, homedir-derived with no override parameter — the $HOME
  // sandbox (vitest.setup.ts) was this file's only defense until this guard.
  assertNotRealUserHome(MANIFEST_PATH, 'write')
  await mkdir(dirname(MANIFEST_PATH), { recursive: true })
  const tmpPath = `${MANIFEST_PATH}.tmp.${process.pid}.${randomUUID()}`
  try {
    await writeFile(tmpPath, JSON.stringify(manifest, null, 2))
    await rename(tmpPath, MANIFEST_PATH)
  } catch (error) {
    try {
      await unlink(tmpPath)
    } catch {
      // best-effort cleanup — surface the original error either way
    }
    throw error
  }
}

/**
 * SMI-6358: the single locked read-modify-write path this file exposes.
 * Delegates to @skillsmith/core's ManifestManager.updateSafely() rather than
 * reimplementing the lock a fourth time — that gives this file's callers
 * (pin.ts, unpin, telemetry.action.ts) three things a bare
 * loadManifest()+saveManifest() pair did not have:
 *
 *   1. Locking: mutually exclusive with every other manifest writer in the
 *      repo that targets the SAME `~/.skillsmith/manifest.json` path (core's
 *      SkillInstallationService/apply_manifest_reconcile/manage.update
 *      adoption path, and mcp-server's own install.helpers.manifest.ts,
 *      which locks the identical `<path>.lock` file via the same wx-flag
 *      protocol even though it is a separately-maintained implementation).
 *   2. Fail-closed reads: ManifestManager.load() throws on a non-ENOENT read
 *      error (corrupt JSON, EACCES, ...) instead of this file's own
 *      loadManifest(), which still silently returns an empty manifest on
 *      ANY error (SMI-5909) — a write built on that empty snapshot would
 *      erase every existing entry. Callers that need a locked, fail-closed
 *      write MUST go through this function, not loadManifest()+saveManifest().
 *   3. Returns the manifest AFTER the update, so a caller that needs the
 *      freshly-computed value (e.g. telemetry's rotated anonymousId) does
 *      not need a second, unlocked read that could see a different writer's
 *      change land in between.
 *
 * Does NOT change this file's own SkillManifest/TelemetryManifest types or
 * loadManifest()/saveManifest() — SMI-6360 governs NOT consolidating the
 * three manifest *implementations* into one; this only reuses the
 * ALREADY-locked primitive for the write step. `manifest` inside the
 * updateSafely() callback is core's own (structurally-mirrored, slightly
 * narrower) SkillManifest type — the casts below are the one integration
 * point between the two mirrored type declarations, same pattern this
 * file's header already documents for the shape overall.
 */
export async function updateManifestEntry(
  updateFn: (manifest: SkillManifest) => SkillManifest
): Promise<SkillManifest> {
  // Constructed per-call, not at module scope. A module-scope instance made
  // merely *importing* this file construct a ManifestManager, which broke every
  // exhaustive `vi.mock('@skillsmith/core')` factory whose subject transitively
  // imports this module — those factories return only the exports their test
  // needs, so a new module-load-time dependency fails them at collection rather
  // than at the call site. Nothing is lost by moving it: the constructor only
  // stores the path, and updateSafely() acquires its own lock per call. This
  // also matches skills-directory.ts and manage.update.helpers.ts, which
  // already construct inside the functions that use it.
  const manifestManager = new ManifestManager(MANIFEST_PATH)
  let result: SkillManifest | undefined
  await manifestManager.updateSafely((manifest): CoreSkillManifest => {
    result = updateFn(manifest as SkillManifest)
    return result as CoreSkillManifest
  })
  // updateSafely()'s callback always runs exactly once before it resolves —
  // result is always assigned by the time we get here.
  return result as SkillManifest
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
  const next: TelemetryManifest = {
    ...current,
    anonymousId: generateAnonymousId(),
    anonymousIdCreatedAt: now.toISOString(),
    previousAnonymousIdRetiredAt: retiredAt.toISOString(),
  }
  if (current.anonymousId !== undefined) {
    next.previousAnonymousId = current.anonymousId
  }
  return next
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

/**
 * Release-prep gate for the bundled typosquat reference snapshot
 * (SMI-6033 Wave 1, Gap 7 — cross-model review follow-up).
 * @module scripts/lib/release-typosquat-snapshot
 *
 * `packages/mcp-server/src/assets/typosquat-reference-snapshot.json` is shipped
 * inside the published `@skillsmith/mcp-server` tarball and is the ONLY input
 * to `skill_validate`'s and `skill_rescan`'s offline typosquat checks
 * (`validate-typosquat-scan.ts`). With an empty `names` array those checks
 * return `[]` unconditionally — a permanently silent no-op, which is exactly
 * how the asset originally shipped: nothing regenerated it and nothing noticed.
 *
 * This module is the release-time half of the two-part fix (the other half is
 * an always-on unit test asserting the checked-in snapshot is non-empty and
 * well-formed — deliberately WITHOUT an age assertion, so CI never becomes a
 * time bomb on an unrelated branch weeks later). Staleness is a
 * release-cadence concern, so the age gate lives here instead.
 *
 * Extracted into `scripts/lib/` per the SMI-4783 convention that keeps
 * `prepare-release.ts` under the 500-line file-length budget.
 */

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { ROOT_DIR } from './version-utils.js'
import { GENERATE_COMMAND, generateTyposquatSnapshot } from '../generate-typosquat-snapshot.js'

/** Repo-relative path — matches what `buildFilesToAdd` expects in `extraFiles`. */
export const TYPOSQUAT_SNAPSHOT_REL_PATH =
  'packages/mcp-server/src/assets/typosquat-reference-snapshot.json'

/**
 * Maximum tolerated snapshot age at release time, in days.
 *
 * ADR-114 puts the release cadence at weekly, so 45 days is ~6 missed cadences
 * of slack before the gate trips. The reference set (top-starred + high-trust
 * skill names) churns slowly and the detector is warn-tier/medium-capped, so
 * weeks of staleness is an accepted, documented tradeoff (see the plan doc's
 * Gap 7); months of it is not.
 */
export const MAX_SNAPSHOT_AGE_DAYS = 45

export interface TyposquatSnapshotAudit {
  ok: boolean
  reason?: 'missing' | 'unparseable' | 'empty' | 'no-timestamp' | 'future-timestamp' | 'stale'
  nameCount: number
  generatedAt: string | null
  ageDays: number | null
  message: string
}

/**
 * Inspect the checked-in snapshot without touching the network.
 * Pure apart from one `readFileSync` — directly unit-testable.
 */
export function auditTyposquatSnapshot(now: Date = new Date()): TyposquatSnapshotAudit {
  const absPath = join(ROOT_DIR, TYPOSQUAT_SNAPSHOT_REL_PATH)
  const base = { nameCount: 0, generatedAt: null, ageDays: null }

  if (!existsSync(absPath)) {
    return {
      ...base,
      ok: false,
      reason: 'missing',
      message: `Snapshot not found at ${TYPOSQUAT_SNAPSHOT_REL_PATH}`,
    }
  }

  let parsed: { generatedAt?: unknown; names?: unknown }
  try {
    parsed = JSON.parse(readFileSync(absPath, 'utf-8'))
  } catch (err) {
    return {
      ...base,
      ok: false,
      reason: 'unparseable',
      message: `Snapshot is not valid JSON: ${err instanceof Error ? err.message : 'Unknown'}`,
    }
  }

  const nameCount = Array.isArray(parsed.names) ? parsed.names.length : 0
  const generatedAt = typeof parsed.generatedAt === 'string' ? parsed.generatedAt : null

  if (nameCount === 0) {
    return {
      ...base,
      ok: false,
      reason: 'empty',
      generatedAt,
      message:
        'Snapshot has ZERO reference names — the skill_validate and skill_rescan ' +
        'typosquat checks would ship as permanent no-ops.',
    }
  }

  if (generatedAt === null) {
    return {
      ...base,
      ok: false,
      reason: 'no-timestamp',
      nameCount,
      message: `Snapshot has ${nameCount} names but no \`generatedAt\` timestamp — age is unverifiable.`,
    }
  }

  const generatedMs = Date.parse(generatedAt)
  if (Number.isNaN(generatedMs)) {
    return {
      ...base,
      ok: false,
      reason: 'no-timestamp',
      nameCount,
      generatedAt,
      message: `Snapshot \`generatedAt\` is not a parseable date: ${generatedAt}`,
    }
  }

  const ageDays = (now.getTime() - generatedMs) / 86_400_000
  if (ageDays < 0) {
    return {
      ...base,
      ok: false,
      reason: 'future-timestamp',
      nameCount,
      generatedAt,
      ageDays,
      message: `Snapshot \`generatedAt\` is in the future (${generatedAt}) — clock skew or a hand-edited asset.`,
    }
  }

  if (ageDays > MAX_SNAPSHOT_AGE_DAYS) {
    return {
      ok: false,
      reason: 'stale',
      nameCount,
      generatedAt,
      ageDays,
      message:
        `Snapshot is ${Math.floor(ageDays)} days old (max ${MAX_SNAPSHOT_AGE_DAYS}) — ` +
        'the shipped typosquat reference set has drifted from the registry.',
    }
  }

  return {
    ok: true,
    nameCount,
    generatedAt,
    ageDays,
    message: `Snapshot OK: ${nameCount} names, ${Math.floor(ageDays)} day(s) old.`,
  }
}

/** True when the generator's required credentials are present in this process. */
export function hasSnapshotCredentials(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
}

export interface EnsureSnapshotResult {
  /** Files to append to the release commit's `extraFiles`. */
  filesToStage: string[]
  /** Lines the orchestrator prints verbatim. */
  log: string[]
}

/**
 * Release-prep Step 5.6.
 *
 * - `skip: true` → warn loudly and do nothing (the `--no-typosquat-snapshot`
 *   escape hatch, for an emergency release with no Supabase access).
 * - Credentials present → regenerate in-process and stage the result.
 * - Credentials absent → audit the checked-in snapshot. A healthy snapshot
 *   passes with a note; an empty / missing / unparseable / stale one THROWS,
 *   naming the exact regeneration command. Failing the release is the point:
 *   the pre-SMI-6033 behaviour was to ship the empty asset silently.
 */
export async function ensureTyposquatSnapshot(
  options: { skip?: boolean } = {}
): Promise<EnsureSnapshotResult> {
  const log: string[] = []

  if (options.skip) {
    log.push('  ⚠ Skipping typosquat snapshot refresh (--no-typosquat-snapshot)')
    log.push(`    The published tarball will ship the snapshot exactly as checked in.`)
    return { filesToStage: [], log }
  }

  if (hasSnapshotCredentials()) {
    const { count, generatedAt } = await generateTyposquatSnapshot()
    log.push(`  ✓ Typosquat snapshot regenerated: ${count} names (${generatedAt})`)
    return { filesToStage: [TYPOSQUAT_SNAPSHOT_REL_PATH], log }
  }

  const audit = auditTyposquatSnapshot()
  if (!audit.ok) {
    throw new Error(
      `Typosquat reference snapshot gate failed: ${audit.message}\n` +
        `    Regenerate it on the host with:\n      ${GENERATE_COMMAND}\n` +
        `    (or re-run with --no-typosquat-snapshot to ship the current asset as-is)`
    )
  }

  log.push(`  ✓ Typosquat snapshot: ${audit.message}`)
  log.push(
    `    (Supabase credentials not in this process — not regenerated. Run` +
      ` \`${GENERATE_COMMAND}\` on the host to refresh.)`
  )
  return { filesToStage: [], log }
}

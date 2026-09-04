/**
 * @fileoverview skill_updates MCP tool — check for registry skill updates
 * @module @skillsmith/mcp-server/tools/skill-updates
 * @see SMI-skill-version-tracking Wave 1
 * @see SMI-6343 Wave 2 — real content-hash comparison (C1)
 *
 * Compares the manifest's recorded install/update-time content hash of each
 * installed skill against the most-recent hash in the skill_versions table
 * to determine whether a newer version has been synced from the registry.
 *
 * SMI-6343 (C1): previously compared `skill_versions`' OLDEST recorded row
 * (documented as a stand-in for "what was installed") against its LATEST
 * row — but `oldest` was never actually tied to a real install event, and
 * (pre-fix) `skill_versions.content_hash` was a metadata-proxy hash, not a
 * real SKILL.md hash, making the whole comparison structurally meaningless.
 * Now compares the manifest's own recorded `contentHash`/`originalContentHash`
 * (the real hash of what is actually installed) against the latest real
 * registry hash, via the shared `compareSkillContentHashes()` comparator so
 * this tool, `skill_outdated`, and the CLI's `skills-directory.ts` cannot
 * drift apart on what "an update is available" means.
 *
 * Tier gate: Individual (version_tracking feature flag).
 * Community users see a graceful license error response, never a hard throw.
 *
 * Hash display: truncated to 8 chars for human readability (full hash stored).
 */

import { z } from 'zod'
import {
  SkillVersionRepository,
  compareSkillContentHashes,
  firstNonBlankHash,
} from '@skillsmith/core'
import { withTelemetry } from '@skillsmith/core/telemetry'
import { loadManifest } from './install.helpers.js'
import { getManifestInstalledSkillIds } from './manifest-skill-ids.helpers.js'
import type { SkillManifest } from './install.types.js'
import type { ToolContext } from '../context.js'

// ============================================================================
// Input / Output types
// ============================================================================

/**
 * Input schema for skill_updates tool
 */
export const skillUpdatesInputSchema = z.object({
  /** Optional filter — check only the specified skill IDs */
  skillIds: z
    .array(z.string().min(1))
    .optional()
    .describe('Specific skill IDs to check (omit for all tracked skills)'),
})

export type SkillUpdatesInput = z.infer<typeof skillUpdatesInputSchema>

/**
 * Per-skill update information returned by the tool
 */
export interface SkillUpdateInfo {
  /** Registry skill identifier (e.g. "author/skill-name") */
  skillId: string
  /**
   * SMI-6343: 8-char prefix of the manifest's recorded install/update-time
   * content hash (`contentHash` ?? `originalContentHash`) — the real
   * recorded installed hash. Renders as the honest placeholder `'--------'`
   * (never a stale `skill_versions` row) when the manifest has no entry for
   * this skill id — `updateAvailable` is `false` for that row too, since an
   * `unknown` comparator outcome never reports an update.
   */
  installedHash: string
  /** 8-char prefix of the most-recent recorded hash (current registry state) */
  latestHash: string
  /** Optional semver from the latest version record */
  semver: string | null
  /** Approximate age of the latest recorded version in days */
  ageDays: number
  /** Whether this skill is pinned (Wave 2 — always false in Wave 1) */
  pinned: boolean
  /** Whether an update is available (latestHash !== installedHash) */
  updateAvailable: boolean
}

/**
 * Response from skill_updates tool
 */
export interface CheckUpdatesResponse {
  /** Number of skills with updates available */
  updatesAvailable: number
  /** Per-skill details */
  skills: SkillUpdateInfo[]
}

// ============================================================================
// Tool schema (MCP tool definition)
// ============================================================================

/**
 * MCP tool definition for skill_updates
 */
export const skillUpdatesToolSchema = {
  name: 'skill_updates' as const,
  description:
    'Check installed skills for available updates by comparing locally-recorded content hashes ' +
    'against the current registry state. Requires Individual tier or higher. ' +
    'Returns a list of skills with their installed vs. latest hash and whether an update is available.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      skillIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Specific skill IDs to check. Omit to check all tracked skills.',
      },
    },
    required: [],
  },
}

// ============================================================================
// Execution
// ============================================================================

/**
 * SMI-6343 (C1, adversarial-review fix): build a map of registry skill id
 * -> the manifest's recorded install/update-time content hash
 * (`contentHash` when the skill has been updated since install, else
 * `originalContentHash`) — the real hash of what is actually installed.
 *
 * A skill installed under two clients (SMI-5894) can produce two manifest
 * entries sharing the same id, and those entries can legitimately carry
 * DIFFERENT installed hashes — e.g. the Claude Code copy was updated and
 * the Cursor copy wasn't. Picking "the first hash found" (the original
 * implementation) makes the verdict depend on manifest iteration order,
 * silently reporting "no update" for a genuinely-outdated client just
 * because an up-to-date sibling entry happened to be read first. Per
 * ADR-144 §3's fail-closed posture ("the system never converts uncertainty
 * into a registry identity/verdict"), a genuine multi-client conflict
 * resolves to no-hash-available (comparator reports `unknown`) rather than
 * guessing which client's state to trust — this is a one-row-per-skill-id
 * response shape, so there is nowhere honest to put two different verdicts
 * for one row.
 */
function buildManifestInstalledHashMap(manifest: SkillManifest): Map<string, string> {
  const hashesById = new Map<string, Set<string>>()
  if (!manifest.installedSkills || typeof manifest.installedSkills !== 'object') {
    return new Map()
  }
  for (const entry of Object.values(manifest.installedSkills)) {
    if (typeof entry.id !== 'string' || entry.id.trim().length === 0) continue
    // firstNonBlankHash() already trims and rejects blank values, so a
    // non-null result here is guaranteed non-blank.
    const hash = firstNonBlankHash(entry.contentHash, entry.originalContentHash)
    if (hash !== null) {
      const set = hashesById.get(entry.id) ?? new Set<string>()
      set.add(hash)
      hashesById.set(entry.id, set)
    }
  }
  const map = new Map<string, string>()
  for (const [id, hashes] of hashesById) {
    // Exactly one distinct hash across every client entry for this id ->
    // unambiguous. Two or more -> conflicting client state; omit from the
    // map entirely so the caller's `?? undefined` lookup falls through to
    // the comparator's honest `unknown` outcome.
    if (hashes.size === 1) {
      map.set(id, [...hashes][0])
    }
  }
  return map
}

/**
 * Execute the skill_updates tool.
 *
 * Resolves which skills to check either from `input.skillIds` or (SMI-5895
 * Wave 2 Step 2) the local manifest's installed-skill IDs — never an
 * unbounded registry-wide scan. The manifest is always loaded (SMI-6343
 * C1) so each skill's real recorded installed hash is available regardless
 * of which path resolved its id; `skill_versions`' latest row still
 * supplies the current registry hash and semver/age display fields.
 *
 * @param input   Validated tool input
 * @param context Tool context with database connection
 * @returns CheckUpdatesResponse with per-skill update status
 */
async function executeSkillUpdatesImpl(
  input: SkillUpdatesInput,
  context: ToolContext
): Promise<CheckUpdatesResponse> {
  const versionRepo = new SkillVersionRepository(context.db)

  const manifest = await loadManifest()
  const manifestInstalledHashes = buildManifestInstalledHashMap(manifest)

  // Determine which skill IDs to check.
  //
  // SMI-5895 (Wave 2 Step 2): previously this ran an unfiltered `SELECT
  // DISTINCT skill_id FROM skill_versions` here whenever skillIds was
  // omitted — a registry-wide scan of every skill ever indexed, not just
  // the ones actually installed (the reported `updatesAvailable: 2833`
  // bug). Bound it the same way the sibling skill_outdated tool already
  // does correctly: the local manifest, via the shared
  // getManifestInstalledSkillIds() helper so the two tools can't drift
  // apart on this again.
  let skillIds: string[]

  if (input.skillIds && input.skillIds.length > 0) {
    skillIds = input.skillIds
  } else {
    skillIds = getManifestInstalledSkillIds(manifest)
  }

  const now = Math.floor(Date.now() / 1000) // Unix seconds
  const skillInfos: SkillUpdateInfo[] = []

  for (const skillId of skillIds) {
    // Latest registry-synced version (semver, age, and — when the manifest
    // has no recorded installed hash — a display-only fallback).
    const history = await versionRepo.getVersionHistory(skillId, 1)

    if (history.length === 0) {
      continue
    }

    const latest = history[0]
    const manifestInstalledHash = manifestInstalledHashes.get(skillId)

    // SMI-6343 (C1): compare the manifest's real recorded installed hash
    // (not skill_versions' oldest row) against the current registry hash.
    const comparison = compareSkillContentHashes(manifestInstalledHash, latest.content_hash)

    const installedHash = manifestInstalledHash ? manifestInstalledHash.slice(0, 8) : '--------'
    const latestHash = latest.content_hash.slice(0, 8)

    const ageDays = Math.floor((now - latest.recorded_at) / 86400)

    skillInfos.push({
      skillId,
      installedHash,
      latestHash,
      semver: latest.semver,
      ageDays,
      pinned: false, // Wave 2: pinning support
      // SMI-6343: an 'unknown' comparator outcome (no manifest-recorded
      // hash for this skill) reports no update — reporting may degrade,
      // but this tool never claims an update is available when it can't
      // actually verify one.
      updateAvailable: comparison.outcome === 'outdated',
    })
  }

  const updatesAvailable = skillInfos.filter((s) => s.updateAvailable).length

  return {
    updatesAvailable,
    skills: skillInfos,
  }
}

// SMI-5017 W2.S2: wrap at export boundary
export const executeSkillUpdates = withTelemetry(executeSkillUpdatesImpl, {
  source: 'mcp-tool',
  extractSkillId: () => 'skill_updates',
  extractFramework: () => 'unknown',
})

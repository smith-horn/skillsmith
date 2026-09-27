/**
 * @fileoverview skill_outdated MCP tool — execution logic + wrapped export
 * @module @skillsmith/mcp-server/tools/outdated.action
 * @see SMI-6532: sibling-split of outdated.ts (SMI-5127+ foo.action.ts
 *   convention) so the ~40-entry renderer table due in this area doesn't
 *   push the file over the 500-line pre-commit gate. `executeOutdatedImpl`
 *   + the `withTelemetry`-wrapped `executeOutdated` export live here; the
 *   zod schema, `OutdatedInput`, and the response interfaces stay in
 *   outdated.ts.
 */

import { SkillVersionRepository, compareSkillContentHashes } from '@skillsmith/core'
import { withTelemetry } from '@skillsmith/core/telemetry'
import type { IdentitySignal, IdentityInconclusiveReason } from '@skillsmith/core'
import type { ToolContext } from '../context.js'
import { hashContent } from './install.conflict-helpers.js'
import { loadManifest, lookupSkillFromRegistry } from './install.helpers.js'
import { getManifestInstalledSkillIds } from './manifest-skill-ids.helpers.js'
import type { SkillManifestEntry, RegistrySkillInfo } from './install.types.js'
import { readInstalledContent, checkDependencies } from './outdated.helpers.js'
import {
  classifyOutdatedEntry,
  buildRegistryLookupOutcome,
  deriveUnknownReason,
  buildOutdatedDiagnosis,
} from './outdated.identity.js'
import type { OutdatedInput, OutdatedSkillInfo, OutdatedResponse } from './outdated.js'

// ============================================================================
// Execution
// ============================================================================

/**
 * Execute the skill_outdated tool.
 *
 * 1. Reads the manifest. If missing/empty, returns an empty result.
 * 2. For each installed skill, hashes the local SKILL.md and compares
 *    against the latest entry in skill_versions.
 * 3. If include_deps is true, queries skill_dependencies for each skill
 *    and checks whether skill-type deps are installed.
 *
 * @param input   Validated tool input
 * @param context Tool context with database connection
 * @returns OutdatedResponse with per-skill status and summary
 */
async function executeOutdatedImpl(
  input: OutdatedInput,
  context: ToolContext
): Promise<OutdatedResponse> {
  const manifest = await loadManifest()
  const entries = Object.values(manifest.installedSkills) as SkillManifestEntry[]

  if (entries.length === 0) {
    return {
      skills: [],
      summary: {
        total_installed: 0,
        outdated: 0,
        up_to_date: 0,
        unknown: 0,
        missing_deps: 0,
        local_drift: 0,
        identity_mismatch: 0,
      },
    }
  }

  const versionRepo = new SkillVersionRepository(context.db)
  const depRepo = context.skillDependencyRepository

  // Build set of installed skill IDs for dependency checking — filter out
  // corrupt entries (SMI-5895 Wave 2 Step 2: shared with skill_updates via
  // getManifestInstalledSkillIds, so the two tools can't drift on this).
  const installedSkillIds = new Set<string>(getManifestInstalledSkillIds(manifest))

  const skills: OutdatedSkillInfo[] = []
  let outdatedCount = 0
  let upToDateCount = 0
  let unknownCount = 0
  let missingDepsCount = 0
  let localDriftCount = 0
  let identityMismatchCount = 0

  // SMI-6343 (H1): the live registry arm is skipped entirely, for every
  // skill, when offline — never a per-skill error in that case. Monthly
  // quota exhaustion is detected the first time it occurs (via
  // lookupSkillFromRegistry's onQuotaExceeded callback) and likewise stops
  // the live arm for every remaining skill in this run, so a quota-exhausted
  // batch never burns one failed call per remaining skill. Per-minute
  // rate-limit 429s are already handled by the API client's own
  // retry/backoff and need no handling here.
  const liveArmOffline = context.apiClient.isOffline()
  let quotaExhausted = false
  // SMI-6343 (H1, pr-reviewer-gate fix): captured once, from whichever call
  // first revealed quota exhaustion — SkillsmithError's own `.message`
  // already carries the used/limit/tier and formatted reset-time text
  // (install.helpers.ts's onQuotaExceeded doc comment), so this is reused
  // verbatim as the diagnosis for every later row that never even attempts
  // the live arm because quotaExhausted is already true.
  let quotaDiagnosis: string | undefined

  for (const entry of entries) {
    // SMI-3177: Skip corrupt manifest entries with missing installPath
    if (!entry.installPath) {
      console.warn(
        `[skill_outdated] Skipping corrupt manifest entry (missing installPath): ${entry.id ?? 'unknown'}`
      )
      skills.push({
        id: entry.id ?? 'unknown',
        installed_hash: '--------',
        latest_hash: '--------',
        status: 'unknown',
        semver: null,
        diagnosis: buildOutdatedDiagnosis({
          state: 'unknown',
          signal: null,
          inconclusiveReason: 'no-history',
        }),
        ...(input.include_deps ? { dependencies: { total: 0, satisfied: [], missing: [] } } : {}),
      })
      unknownCount++
      continue
    }

    // Read + hash the currently installed SKILL.md
    const localContent = await readInstalledContent(entry.installPath)
    const localHash = localContent !== null ? hashContent(localContent) : null

    // Historical arm: the most-recently-synced skill_versions row. Valid as
    // an "ever matched" signal now that SyncEngine records a real SKILL.md
    // hash instead of a metadata proxy (SMI-6343 Wave 2).
    const history = await versionRepo.getVersionHistory(entry.id, 1)
    const historicalHash = history.length > 0 ? history[0].content_hash : null
    const historicalSemver = history.length > 0 ? history[0].semver : null

    // Live registry arm: only attempted when online, not yet quota-exhausted
    // for this run, and there is a local hash worth comparing against (no
    // point spending a call when the installed SKILL.md can't even be read).
    let liveHash: string | null = null
    // SMI-6343 (pr-reviewer-gate fix): true whenever the live arm was
    // actually attempted for THIS skill and lookupSkillFromRegistry()
    // reported a failure via onLiveLookupFailed — distinct from "never
    // attempted" (offline, already quota-exhausted from an earlier skill,
    // or no local hash to check). H1's degradation table requires a failed
    // attempt to degrade THIS skill to `unknown`, never to silently fall
    // back to potentially-stale history — falling back to history is
    // correct only when the live arm was skipped outright, not when it was
    // tried and failed.
    //
    // Driven by the onLiveLookupFailed callback, NOT a try/catch around
    // this call: lookupSkillFromRegistry() never rethrows — every caught
    // error inside it (network, DNS, timeout, quota) falls through to a
    // local-DB fallback that itself never carries a contentHash, so a
    // try/catch here observes nothing to catch. A pr-reviewer-gate finding
    // caught this: the adversarial-review round's fix correctly handled
    // the quota case (via the quotaExhausted flag) but left the generic
    // network-error case silently falling back to historicalHash, exactly
    // the bug this whole block exists to prevent.
    let liveArmFailed = false
    // SMI-6343 (Wave 3): hoisted so signal 2 can reuse this SAME lookup
    // instead of firing a second registry call for the same skill.
    let registryInfo: RegistrySkillInfo | null = null
    if (!liveArmOffline && !quotaExhausted && localHash !== null) {
      try {
        registryInfo = await lookupSkillFromRegistry(entry.id, context, {
          onQuotaExceeded: (error) => {
            quotaExhausted = true
            if (!quotaDiagnosis) {
              quotaDiagnosis = error instanceof Error ? error.message : String(error)
            }
          },
          onLiveLookupFailed: () => {
            liveArmFailed = true
          },
        })
        liveHash = registryInfo?.contentHash ?? null
      } catch {
        // Defense-in-depth only: lookupSkillFromRegistry() never rethrows
        // in its current implementation (onLiveLookupFailed above is the
        // real signal for every error it catches internally), but H1
        // requires this tool to never fail the whole call for any reason —
        // an unexpected throw here (a future change to the helper, a bad
        // mock in a caller's test) must still degrade to unknown, not
        // propagate.
        liveHash = null
        liveArmFailed = true
      }
    }

    // Live arm wins when it has data. When the live arm was never
    // attempted (offline / already quota-exhausted / no local hash), fall
    // back to the historical arm — a documented "skip entirely"
    // degradation, not a failure, so stale-but-real history is a
    // reasonable secondary signal. When the live arm WAS attempted for
    // this skill but failed, historicalHash is deliberately NOT consulted
    // (see liveArmFailed above), so this row honestly resolves to
    // `unknown` via the comparator rather than a definitive verdict built
    // on data that might no longer be true. `null` (neither available) is
    // also what fixes the latest_hash echo bug below — an unchecked skill
    // no longer echoes installed_hash.
    const registryHash = liveArmFailed ? null : (liveHash ?? historicalHash)
    const comparison = compareSkillContentHashes(localHash, registryHash)

    // SMI-6343 (Wave 3): mirrors the gate guarding the `try` block above —
    // was the live arm actually attempted for THIS skill (vs. skipped for
    // offline/quota/no-local-hash)? Feeds signal 2 below.
    const liveArmAttempted = !liveArmOffline && !quotaExhausted && localHash !== null
    const unknownReasonIfAny = deriveUnknownReason({
      liveArmOffline,
      quotaExhausted,
      liveArmFailed,
    })

    let status: 'current' | 'outdated' | 'local-drift' | 'identity-mismatch' | 'unknown'
    let identitySignal: IdentitySignal | null = null
    let inconclusiveReason: IdentityInconclusiveReason | null = null

    if (comparison.outcome === 'current') {
      status = 'current'
    } else if (comparison.outcome === 'unknown') {
      status = 'unknown'
      inconclusiveReason = unknownReasonIfAny
    } else {
      // comparison.outcome === 'outdated' — run the three contradiction
      // signals (SMI-6343 Wave 3, AC#3) before trusting this as a genuine,
      // safe-to-bulk-update version bump.
      const registryLookup = buildRegistryLookupOutcome({
        liveArmAttempted,
        liveArmOffline,
        quotaExhausted,
        liveArmFailed,
        registryInfo,
      })
      const classification = classifyOutdatedEntry({
        entry,
        comparisonOutcome: comparison.outcome,
        localHash,
        localContent,
        registryLookup,
        unknownReason: unknownReasonIfAny,
      })
      status = classification.state
      identitySignal = classification.signal
      inconclusiveReason = classification.inconclusiveReason
    }

    switch (status) {
      case 'current':
        upToDateCount++
        break
      case 'outdated':
        outdatedCount++
        break
      case 'local-drift':
        localDriftCount++
        break
      case 'identity-mismatch':
        identityMismatchCount++
        break
      case 'unknown':
        unknownCount++
        break
    }

    const diagnosis = buildOutdatedDiagnosis({
      state: status,
      signal: identitySignal,
      inconclusiveReason,
    })

    // SMI-6343 (H1): the plan's degradation contract requires a diagnosis
    // naming the reason for an offline- or quota-caused `unknown` row.
    // Gated on localHash !== null so a row that's unknown for an unrelated
    // reason (SKILL.md unreadable) doesn't get a misleading offline/quota
    // explanation — offline/quota only actually explain a row that would
    // otherwise have attempted the live arm.
    let degradationHint: string | undefined
    if (status === 'unknown' && localHash !== null) {
      if (liveArmOffline) {
        degradationHint = `Registry offline — skipped live check for ${entry.id}; no prior sync history to compare against either.`
      } else if (quotaExhausted && quotaDiagnosis) {
        degradationHint = quotaDiagnosis
      }
    }

    const skillInfo: OutdatedSkillInfo = {
      id: entry.id,
      installed_hash: localHash?.slice(0, 8) ?? '--------',
      // SMI-6343: fixes the echo bug — previously this rendered
      // installed_hash when there was no comparison data at all, which
      // visually read as "in sync" for a row that was never actually
      // checked. Now it only ever reflects a real (live or historical)
      // registry hash, or the honest '--------' placeholder.
      latest_hash: registryHash ? registryHash.slice(0, 8) : '--------',
      status,
      semver: historicalSemver,
      diagnosis,
      // SMI-5407: surface a recovery hint when the manifest entry has no source.
      // The source is needed by skill_diff / View-Changes to fetch the latest
      // SKILL.md content. Recovering it requires `sklx audit sources`. The
      // H1 degradation diagnosis (offline / quota) takes precedence when
      // both would apply — it explains why THIS run's status couldn't be
      // determined, which is the more actionable, run-specific fact; the
      // missing-source condition is a standing one that will still be true
      // next run regardless.
      ...(degradationHint
        ? { hint: degradationHint }
        : typeof entry.source !== 'string' || entry.source.trim().length === 0
          ? {
              hint: `Source not tracked for ${entry.id}. Run \`sklx audit sources\` (or MCP skill_recover_source) to recover.`,
            }
          : {}),
    }

    // Dependency satisfaction
    if (input.include_deps) {
      const deps = depRepo.getDependencies(entry.id)
      if (deps.length > 0) {
        const depStatus = checkDependencies(deps, installedSkillIds)
        skillInfo.dependencies = depStatus
        if (depStatus.missing.length > 0) {
          missingDepsCount++
        }
      } else {
        skillInfo.dependencies = { total: 0, satisfied: [], missing: [] }
      }
    }

    skills.push(skillInfo)
  }

  return {
    skills,
    summary: {
      total_installed: entries.length,
      outdated: outdatedCount,
      up_to_date: upToDateCount,
      unknown: unknownCount,
      missing_deps: missingDepsCount,
      local_drift: localDriftCount,
      identity_mismatch: identityMismatchCount,
    },
  }
}

// SMI-5017 W2.S2: wrap at export boundary
export const executeOutdated = withTelemetry(executeOutdatedImpl, {
  source: 'mcp-tool',
  extractSkillId: () => 'skill_outdated',
  extractFramework: () => 'unknown',
})

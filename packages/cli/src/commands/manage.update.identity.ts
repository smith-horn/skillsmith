/**
 * @fileoverview `skillsmith update` tamper-check classification
 * @module @skillsmith/cli/commands/manage.update.identity
 * @see SMI-6343 Wave 3 — tamper-check classification (AC#3), H5
 *
 * CLI counterpart of `packages/mcp-server/src/tools/outdated.identity.ts` —
 * both adapt their own package's registry-lookup shape into the SAME shared
 * `@skillsmith/core` classification module (`skill-identity-
 * classification.ts`), so the CLI and the MCP tool cannot drift into two
 * independently-maintained implementations of the three contradiction
 * signals.
 *
 * Unlike `outdated.ts` (which only gates on a Wave 2 content-hash
 * comparison), this module classifies an entry the caller has ALREADY
 * determined needs a force-install (`getSkillDiff()` found a real diff via
 * its own registry-version-string comparison) — the CLI's local
 * `skill_versions` cache is commonly empty (SMI-6343 Finding 4B), so gating
 * classification behind a hash comparison here would make almost every
 * `update` refuse to proceed. `classifyDivergentEntry()` is called directly:
 * signal evaluation, plus "has this file been edited since install," never
 * a hash-comparison precondition.
 *
 * Signal 2 (front-matter contradiction) reuses `getSkillDiff()`'s OWN
 * already-obtained registry author/name (`SkillDiff.resolvedRegistryRecord`)
 * rather than firing a second, independent `RegistryLookup.lookup(entry.id)`
 * call — deliberately: `RegistryLookup`'s existing implementations
 * (`createDbRegistryLookup` / `createApiBackedRegistryLookup`) require a
 * truthy `repoUrl` before returning anything at all, an install-time
 * concern signal 2 has no interest in, so a fresh lookup keyed on `repoUrl`
 * presence would under-report author data `getSkillDiff` already has in
 * hand.
 */

import { readFile } from 'fs/promises'
import { join } from 'path'
import {
  hashContent,
  classifyDivergentEntry,
  type SkillManifestEntry,
  type RegistryLookupOutcome,
  type IdentitySignal,
  type IdentityInconclusiveReason,
  type OutdatedClassificationState,
} from '@skillsmith/core'
import { getInstallPath, type ClientId, type ScopedInstallTarget } from '@skillsmith/core/install'

export interface UpdateEntryClassification {
  state: OutdatedClassificationState
  signal: IdentitySignal | null
  inconclusiveReason: IdentityInconclusiveReason | null
}

/**
 * Classify the CURRENTLY-installed manifest entry the caller is about to
 * overwrite via `install(force: true)`.
 */
export async function classifyManifestEntryForUpdate(params: {
  entry: SkillManifestEntry
  client: ClientId
  scopeTarget?: ScopedInstallTarget | undefined
  /** `SkillDiff.resolvedRegistryRecord` — see this module's fileoverview. */
  resolvedRegistryRecord: { author: string | null; name: string | null } | null
}): Promise<UpdateEntryClassification> {
  const { entry, client, scopeTarget, resolvedRegistryRecord } = params

  let localContent: string | null
  try {
    // Defensive `typeof` guard, not just try/catch: a mocked `readFile`
    // (this module's own test suite, and several `manage.update.test.ts`
    // fixtures) can resolve to `undefined` without throwing when no
    // implementation is wired for a given call — `hashContent(undefined)`
    // would otherwise throw deep inside `classifyDivergentEntry`.
    const raw = await readFile(join(entry.installPath, 'SKILL.md'), 'utf-8')
    localContent = typeof raw === 'string' ? raw : null
  } catch {
    localContent = null
  }
  const localHash = localContent !== null ? hashContent(localContent) : null

  // `null` means THIS resolution never consulted the registry (the raw-URL
  // branch) — not a network failure. The shared module separately exempts
  // an `entry.id` that doesn't parse as `owner/name` from signal 2 entirely
  // (see `skill-identity-classification.ts`), so this "attempted: false"
  // only actually blocks when `entry.id` IS registry-shaped yet this
  // particular resolution genuinely never confirmed it.
  const registryLookup: RegistryLookupOutcome = resolvedRegistryRecord
    ? { attempted: true, record: resolvedRegistryRecord, failureReason: null }
    : { attempted: false, record: null, failureReason: null }

  const expectedRootDir = scopeTarget?.dir ?? getInstallPath(client)

  return classifyDivergentEntry({
    entry,
    localHash,
    localContent,
    expectedRootDir,
    registryLookup,
  })
}

/** Human-readable reason string for a `Skipped` bucket entry in `updateSkills()`'s summary. */
export function buildUpdateSkipReason(classification: UpdateEntryClassification): string {
  switch (classification.state) {
    case 'identity-mismatch':
      return (
        `recorded identity contradicts what is on disk (${classification.signal}) — ` +
        'run skill_recover_source, then apply_manifest_reconcile before updating'
      )
    case 'local-drift':
      return 'on-disk content differs from the registry with no identity contradiction — looks like a local edit'
    case 'unknown':
      return `could not verify identity (${classification.inconclusiveReason ?? 'unknown reason'})`
    default:
      return ''
  }
}

/** True when this classification must NOT be force-installed over. */
export function isUnsafeToForceInstall(classification: UpdateEntryClassification): boolean {
  return classification.state !== 'outdated' && classification.state !== 'current'
}

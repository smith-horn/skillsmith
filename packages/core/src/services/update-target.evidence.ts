/**
 * @fileoverview Manifest evidence for the update eligibility gate (SMI-6532, A2 §4.1).
 * @module @skillsmith/core/services/update-target.evidence
 * @see ADR-155 — skill updates write only where they compared
 * @see ADR-145 — manifest provenance as a second trust axis
 *
 * WHY THIS IS AN INTERFACE AND NOT A CALL INTO SMI-6345.
 *
 * The eligibility gate needs one question answered: for the directory we are
 * about to compare, what does the manifest say about it? SMI-6345 will own the
 * real answer — it is extracting a shared `(manifest, harness, scannedDir,
 * dirName)` primitive as part of a much larger identity programme
 * (`skill-inventory-harness-tracking.md:336`). That programme is In Progress
 * and its primitive does not exist yet.
 *
 * Waiting for it would block the gate behind an unrelated schedule. Reaching
 * into it early would couple the gate to a shape still being designed. So A2
 * depends on the INPUT and OUTPUT shapes only, ships a temporary resolver
 * behind them, and `classifyUpdateTarget` takes the resolver as a parameter and
 * imports no implementation at all.
 *
 * When SMI-6345 lands, one adapter maps its output to `ManifestEvidence` and
 * `temporaryManifestEvidenceResolver` is deleted. A shared fixture test runs
 * both resolvers against the same cases BEFORE the swap, so the replacement is
 * proven equivalent rather than assumed to be.
 *
 * The input shape deliberately matches SMI-6345's proposed signature verbatim.
 * If that signature changes, this file is where the mismatch surfaces, and it
 * surfaces at the type level rather than at runtime.
 */

import { manifestKeyFor } from './skill-installation.helpers.js'
import { resolveRealOrFallback } from './skill-installation.target-guard.js'
import type { ClientId } from '../install/paths.js'
import type { SkillManifest, SkillManifestEntry } from './skill-installation.types.js'

/**
 * What the resolver is asked about: one directory, in the context of one
 * manifest snapshot and one harness.
 */
export interface ManifestEvidenceInput {
  /**
   * ONE strict snapshot for the whole run. Not re-read per skill.
   *
   * A gate that re-reads the manifest per candidate can classify two skills
   * against two different manifests, so a concurrent writer could make the plan
   * internally inconsistent — eligible and ineligible decided under different
   * facts. The snapshot is taken once by the caller and passed down.
   */
  manifest: SkillManifest
  /** The harness whose directory is being scanned. */
  harness: ClientId
  /** Realpath of the directory that will be compared and possibly written. */
  scannedDir: string
  /** Basename of that directory — the name half of the manifest key. */
  dirName: string
}

/**
 * Why a directory failed to produce usable manifest evidence.
 *
 * `null` means evidence WAS produced. It does not mean the skill is eligible —
 * eligibility is `classifyUpdateTarget`'s decision, and it reads these fields
 * plus several signals this resolver never sees.
 */
export type EvidenceDisqualifier =
  /** No manifest entry under this harness's key for this directory name. */
  | 'no-entry'
  /** An entry exists, but its `installPath` resolves somewhere else. */
  | 'path-mismatch'
  /** An entry exists, but its `installPath` is absent or not absolute. */
  | 'invalid-install-path'

/**
 * What the manifest says about one scanned directory.
 *
 * Every field is evidence, never proof (ADR-144 §1). A populated `canonicalId`
 * means the manifest claims one, not that the claim was verified.
 */
export interface ManifestEvidence {
  /** The key looked up — `name` for the canonical client, `name::client` otherwise. */
  manifestKey: string
  /** The entry found under that key, or `null` when there is none. */
  entry: SkillManifestEntry | null
  /** The id the manifest attributes to this directory. */
  canonicalId: string | null
  /** The source string recorded at install time. */
  source: string | null
  /** ADR-145's second trust axis. `'local'` is a hard skip in the gate. */
  provenance: 'local' | 'registry' | null
  /** A pin, if the user set one. Any value here is a skip. */
  pinnedVersion: string | null
  /** `'never'` and `'manual'` are skips; `'auto'` is not by itself eligibility. */
  updatePolicy: 'auto' | 'manual' | 'never' | null
  /** Why no usable evidence was produced, or `null` when it was. */
  disqualifiedBy: EvidenceDisqualifier | null
}

/** The seam. `classifyUpdateTarget` takes one of these and imports no implementation. */
export type ManifestEvidenceResolver = (input: ManifestEvidenceInput) => Promise<ManifestEvidence>

/** The shape returned whenever evidence could not be produced. */
function disqualified(
  manifestKey: string,
  entry: SkillManifestEntry | null,
  reason: EvidenceDisqualifier
): ManifestEvidence {
  return {
    manifestKey,
    entry,
    canonicalId: null,
    source: null,
    provenance: null,
    pinnedVersion: null,
    updatePolicy: null,
    disqualifiedBy: reason,
  }
}

/**
 * A2's stand-in resolver, to be deleted when SMI-6345's primitive lands.
 *
 * Two deliberate properties, both of which the replacement must also have:
 *
 * 1. **It keys by `manifestKeyFor(dirName, harness)`.** A bare-name lookup
 *    reads the canonical client's entry for a non-canonical harness — the
 *    SMI-6358 defect class. The key is computed, never assumed.
 *
 * 2. **It compares realpaths, not strings.** Two spellings of one directory
 *    (a symlink, a case difference on APFS, a trailing slash) are the same
 *    directory to the kernel and different strings to a comparison. An entry
 *    whose `installPath` names a DIFFERENT directory is `path-mismatch` and
 *    produces no evidence — it is never adopted, because adopting it is how a
 *    write lands somewhere nobody compared (ADR-155).
 *
 * Mirrors `skill-installation.target-guard.ts`'s own comparison by calling the
 * same `resolveRealOrFallback`, so the two cannot drift.
 */
export const temporaryManifestEvidenceResolver: ManifestEvidenceResolver = async (input) => {
  const { manifest, harness, scannedDir, dirName } = input
  const manifestKey = manifestKeyFor(dirName, harness)

  // The `?.` guards a case `SkillManifest` says cannot happen, and it is NOT
  // dead code: `packages/cli/src/utils/manifest.ts:150` does
  // `JSON.parse(content) as SkillManifest` — an unchecked cast. A manifest file
  // missing `installedSkills` yields an object the type claims has it and that
  // does not. (`skill-manifest.ts:120` does default it, but that is a different
  // loader, and this resolver is handed a snapshot rather than choosing one.)
  //
  // Without the guard that case is a TypeError inside the gate, which fails a
  // safety check OPEN by crashing the run rather than reporting every skill
  // ineligible. Do not remove it on the type's word alone.
  const entry = (manifest.installedSkills?.[manifestKey] ?? null) as SkillManifestEntry | null
  if (entry === null) {
    return disqualified(manifestKey, null, 'no-entry')
  }

  // Checked before resolving, because resolveRealOrFallback on a relative path
  // silently resolves against process.cwd() and on undefined throws a raw
  // TypeError — both of which turn a structured refusal into a wrong answer or
  // a crash. Same guard target-guard.ts states for the same reason.
  if (typeof entry.installPath !== 'string' || !entry.installPath.startsWith('/')) {
    return disqualified(manifestKey, entry, 'invalid-install-path')
  }

  const realEntry = await resolveRealOrFallback(entry.installPath)
  const realScanned = await resolveRealOrFallback(scannedDir)
  if (realEntry !== realScanned) {
    return disqualified(manifestKey, entry, 'path-mismatch')
  }

  return {
    manifestKey,
    entry,
    canonicalId: entry.id ?? null,
    source: entry.source ?? null,
    provenance: entry.provenance ?? null,
    pinnedVersion: entry.pinnedVersion ?? null,
    updatePolicy: entry.updatePolicy ?? null,
    disqualifiedBy: null,
  }
}

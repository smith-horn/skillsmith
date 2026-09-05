/**
 * @fileoverview Shared skill-identity contradiction-signal classification
 * @module @skillsmith/core/services/skill-identity-classification
 * @see SMI-6343 Wave 3 — tamper-check classification (AC#3)
 *
 * Three deterministic-or-best-effort "does this manifest entry's recorded
 * identity contradict what's actually installed" signals, plus a
 * "has this on-disk content been locally edited since install" check —
 * consumed by BOTH `packages/mcp-server/src/tools/outdated.ts` (via
 * `outdated.identity.ts`) and `packages/cli/src/commands/manage.update.ts`,
 * so the two packages cannot drift into two independently-maintained
 * implementations of the same contradiction logic (exactly the "sibling
 * implementation" bug class both Wave 1 and Wave 2 of SMI-6343 already hit).
 *
 * Deliberately decoupled from either caller's own `RegistrySkillInfo` shape
 * (mcp-server's `install.types.ts` and core's own `skill-installation.types.ts`
 * both have independently-evolved versions) — callers adapt their own
 * registry-lookup result into the minimal {@link RegistryLookupOutcome} shape
 * this module needs.
 *
 * Every function here is synchronous and filesystem-free by design: signal 3
 * (path containment) is a pure string check against an already-resolved
 * expected root directory, not a `fs.realpath` call — the callers of this
 * module (`outdated.ts`, `manage.update.ts`) only ever reach the "outdated"
 * classification branch after already having successfully read the
 * installed skill's SKILL.md this same iteration, so "does installPath
 * exist" is already established by the time these signals run.
 */

import { relative, isAbsolute } from 'node:path'
import { SkillParser } from '../indexer/SkillParser.js'
import { firstNonBlankHash } from './skill-content-comparison.js'
import type { ContentComparisonOutcome } from './skill-content-comparison.js'
import type { ClientId } from '../install/paths.js'

// ============================================================================
// Types
// ============================================================================

/** Which of the three contradiction signals fired. */
export type IdentitySignal = 'owner-mismatch' | 'frontmatter-contradiction' | 'path-unresolved'

/** Why a classification could not be conclusively determined. */
export type IdentityInconclusiveReason =
  | 'offline'
  | 'quota-exhausted'
  | 'network-error'
  | 'no-registry-record'
  | 'no-history'

/** The five-state classification `outdated.ts`/`manage.update.ts` report against a divergent entry. */
export type OutdatedClassificationState =
  | 'current'
  | 'outdated'
  | 'local-drift'
  | 'identity-mismatch'
  | 'unknown'

/** Minimal registry-record shape signal 2 needs. */
export interface IdentityRegistryRecord {
  author?: string | null
  name?: string | null
}

/**
 * The outcome of a caller's OWN registry lookup for the entry's claimed
 * `id`, adapted into this module's minimal shape.
 *
 * `attempted: false` means the caller never even tried this run (offline,
 * or an earlier skill in the same batch already exhausted quota) —
 * `failureReason` in that case names WHY it wasn't attempted. `attempted:
 * true` with `record: null` means the lookup completed but found nothing
 * for this id (a distinct case from a failed lookup — see
 * `no-registry-record` below).
 */
export interface RegistryLookupOutcome {
  attempted: boolean
  record: IdentityRegistryRecord | null
  /** Populated when the lookup either wasn't attempted or didn't complete. */
  failureReason?: 'offline' | 'quota-exhausted' | 'network-error' | null
}

/** The subset of a manifest entry every signal needs. */
export interface ManifestEntryForIdentity {
  id: string
  source: string
  installPath: string
  client?: ClientId
  contentHash?: string
  originalContentHash?: string
}

/** Result of {@link classifyManifestEntryIdentity}. */
export interface IdentityClassificationResult {
  /** Which signal fired. Null when no signal fired (regardless of `inconclusive`). */
  signal: IdentitySignal | null
  /** True when signal 2 (frontmatter) could not be checked at all. */
  inconclusive: boolean
  /** Populated only when `inconclusive` is true. */
  inconclusiveReason: IdentityInconclusiveReason | null
}

/** Result of {@link classifyDivergentEntry}. */
export interface DivergentEntryClassification {
  state: Exclude<OutdatedClassificationState, 'current'>
  signal: IdentitySignal | null
  inconclusiveReason: IdentityInconclusiveReason | null
}

// ============================================================================
// Signal 1 — owner mismatch
// ============================================================================

/**
 * Parse a clean `owner/name` pair (exactly one slash, no URL scheme) into
 * its owner segment. Returns `null` for anything that isn't that exact
 * shape — critically, a raw URL (`https://github.com/owner/repo`, a
 * direct-URL install's `id`/`source`) is NOT an `owner/name` pair and must
 * return `null` here rather than a garbage "owner" parsed from before the
 * URL's first slash (e.g. `'https:'`). Mirrors the same 2-segment
 * distinction `install.helpers.ts`'s `parseSkillId()` already draws between
 * a registry id and a direct GitHub reference.
 */
function parseOwnerFromOwnerNamePair(value: string): string | null {
  if (value.includes('://')) return null
  const parts = value.split('/')
  if (parts.length !== 2) return null
  const [owner, name] = parts
  return owner.length > 0 && name.length > 0 ? owner : null
}

/**
 * Parse the owner segment out of a manifest `source` string. Real installs
 * write `source` as `'github:' + owner + '/' + repo` (`skill-installation.
 * service.ts`) — the `'github:'` prefix is optional here so a bare
 * `owner/repo` (or a future non-GitHub source shape) still parses. Returns
 * `null` for the `'unknown'` distrust sentinel, a raw URL, or anything else
 * with no parseable `owner/name` shape.
 */
export function parseOwnerFromSource(source: string | undefined | null): string | null {
  if (!source || source === 'unknown') return null
  const withoutPrefix = source.startsWith('github:') ? source.slice('github:'.length) : source
  return parseOwnerFromOwnerNamePair(withoutPrefix)
}

/**
 * Parse the owner segment out of a manifest entry's `id`. Returns `null`
 * for anything that isn't a clean `owner/name` pair — most importantly a
 * raw GitHub URL, which a direct-URL install records as `id` verbatim (see
 * {@link parseOwnerFromOwnerNamePair}).
 */
export function parseOwnerFromId(id: string | undefined | null): string | null {
  if (!id) return null
  return parseOwnerFromOwnerNamePair(id)
}

/**
 * Signal 1: `id` parses as `owner/name` and `source` names a DIFFERENT
 * owner. Deterministic, offline, zero network dependency. Catches the real
 * `linear` skill corruption (`source: "github:lobehub/lobehub"` vs
 * `id: "wrsmith108/linear"`).
 */
export function detectOwnerMismatch(
  entry: Pick<ManifestEntryForIdentity, 'id' | 'source'>
): boolean {
  const idOwner = parseOwnerFromId(entry.id)
  const sourceOwner = parseOwnerFromSource(entry.source)
  if (!idOwner || !sourceOwner) return false
  return idOwner.toLowerCase() !== sourceOwner.toLowerCase()
}

// ============================================================================
// Signal 3 — path unresolved
// ============================================================================

/**
 * Signal 3: `installPath` is absent, or resolves OUTSIDE `expectedRootDir`
 * (the claimed client's native install root, or a workspace-scoped
 * equivalent the caller resolves — see each caller's own scope handling).
 *
 * Deliberately a pure string containment check (`path.relative`), not a
 * filesystem call: both callers of this module only reach this signal after
 * already having successfully read the entry's SKILL.md this same
 * iteration, so filesystem existence is already established. This also
 * catches the exact shape of the SMI-6343 Wave 1 test-fixture leak (an
 * OS-temp-dir `installPath` written into the real manifest) via simple
 * string comparison, with no need to resolve symlinks.
 */
export function detectPathUnresolved(
  installPath: string | undefined | null,
  expectedRootDir: string
): boolean {
  if (!installPath) return true
  const rel = relative(expectedRootDir, installPath)
  if (rel === '') return false
  return rel.startsWith('..') || isAbsolute(rel)
}

// ============================================================================
// Signal 2 — front-matter contradiction
// ============================================================================

interface Signal2Result {
  fired: boolean
  inconclusive: boolean
  inconclusiveReason: IdentityInconclusiveReason | null
}

function normalize(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * Signal 2: on-disk front-matter `author`/`name` contradicts the registry's
 * record for the claimed `id`. Catches the real `commit` skill corruption
 * (internally-consistent id/source, but content that belongs to an
 * unrelated skill) — signal 1 alone does not catch this shape.
 *
 * H2 (fail-closed): when the registry lookup could not complete (offline,
 * network error, quota-exhausted) OR completed but found no record for the
 * claimed id, this returns `inconclusive: true` — NEVER "no contradiction."
 * An inconclusive signal 2 still forces the overall classification to
 * `unknown`, not `local-drift`/`current` — see {@link classifyDivergentEntry}.
 *
 * Exception, not a weakening of H2: when `id` itself doesn't parse as a
 * well-formed `owner/name` registry key (a raw GitHub URL from a direct-URL
 * install, an unresolved UUID) there is structurally no registry record to
 * look up in the first place — a caller cannot "fail to check" something
 * that was never a registry-backed identity to begin with. This is a clean
 * non-fire, not an inconclusive one, exactly mirroring how an unparseable
 * on-disk front-matter is treated below.
 */
function evaluateFrontmatterContradiction(
  entryId: string,
  localContent: string | null,
  registryLookup: RegistryLookupOutcome
): Signal2Result {
  if (parseOwnerFromId(entryId) === null) {
    return { fired: false, inconclusive: false, inconclusiveReason: null }
  }
  if (!registryLookup.attempted) {
    return {
      fired: false,
      inconclusive: true,
      inconclusiveReason: registryLookup.failureReason ?? 'network-error',
    }
  }
  if (registryLookup.failureReason) {
    return { fired: false, inconclusive: true, inconclusiveReason: registryLookup.failureReason }
  }
  if (!registryLookup.record) {
    return { fired: false, inconclusive: true, inconclusiveReason: 'no-registry-record' }
  }

  const parsed = localContent !== null ? new SkillParser().parse(localContent) : null
  if (!parsed) {
    // Nothing to contradict with — a local parse failure is a data-quality
    // fact, not a network-dependent uncertainty, so this is a clean
    // non-fire, not `inconclusive` (see this module's fileoverview).
    return { fired: false, inconclusive: false, inconclusiveReason: null }
  }

  const localAuthor = normalize(parsed.author)
  const localName = normalize(parsed.name)
  const registryAuthor = normalize(registryLookup.record.author)
  const registryName = normalize(registryLookup.record.name)

  const authorContradiction =
    localAuthor !== null &&
    registryAuthor !== null &&
    localAuthor.toLowerCase() !== registryAuthor.toLowerCase()
  const nameContradiction =
    localName !== null &&
    registryName !== null &&
    localName.toLowerCase() !== registryName.toLowerCase()

  return {
    fired: authorContradiction || nameContradiction,
    inconclusive: false,
    inconclusiveReason: null,
  }
}

// ============================================================================
// Combined signal classification
// ============================================================================

/**
 * Run all three contradiction signals against a manifest entry. Any one
 * conclusively firing means `signal` is non-null — order (1, 3, 2) checks
 * the two deterministic/offline signals first, only falling to the
 * network-dependent signal 2 when neither of those already answered the
 * question.
 */
export function classifyManifestEntryIdentity(params: {
  entry: ManifestEntryForIdentity
  localContent: string | null
  expectedRootDir: string
  registryLookup: RegistryLookupOutcome
}): IdentityClassificationResult {
  const { entry, localContent, expectedRootDir, registryLookup } = params

  if (detectOwnerMismatch(entry)) {
    return { signal: 'owner-mismatch', inconclusive: false, inconclusiveReason: null }
  }
  if (detectPathUnresolved(entry.installPath, expectedRootDir)) {
    return { signal: 'path-unresolved', inconclusive: false, inconclusiveReason: null }
  }

  const signal2 = evaluateFrontmatterContradiction(entry.id, localContent, registryLookup)
  if (signal2.inconclusive) {
    return { signal: null, inconclusive: true, inconclusiveReason: signal2.inconclusiveReason }
  }
  if (signal2.fired) {
    return { signal: 'frontmatter-contradiction', inconclusive: false, inconclusiveReason: null }
  }
  return { signal: null, inconclusive: false, inconclusiveReason: null }
}

// ============================================================================
// Local-edit detection (local-drift vs outdated)
// ============================================================================

/**
 * Has the on-disk content changed since the manifest's own recorded
 * install/update-time hash? This is what distinguishes a benign local edit
 * (`local-drift`) from a genuine registry version bump (`outdated`) once
 * no identity signal has fired.
 *
 * When the manifest never recorded a comparable hash at all (a legacy or
 * adopted entry, `contentHash`/`originalContentHash` both absent), this
 * deliberately defaults to `false` (no edit evidence) rather than `true`
 * (conservative) — absence of a recorded hash is a data-quality gap, not
 * positive evidence of tampering, and defaulting to `true` here would
 * misclassify the large population of legacy/adopted entries that never had
 * a hash recorded as `local-drift` even when they are genuinely just
 * outdated (SMI-6343 Wave 3 review finding).
 */
export function hasRecordedLocalEdit(
  entry: Pick<ManifestEntryForIdentity, 'contentHash' | 'originalContentHash'>,
  localHash: string | null
): boolean {
  const recordedHash = firstNonBlankHash(entry.contentHash, entry.originalContentHash)
  if (recordedHash === null || localHash === null) return false
  return recordedHash !== localHash
}

// ============================================================================
// Full divergent-entry classification
// ============================================================================

/**
 * Classify an entry the caller has ALREADY determined is divergent from the
 * registry (mcp-server: `compareSkillContentHashes(...).outcome ===
 * 'outdated'`; CLI: `getSkillDiff()` found a version/content difference).
 * Never returns `'current'` — callers own that trivial case themselves,
 * since it never needs signal evaluation at all.
 */
export function classifyDivergentEntry(params: {
  entry: ManifestEntryForIdentity
  localHash: string | null
  localContent: string | null
  expectedRootDir: string
  registryLookup: RegistryLookupOutcome
}): DivergentEntryClassification {
  const identity = classifyManifestEntryIdentity(params)
  if (identity.signal) {
    return { state: 'identity-mismatch', signal: identity.signal, inconclusiveReason: null }
  }
  if (identity.inconclusive) {
    return { state: 'unknown', signal: null, inconclusiveReason: identity.inconclusiveReason }
  }

  const hasLocalEdit = hasRecordedLocalEdit(params.entry, params.localHash)
  return hasLocalEdit
    ? { state: 'local-drift', signal: null, inconclusiveReason: null }
    : { state: 'outdated', signal: null, inconclusiveReason: null }
}

/**
 * Full 5-state classification given an already-computed content-comparison
 * outcome (from `compareSkillContentHashes`) plus the caller-derived reason
 * a plain `'unknown'` comparison outcome couldn't be resolved (offline,
 * quota-exhausted, network-error, or no-history — the caller already tracks
 * which applies; see `outdated.ts`'s `deriveUnknownReason`).
 */
export function classifyOutdatedState(params: {
  comparisonOutcome: ContentComparisonOutcome
  unknownReasonWhenComparisonUnknown: IdentityInconclusiveReason
  entry: ManifestEntryForIdentity
  localHash: string | null
  localContent: string | null
  expectedRootDir: string
  registryLookup: RegistryLookupOutcome
}): {
  state: OutdatedClassificationState
  signal: IdentitySignal | null
  inconclusiveReason: IdentityInconclusiveReason | null
} {
  if (params.comparisonOutcome === 'current') {
    return { state: 'current', signal: null, inconclusiveReason: null }
  }
  if (params.comparisonOutcome === 'unknown') {
    return {
      state: 'unknown',
      signal: null,
      inconclusiveReason: params.unknownReasonWhenComparisonUnknown,
    }
  }
  return classifyDivergentEntry(params)
}

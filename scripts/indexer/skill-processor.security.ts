/**
 * Security helpers for the Node indexer skill-processor (SMI-5436 Wave 0+2).
 *
 * Wave 0: extracted buildQuarantineReason + readResponseWithLimit from
 * skill-processor.ts to keep that file ≤500 lines.
 * Wave 2: adds sibling-scan plumbing — enumerateSiblingTargets,
 * fetchSiblingContent, mergeSiblingScans, buildMergedQuarantineReason.
 * SMI-5879 PR-2192a: adds scanSkillBundle — the enumerate -> fetch -> scan ->
 * merge loop extracted verbatim out of validateSkillMd (skill-processor.ts),
 * so the pre-merge simulator can call the same function production uses.
 * SMI-6033 Wave 1 (Gap 7): scanSkillBundle grows an optional trailing
 * `typosquat` param (candidate name + reference set) folded into the same
 * mergeSiblingScans() merge pattern as sibling findings — additive-only, so
 * the SMI-5879 dual-scan simulator's ScanSkillBundleFn structural pin
 * (smi5879-simulate-full.types.ts) still matches (extra OPTIONAL trailing
 * parameters preserve function-type assignability).
 *
 * Parity with supabase/functions/indexer/skill-processor.security.ts is
 * enforced by parity.test.ts.
 *
 * SMI-6033 Wave 3 (Gap 5): scanSkillBundle now also computes
 * `isHighTrustAuthor` from `owner` (the indexer's own resolved GitHub repo
 * owner — a verified fact, not a spoofable SKILL.md frontmatter field) and
 * threads it into every scanSkillContent call (primary + siblings), enabling
 * the Gatekeeper-bypass trust-tier carve-out on THIS (indexer) path only.
 * Reuses the exact same HIGH_TRUST_AUTHORS owner-set lookup Gap 7's
 * typosquat-reference.ts already sources from — not a second mechanism.
 *
 * SMI-6033 Wave 2 (Gap 8): scanSkillBundle also reads a bounded set of
 * OPERATIONAL CODE files (scripts/, src/, bin/) picked from the repo's git
 * tree, appended to the same sibling list the existing fetch/scan/merge loop
 * walks. Selection, budget and coverage: ./skill-processor.security.tree.ts.
 */

import {
  shouldQuarantine,
  summarizeFindings,
  scanSkillContent,
  type EdgeScanResult,
  type SecurityFinding,
} from './_shared/security-scanner-edge.ts'
import { type RateLimitTelemetry } from './_shared/rate-limit.ts'
// SMI-6033 Wave 1 (Gap 7): the already-built typosquat detector (SMI-595) —
// scripts/indexer/ is a Node tree so it can import packages/core directly
// (see typosquat-reference.ts's header for why the Deno twin cannot).
import {
  detectTyposquat,
  resolveTyposquatEnforcementMode,
} from '../../packages/core/src/security/scanner/index.js'
// SMI-6033 Wave 3 (Gap 5): the same high-trust-author allowlist Gap 7's
// typosquat-reference.ts already sources from.
import { HIGH_TRUST_AUTHORS } from './high-trust-authors.ts'
// SMI-6033 Wave 2 (Gap 8): extended scan-surface helpers, split into a sibling
// module to keep this file under the 500-line gate.
import {
  MAX_EXTENDED_SIBLING_FILES,
  computeScanCoverage,
  enumerateExtendedSiblingTargets,
  fetchRepoTreeEntries,
  type ScanCoverage,
} from './skill-processor.security.tree.ts'

// sync: packages/core/src/services/skill-installation.policy.ts BUNDLED_SCAN_FILES
export const BUNDLED_SCAN_FILES = [
  'README.md',
  'examples.md',
  'config.json',
  '.claude/settings.json',
  '.claude/settings.local.json',
  '.mcp.json',
  'package.json',
] as const

export type BundledScanFile = (typeof BUNDLED_SCAN_FILES)[number]

/**
 * SMI-2384: Build a human-readable quarantine reason for authors.
 *
 * When a skill is quarantined, this produces a message summarizing:
 * - Number of findings and risk score
 * - Types of patterns found with line numbers (max 5)
 * - Appeal URL with the skill identifier pre-filled
 */
export function buildQuarantineReason(
  scanResult: EdgeScanResult,
  owner: string,
  name: string
): string {
  if (!shouldQuarantine(scanResult)) {
    return ''
  }

  const findingSummary = summarizeFindings(scanResult.findings)
  const appealUrl = `https://www.skillsmith.app/contact?topic=quarantine&skill=${encodeURIComponent(`${owner}/${name}`)}`

  return `Security scan detected ${scanResult.findings.length} finding${scanResult.findings.length === 1 ? '' : 's'} (risk score: ${scanResult.riskScore}/100). ${findingSummary}. Appeal at ${appealUrl}`
}

/**
 * SMI-2283: Read response body with byte-counted limit to prevent memory exhaustion.
 * Streams the body and aborts if the accumulated size exceeds the limit.
 * @throws Error if response body exceeds maxBytes
 */
export async function readResponseWithLimit(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) {
    throw new Error('Response body is not readable')
  }

  const chunks: Uint8Array[] = []
  let totalBytes = 0

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      totalBytes += value.byteLength
      if (totalBytes > maxBytes) {
        reader.cancel()
        throw new Error(`Response body exceeds maximum size of ${maxBytes} bytes`)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const decoder = new TextDecoder()
  return chunks.map((chunk) => decoder.decode(chunk, { stream: true })).join('') + decoder.decode()
}

// SMI-6033 Wave 2 (Gap 8) adversarial-review fix: sibling-scan plumbing
// (enumerateSiblingTargets, fetchSiblingContent, mergeSiblingScans,
// buildMergedQuarantineReason + supporting types) extracted to
// skill-processor.security.sibling.ts to keep this file under the 500-line
// gate. Re-exported below so the public API is unchanged.
import {
  MAX_SIBLING_CONTENT_BYTES,
  enumerateSiblingTargets,
  fetchSiblingContent,
  mergeSiblingScans,
  type SiblingEdgeScan,
  type MergedEdgeScanResult,
} from './skill-processor.security.sibling.ts'
export {
  MAX_SIBLING_CONTENT_BYTES,
  DOC_CLASS_BASENAMES,
  enumerateSiblingTargets,
  fetchSiblingContent,
  mergeSiblingScans,
  buildMergedQuarantineReason,
  type SiblingEdgeScan,
  type MergedEdgeScanResult,
  type FetchSiblingResult,
} from './skill-processor.security.sibling.ts'

/**
 * Max CDN fetches per skill (latency cap, not a rate-budget guard — CDN costs
 * zero core quota). SMI-6033 Wave 2 (Gap 8): widened to the 7 fixed bundled
 * files PLUS up to MAX_EXTENDED_SIBLING_FILES operational-code ones.
 * Documentation only — nothing enforces it; the two enumerate* functions are
 * what bound the real count. Kept accurate because parity.test.ts and
 * skill-processor.security.test.ts both pin it as a declared-vs-real check.
 */
export const MAX_SIBLING_BLOB_FETCHES_PER_SKILL =
  BUNDLED_SCAN_FILES.length + MAX_EXTENDED_SIBLING_FILES

// =============================================================================
// SMI-5879 PR-2192a: scanSkillBundle extraction (design 8.2.1 / 8.2.1.1)
// =============================================================================

/**
 * SMI-5879 PR-2192a: injectable fetch/scan layers for scanSkillBundle. Tests
 * (and the Wave 3 simulator's tier-1 retry wrapper, per 8.2.1.1 item 3) swap
 * either layer; production callers pass no `deps` and get the real
 * implementations below.
 */
export interface ScanSkillBundleDeps {
  fetchSiblingContent?: typeof fetchSiblingContent
  scanSkillContent?: typeof scanSkillContent
  // SMI-6033 Wave 2 (Gap 8): swappable so tests can drive the extended
  // scan surface from a synthetic tree without a Trees API round-trip.
  fetchRepoTreeEntries?: typeof fetchRepoTreeEntries
}

/**
 * SMI-5879 PR-2192a (8.2.2): one skipped-sibling record. Observability only —
 * its addition changes no quarantine verdict.
 */
export interface SiblingFailure {
  relPath: string
  kind: 'transient' | 'removed'
}

export interface ScanSkillBundleResult {
  securityScan: EdgeScanResult
  siblingScans: SiblingEdgeScan[]
  /** Present when at least one sibling was successfully fetched and scanned. */
  mergedSecurityScan?: MergedEdgeScanResult
  siblingFailures: SiblingFailure[]
  /**
   * SMI-6033 Wave 2 (Gap 8): was this skill's scan surface complete, and why
   * not when it wasn't — persisted as `scan_coverage_incomplete` /
   * `scan_coverage_note` so a partially scanned skill is never recorded as
   * fully scanned. Never affects the verdict: an honesty flag, not an input.
   */
  scanCoverage: ScanCoverage
}

/**
 * SMI-6033 Wave 1 (Gap 7): optional typosquat scan input for scanSkillBundle.
 * `referenceNames` should be built ONCE per indexer batch run (see
 * `typosquat-reference.ts`) and passed down — never rebuilt per skill.
 */
export interface TyposquatScanInput {
  candidateName: string
  referenceNames: ReadonlySet<string>
}

/**
 * SMI-6033 Wave 3 (Gap 5 Product decision, 2026-08-14): is `owner` one of
 * this indexer's own high-trust author owners? Reuses the exact same
 * HIGH_TRUST_AUTHORS-owner-set lookup Gap 7's typosquat-reference.ts already
 * builds (`HIGH_TRUST_AUTHORS.map((a) => a.owner)`) — not a second
 * mechanism. `owner` here is expected to be the GitHub repo owner the
 * indexer itself resolved this skill under (a verified fact), never a
 * spoofable SKILL.md frontmatter field — see the plan's "Product decision:
 * Gatekeeper-bypass carve-out" section for why that distinction is
 * load-bearing.
 */
function isHighTrustOwner(owner: string): boolean {
  return HIGH_TRUST_AUTHORS.some((a) => a.owner.toLowerCase() === owner.toLowerCase())
}

/**
 * SMI-5879 PR-2192a: the single scan-surface entry point (design 8.2.1 /
 * 8.2.1.1). Body is the pre-existing inline enumerate -> fetch -> scan ->
 * merge loop from validateSkillMd (skill-processor.ts, both twins), moved
 * verbatim, plus the additive siblingFailures observable (8.2.2). Production
 * quarantine behaviour is UNCHANGED by this extraction.
 *
 * The pre-merge simulator (Wave 3, per 8.2 RC-2) calls this SAME function, so
 * identity between the production quarantine gate and the simulated verdict
 * is structural, not a test-time coincidence.
 *
 * Deliberately NOT unified with runSiblingRescan
 * (revalidate-stale-quarantines.sibling.ts): that path is fail-CLOSED (any
 * transient sibling failure aborts the rescan and keeps the quarantine in
 * place); this path is fail-OPEN (a transient failure skips that sibling and
 * merges without it). Unifying them would change a live production
 * quarantine decision, which a behaviour-preserving extraction must not do —
 * see revalidate-stale-quarantines.sibling.ts's own header.
 */
export async function scanSkillBundle(
  owner: string,
  repo: string,
  branch: string,
  skillPath: string | undefined,
  primaryContent: string,
  telemetry: RateLimitTelemetry,
  deps?: ScanSkillBundleDeps,
  // SMI-6033 Wave 1 (Gap 7): optional, additive-only trailing param — see
  // this file's header for why the SMI-5879 simulator's structural pin on
  // this function's signature stays satisfied.
  typosquat?: TyposquatScanInput
): Promise<ScanSkillBundleResult> {
  const doFetchSiblingContent = deps?.fetchSiblingContent ?? fetchSiblingContent
  const doScanSkillContent = deps?.scanSkillContent ?? scanSkillContent
  const doFetchRepoTreeEntries = deps?.fetchRepoTreeEntries ?? fetchRepoTreeEntries

  // SMI-6033 Wave 3 (Gap 5): the Gatekeeper-bypass trust-tier carve-out's
  // precondition — see isHighTrustOwner's own header and
  // scanGatekeeperBypass's header (security-scanner-edge.compound.ts) for
  // the full policy. `owner` is a verified fact on this (indexer) path.
  const isHighTrustAuthor = isHighTrustOwner(owner)

  // SMI-2272: Run security scan on SKILL.md content
  const securityScan = await doScanSkillContent(primaryContent, isHighTrustAuthor)
  if (!securityScan.passed) {
    console.log(
      `[SecurityScan] ${owner}/${repo}: riskScore=${securityScan.riskScore}, findings=${securityScan.findings.length}`
    )
  }

  // SMI-5436 Wave 2: scan sibling files (CDN fetch, zero core quota)
  // SMI-6033 Wave 2 (Gap 8): plus a ranked, capped set of operational-code
  // files (scripts/, src/, bin/, and skill-dir top level) from the repo's git
  // tree, APPENDED to the same array the existing fetch -> scan -> merge loop
  // below walks — so there is no parallel merge path to drift. Each entry is
  // tagged `isExtended` below so mergeSiblingScans can apply its (narrower,
  // see that function's own header) rejection rule to this new surface.
  const treeResult = await doFetchRepoTreeEntries(owner, repo, branch, telemetry)
  const extended = enumerateExtendedSiblingTargets(
    skillPath ?? '',
    treeResult.entries,
    primaryContent,
    MAX_SIBLING_CONTENT_BYTES
  )
  const siblingPaths = [...enumerateSiblingTargets(skillPath ?? ''), ...extended.targets]
  // SMI-6033 Wave 2 (Gap 8) fix: which paths came from the new extended
  // surface, so mergeSiblingScans can apply its narrower rejection rule to
  // them (see that function's own header) without touching the original 7
  // fixed siblings' behavior at all.
  const extendedPathSet = new Set(extended.targets)
  const siblingScans: SiblingEdgeScan[] = []
  // SMI-5879 (8.2.2): observability only — never consulted by the merge below.
  const siblingFailures: SiblingFailure[] = []
  for (const relPath of siblingPaths) {
    const sibResult = await doFetchSiblingContent(owner, repo, branch, relPath, telemetry)
    if (sibResult !== null && !('removed' in sibResult)) {
      const sibContent = sibResult.content
      const isExtendedSibling = extendedPathSet.has(relPath)
      // SMI-6033 Wave 2 (Gap 8) fix: extended siblings are real source files,
      // not markdown — see scanSkillContent's own header for why the
      // markdown-only indented-code-block heuristic must be disabled for
      // them (it otherwise silently downgrades severity on nearly all
      // indented Python/Ruby/etc. control-flow bodies). The original 7
      // fixed siblings keep the default (markdown=true) unchanged.
      const sibScan = await doScanSkillContent(sibContent, isHighTrustAuthor, !isExtendedSibling)
      siblingScans.push({ relPath, scan: sibScan, isExtended: isExtendedSibling })
    } else if (sibResult === null) {
      // Transient: network error, 429, or oversized — same fail-open behavior as before.
      siblingFailures.push({ relPath, kind: 'transient' })
    } else {
      // 404: file confirmed absent from repo — same skip behavior as before.
      siblingFailures.push({ relPath, kind: 'removed' })
    }
  }
  // SMI-6033 Wave 1 (Gap 7): typosquat findings for this skill's candidate
  // name, in warn mode (SMI-595 default) — merged the SAME way sibling
  // findings are (mergeSiblingScans's allFindings + calculateRiskScore).
  // core's SecurityFinding.type union is a strict superset of this file's
  // local (edge-twin) union, and core's finding carries a `category` field
  // this file's SecurityFinding doesn't declare — mapped explicitly into the
  // local shape (category folded into the message) rather than passed
  // through, so this stays a real structural match, not an unsafe cast.
  const typosquatFindings: SecurityFinding[] =
    typosquat && typosquat.referenceNames.size > 0
      ? detectTyposquat(
          typosquat.candidateName,
          typosquat.referenceNames,
          resolveTyposquatEnforcementMode('warn')
        ).map(
          (f): SecurityFinding => ({
            type: 'typosquat',
            severity: f.severity,
            confidence: f.confidence,
            message: f.category ? `[${f.category}] ${f.message}` : f.message,
            location: f.location,
          })
        )
      : []

  const mergedSecurityScan =
    siblingScans.length > 0 || typosquatFindings.length > 0
      ? mergeSiblingScans(securityScan, siblingScans, typosquatFindings)
      : undefined

  if (mergedSecurityScan?.quarantine && !securityScan.findings.length) {
    console.log(
      `[SecurityScan] ${owner}/${repo}: sibling triggered quarantine (${mergedSecurityScan.primarySiblingPath})`
    )
  }

  // SMI-6033 Wave 2 (Gap 8): a clean 404 ('removed') is NOT incomplete
  // coverage — a confirmed-absent file is complete coverage of a smaller
  // surface. Only 'transient' failures mean we do not know what was in it.
  const scanCoverage = computeScanCoverage({
    droppedForCount: extended.droppedForCount,
    droppedForSize: extended.droppedForSize,
    hasTransientSiblingFailure: siblingFailures.some((f) => f.kind === 'transient'),
    treeFetchFailed: treeResult.fetchFailed,
    treeTruncated: treeResult.truncated,
    treeBudgetExhausted: treeResult.budgetExhausted,
  })

  return { securityScan, siblingScans, mergedSecurityScan, siblingFailures, scanCoverage }
}

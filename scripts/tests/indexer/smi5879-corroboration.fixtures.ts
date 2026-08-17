/**
 * Shared loader/materialiser/digest/edge-projection helpers for the G-5
 * fixture-corpus corroboration check (SMI-5879 Wave 1).
 * @module scripts/tests/indexer/smi5879-corroboration.fixtures
 *
 * Algorithm + wiring narrative:
 * `docs/internal/implementation/smi-5879-g5-corroboration-spec.md`. Typed
 * contract: `scripts/indexer/smi5879-corroboration.types.ts`.
 *
 * Used by BOTH `scripts/indexer/smi5879-corroboration-generate.ts` (the
 * golden generator) and `scripts/tests/indexer/smi5879-corroboration.edge.test.ts`
 * (the comparison test) — the two must agree on materialisation, hashing,
 * and the edge reconstruction formula, so a single shared implementation is
 * load-bearing, not a convenience. The CORE comparison test
 * (`packages/core/tests/security/smi5879-corroboration.core.test.ts`)
 * deliberately does NOT import this file — `packages/core` never imports
 * from `scripts/` (see this repo's `smi5879-corroboration.types.ts` header)
 * — and instead duplicates the ~5-line materialiser/hasher inline, per the
 * spec doc's explicit "Files" section rationale.
 *
 * PRE-PORT VACUOUSNESS WARNING: everything in this module exists to support
 * a version-regression check (pre-port scanner vs post-port scanner). Until
 * PR #2192 merges, "post-port" IS "pre-port" on this branch, so any
 * comparison built from these helpers is comparing the scanner to itself.
 * That is expected — see the two test files' own module docs for the full
 * explanation — but a reader of just this file should not mistake a green
 * run for evidence the port was checked.
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  BundleCase,
  CaseContent,
  ContentCase,
  CorpusManifest,
  EdgeNonAiKey,
  GoldenSnapshot,
} from '../../indexer/smi5879-corroboration.types.ts'
import { EDGE_NON_AI_BREAKDOWN_KEYS } from '../../indexer/smi5879-corroboration.types.ts'
import {
  CATEGORY_COEFFICIENTS,
  CATEGORY_WEIGHTS,
  CONFIDENCE_WEIGHTS,
  SEVERITY_WEIGHTS,
  type SecurityFinding,
  type SecurityFindingType,
} from '../../indexer/_shared/security-scanner-edge.context.ts'
import {
  scanSkillBundle,
  type FetchSiblingResult,
  type ScanSkillBundleResult,
} from '../../indexer/skill-processor.security.ts'
import { newRateLimitTelemetry } from '../../indexer/_shared/rate-limit.ts'
// SMI-6033 Wave 2 (Gap 8): keeps the extended (Trees API) scan surface out of
// this test — see the fixture's own comment.
import { emptyRepoTree } from './scan-skill-bundle.fixtures.ts'

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const HERE = import.meta.dirname
export const MANIFEST_PATH = join(HERE, 'smi5879-corroboration-corpus.json')
export const CORE_GOLDEN_PATH = join(HERE, 'smi5879-corroboration-golden.core.json')
export const EDGE_GOLDEN_PATH = join(HERE, 'smi5879-corroboration-golden.edge.json')
/** Repo root, for resolving the origin-drift check's upstream fixture files (edge test only). */
export const REPO_ROOT = join(HERE, '..', '..', '..')

// ---------------------------------------------------------------------------
// Materialisation, hashing, IO
// ---------------------------------------------------------------------------

/**
 * Deliberately trivial (spec doc §1's framing) so duplicating it on the core
 * side carries no divergence risk — any divergence that DID occur is caught
 * immediately by {@link ContentCase.contentSha256}.
 */
export function materializeContent(content: CaseContent): string {
  if (content.kind === 'literal') return content.text
  return content.segments.map((s) => s.text.repeat(s.repeat)).join('')
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export function readManifestFileBytes(): Buffer {
  return readFileSync(MANIFEST_PATH)
}

/** SHA-256 of the manifest FILE BYTES as committed — never of re-serialised JSON. */
export function computeManifestDigest(): string {
  return createHash('sha256').update(readManifestFileBytes()).digest('hex')
}

export function loadManifest(): CorpusManifest {
  return JSON.parse(readManifestFileBytes().toString('utf8')) as CorpusManifest
}

export function loadGolden<K extends string>(twin: 'core' | 'edge'): GoldenSnapshot<K> {
  const path = twin === 'core' ? CORE_GOLDEN_PATH : EDGE_GOLDEN_PATH
  return JSON.parse(readFileSync(path, 'utf8')) as GoldenSnapshot<K>
}

export interface ContentMismatch {
  caseId: string
  reason: string
}

/**
 * Re-materialises `c.content` and checks it against `c.contentSha256` /
 * `c.contentLength`. Returns `null` on a match, a {@link ContentMismatch}
 * otherwise — never throws, so callers (generator precondition, comparison
 * test step 2) can collect every offender before reporting.
 */
export function verifyCaseContentHash(c: ContentCase): ContentMismatch | null {
  const text = materializeContent(c.content)
  if (text.length !== c.contentLength) {
    return {
      caseId: c.caseId,
      reason: `contentLength mismatch: manifest says ${c.contentLength}, materialised text is ${text.length}`,
    }
  }
  const hash = sha256Hex(text)
  if (hash !== c.contentSha256) {
    return {
      caseId: c.caseId,
      reason: `contentSha256 mismatch: manifest says ${c.contentSha256}, materialised hash is ${hash}`,
    }
  }
  return null
}

/** Sort comparator matching the manifest/golden's canonical row order (spec doc §3). */
export const byCaseId = <T extends { caseId: string }>(a: T, b: T): number =>
  a.caseId.localeCompare(b.caseId, 'en')

// ---------------------------------------------------------------------------
// Edge projection — reconstructed from findings (spec doc §2)
// ---------------------------------------------------------------------------

/**
 * All nine `SecurityFindingType`s — the full accumulation, before the non-AI
 * projection. SMI-6033 Wave 1 added `sensitive_path` and `typosquat` to edge's
 * type union (previously seven); both are listed here so `reconstructEdgeBreakdown`
 * doesn't silently drop their contribution to `reconstructedTotal` into `NaN`
 * for any case whose content now trips the newly-wired sensitive_path detector
 * (see `security-scanner-edge.paths.ts`) — `typosquat` has no edge call site
 * yet (type-system registration only) so it stays structurally zero here, same
 * as core's own `STRUCTURALLY_ZERO_CORE_KEYS` treatment of the same category.
 */
const ALL_EDGE_FINDING_TYPES: readonly SecurityFindingType[] = [
  'jailbreak',
  'suspicious_pattern',
  'data_exfiltration',
  'privilege_escalation',
  'prompt_injection',
  'code_execution',
  'obfuscated_directive',
  'sensitive_path',
  'typosquat',
]

export interface EdgeReconstruction {
  /** All 9 categories, capped at 100 each — NOT what gets projected into the golden row. */
  fullBreakdown: Record<SecurityFindingType, number>
  /** The 5 non-AI keys picked out of {@link fullBreakdown} — what DOES get projected. */
  nonAiProjection: Record<EdgeNonAiKey, number>
  /** `min(100, round(sum(fullBreakdown[cat] * CATEGORY_COEFFICIENTS[cat])))` — must equal `EdgeScanResult.riskScore`. */
  reconstructedTotal: number
}

/**
 * Reconstructs the edge scanner's internal per-category breakdown from its
 * findings, using the scanner's OWN weight tables (imported, never re-typed
 * as literals — spec doc §2). This is the same accumulation
 * `calculateRiskScore` in `security-scanner-edge.context.ts` performs
 * internally and then discards; the corroboration tests keep the live
 * cross-check (`reconstructedTotal === EdgeScanResult.riskScore`) as a
 * permanent assertion, not a one-off sanity check.
 */
export function reconstructEdgeBreakdown(findings: readonly SecurityFinding[]): EdgeReconstruction {
  const fullBreakdown = Object.fromEntries(ALL_EDGE_FINDING_TYPES.map((t) => [t, 0])) as Record<
    SecurityFindingType,
    number
  >
  for (const finding of findings) {
    const severityWeight = SEVERITY_WEIGHTS[finding.severity]
    const categoryWeight = CATEGORY_WEIGHTS[finding.type] ?? 1.0
    const confidenceWeight = CONFIDENCE_WEIGHTS[finding.confidence ?? 'high']
    fullBreakdown[finding.type] += severityWeight * categoryWeight * confidenceWeight
  }
  for (const type of ALL_EDGE_FINDING_TYPES) {
    fullBreakdown[type] = Math.min(100, fullBreakdown[type])
  }
  let total = 0
  for (const type of ALL_EDGE_FINDING_TYPES) {
    total += fullBreakdown[type] * CATEGORY_COEFFICIENTS[type]
  }
  const reconstructedTotal = Math.min(100, Math.round(total))
  const nonAiProjection = Object.fromEntries(
    EDGE_NON_AI_BREAKDOWN_KEYS.map((k) => [k, fullBreakdown[k as SecurityFindingType]])
  ) as Record<EdgeNonAiKey, number>
  return { fullBreakdown, nonAiProjection, reconstructedTotal }
}

// ---------------------------------------------------------------------------
// Bundle-case scanning (edge only — spec doc §2's bundle paragraph)
// ---------------------------------------------------------------------------

export interface BundleScanOutcome {
  /** `mergedSecurityScan.findings` when merged is defined, else `securityScan.findings`. */
  findings: SecurityFinding[]
  merged: boolean
  /** Sorted relPaths of siblings that were successfully fetched and scanned. */
  siblingRelPaths: string[]
  /** Sorted `relPath:kind` pairs from `siblingFailures`. */
  siblingFailures: string[]
  /**
   * `mergedSecurityScan.riskScore` when merged, else `securityScan.riskScore`
   * — both are `calculateRiskScore(<the same finding set as {@link findings}>)`,
   * so this is the exact real-scorer total the reconstruction cross-check
   * (spec doc §2) must reproduce for bundle rows too, same as content rows.
   */
  riskScoreForCrossCheck: number
}

/**
 * Runs {@link scanSkillBundle} for one manifest `BundleCase`, stubbing
 * `deps.fetchSiblingContent` (never `global.fetch`, per spec doc §7's SB-3
 * note) from the bundle case's own `siblings` + the resolved primary/sibling
 * content cases. `contentByCaseId` must contain every `ContentCase.caseId`
 * the bundle case references (`primaryRef` and every `contentRef`).
 */
export async function scanBundleCase(
  bundleCase: BundleCase,
  contentByCaseId: ReadonlyMap<string, string>
): Promise<BundleScanOutcome> {
  const primaryContent = contentByCaseId.get(bundleCase.primaryRef)
  if (primaryContent === undefined) {
    throw new Error(
      `bundle case ${bundleCase.caseId}: unresolved primaryRef "${bundleCase.primaryRef}"`
    )
  }

  const bySiblingRelPath = new Map<string, { transient: true } | { text: string }>()
  for (const sibling of bundleCase.siblings) {
    if ('outcome' in sibling) {
      bySiblingRelPath.set(sibling.relPath, { transient: true })
      continue
    }
    const text = contentByCaseId.get(sibling.contentRef)
    if (text === undefined) {
      throw new Error(
        `bundle case ${bundleCase.caseId}: unresolved sibling contentRef "${sibling.contentRef}"`
      )
    }
    bySiblingRelPath.set(sibling.relPath, { text })
  }

  async function fetchStub(
    _owner: string,
    _repo: string,
    _branch: string,
    relPath: string
  ): Promise<FetchSiblingResult> {
    const entry = bySiblingRelPath.get(relPath)
    if (!entry) return { removed: true } // defaultSiblingOutcome, always 'removed' (404)
    if ('transient' in entry) return null // FetchSiblingResult's transient-failure encoding
    return { content: entry.text }
  }

  const result: ScanSkillBundleResult = await scanSkillBundle(
    'smi5879-corroboration',
    'fixture-corpus',
    'main',
    undefined,
    primaryContent,
    newRateLimitTelemetry(),
    { fetchSiblingContent: fetchStub, fetchRepoTreeEntries: emptyRepoTree }
  )

  const merged = result.mergedSecurityScan !== undefined
  const findings = merged
    ? (result.mergedSecurityScan?.findings ?? [])
    : result.securityScan.findings
  const riskScoreForCrossCheck = merged
    ? (result.mergedSecurityScan?.riskScore ?? result.securityScan.riskScore)
    : result.securityScan.riskScore
  const siblingRelPaths = result.siblingScans.map((s) => s.relPath).sort()
  const siblingFailures = result.siblingFailures.map((f) => `${f.relPath}:${f.kind}`).sort()
  return { findings, merged, siblingRelPaths, siblingFailures, riskScoreForCrossCheck }
}

// ---------------------------------------------------------------------------
// JSON Pointer resolution (origin drift, edge test only — spec doc §5's
// assertion 4)
// ---------------------------------------------------------------------------

/** Minimal RFC 6901 JSON Pointer resolver — sufficient for this manifest's flat `/categories/.../N` pointers. */
export function resolveJsonPointer(doc: unknown, pointer: string): unknown {
  if (pointer === '') return doc
  const parts = pointer
    .replace(/^\//, '')
    .split('/')
    .map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'))
  let cur: unknown = doc
  for (const part of parts) {
    if (Array.isArray(cur)) {
      cur = cur[Number(part)]
    } else if (cur !== null && typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[part]
    } else {
      return undefined
    }
  }
  return cur
}

/** Reads and parses a repo-relative JSON fixture file (e.g. `origin.file` on a `json-pointer` case). */
export function loadRepoJsonFile(repoRelativePath: string): unknown {
  return JSON.parse(readFileSync(join(REPO_ROOT, repoRelativePath), 'utf8'))
}

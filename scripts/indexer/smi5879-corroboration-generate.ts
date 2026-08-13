/**
 * G-5 fixture-corpus corroboration — golden-snapshot GENERATOR (SMI-5879
 * Wave 1). A script, invoked explicitly by a human — never run by CI, never
 * imported by a test. Produces
 * `scripts/tests/indexer/smi5879-corroboration-golden.{core,edge}.json` by
 * running the manifest's corpus through the PRE-PORT scanners.
 * @module scripts/indexer/smi5879-corroboration-generate
 *
 * Algorithm + wiring narrative:
 * `docs/internal/implementation/smi-5879-g5-corroboration-spec.md` §3/§4.
 * Typed contract: `scripts/indexer/smi5879-corroboration.types.ts`.
 *
 * PRE-PORT VACUOUSNESS WARNING: this generator only ever produces a
 * meaningful golden when run at {@link PRE_PORT_BASELINE_SHA} — its own
 * preconditions enforce that. Running it AFTER PR #2192 merges would silently
 * bake post-port values into a file whose whole purpose is to be the PRE-port
 * reference; that is exactly the failure mode the HEAD-pin precondition below
 * exists to prevent. If {@link PRE_PORT_BASELINE_SHA} is no longer reachable
 * as a clean HEAD (the shortcut described in the module doc below has
 * expired), do NOT edit this precondition to relax it — cut an isolated
 * worktree at the pinned SHA instead (spec doc §4's runbook) and run this
 * script there.
 *
 * USAGE: `npx tsx scripts/indexer/smi5879-corroboration-generate.ts`
 * (from the repo root, inside the dev container — this imports the real
 * core + edge scanners, which is a `packages/core`/`scripts/indexer` runtime
 * dependency, not just a type-only one).
 *
 * PRECONDITIONS (spec doc §4 — refuses to write, never partially writes, if
 * any of these fail):
 *   1. `git rev-parse HEAD === PRE_PORT_BASELINE_SHA`. Reused from
 *      `smi5879-gate-check.closure.ts`'s `gitRevParseHead`.
 *   2. The tree is clean on {@link GENERATOR_SCANNER_SOURCE_PATHS} — the
 *      files that actually determine scan output. Deliberately narrower than
 *      `checkGitTreeClean`'s DEFAULT (`CLOSURE_WATCHED_SOURCE_PATHS`): this
 *      generator's own job is to add new files (this script, the golden
 *      outputs, the manifest, the corroboration test files) that are
 *      legitimately untracked at generation time — an unscoped
 *      `git status --porcelain` would report "dirty" unconditionally and the
 *      precondition could never pass. What DOES need to be clean is exactly
 *      the scanner SOURCE code whose behaviour this golden is meant to
 *      capture; that is a strict subset of `CLOSURE_WATCHED_SOURCE_PATHS` /
 *      `ADDITIONAL_CLOSURE_WATCHED_SOURCE_PATHS`, reusing `checkGitTreeClean`
 *      itself (imported, not reimplemented) with a scoped path list.
 *   3. Every manifest case's materialised content matches its pinned
 *      `contentSha256`/`contentLength` (`verifyCaseContentHash`).
 *   4. Determinism: every case is scanned {@link DETERMINISM_REPEATS} times
 *      on FRESH `SecurityScanner` instances (core) and re-checked once more
 *      against a REUSED instance built while assembling the golden, and
 *      (edge/bundle) is re-scanned {@link DETERMINISM_REPEATS} times with the
 *      projected result compared, not raw findings (spec doc §3: finding
 *      order/text/timestamps are excluded from the projection on purpose).
 */

import { writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { checkGitTreeClean, gitRevParseHead } from './smi5879-gate-check.closure.ts'
import {
  CORE_NON_AI_BREAKDOWN_KEYS,
  EDGE_NON_AI_BREAKDOWN_KEYS,
  PRE_PORT_BASELINE_SHA,
  type BundleCase,
  type ContentCase,
  type CoreGoldenSnapshot,
  type CoreNonAiKey,
  type EdgeGoldenSnapshot,
  type EdgeNonAiKey,
  type GoldenProvenance,
  type GoldenRow,
} from './smi5879-corroboration.types.ts'
import {
  byCaseId,
  computeManifestDigest,
  CORE_GOLDEN_PATH,
  EDGE_GOLDEN_PATH,
  loadManifest,
  materializeContent,
  reconstructEdgeBreakdown,
  scanBundleCase,
  sha256Hex,
  verifyCaseContentHash,
} from '../tests/indexer/smi5879-corroboration.fixtures.ts'
import {
  SecurityScanner,
  type RiskScoreBreakdown,
} from '../../packages/core/src/security/scanner/index.js'
import { scanSkillContent } from './_shared/security-scanner-edge.js'

const DETERMINISM_REPEATS = 5
const GENERATOR = 'scripts/indexer/smi5879-corroboration-generate.ts'

/**
 * The scanner SOURCE files that determine scan output — see the module doc's
 * precondition #2 for why this is narrower than `CLOSURE_WATCHED_SOURCE_PATHS`.
 */
const GENERATOR_SCANNER_SOURCE_PATHS = [
  // Core
  'packages/core/src/security/scanner/SecurityScanner.ts',
  'packages/core/src/security/scanner/SecurityScanner.helpers.ts',
  'packages/core/src/security/scanner/SecurityScanner.risk-score.ts',
  'packages/core/src/security/scanner/SecurityScanner.scanners.ts',
  'packages/core/src/security/scanner/SecurityScanner.exec.ts',
  'packages/core/src/security/scanner/SecurityScanner.ssrf.ts',
  'packages/core/src/security/scanner/SecurityScanner.pii.ts',
  'packages/core/src/security/scanner/SecurityScanner.evidence.ts',
  'packages/core/src/security/scanner/regex-utils.ts',
  'packages/core/src/security/scanner/types.ts',
  'packages/core/src/security/scanner/weights.ts',
  'packages/core/src/security/scanner/index.ts',
  'packages/core/src/security/scanner/patterns.ts',
  'packages/core/src/security/scanner/patterns.jailbreak.ts',
  'packages/core/src/security/scanner/patterns.jailbreak.evidence.ts',
  'packages/core/src/security/scanner/patterns.scope.ts',
  // Edge (Node mirror)
  'scripts/indexer/_shared/security-scanner-edge.ts',
  'scripts/indexer/_shared/security-scanner-edge.context.ts',
  'scripts/indexer/_shared/security-scanner-edge.exec.ts',
  'scripts/indexer/_shared/security-scanner-edge.patterns.ts',
  'scripts/indexer/_shared/security-scanner-edge.evidence.ts',
  'scripts/indexer/_shared/security-scanner-edge.chmod-compound.ts',
  // Edge bundle path (needed for the 5 SB cases)
  'scripts/indexer/skill-processor.security.ts',
  'scripts/indexer/_shared/rate-limit.ts',
] as const

class GeneratorPreconditionError extends Error {}

function fail(message: string): never {
  throw new GeneratorPreconditionError(message)
}

function assertPreconditions(): void {
  const head = gitRevParseHead()
  if (head !== PRE_PORT_BASELINE_SHA) {
    fail(
      `git rev-parse HEAD="${head ?? '(unresolvable)'}" does not equal PRE_PORT_BASELINE_SHA=` +
        `"${PRE_PORT_BASELINE_SHA}". This generator refuses to run anywhere except a clean ` +
        "checkout of the pinned pre-port baseline — see this module's header for the " +
        'isolated-worktree runbook if that SHA is no longer reachable as HEAD.'
    )
  }
  const treeCheck = checkGitTreeClean(GENERATOR_SCANNER_SOURCE_PATHS)
  if (!treeCheck.clean) {
    fail(
      'the scanner source tree is not clean (git status --porcelain on ' +
        `GENERATOR_SCANNER_SOURCE_PATHS): ${treeCheck.error ?? 'uncommitted changes present'}. ` +
        'A dirty scanner source means the code actually executed is not fully identified by HEAD.'
    )
  }
}

function assertContentHashesMatch(cases: readonly ContentCase[]): void {
  const mismatches = cases.map(verifyCaseContentHash).filter((m) => m !== null)
  if (mismatches.length > 0) {
    fail(
      `${mismatches.length} manifest case(s) failed content-hash verification:\n` +
        mismatches.map((m) => `  - ${m.caseId}: ${m.reason}`).join('\n')
    )
  }
}

/** Deep-equality via canonical JSON — every value here is plain numbers/strings/booleans/arrays. */
function assertIdenticalProjections(label: string, projections: readonly unknown[]): void {
  const [first, ...rest] = projections
  const firstJson = JSON.stringify(first)
  rest.forEach((p, i) => {
    if (JSON.stringify(p) !== firstJson) {
      fail(
        `non-determinism detected for ${label}: repeat 0 and repeat ${i + 1} produced different ` +
          `projections.\n  repeat 0: ${firstJson}\n  repeat ${i + 1}: ${JSON.stringify(p)}`
      )
    }
  })
}

function projectCore(breakdown: RiskScoreBreakdown): Record<CoreNonAiKey, number> {
  return Object.fromEntries(CORE_NON_AI_BREAKDOWN_KEYS.map((k) => [k, breakdown[k]])) as Record<
    CoreNonAiKey,
    number
  >
}

/**
 * Scans one core content case {@link DETERMINISM_REPEATS} times on FRESH
 * `SecurityScanner` instances, asserts identical projections, then re-scans
 * once more on `sharedScanner` (a REUSED instance) and asserts that matches
 * too — satisfying spec doc §4's "fresh as well as reused" requirement in a
 * single pass rather than two separate sweeps.
 */
function generateCoreRow(c: ContentCase, sharedScanner: SecurityScanner): GoldenRow<CoreNonAiKey> {
  const text = materializeContent(c.content)
  const freshProjections = Array.from({ length: DETERMINISM_REPEATS }, () =>
    projectCore(new SecurityScanner().scan(c.skillId, text).riskBreakdown)
  )
  assertIdenticalProjections(`core/${c.caseId}`, freshProjections)
  const reusedProjection = projectCore(sharedScanner.scan(c.skillId, text).riskBreakdown)
  assertIdenticalProjections(`core/${c.caseId} (reused-instance cross-check)`, [
    freshProjections[0],
    reusedProjection,
  ])
  return { caseId: c.caseId, contentSha256: c.contentSha256, breakdown: reusedProjection }
}

async function generateEdgeContentRow(c: ContentCase): Promise<GoldenRow<EdgeNonAiKey>> {
  const text = materializeContent(c.content)
  const results = []
  for (let i = 0; i < DETERMINISM_REPEATS; i++) {
    const result = await scanSkillContent(text)
    const reconstruction = reconstructEdgeBreakdown(result.findings)
    if (reconstruction.reconstructedTotal !== result.riskScore) {
      fail(
        `edge/${c.caseId} repeat ${i}: reconstructed total ${reconstruction.reconstructedTotal} ` +
          `!== EdgeScanResult.riskScore ${result.riskScore} — the reconstruction formula has ` +
          'drifted from calculateRiskScore'
      )
    }
    results.push(reconstruction.nonAiProjection)
  }
  assertIdenticalProjections(`edge/${c.caseId}`, results)
  return { caseId: c.caseId, contentSha256: c.contentSha256, breakdown: results[0] }
}

async function generateEdgeBundleRow(
  b: BundleCase,
  contentByCaseId: ReadonlyMap<string, string>
): Promise<GoldenRow<EdgeNonAiKey>> {
  const rows = []
  for (let i = 0; i < DETERMINISM_REPEATS; i++) {
    const outcome = await scanBundleCase(b, contentByCaseId)
    const reconstruction = reconstructEdgeBreakdown(outcome.findings)
    if (reconstruction.reconstructedTotal !== outcome.riskScoreForCrossCheck) {
      fail(
        `bundle/${b.caseId} repeat ${i}: reconstructed total ${reconstruction.reconstructedTotal} ` +
          `!== the real merged/primary riskScore ${outcome.riskScoreForCrossCheck}`
      )
    }
    rows.push({
      breakdown: reconstruction.nonAiProjection,
      merged: outcome.merged,
      siblingRelPaths: outcome.siblingRelPaths,
      siblingFailures: outcome.siblingFailures,
    })
  }
  assertIdenticalProjections(`bundle/${b.caseId}`, rows)
  const primaryContentSha256 = sha256Hex(contentByCaseId.get(b.primaryRef) ?? '')
  const final = rows[0]
  return {
    caseId: b.caseId,
    contentSha256: primaryContentSha256,
    breakdown: final.breakdown,
    bundle: {
      merged: final.merged,
      siblingRelPaths: final.siblingRelPaths,
      siblingFailures: final.siblingFailures,
    },
  }
}

function buildProvenance(
  manifestVersion: number,
  projectionSchemaVersion: number
): GoldenProvenance {
  return {
    sourceCommit: PRE_PORT_BASELINE_SHA,
    manifestDigest: computeManifestDigest(),
    manifestVersion,
    projectionSchemaVersion,
    nodeVersion: process.version,
    generator: GENERATOR,
    generatedAt: new Date().toISOString(),
    determinismRepeats: DETERMINISM_REPEATS,
  }
}

function writeGoldenAndFormat(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf8')
  // Hash the PRETTIER-formatted bytes, not the raw generator output (spec
  // doc §3) — format immediately, before anything downstream reads this file.
  execFileSync('npx', ['prettier', '--write', path], { stdio: 'inherit' })
}

async function main(): Promise<void> {
  assertPreconditions()

  const manifest = loadManifest()
  const allCases = [...manifest.contentCases]
  assertContentHashesMatch(allCases)

  const contentByCaseId = new Map(allCases.map((c) => [c.caseId, materializeContent(c.content)]))

  const sharedScanner = new SecurityScanner()
  const coreRows = allCases
    .filter((c) => c.twins.includes('core'))
    .map((c) => generateCoreRow(c, sharedScanner))
    .sort(byCaseId)

  const edgeContentRows: GoldenRow<EdgeNonAiKey>[] = []
  for (const c of allCases.filter((c) => c.twins.includes('edge'))) {
    edgeContentRows.push(await generateEdgeContentRow(c))
  }
  const edgeBundleRows: GoldenRow<EdgeNonAiKey>[] = []
  for (const b of manifest.bundleCases) {
    edgeBundleRows.push(await generateEdgeBundleRow(b, contentByCaseId))
  }
  const edgeRows = [...edgeContentRows, ...edgeBundleRows].sort(byCaseId)

  const coreGolden: CoreGoldenSnapshot = {
    twin: 'core',
    provenance: buildProvenance(manifest.manifestVersion, manifest.projectionSchemaVersion),
    projectedKeys: CORE_NON_AI_BREAKDOWN_KEYS,
    rows: coreRows,
  }
  const edgeGolden: EdgeGoldenSnapshot = {
    twin: 'edge',
    provenance: buildProvenance(manifest.manifestVersion, manifest.projectionSchemaVersion),
    projectedKeys: EDGE_NON_AI_BREAKDOWN_KEYS,
    rows: edgeRows,
  }

  writeGoldenAndFormat(CORE_GOLDEN_PATH, coreGolden)
  writeGoldenAndFormat(EDGE_GOLDEN_PATH, edgeGolden)

  console.log(
    `Generated ${coreRows.length} core row(s) and ${edgeRows.length} edge row(s) ` +
      `(${edgeContentRows.length} content + ${edgeBundleRows.length} bundle) at sourceCommit=` +
      `${PRE_PORT_BASELINE_SHA}.`
  )
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
}

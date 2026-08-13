/**
 * SMI-5879 G-5 fixture-corpus corroboration — EDGE twin.
 * @module scripts/tests/indexer/smi5879-corroboration.edge
 *
 * Version-regression check: pre-port edge scanner (the committed golden,
 * generated at `PRE_PORT_BASELINE_SHA` — see
 * `docs/internal/implementation/smi-5879-g5-corroboration-spec.md` §0/§4) vs
 * THIS branch's HEAD edge scanner (`scanSkillContent` / `scanSkillBundle`,
 * Node mirror only — the deployed Deno twin is covered transitively by
 * `parity.test.ts`'s whole-file byte-identity assertion, spec doc §2's "The
 * Deno copy" note), over the shared fixture corpus, asserting every non-AI
 * category subtotal is unchanged. Edge has no `RiskScoreBreakdown` to read
 * directly — `calculateRiskScore` returns a bare number and discards its
 * internal per-category map — so the projection here is RECONSTRUCTED from
 * `findings` using the scanner's own weight tables
 * (`reconstructEdgeBreakdown`, `smi5879-corroboration.fixtures.ts`), with a
 * permanent live cross-check that the reconstruction reproduces the real
 * `riskScore` exactly.
 *
 * PRE-PORT VACUOUSNESS WARNING: PR #2192 (the evidence-tier port to this
 * twin) has not merged as of this file's authorship. Until it does, "current
 * HEAD" and "pre-port baseline" are the SAME scanner, so a green run here is
 * NOT yet evidence the port preserved non-AI scoring — it is the scanner
 * compared to itself. This check starts being meaningful the moment #2192
 * lands; do not read a pre-merge green as validation of anything.
 */

import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CORROBORATION_COLLECTION,
  EDGE_NON_AI_BREAKDOWN_KEYS,
  PRE_PORT_BASELINE_SHA,
  type EdgeNonAiKey,
} from '../../indexer/smi5879-corroboration.types.ts'
import {
  byCaseId,
  computeManifestDigest,
  loadGolden,
  loadManifest,
  loadRepoJsonFile,
  materializeContent,
  reconstructEdgeBreakdown,
  REPO_ROOT,
  resolveJsonPointer,
  scanBundleCase,
  sha256Hex,
  verifyCaseContentHash,
} from './smi5879-corroboration.fixtures.ts'
import { scanSkillContent } from '../../indexer/_shared/security-scanner-edge.ts'
import { CLOSURE_WATCHED_SOURCE_PATHS } from '../../indexer/smi5879-gate-check.closure.ts'
import { traceLocalImportGraph } from './smi5879-corroboration.import-graph.ts'

const manifest = loadManifest()
const golden = loadGolden<EdgeNonAiKey>('edge')
const manifestDigest = computeManifestDigest()

const edgeContentCases = manifest.contentCases.filter((c) => c.twins.includes('edge'))
const contentByCaseId = new Map(
  manifest.contentCases.map((c) => [c.caseId, materializeContent(c.content)])
)
const goldenByCaseId = new Map(golden.rows.map((r) => [r.caseId, r]))

describe('SMI-5879 G-5 fixture-corpus corroboration (edge)', () => {
  it('golden provenance binds to the pinned pre-port SHA and the committed manifest digest', () => {
    expect(golden.provenance.sourceCommit).toBe(PRE_PORT_BASELINE_SHA)
    expect(golden.provenance.manifestDigest).toBe(manifestDigest)
    expect(golden.provenance.manifestVersion).toBe(manifest.manifestVersion)
    expect(golden.provenance.projectionSchemaVersion).toBe(manifest.projectionSchemaVersion)
    expect(golden.twin).toBe('edge')
    expect([...golden.projectedKeys].sort()).toEqual([...EDGE_NON_AI_BREAKDOWN_KEYS].sort())
  })

  it('every non-AI category subtotal is unchanged from the pre-port golden, for every corpus case', async () => {
    interface Offense {
      caseId: string
      key: string
      golden: number | boolean | string[]
      actual: number | boolean | string[]
    }
    const offenses: Offense[] = []
    const contentMismatches: string[] = []
    const crossCheckFailures: string[] = []

    for (const c of edgeContentCases) {
      const mismatch = verifyCaseContentHash(c)
      if (mismatch) {
        contentMismatches.push(`${mismatch.caseId}: ${mismatch.reason}`)
        continue
      }
      const goldenRow = goldenByCaseId.get(c.caseId)
      if (!goldenRow) continue // caught by the coverage test below, not here
      const text = materializeContent(c.content)
      const result = await scanSkillContent(text)
      const reconstruction = reconstructEdgeBreakdown(result.findings)
      if (reconstruction.reconstructedTotal !== result.riskScore) {
        crossCheckFailures.push(
          `${c.caseId}: reconstructed total ${reconstruction.reconstructedTotal} !== ` +
            `EdgeScanResult.riskScore ${result.riskScore}`
        )
      }
      for (const key of EDGE_NON_AI_BREAKDOWN_KEYS) {
        if (reconstruction.nonAiProjection[key] !== goldenRow.breakdown[key]) {
          offenses.push({
            caseId: c.caseId,
            key,
            golden: goldenRow.breakdown[key],
            actual: reconstruction.nonAiProjection[key],
          })
        }
      }
    }

    for (const b of manifest.bundleCases) {
      const goldenRow = goldenByCaseId.get(b.caseId)
      if (!goldenRow) continue // caught by the coverage test below, not here
      const outcome = await scanBundleCase(b, contentByCaseId)
      const reconstruction = reconstructEdgeBreakdown(outcome.findings)
      if (reconstruction.reconstructedTotal !== outcome.riskScoreForCrossCheck) {
        crossCheckFailures.push(
          `${b.caseId}: reconstructed total ${reconstruction.reconstructedTotal} !== the real ` +
            `merged/primary riskScore ${outcome.riskScoreForCrossCheck}`
        )
      }
      for (const key of EDGE_NON_AI_BREAKDOWN_KEYS) {
        if (reconstruction.nonAiProjection[key] !== goldenRow.breakdown[key]) {
          offenses.push({
            caseId: b.caseId,
            key,
            golden: goldenRow.breakdown[key],
            actual: reconstruction.nonAiProjection[key],
          })
        }
      }
      const goldenBundle = goldenRow.bundle
      if (!goldenBundle) {
        offenses.push({ caseId: b.caseId, key: '(bundle)', golden: 'present', actual: 'absent' })
      } else {
        if (goldenBundle.merged !== outcome.merged) {
          offenses.push({
            caseId: b.caseId,
            key: '(bundle.merged)',
            golden: goldenBundle.merged,
            actual: outcome.merged,
          })
        }
        if (
          JSON.stringify(goldenBundle.siblingRelPaths) !== JSON.stringify(outcome.siblingRelPaths)
        ) {
          offenses.push({
            caseId: b.caseId,
            key: '(bundle.siblingRelPaths)',
            golden: goldenBundle.siblingRelPaths,
            actual: outcome.siblingRelPaths,
          })
        }
        if (
          JSON.stringify(goldenBundle.siblingFailures) !== JSON.stringify(outcome.siblingFailures)
        ) {
          offenses.push({
            caseId: b.caseId,
            key: '(bundle.siblingFailures)',
            golden: goldenBundle.siblingFailures,
            actual: outcome.siblingFailures,
          })
        }
      }
    }

    expect(contentMismatches, contentMismatches.join('\n')).toEqual([])
    expect(crossCheckFailures, crossCheckFailures.join('\n')).toEqual([])
    expect(offenses, JSON.stringify(offenses, null, 2)).toEqual([])
  })

  it('the golden covers every manifest case targeting this twin, including bundle cases, and no others', () => {
    const manifestRows = [
      ...edgeContentCases.map((c) => ({ caseId: c.caseId })),
      ...manifest.bundleCases.map((b) => ({ caseId: b.caseId })),
    ].sort(byCaseId)
    const goldenIds = [...golden.rows].sort(byCaseId).map((r) => r.caseId)
    expect(goldenIds).toEqual(manifestRows.map((r) => r.caseId))
  })

  it('every projected key is exercised non-zero by at least one case', () => {
    const nonZeroSomewhere = new Set<EdgeNonAiKey>()
    for (const row of golden.rows) {
      for (const key of EDGE_NON_AI_BREAKDOWN_KEYS) {
        if (row.breakdown[key] !== 0) nonZeroSomewhere.add(key)
      }
    }
    for (const key of EDGE_NON_AI_BREAKDOWN_KEYS) {
      expect(nonZeroSomewhere.has(key), `${key} is never non-zero in any golden row`).toBe(true)
    }
  })

  it('origin drift: json-pointer cases still match their upstream fixture, and composed cases still re-materialise to their digest', () => {
    const offenses: string[] = []
    for (const c of manifest.contentCases) {
      if (c.origin.kind === 'json-pointer') {
        const doc = loadRepoJsonFile(c.origin.file)
        const val = resolveJsonPointer(doc, c.origin.pointer)
        const text = materializeContent(c.content)
        if (val !== text) {
          offenses.push(
            `${c.caseId}: ${c.origin.file}${c.origin.pointer} no longer equals the manifest's pinned text`
          )
        }
      } else if (c.content.kind === 'composed') {
        const text = materializeContent(c.content)
        if (sha256Hex(text) !== c.contentSha256) {
          offenses.push(
            `${c.caseId}: composed content no longer re-materialises to its recorded digest`
          )
        }
      }
    }
    expect(offenses, offenses.join('\n')).toEqual([])
  })

  it('CLOSURE_WATCHED_SOURCE_PATHS is closed under both corroboration tests import graphs', () => {
    const entryFiles = CORROBORATION_COLLECTION.map((spec) => join(REPO_ROOT, spec.file))
    const visited = traceLocalImportGraph(entryFiles)
    const watched = new Set<string>(CLOSURE_WATCHED_SOURCE_PATHS)
    const unwatched: string[] = []
    for (const absPath of visited) {
      const relPath = relative(REPO_ROOT, absPath).split(sep).join('/')
      if (!watched.has(relPath)) unwatched.push(relPath)
    }
    expect(unwatched.sort(), unwatched.join('\n')).toEqual([])
  })
})

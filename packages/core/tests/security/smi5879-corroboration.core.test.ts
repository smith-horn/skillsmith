/**
 * SMI-5879 G-5 fixture-corpus corroboration — CORE twin.
 * @module packages/core/tests/security/smi5879-corroboration.core
 *
 * Version-regression check: pre-port `SecurityScanner` (the committed golden,
 * generated at `PRE_PORT_BASELINE_SHA` — see
 * `docs/internal/implementation/smi-5879-g5-corroboration-spec.md` §0/§4) vs
 * THIS branch's HEAD `SecurityScanner`, over the shared fixture corpus,
 * asserting every non-AI `RiskScoreBreakdown` key is unchanged. It is NOT
 * `scripts/tests/indexer/parity.test.ts`'s core/Node/Deno twin-parity check —
 * see `scripts/indexer/smi5879-corroboration.types.ts`'s header for the full
 * distinction.
 *
 * PRE-PORT VACUOUSNESS WARNING: PR #2192 (the evidence-tier port to the edge
 * twin) has not merged as of this file's authorship. Until it does, "current
 * HEAD" and "pre-port baseline" are the SAME scanner, so a green run here is
 * NOT yet evidence the port preserved non-AI scoring — it is the scanner
 * compared to itself. This check starts being meaningful the moment #2192
 * lands; do not read a pre-merge green as validation of anything.
 *
 * `packages/core` never imports from `scripts/` (an established repo
 * boundary — see `smi5879-corroboration.types.ts`'s own header), so this
 * file duplicates the ~5-line content materialiser/hasher and the two small
 * key-list constants below rather than importing
 * `scripts/tests/indexer/smi5879-corroboration.fixtures.ts` /
 * `scripts/indexer/smi5879-corroboration.types.ts` across that boundary.
 * `contentSha256` re-verification (assertion 2 below) makes any divergence
 * between the two copies a loud test failure, never a silent one.
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
// Imported from the SCANNER submodule directly, NOT the `../../src/security/
// index.js` barrel other core security tests use — that barrel also
// re-exports typosquat/confusables/AuditLogger/rate-limiter/SkillSandbox
// (unrelated to RiskScoreBreakdown scoring; `SecurityScanner.scan()` never
// calls typosquat.ts, per this repo's `smi5879-corroboration.types.ts`
// header). The edge test's watch-list-closure assertion traces this file's
// OWN transitive import graph, so importing the wide barrel here would drag
// dozens of unrelated files into that closure for no behavioural reason.
import { SecurityScanner } from '../../src/security/scanner/SecurityScanner.js'
import type { RiskScoreBreakdown } from '../../src/security/scanner/types.js'

// ---------------------------------------------------------------------------
// Duplicated from scripts/indexer/smi5879-corroboration.types.ts — keep in
// sync; see this file's header for why it cannot be imported directly.
// ---------------------------------------------------------------------------

const PRE_PORT_BASELINE_SHA = 'a694a9f242197277fa69210e0241f84b883552e6'

const CORE_NON_AI_BREAKDOWN_KEYS = [
  'codeExecution',
  'dataExfiltration',
  'externalUrls',
  'obfuscatedDirective',
  'pii',
  'privilegeEscalation',
  'promptLeaking',
  'sensitivePaths',
  'socialEngineering',
  'ssrf',
  'suspiciousCode',
  'typosquat',
] as const
type CoreNonAiKey = (typeof CORE_NON_AI_BREAKDOWN_KEYS)[number]

const STRUCTURALLY_ZERO_CORE_KEYS = ['typosquat'] as const

// ---------------------------------------------------------------------------
// Manifest/golden shapes (only the fields this file reads)
// ---------------------------------------------------------------------------

interface CaseContent {
  kind: 'literal' | 'composed'
  text?: string
  segments?: Array<{ text: string; repeat: number }>
}

interface ContentCase {
  caseId: string
  twins: Array<'core' | 'edge'>
  skillId: string
  content: CaseContent
  contentSha256: string
  contentLength: number
}

interface CorpusManifest {
  manifestVersion: number
  projectionSchemaVersion: number
  contentCases: ContentCase[]
}

interface GoldenRow {
  caseId: string
  contentSha256: string
  breakdown: Record<CoreNonAiKey, number>
}

interface GoldenSnapshot {
  twin: 'core' | 'edge'
  provenance: {
    sourceCommit: string
    manifestDigest: string
    manifestVersion: number
    projectionSchemaVersion: number
  }
  projectedKeys: readonly CoreNonAiKey[]
  rows: GoldenRow[]
}

// ---------------------------------------------------------------------------
// The ~5-line materialiser/hasher (deliberately duplicated — see header)
// ---------------------------------------------------------------------------

function materializeContent(content: CaseContent): string {
  if (content.kind === 'literal') return content.text ?? ''
  return (content.segments ?? []).map((s) => s.text.repeat(s.repeat)).join('')
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

// ---------------------------------------------------------------------------
// Fixtures — read by path from the repo root, not imported (see header)
// ---------------------------------------------------------------------------

const REPO_ROOT = join(import.meta.dirname, '../../../../')
const MANIFEST_PATH = join(REPO_ROOT, 'scripts/tests/indexer/smi5879-corroboration-corpus.json')
const GOLDEN_PATH = join(REPO_ROOT, 'scripts/tests/indexer/smi5879-corroboration-golden.core.json')

const manifestBytes = readFileSync(MANIFEST_PATH)
const manifest = JSON.parse(manifestBytes.toString('utf8')) as CorpusManifest
const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as GoldenSnapshot
const manifestDigest = createHash('sha256').update(manifestBytes).digest('hex')

const coreCases = manifest.contentCases.filter((c) => c.twins.includes('core'))
const goldenByCaseId = new Map(golden.rows.map((r) => [r.caseId, r]))
const scanner = new SecurityScanner()

function projectCore(breakdown: RiskScoreBreakdown): Record<CoreNonAiKey, number> {
  return Object.fromEntries(CORE_NON_AI_BREAKDOWN_KEYS.map((k) => [k, breakdown[k]])) as Record<
    CoreNonAiKey,
    number
  >
}

describe('SMI-5879 G-5 fixture-corpus corroboration (core)', () => {
  it('golden provenance binds to the pinned pre-port SHA and the committed manifest digest', () => {
    expect(golden.provenance.sourceCommit).toBe(PRE_PORT_BASELINE_SHA)
    expect(golden.provenance.manifestDigest).toBe(manifestDigest)
    expect(golden.provenance.manifestVersion).toBe(manifest.manifestVersion)
    expect(golden.provenance.projectionSchemaVersion).toBe(manifest.projectionSchemaVersion)
    expect(golden.twin).toBe('core')
    expect([...golden.projectedKeys].sort()).toEqual([...CORE_NON_AI_BREAKDOWN_KEYS].sort())
  })

  it('every non-AI RiskScoreBreakdown key is unchanged from the pre-port golden, for every corpus case', () => {
    interface Offense {
      caseId: string
      key: CoreNonAiKey
      golden: number
      actual: number
    }
    const offenses: Offense[] = []
    const contentMismatches: string[] = []

    for (const c of coreCases) {
      const text = materializeContent(c.content)
      const actualHash = sha256Hex(text)
      if (actualHash !== c.contentSha256) {
        contentMismatches.push(
          `${c.caseId}: manifest contentSha256=${c.contentSha256}, materialised=${actualHash}`
        )
        continue
      }
      const goldenRow = goldenByCaseId.get(c.caseId)
      if (!goldenRow) continue // caught by the coverage test below, not here
      const report = scanner.scan(c.skillId, text)
      const actualProjection = projectCore(report.riskBreakdown)
      for (const key of CORE_NON_AI_BREAKDOWN_KEYS) {
        if (actualProjection[key] !== goldenRow.breakdown[key]) {
          offenses.push({
            caseId: c.caseId,
            key,
            golden: goldenRow.breakdown[key],
            actual: actualProjection[key],
          })
        }
      }
    }

    expect(contentMismatches, contentMismatches.join('\n')).toEqual([])
    expect(offenses, JSON.stringify(offenses, null, 2)).toEqual([])
  })

  it('the golden covers every manifest case targeting this twin, and no others', () => {
    const manifestIds = coreCases.map((c) => c.caseId).sort((a, b) => a.localeCompare(b, 'en'))
    const goldenIds = golden.rows.map((r) => r.caseId).sort((a, b) => a.localeCompare(b, 'en'))
    expect(goldenIds).toEqual(manifestIds)
  })

  it('every projected key except the structurally-zero ones is exercised non-zero by at least one case', () => {
    const nonZeroSomewhere = new Set<CoreNonAiKey>()
    const zeroEverywhere = new Set<CoreNonAiKey>(CORE_NON_AI_BREAKDOWN_KEYS)
    for (const row of golden.rows) {
      for (const key of CORE_NON_AI_BREAKDOWN_KEYS) {
        if (row.breakdown[key] !== 0) {
          nonZeroSomewhere.add(key)
          zeroEverywhere.delete(key)
        }
      }
    }
    for (const key of CORE_NON_AI_BREAKDOWN_KEYS) {
      if ((STRUCTURALLY_ZERO_CORE_KEYS as readonly string[]).includes(key)) {
        expect(nonZeroSomewhere.has(key), `${key} was expected to be structurally zero`).toBe(false)
      } else {
        expect(nonZeroSomewhere.has(key), `${key} is never non-zero in any golden row`).toBe(true)
      }
    }
    for (const key of STRUCTURALLY_ZERO_CORE_KEYS) {
      expect(zeroEverywhere.has(key), `${key} was expected to stay zero in every row`).toBe(true)
    }
  })
})

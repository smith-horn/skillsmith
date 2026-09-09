/**
 * SMI-6441 Wave 2 Step 4 — blast-radius verification for the MF-4b weak-password veto.
 * @module scripts/indexer/smi6441-blast-radius
 *
 * NEW FILE, NOT A `--wave=6441` MODE (the plan, `:1024-1027`, permits either).
 * `smi5207-blast-radius-transitions.ts:16-31` infers "before" from "pre-fix severity was
 * UNCONDITIONALLY `high`" — correct history for SMI-5207, INVALID here, since this wave moves
 * severity the other way. Two contradictory severity models in one file is exactly the
 * readability loss that clause guards against; that script also has no concept of the three
 * DECISION surfaces below, and at 341 lines could not absorb them under the 500-line gate.
 * Shared CLI/population plumbing IS reused unchanged, by import — reuse without repurposing.
 *
 * THE ABORT CRITERION IS INVERTED. SMI-5207 could only LOWER severity, so its harness aborts on
 * unexpected CLEARS. SMI-6441 RAISES severity for some inputs, so this one aborts on unexpected
 * QUARANTINES and BLOCKS. None of 5207's abort posture carries over.
 *
 * "BEFORE" IS A REAL COUNTERFACTUAL, NOT AN INFERENCE — via the Step 1 seam (plan `:504-517`):
 *   const lines  = content.split('\n')      // content = extractScannableContent(skill)
 *   const idx    = finding.lineNumber - 1   // scanners.ts:135 sets lineNumber = index + 1
 *   const before = assignmentHasRealValue(lines, idx, { weakPasswordVeto: false })
 *   const after  = assignmentHasRealValue(lines, idx)
 * The input is NEVER reconstructed from `finding.location`: per the plan's C-2 table
 * (`:994-998`), `location` is `line.trim().slice(0, 100)` (scanners.ts:134, read and confirmed),
 * so `.slice` drops whole assignment segments, `.trim()` destroys the indentation
 * `isDocumentationContext()` needs, and a one-element array makes `lines[index + 1]` permanently
 * `undefined` — `password:\n  monkey dragon`, a named must-fire case, could never be classified.
 *
 * FOUR GUARDS, each fatal to the WHOLE RUN (ABORTED_HARNESS_INVARIANT — never skip-and-continue,
 * never fall back to the `location` shape), because a silent mismatch reads as "zero
 * transitions", the invisible-success mode this wave exists to prevent:
 *   G1 (plan)  `lines[idx].trim().slice(0,100) === finding.location`; assertLocationAgreement
 *              says why "every finding processed" cannot be taken literally.
 *   G2 (plan)  findings-EVALUATED is counted beside the transition count; 0/0 exits non-zero.
 *   G3 (added) the recomputed AFTER verdict must equal the severity the scanner recorded.
 *   G4 (added) the `passed` mirror 4c needs is proved against the real report on every skill.
 *
 * FIDELITY LIMIT — CARRIED INTO THE JSON (`fidelityNote`), NOT JUST PROSE. Every arm runs the
 * CORE substrate; arm 4a's production substrate is the edge twin and its real full-population
 * vehicle is `smi5879-simulate-full.*`, deliberately NOT duplicated here. 4a below measures the
 * mechanism the plan names as the only way an indexer verdict can move — `escalateCodeExecution`
 * promotion crossing QUARANTINE_THRESHOLD.
 *
 * Does NOT typecheck until Step 1 lands the seam. Expected. `--help` prints the CLI surface. */

import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  MAX_LINE_LENGTH_FOR_REGEX,
  type ScanReport,
  type SecurityFinding,
  type SecuritySeverity,
} from '../../packages/core/src/security/scanner/index.js'
import { VALUE_GATED_ASSIGNMENT_PATTERNS } from '../../packages/core/src/security/scanner/patterns.js'
import type { VetoSegment, CensusRow, SkillRow } from './smi6441-blast-radius.types.ts'
import { assignmentHasRealValue } from '../../packages/core/src/security/scanner/SecurityScanner.value-gate.js'
import {
  COMMON_WEAK_PASSWORDS,
  WEAK_PASSWORD_LEXICON_VERSION,
} from '../../packages/core/src/security/scanner/SecurityScanner.weak-passwords.js'
import { escalateCodeExecution } from '../../packages/core/src/security/scanner/SecurityScanner.exec.js'
import { calculateRiskScore } from '../../packages/core/src/security/scanner/SecurityScanner.risk-score.js'
import {
  shouldQuarantine,
  DEFAULT_TRUST_CONFIG,
} from '../../packages/core/src/scripts/skill-scanner/trust-scorer.js'
import { isRejectableScan } from '../../packages/core/src/services/skill-installation.policy.js'
import { TRUST_TIER_SCANNER_OPTIONS } from '../../packages/core/src/services/skill-installation.types.js'
// Direct-from-source, same reason the 5207 harnesses give: skill-scanner/index.ts is also the
// weekly-scan CLI entrypoint and calls its own main() at import time.
import { extractScannableContent } from '../../packages/core/src/scripts/skill-scanner/file-scanner.js'
// The indexer's own gate threshold, imported not re-typed — same specifier
// scripts/indexer/skill-processor.security.ts:36 uses. That gate is purely score-driven
// (security-scanner-edge.quarantine.ts:65), which is what makes arm 4a computable here.
import { QUARANTINE_THRESHOLD } from './_shared/security-scanner-edge.ts'
import {
  SecurityScanner,
  SCANNER_RULESET_VERSION,
  parseCommonArgs,
  loadPopulation,
  loadAllowlistMatcher,
} from './smi5207-blast-radius.helpers.js'

/** Scoped + gitignored; never the repo root (CLAUDE.md working-files rule). */
const DEFAULT_REPORT_PATH = '.smi6441-reports/blast-radius-report.json'
/** Plan Step 4d: > 20 flips is a trigger to re-examine the keeplist. */
const CENSUS_CEILING = 20
/** SecurityScanner.ts:108 — `options.riskThreshold ?? 40`. G4 proves this still matches. */
const SCANNER_DEFAULT_RISK_THRESHOLD = 40

/**
 * Independent reimplementation of value-gate.ts's private ASSIGNMENT_HEAD / MAX_LABEL_TOKENS /
 * token regex, used ONLY to explain a flip after the fact. Independence is the point — sharing
 * the implementation would share any bug with the thing it verifies. Drift fails CLOSED: a flip
 * this segmenter cannot explain is a HARD ABORT (censusRowFor), never a silent pass. */
const HARNESS_ASSIGNMENT_HEAD = /(?:credentials|\bsecrets?|password)\s*[:=]\s*/gi
const HARNESS_LABEL_TOKEN = /^[a-z]{1,19}$/
const HARNESS_MAX_LABEL_TOKENS = 2

class HarnessAbort extends Error {}

const MF4_PATTERNS = [...VALUE_GATED_ASSIGNMENT_PATTERNS]

/**
 * Which pattern produced a finding is read from the finding's OWN `message`
 * (`… (${pattern.source})`, scanners.ts:133) by exact suffix membership against the finite MF-4
 * set — not by re-running the pattern loop (which needs scanners.ts's module-private MF-1
 * `CREDENTIAL_ASSIGNMENT` gate to pick the same winner), and not by parsing (`pattern.source`
 * can contain parentheses). `message` has no truncation on the pattern-source tail. */
function isMf4AssignmentFinding(finding: SecurityFinding): boolean {
  return MF4_PATTERNS.some((p) => finding.message.endsWith(`(${p.source})`))
}

/** Suffix membership is only unambiguous if no MF-4 source is a suffix of another. */
function assertPatternSuffixesUnambiguous(): void {
  for (const a of MF4_PATTERNS) {
    for (const b of MF4_PATTERNS) {
      if (a !== b && `(${a.source})`.endsWith(`(${b.source})`)) {
        throw new HarnessAbort(`MF-4 sources suffix-ambiguous: "${b.source}" ends "${a.source}".`)
      }
    }
  }
}

/**
 * G1. Applied to every `sensitive_path` finding — the widest scope over which
 * `location === line.trim().slice(0,100)` is provable (scanners.ts:134). Deliberately NOT every
 * finding of every type, despite the plan's literal wording: `typosquat` (location =
 * candidateName), `external_url` (= url), `ssrf` (= match[0]) and helpers.ts's compound findings
 * build `location` from something else, so a blanket form would abort healthy runs. */
function assertLocationAgreement(skill: string, lines: string[], f: SecurityFinding): number {
  if (typeof f.lineNumber !== 'number') {
    throw new HarnessAbort(`${skill}: sensitive_path finding has no lineNumber (${f.message})`)
  }
  const idx = f.lineNumber - 1
  const line = lines[idx]
  if (line === undefined) {
    throw new HarnessAbort(
      `${skill}: lineNumber ${f.lineNumber} out of range for the scanned document ` +
        `(${lines.length} lines) — the harness was handed the wrong content.`
    )
  }
  const reconstructed = line.trim().slice(0, 100)
  if (reconstructed !== f.location) {
    throw new HarnessAbort(
      `${skill}: G1 mismatch at line ${f.lineNumber}.\n` +
        `  lines[idx].trim().slice(0,100) = ${JSON.stringify(reconstructed)}\n` +
        `  finding.location               = ${JSON.stringify(f.location)}\n` +
        'The content is not what the scan ran on; every number this run would produce is bogus.'
    )
  }
  return idx
}

/** The 2-token carve-out shape with >= 1 lexicon hit (value-gate.ts:65-70 + plan item 4). */
function classifySegment(span: string, src: VetoSegment['src']): VetoSegment | null {
  const value = span.replace(/^['"]|['"]$/g, '').trim()
  const tokens = value.split(/\s+/)
  if (tokens.length !== HARNESS_MAX_LABEL_TOKENS) return null
  if (!tokens.every((t) => HARNESS_LABEL_TOKEN.test(t))) return null
  const hits = tokens.filter((t) => COMMON_WEAK_PASSWORDS.has(t))
  return hits.length === 0 ? null : { value, src, hits }
}

/** Independent post-hoc explanation of a flip. Empty result ⇒ the veto left its carve-out. */
function vetoShapedSegments(lines: string[], index: number): VetoSegment[] {
  const line = lines[index].slice(0, MAX_LINE_LENGTH_FOR_REGEX)
  const heads = [...line.matchAll(HARNESS_ASSIGNMENT_HEAD)]
  const out: VetoSegment[] = []
  let trailingKeyIsBare = false
  for (let i = 0; i < heads.length; i++) {
    const from = (heads[i].index ?? 0) + heads[i][0].length
    const to = i + 1 < heads.length ? (heads[i + 1].index ?? line.length) : line.length
    const raw = line.slice(from, to)
    if (raw.trim().length === 0) {
      trailingKeyIsBare = i === heads.length - 1
      continue
    }
    trailingKeyIsBare = false
    const seg = classifySegment(raw, 'same_line')
    if (seg) out.push(seg)
  }
  if (trailingKeyIsBare) {
    // YAML block form: value-gate.ts:130-131 re-enters isProseValue with `lines[index+1].trim()`.
    const next: string | undefined = lines[index + 1]
    const seg = next === undefined ? null : classifySegment(next.trim(), 'next_line')
    if (seg) out.push(seg)
  }
  return out
}

function censusRowFor(skill: string, lines: string[], f: SecurityFinding, i: number): CensusRow {
  if (f.inDocumentationContext === true) {
    throw new HarnessAbort(
      `${skill}: MEDIUM→HIGH flip at line ${f.lineNumber} has inDocumentationContext=true. The ` +
        'doc-context branch precedes MF-4 (scanners.ts:100), so this is structurally impossible.'
    )
  }
  const segs = vetoShapedSegments(lines, i)
  const ok = segs.length > 0
  return {
    skillId: skill,
    lineNumber: f.lineNumber as number,
    sourceLine: lines[i],
    valueSource: ok ? segs.map((s) => s.src).join('+') : 'none',
    segmentValue: ok ? segs.map((s) => s.value).join(' | ') : '',
    lexiconTokensHit: [...new Set(segs.flatMap((s) => s.hits))],
    shapeVerdict: ok ? 'two_token_carveout' : 'unexplained_shape',
  }
}

/** Mirror of SecurityScanner.ts:450-453, proved against the real report by G4 before use. */
function scanPassed(findings: SecurityFinding[], riskThreshold: number): boolean {
  return (
    !findings.some((f) => f.severity === 'critical') &&
    !findings.some((f) => f.severity === 'high') &&
    calculateRiskScore(findings).total < riskThreshold
  )
}

function analyzeSkill(
  skill: string,
  content: string,
  after: ScanReport,
  allowlist: ReturnType<typeof loadAllowlistMatcher>['matcher']
): { row: SkillRow; census: CensusRow[] } {
  const lines = content.split('\n')
  const census: CensusRow[] = []
  let mf4Evaluated = 0

  const beforeFindings: SecurityFinding[] = after.findings.map((f) => {
    if (f.type !== 'sensitive_path') return { ...f }
    const idx = assertLocationAgreement(skill, lines, f) // G1
    if (f.inDocumentationContext === true || !isMf4AssignmentFinding(f)) return { ...f }

    mf4Evaluated++
    const beforeReal = assignmentHasRealValue(lines, idx, { weakPasswordVeto: false })
    const afterReal = assignmentHasRealValue(lines, idx)
    const afterSeverity: SecuritySeverity = afterReal ? 'high' : 'medium'
    if (afterSeverity !== f.severity) {
      throw new HarnessAbort(
        `${skill}: G3 — recomputed AFTER severity (${afterSeverity}) disagrees with the severity ` +
          `the scanner recorded (${f.severity}) at line ${f.lineNumber}. The harness's model of ` +
          'SecurityScanner.scanners.ts:107 is wrong; every number below is meaningless.'
      )
    }
    if (!beforeReal && afterReal) census.push(censusRowFor(skill, lines, f, idx))
    // `confidence` must be re-derived, not inherited from the AFTER finding.
    // SecurityScanner.scanners.ts:111-115 computes it FROM severity
    // (inDocContext ? 'low' : severity === 'high' ? 'high' : 'medium'), and
    // risk scoring consumes confidence — so spreading the post-change
    // `confidence: 'high'` onto a counterfactual finding we just demoted to
    // 'medium' inflates the BEFORE risk score. That can push a BEFORE total
    // over the 40-point indexer threshold, making a skill look
    // already-quarantined and hiding a real 4a transition. The doc-context
    // arm ('low') is genuinely unreachable here — the early return above
    // already excluded every doc-context finding, and the compiler narrows
    // `inDocumentationContext` to `false | undefined` at this point, so
    // writing that arm is a TS2367 error rather than defensive coding.
    const beforeSeverity: SecuritySeverity = beforeReal ? 'high' : 'medium'
    return { ...f, severity: beforeSeverity, confidence: beforeReal ? 'high' : 'medium' }
  })

  // Re-run the REAL escalation over the counterfactual array, as
  // smi5207-blast-radius-transitions.ts:145-155 does: code_execution is reset to
  // scanCodeExecution()'s documented single-emission baseline ('medium') so escalation is
  // recomputed, not inherited. sensitive_path substitution is then the ONLY variable differing
  // from the real AFTER run, so a promotion is causally attributable.
  for (const f of beforeFindings) if (f.type === 'code_execution') f.severity = 'medium'
  escalateCodeExecution(beforeFindings)

  if (scanPassed(after.findings, SCANNER_DEFAULT_RISK_THRESHOLD) !== after.passed) {
    throw new HarnessAbort(
      `${skill}: G4 — the \`passed\` mirror disagrees with the real ScanReport.passed. ` +
        'SecurityScanner.ts:450-453 has changed shape; the 4c arm cannot be trusted.'
    )
  }

  const beforeReport: ScanReport = {
    ...after,
    findings: beforeFindings,
    riskScore: calculateRiskScore(beforeFindings).total,
  }
  const newBlockTiers: string[] = []
  const newRejectTiers: string[] = []
  for (const [tier, opts] of Object.entries(TRUST_TIER_SCANNER_OPTIONS)) {
    const t = opts.riskThreshold ?? SCANNER_DEFAULT_RISK_THRESHOLD
    const pB = scanPassed(beforeFindings, t)
    const pA = scanPassed(after.findings, t)
    if (pB && !pA) newBlockTiers.push(tier) // skill-installation.service.ts:233
    const rB = isRejectableScan({ passed: pB, findings: beforeFindings })
    const rA = isRejectableScan({ passed: pA, findings: after.findings })
    if (!rB && rA) newRejectTiers.push(tier) // .io.ts:378 / .content.ts:185
  }

  const row: SkillRow = {
    skillId: skill,
    mf4Evaluated,
    quarantinedBefore: shouldQuarantine(beforeReport, DEFAULT_TRUST_CONFIG, allowlist),
    quarantinedAfter: shouldQuarantine(after, DEFAULT_TRUST_CONFIG, allowlist),
    indexerRiskBefore: beforeReport.riskScore,
    indexerRiskAfter: after.riskScore,
    indexerQBefore: beforeReport.riskScore >= QUARANTINE_THRESHOLD,
    indexerQAfter: after.riskScore >= QUARANTINE_THRESHOLD,
    codeExecBefore: beforeFindings.find((f) => f.type === 'code_execution')?.severity ?? null,
    codeExecAfter: after.findings.find((f) => f.type === 'code_execution')?.severity ?? null,
    newBlockTiers,
    newRejectTiers,
  }
  return { row, census }
}

/** 4d census, machine-readable — paste-ready for the plan's per-flip table. */
function writeCensusCsv(path: string, rows: CensusRow[]): void {
  const q = (v: string): string => `"${v.replace(/"/g, '""')}"`
  const head =
    'skillId,lineNumber,valueSource,segmentValue,lexiconTokensHit,shapeVerdict,sourceLine'
  const body = rows.map(
    (r) =>
      `${q(r.skillId)},${r.lineNumber},${q(r.valueSource)},${q(r.segmentValue)},` +
      `${q(r.lexiconTokensHit.join(' '))},${r.shapeVerdict},${q(r.sourceLine)}`
  )
  writeFileSync(path, [head, ...body].join('\n') + '\n')
}

function printHelp(): void {
  console.log(`
SMI-6441 Wave 2 Step 4 — MF-4b weak-password-veto blast radius (arms 4a/4b/4c/4d)
  npx tsx scripts/indexer/smi6441-blast-radius.ts --population=<path> [options]

  --population=<path>  ImportedSkill[] JSON. \`beforeQuarantined\` IGNORED — "before" here is a
                        causal counterfactual, not a ground-truth field.
  --fixtures           Built-in 5207 sample. Smoke only, NOT a wave verification.
  --allowlist-path=<p> 4b Gate-A allowlist. Default ./data/skills-security-allowlist.json
  --allowed-new-quarantine=<skillId>  Hand-verified TP, 4a/4b only (repeatable).
  --allowed-new-block=<skillId>  Hand-verified TP, 4c only (repeatable). SEPARATE by design: no
                        allowlist exists in skill-installation.*, so 4c's bar is higher.
  --accept-census-over-ceiling=<why>  Accept > ${CENSUS_CEILING} flips WITH a written rationale,
                        echoed into the report. Never clears a shape hard-abort.
  --allow-zero-evaluated / --report-path=<p> / --csv=<p> (4d census, machine-readable)
`)
}

function collectRepeated(argv: string[], flag: string): { values: string[]; rest: string[] } {
  const values: string[] = []
  const rest: string[] = []
  for (const raw of argv) {
    if (raw.startsWith(`${flag}=`)) values.push(raw.slice(flag.length + 1))
    else rest.push(raw)
  }
  return { values, rest }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h')) return printHelp()

  const zeroOk = argv.includes('--allow-zero-evaluated')
  const qa = collectRepeated(
    argv.filter((a) => a !== '--allow-zero-evaluated'),
    '--allowed-new-quarantine'
  )
  const bl = collectRepeated(qa.rest, '--allowed-new-block')
  const ce = collectRepeated(bl.rest, '--accept-census-over-ceiling')
  const okQuarantine = new Set(qa.values)
  const okBlock = new Set(bl.values)
  const ceilingRationale = ce.values[0] ?? null

  assertPatternSuffixesUnambiguous()
  const common = parseCommonArgs(ce.rest, { reportPath: DEFAULT_REPORT_PATH })
  const { population, source } = loadPopulation(common)
  const { matcher, entryCount } = loadAllowlistMatcher(common.allowlistPath)
  const scanner = new SecurityScanner()

  const rows: SkillRow[] = []
  const census: CensusRow[] = []
  let totalFindings = 0
  let spFindings = 0

  for (const skill of population) {
    // The exact three calls scanSkill() makes, in order (scanner.ts:107-109), unrolled only so
    // `content` is in hand — finding.lineNumber indexes into THAT string, not the raw file.
    const content = extractScannableContent(skill)
    const after = scanner.scan(skill.id, content)
    totalFindings += after.findings.length
    spFindings += after.findings.filter((f) => f.type === 'sensitive_path').length
    const { row, census: rowCensus } = analyzeSkill(skill.id, content, after, matcher)
    rows.push(row)
    census.push(...rowCensus)
  }

  const evaluated = rows.reduce((n, r) => n + r.mf4Evaluated, 0)
  const new4a = rows.filter((r) => !r.indexerQBefore && r.indexerQAfter)
  const promos = rows.filter((r) => r.codeExecBefore === 'medium' && r.codeExecAfter === 'critical')
  const new4b = rows.filter((r) => !r.quarantinedBefore && r.quarantinedAfter)
  const new4c = rows.filter((r) => r.newBlockTiers.length > 0 || r.newRejectTiers.length > 0)
  const unexplained = census.filter((r) => r.shapeVerdict === 'unexplained_shape')
  const bad = (rs: SkillRow[], ok: Set<string>): boolean => rs.some((r) => !ok.has(r.skillId))

  const verdicts: string[] = []
  const add = (hit: boolean, name: string): void => {
    if (hit) verdicts.push(name)
  }
  add(evaluated === 0 && !zeroOk, 'BROKEN_HARNESS_ZERO_EVALUATED')
  add(bad(new4a, okQuarantine), 'ABORT_4A_NEW_INDEXER_QUARANTINE')
  add(bad(new4b, okQuarantine), 'ABORT_4B_NEW_QUARANTINE')
  add(bad(new4c, okBlock), 'ABORT_4C_NEW_INSTALL_BLOCK')
  add(unexplained.length > 0, 'ABORT_4D_CENSUS_SHAPE_OUTSIDE_CARVE_OUT')
  add(census.length > CENSUS_CEILING && ceilingRationale === null, 'INVESTIGATE_4D_OVER_CEILING')

  const report = {
    reportKind: 'smi6441_blast_radius' as const,
    generatedAt: new Date().toISOString(),
    verdict: verdicts.length === 0 ? ['CLEAN'] : verdicts,
    scannerRulesetVersion: SCANNER_RULESET_VERSION,
    weakPasswordLexiconVersion: WEAK_PASSWORD_LEXICON_VERSION,
    populationSource: source,
    fidelityNote:
      'Core substrate only. Arm 4a is the mechanism signal (escalateCodeExecution promotion ' +
      'crossing QUARANTINE_THRESHOLD) over the supplied population; the production 4a vehicle ' +
      'is the edge twin via scripts/indexer/smi5879-simulate-full.*, not duplicated here.',
    counts: {
      totalSkills: population.length,
      totalFindings,
      sensitivePathFindings: spFindings,
      /** G2 denominator — "0 transitions of 0 evaluated" is a broken harness, not a pass. */
      mf4AssignmentFindingsEvaluated: evaluated,
      mediumToHighTransitions: census.length,
    },
    arm4a: {
      indexerQuarantineThreshold: QUARANTINE_THRESHOLD,
      newlyQuarantinedSkills: new4a.map((r) => r.skillId),
      codeExecMediumToCriticalPromotions: promos.map((r) => r.skillId),
    },
    arm4b: {
      allowlistPath: common.allowlistPath,
      allowlistEntryCount: entryCount,
      quarantineThreshold: DEFAULT_TRUST_CONFIG.quarantineThreshold,
      newlyQuarantinedSkills: new4b.map((r) => r.skillId),
    },
    /** Per-tier detail lives on skillRows[].newBlockTiers / .newRejectTiers. */
    arm4c: { newlyBlockedSkills: new4c.map((r) => r.skillId) },
    arm4d: { ceiling: CENSUS_CEILING, ceilingRationale, rows: census },
    allowed: { newQuarantine: [...okQuarantine], newBlock: [...okBlock] },
    skillRows: rows,
  }

  const reportPath = common.reportPath ?? DEFAULT_REPORT_PATH
  mkdirSync(dirname(reportPath), { recursive: true })
  writeFileSync(reportPath, JSON.stringify(report, null, 2))
  if (common.csvPath) writeCensusCsv(common.csvPath, census)

  const zeroWarn = evaluated === 0 ? '  !! 0 evaluated — BROKEN HARNESS, not a clean result.' : ''
  console.log(
    [
      `\nSMI-6441 blast radius — ${source}`,
      `Ruleset ${SCANNER_RULESET_VERSION}; lexicon ${WEAK_PASSWORD_LEXICON_VERSION}`,
      `Skills ${population.length}; findings ${totalFindings}; sensitive_path ${spFindings}`,
      `MF-4 findings EVALUATED: ${evaluated}  |  MEDIUM→HIGH transitions: ${census.length}`,
      ...(zeroWarn ? [zeroWarn] : []),
      `4a newly indexer-quarantined: ${new4a.length} (code_exec med→crit: ${promos.length})`,
      `4b newly quarantined (Gate-A): ${new4b.length} — expected 0`,
      `4c newly blocked/rejectable installs: ${new4c.length} — expected 0`,
      `4d census: ${census.length} rows (ceiling ${CENSUS_CEILING}); unexplained: ${unexplained.length}`,
      ...census.map(
        (r) =>
          `  - ${r.skillId} L${r.lineNumber} [${r.shapeVerdict}] ` +
          `hit=${r.lexiconTokensHit.join('/') || '(none)'} value=${JSON.stringify(r.segmentValue)}`
      ),
      `Verdict: ${report.verdict.join(', ')}`,
      `Report: ${reportPath}${common.csvPath ? `; census CSV: ${common.csvPath}` : ''}`,
    ].join('\n')
  )
  process.exitCode = verdicts.length === 0 ? 0 : 1
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    if (err instanceof HarnessAbort) {
      console.error('\nRUN ABORTED — ABORTED_HARNESS_INVARIANT\n' + err.message)
    } else {
      console.error(err instanceof Error ? err.stack : String(err))
    }
    process.exit(1)
  })
}

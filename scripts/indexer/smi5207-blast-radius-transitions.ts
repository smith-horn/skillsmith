/**
 * SMI-5207 Wave 1 Step 4e — finding-level severity-transition metric.
 * @module scripts/indexer/smi5207-blast-radius-transitions
 *
 * Per the plan: "New: emit per-finding `{type, severity_before,
 * severity_after}` for 4a/4b, and count `code_execution` critical->medium
 * flips attributable to `sensitive_path` co-signal demotion." A reporting
 * addition over 4b's per-skill scan, not a new scan mechanism — see the
 * plan's Context section, "Cross-cutting: the co-signal demotion", for why
 * this specific transition is the fix's primary indexer-path clearing
 * mechanism AND its primary false-negative risk, and therefore the
 * highest-value target for hand review (Step 4 item 2: "hand-review, not
 * sample, every flip it surfaces").
 *
 * HOW "BEFORE" SEVERITY IS COMPUTED, PER FINDING (no old-code execution
 * needed — see smi5207-blast-radius-weekly.ts's header for the same
 * argument at the skill-verdict level): SMI-5207 changes exactly ONE thing
 * at the finding level — `scanSensitivePaths()`'s severity assignment for
 * the 9 path-form + 3 assignment-form patterns (MF-3/MF-4). Every other
 * finding type, and the ENV_PATH_PATTERN (MF-2) / VALUE_GATED_KEYWORD_PATTERNS
 * (MF-1) branches of `sensitive_path` itself, are BYTE-IDENTICAL before and
 * after this change. So for a `sensitive_path` finding, "before" severity is
 * a pure, provable function of the AFTER finding's own recorded fields:
 *   - `inDocumentationContext: true`  -> unchanged (that branch predates SMI-5207)
 *   - matched pattern is ENV_PATH_PATTERN or a VALUE_GATED_KEYWORD_PATTERNS
 *     member -> unchanged (MF-1/MF-2, untouched by this wave)
 *   - matched pattern is in PATH_FORM_PATTERNS or VALUE_GATED_ASSIGNMENT_PATTERNS
 *     -> pre-fix severity was UNCONDITIONALLY 'high' outside doc-context —
 *     this is the exact bug SMI-5207 closes, verified against the real
 *     pre-change scanSensitivePaths() source (git diff, read in full before
 *     writing this script).
 * "Which pattern matched" is reconstructed by re-running the REAL, imported
 * `SENSITIVE_PATH_PATTERNS` array against the finding's own `location`
 * (the raw source line, `.slice(0,100)`-truncated) with the SAME
 * first-match-wins loop `scanSensitivePaths()` itself uses — not string-
 * parsed out of the finding's `message`, which is a much more fragile
 * approach (pattern.source values can themselves contain parentheses).
 *
 * FOR `code_execution` FLIPS SPECIFICALLY: rather than reimplementing
 * `escalateCodeExecution()`'s co-signal logic (its min-severity table and
 * 40-line window are private to SecurityScanner.exec.ts and deliberately
 * NOT duplicated here), this script imports and RE-RUNS the real,
 * unmodified `escalateCodeExecution()` against a counterfactual findings
 * array: a deep clone of the real AFTER findings with (a) every
 * `sensitive_path` finding's severity substituted for its inferred pre-fix
 * value, and (b) the `code_execution` finding's severity reset to its
 * documented pre-escalation baseline (`scanCodeExecution()` always emits
 * exactly `medium` — a single-emission, deterministic invariant, not a
 * guess). Since sensitive_path substitution is the ONLY variable that
 * differs between this counterfactual run and the real AFTER run, a
 * critical->medium flip detected this way is causally attributable to this
 * fix by construction — not inferred from a severity diff after the fact,
 * which cannot on its own distinguish "sensitive_path stopped qualifying"
 * from an unrelated cause.
 *
 * USAGE:
 *   npx tsx scripts/indexer/smi5207-blast-radius-transitions.ts --fixtures
 *   npx tsx scripts/indexer/smi5207-blast-radius-transitions.ts \
 *     --population=<path> [--report-path=<path>] [--csv=<path>]
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type {
  SecurityFinding,
  SecuritySeverity,
} from '../../packages/core/src/security/scanner/index.js'
import {
  safeRegexCheck,
  SENSITIVE_PATH_PATTERNS,
} from '../../packages/core/src/security/scanner/index.js'
import {
  PATH_FORM_PATTERNS,
  VALUE_GATED_ASSIGNMENT_PATTERNS,
  ENV_PATH_PATTERN,
} from '../../packages/core/src/security/scanner/patterns.js'
import { escalateCodeExecution } from '../../packages/core/src/security/scanner/SecurityScanner.exec.js'
// NOT imported from skill-scanner/index.ts's barrel: that file is ALSO the
// weekly-scan CLI entrypoint (`scan-imported-skills.ts` imports it purely to
// "Re-run the CLI entry point") and calls its own main() UNCONDITIONALLY at
// import time — with no `import.meta.url` guard — which parses process.argv
// (THIS script's own --fixtures/--csv flags) as its own CLI options and
// exits. Caught during this worker's own verification run. Import directly
// from the source module instead, same fix as smi5207-blast-radius-weekly.ts
// already applies for `scanSkill`.
import { extractScannableContent } from '../../packages/core/src/scripts/skill-scanner/file-scanner.js'
import { SecurityScanner, parseCommonArgs, loadPopulation } from './smi5207-blast-radius.helpers.js'
import type {
  Smi5207CodeExecFlip,
  Smi5207FindingTransition,
  Smi5207TransitionsReport,
} from './smi5207-blast-radius.types.js'

// Governance review L-3: never the repo root (CLAUDE.md "Never save working
// files, text/mds and tests to the root folder") — a scoped, gitignored
// directory instead.
const DEFAULT_REPORT_PATH = '.smi5207-reports/blast-radius-transitions-report.json'

/**
 * Display/triage aid only — NOT the causal decision (that comes from
 * re-running the real `escalateCodeExecution`, see this module's header).
 * Mirrors `MAX_CODE_EXECUTION_CO_SIGNAL_LINE_DISTANCE`
 * (SecurityScanner.exec.ts), which is private to that module and
 * deliberately not duplicated as logic here — only its value, for labeling
 * candidates in the human-review report.
 */
const REPORT_CO_SIGNAL_WINDOW = 40

/** Re-run scanSensitivePaths()'s own first-match-wins pattern selection against a finding's raw line. */
function classifyMatchedPattern(location: string): RegExp | undefined {
  for (const pattern of SENSITIVE_PATH_PATTERNS) {
    if (safeRegexCheck(pattern, location)) return pattern
  }
  return undefined
}

/** See this module's header, "HOW 'BEFORE' SEVERITY IS COMPUTED". */
function inferSensitivePathSeverityBefore(finding: SecurityFinding): SecuritySeverity {
  if (finding.inDocumentationContext) return finding.severity
  const pattern = classifyMatchedPattern(finding.location ?? '')
  if (!pattern || pattern === ENV_PATH_PATTERN) return finding.severity // MF-2 / unclassified: untouched
  if (PATH_FORM_PATTERNS.has(pattern) || VALUE_GATED_ASSIGNMENT_PATTERNS.has(pattern)) return 'high'
  return finding.severity // MF-1 survivors (VALUE_GATED_KEYWORD_PATTERNS): untouched
}

/** Pre-fix severity for ANY finding — only sensitive_path can differ from the after value. */
function inferSeverityBefore(finding: SecurityFinding): SecuritySeverity {
  return finding.type === 'sensitive_path'
    ? inferSensitivePathSeverityBefore(finding)
    : finding.severity
}

interface ScanTransitionResult {
  transitions: Smi5207FindingTransition[]
  flip: Smi5207CodeExecFlip | null
}

/** Scan one skill and derive its finding-level transitions + any code_execution flip. */
function analyzeSkillTransitions(
  skillId: string,
  afterFindings: SecurityFinding[]
): ScanTransitionResult {
  const severityBefore = afterFindings.map(inferSeverityBefore)

  // Counterfactual pre-fix findings array: sensitive_path severities
  // substituted; code_execution reset to its documented unescalated
  // baseline ('medium' — scanCodeExecution() single-emission invariant).
  // Every other field (type, lineNumber, inDocumentationContext, location,
  // confidence) is preserved unchanged — escalateCodeExecution() reads all
  // of them.
  const preFixFindings: SecurityFinding[] = afterFindings.map((f, i) => ({
    ...f,
    severity: f.type === 'code_execution' ? 'medium' : severityBefore[i],
  }))
  escalateCodeExecution(preFixFindings)

  // For every finding type except code_execution, severityBefore[i] (derived
  // independently above) IS the "before" value. For code_execution
  // specifically, its OWN severity is a DERIVED value (escalateCodeExecution's
  // output) rather than independently inferred — its true "before" is
  // preFixFindings[i].severity (what the real escalation function produced
  // when run against the counterfactual sensitive_path values), which is why
  // it's special-cased below instead of reusing severityBefore[i] (which for
  // code_execution just holds its unchanged AFTER value, copied through
  // inferSeverityBefore's pass-through branch).
  const transitions: Smi5207FindingTransition[] = []
  afterFindings.forEach((f, i) => {
    const isCodeExec = f.type === 'code_execution'
    const before = isCodeExec ? preFixFindings[i].severity : severityBefore[i]
    const after = f.severity
    if (before === after) return
    transitions.push({
      skillId,
      type: f.type,
      lineNumber: f.lineNumber,
      location: f.location,
      severityBefore: before,
      severityAfter: after,
      messageAfter: f.message,
    })
  })

  const codeExecIdx = afterFindings.findIndex((f) => f.type === 'code_execution')
  if (codeExecIdx === -1) return { transitions, flip: null }
  const codeExecAfter = afterFindings[codeExecIdx]
  const codeExecBefore = preFixFindings[codeExecIdx].severity
  if (!(codeExecBefore === 'critical' && codeExecAfter.severity === 'medium')) {
    return { transitions, flip: null }
  }

  // Attribution: since substituting sensitive_path severities back to their
  // pre-fix values is the ONLY variable that differs between this
  // counterfactual run and the real after-run, a critical->medium flip
  // detected this way is caused by a sensitive_path demotion by
  // construction. The fallback branch is defensive only — it should be
  // unreachable given this script's own construction, and is reported
  // honestly (not asserted/thrown) so a violation of that assumption
  // surfaces in the report rather than crashing the tool.
  const demotedSensitivePathExists = afterFindings.some(
    (f, i) =>
      f.type === 'sensitive_path' &&
      (severityBefore[i] === 'high' || severityBefore[i] === 'critical') &&
      f.severity !== 'high' &&
      f.severity !== 'critical'
  )

  const coSignalCandidates = afterFindings
    .map((f, i) => ({ f, i }))
    .filter(({ f }) => f.type === 'sensitive_path' && f.inDocumentationContext !== true)
    .map(({ f, i }) => ({
      type: f.type,
      lineNumber: f.lineNumber,
      location: f.location,
      severityBefore: severityBefore[i],
      severityAfter: f.severity,
      withinReportingWindow:
        typeof codeExecAfter.lineNumber === 'number' && typeof f.lineNumber === 'number'
          ? Math.abs(codeExecAfter.lineNumber - f.lineNumber) <= REPORT_CO_SIGNAL_WINDOW
          : true,
    }))

  const flip: Smi5207CodeExecFlip = {
    skillId,
    codeExecLineNumber: codeExecAfter.lineNumber,
    codeExecLocation: codeExecAfter.location,
    codeExecMessageAfter: codeExecAfter.message,
    attributedTo: demotedSensitivePathExists
      ? 'sensitive_path_co_signal_demotion'
      : 'other_or_unattributed',
    coSignalCandidates,
  }
  return { transitions, flip }
}

function writeCsv(path: string, transitions: Smi5207FindingTransition[]): void {
  const header = 'skillId,type,lineNumber,severityBefore,severityAfter,location,messageAfter'
  const escape = (v: string): string => `"${v.replace(/"/g, '""')}"`
  const rows = transitions.map((t) =>
    [
      escape(t.skillId),
      escape(t.type),
      String(t.lineNumber ?? ''),
      t.severityBefore,
      t.severityAfter,
      escape(t.location ?? ''),
      escape(t.messageAfter),
    ].join(',')
  )
  writeFileSync(path, [header, ...rows].join('\n') + '\n')
}

function printHelp(): void {
  console.log(`
SMI-5207 Wave 1 Step 4e — finding-level severity-transition metric

Usage:
  npx tsx scripts/indexer/smi5207-blast-radius-transitions.ts --fixtures
  npx tsx scripts/indexer/smi5207-blast-radius-transitions.ts --population=<path> [options]

Options:
  --fixtures               Use this worker's built-in hand-crafted sample.
  --population=<path>      A JSON array (or {skills:[...]}) of
                            Smi5207PopulationSkill rows.
  --report-path=<path>     Default: ${DEFAULT_REPORT_PATH}
  --csv=<path>             Also write findingTransitions as CSV (hand-review friendly).
  --help, -h                This message.
`)
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp()
    return
  }

  const common = parseCommonArgs(argv, { reportPath: DEFAULT_REPORT_PATH })
  const { population, source } = loadPopulation(common)
  const scanner = new SecurityScanner()

  const findingTransitions: Smi5207FindingTransition[] = []
  const flips: Smi5207CodeExecFlip[] = []

  for (const skill of population) {
    const content = extractScannableContent(skill)
    const scanReport = scanner.scan(skill.id, content)
    const { transitions, flip } = analyzeSkillTransitions(skill.id, scanReport.findings)
    findingTransitions.push(...transitions)
    if (flip) flips.push(flip)
  }

  const report: Smi5207TransitionsReport = {
    reportKind: 'smi5207_blast_radius_transitions',
    generatedAt: new Date().toISOString(),
    populationSource: source,
    totalSkills: population.length,
    totalFindingTransitions: findingTransitions.length,
    findingTransitions,
    codeExecutionFlips: {
      criticalToMedium: flips,
      count: flips.length,
      attributedToSensitivePathCount: flips.filter(
        (f) => f.attributedTo === 'sensitive_path_co_signal_demotion'
      ).length,
    },
  }

  const reportPath = common.reportPath ?? DEFAULT_REPORT_PATH
  mkdirSync(dirname(reportPath), { recursive: true })
  writeFileSync(reportPath, JSON.stringify(report, null, 2))
  if (common.csvPath) writeCsv(common.csvPath, findingTransitions)

  console.log(`\nSMI-5207 blast-radius (finding-level transitions) — ${report.populationSource}`)
  console.log(
    `Scanned ${report.totalSkills} skill(s), ${report.totalFindingTransitions} finding transition(s).`
  )
  console.log(
    `code_execution critical->medium flips: ${report.codeExecutionFlips.count} ` +
      `(${report.codeExecutionFlips.attributedToSensitivePathCount} attributed to sensitive_path co-signal demotion)`
  )
  if (report.codeExecutionFlips.count > 0) {
    console.log('\nEvery flip below requires hand review (plan Step 4 item 2 — no sampling):')
    for (const flip of report.codeExecutionFlips.criticalToMedium) {
      console.log(
        `  - ${flip.skillId} (line ${flip.codeExecLineNumber ?? '?'}): ${flip.attributedTo}, ` +
          `${flip.coSignalCandidates.length} sensitive_path candidate(s) in window`
      )
    }
  }
  console.log(
    `Report written to ${reportPath}${common.csvPath ? `; CSV written to ${common.csvPath}` : ''}`
  )
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
}

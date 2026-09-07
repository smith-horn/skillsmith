/**
 * SMI-5207 Wave 1 Step 4b — core weekly-scanner + trust-scorer replay.
 * @module scripts/indexer/smi5207-blast-radius-weekly
 *
 * Per the plan (docs/internal/implementation/smi-5207-sensitive-path-action-context-gating.md,
 * Wave 1 Step 4): "New script: replay the same population's flattened
 * documents through `SecurityScanner.scan()` + `shouldQuarantine(report,
 * config, allowlist)`, emitting per-skill before/after verdicts."
 *
 * WHAT THIS SCRIPT DOES: for each skill in the population, reuses the REAL
 * production call sequence unmodified — `scanSkill()`
 * (packages/core/src/scripts/skill-scanner/scanner.ts), which internally
 * does `extractScannableContent(skill)` -> `scanner.scan(skill.id, content)`
 * -> `shouldQuarantine(report, config, allowlist)` — the exact same function
 * the real `scan-imported-skills.ts` CLI calls per skill in
 * `weekly-security-scan.yml`. Nothing about the scan path is reimplemented
 * here; only the before/after comparison and reporting are new.
 *
 * BEFORE/AFTER COMPARISON — CHOSEN DESIGN (see the task's own two options):
 * this script runs ONLY the current (post-fix) code and compares each
 * skill's verdict against a supplied "before" ground-truth field
 * (`beforeQuarantined` on `Smi5207PopulationSkill`), NOT a literal dual-run
 * against a reconstructed pre-fix module graph. Reasoning:
 *
 *   1. The design's OWN governing invariant, verified across seven review
 *      rounds, is that every severity transition this change makes is
 *      monotonically non-increasing — nothing that was MEDIUM/clear before
 *      can become HIGH/quarantined after (plan Context, "Governing
 *      invariant"). That means the only two properties worth checking are
 *      exactly "did anything get WORSE" (a hard abort — would falsify the
 *      invariant outright) and "did anything clear that shouldn't have" (a
 *      hand-review gate) — both fully answerable from the AFTER scan plus a
 *      "before" ground truth, with no need to re-execute old code at all.
 *   2. Reconstructing "before" by loading the pre-fix TypeScript module graph
 *      (`git show <base>:path` for every transitively-affected file, then
 *      evaluating it in an isolated module context so it doesn't collide
 *      with the live "after" `SecurityScanner` class in the same process)
 *      is real, fragile engineering with its own correctness risk — a
 *      verification tool built to catch a monotonicity violation would
 *      itself need to be trusted not to have silently loaded the wrong
 *      dependency closure. A ground-truth comparison carries no such risk:
 *      it's the REAL prior-world state, not a re-derived approximation of it.
 *   3. `skills.quarantined` is a real, existing DB column (see
 *      scripts/indexer/skill-processor.ts and the migrations that reference
 *      it) — a genuine, non-hypothetical source for `beforeQuarantined` on a
 *      real corpus run, read once, read-only, before this PR's ruleset goes
 *      live. This script's own hand-crafted `--fixtures` sample hard-codes
 *      the equivalent ground truth per-fixture instead (see
 *      smi5207-blast-radius.fixtures.ts), since a live DB/GitHub read is
 *      explicitly out of scope for this worker without queen confirmation.
 *
 * USAGE:
 *   npx tsx scripts/indexer/smi5207-blast-radius-weekly.ts --fixtures
 *   npx tsx scripts/indexer/smi5207-blast-radius-weekly.ts \
 *     --population=<path-to-Smi5207PopulationSkill[].json> \
 *     [--allowlist-path=<path>] [--allowed-flip=<skillId>]... \
 *     [--report-path=<path>]
 *
 * Exit code: 0 when clean (every clear is on the allowed-flip list and
 * nothing newly quarantined); 1 on any violation — see printSummary().
 */

import { writeFileSync } from 'node:fs'
// scanSkill is NOT re-exported from skill-scanner/index.ts's barrel (only
// scanImportedSkills/DEFAULT_CONFIG/DEFAULT_CLI_OPTIONS are) — imported
// directly from its source module instead.
import { scanSkill } from '../../packages/core/src/scripts/skill-scanner/scanner.js'
import { DEFAULT_TRUST_CONFIG } from '../../packages/core/src/scripts/skill-scanner/trust-scorer.js'
import {
  SecurityScanner,
  SCANNER_RULESET_VERSION,
  parseCommonArgs,
  loadPopulation,
  loadAllowlistMatcher,
  DEFAULT_ALLOWLIST_PATH,
} from './smi5207-blast-radius.helpers.js'
import { SMI5207_NAMED_ALLOWED_FLIPS } from './smi5207-blast-radius.fixtures.js'
import type {
  Smi5207RowOutcome,
  Smi5207WeeklyReport,
  Smi5207WeeklyRow,
} from './smi5207-blast-radius.types.js'

const DEFAULT_REPORT_PATH = 'smi5207-blast-radius-weekly-report.json'

function classifyOutcome(before: boolean | null, after: boolean): Smi5207RowOutcome {
  if (before === null) return 'unknown_before'
  if (before === after) return before ? 'unchanged_quarantined' : 'unchanged_clean'
  return before && !after ? 'newly_cleared' : 'newly_quarantined'
}

function printHelp(): void {
  console.log(`
SMI-5207 Wave 1 Step 4b — core weekly-scanner blast-radius verifier

Usage:
  npx tsx scripts/indexer/smi5207-blast-radius-weekly.ts --fixtures
  npx tsx scripts/indexer/smi5207-blast-radius-weekly.ts --population=<path> [options]

Options:
  --fixtures               Use this worker's built-in hand-crafted sample
                            (see smi5207-blast-radius.fixtures.ts). Mutually
                            exclusive with --population.
  --population=<path>      A JSON array (or {skills:[...]}) of
                            Smi5207PopulationSkill rows — see
                            smi5207-blast-radius.types.ts for the shape and
                            how to source "beforeQuarantined" for a real run.
  --allowlist-path=<path>  Default: ${DEFAULT_ALLOWLIST_PATH}
  --allowed-flip=<skillId> Additional skillId allowed to newly clear, beyond
                            the plan's own named list (repeatable).
  --report-path=<path>     Default: ${DEFAULT_REPORT_PATH}
  --help, -h                This message.
`)
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp()
    return
  }

  const allowedFlipOverrides: string[] = []
  const remainingArgv: string[] = []
  for (const raw of argv) {
    if (raw.startsWith('--allowed-flip=')) {
      allowedFlipOverrides.push(raw.slice('--allowed-flip='.length))
    } else {
      remainingArgv.push(raw)
    }
  }

  const common = parseCommonArgs(remainingArgv, { reportPath: DEFAULT_REPORT_PATH })
  const { population, source } = loadPopulation(common)
  const { matcher, entryCount } = loadAllowlistMatcher(common.allowlistPath)

  // Additive to the plan's own named list, never a replacement — Step 4
  // item 1's floor ("the two live FPs..., plausibly entries 1 and 3... —
  // and nothing else") is a deliberate default posture, not a suggestion.
  const allowedFlipList = [...new Set([...SMI5207_NAMED_ALLOWED_FLIPS, ...allowedFlipOverrides])]

  const scanner = new SecurityScanner()
  const rows: Smi5207WeeklyRow[] = []
  const counts: Record<Smi5207RowOutcome, number> = {
    unchanged_quarantined: 0,
    unchanged_clean: 0,
    newly_cleared: 0,
    newly_quarantined: 0,
    unknown_before: 0,
  }

  for (const skill of population) {
    const result = scanSkill(skill, scanner, DEFAULT_TRUST_CONFIG, matcher)
    const before = skill.beforeQuarantined ?? null
    const after = result.isQuarantined
    const outcome = classifyOutcome(before, after)
    counts[outcome]++

    const highestSeverity =
      result.scanReport.findings.length > 0
        ? result.scanReport.findings.reduce((worst, f) => {
            const rank = { low: 0, medium: 1, high: 2, critical: 3 } as const
            return rank[f.severity] > rank[worst] ? f.severity : worst
          }, result.scanReport.findings[0].severity)
        : null

    rows.push({
      skillId: skill.id,
      before,
      after,
      afterRiskScore: result.scanReport.riskScore,
      afterHighestSeverity: highestSeverity,
      outcome,
    })
  }

  const violations = rows.filter(
    (r) =>
      r.outcome === 'newly_quarantined' ||
      (r.outcome === 'newly_cleared' && !allowedFlipList.includes(r.skillId))
  )

  const report: Smi5207WeeklyReport = {
    reportKind: 'smi5207_blast_radius_weekly',
    generatedAt: new Date().toISOString(),
    scannerRulesetVersion: SCANNER_RULESET_VERSION,
    allowlistPath: common.allowlistPath,
    allowlistEntryCount: entryCount,
    allowedFlipList,
    populationSource: source,
    totalScanned: rows.length,
    counts,
    violations,
    rows,
  }

  const reportPath = common.reportPath ?? DEFAULT_REPORT_PATH
  writeFileSync(reportPath, JSON.stringify(report, null, 2))

  printSummary(report)
  console.log(`Report written to ${reportPath}`)

  process.exitCode = violations.length > 0 ? 1 : 0
}

function printSummary(report: Smi5207WeeklyReport): void {
  console.log(`\nSMI-5207 blast-radius (weekly scanner) — ${report.populationSource}`)
  console.log(`Scanner ruleset: ${report.scannerRulesetVersion}`)
  console.log(
    `Allowlist: ${report.allowlistPath} (${report.allowlistEntryCount} entries); ` +
      `allowed-flip list: ${report.allowedFlipList.join(', ') || '(none)'}`
  )
  console.log(`Scanned ${report.totalScanned} skill(s):`)
  for (const [outcome, count] of Object.entries(report.counts)) {
    console.log(`  ${outcome}: ${count}`)
  }
  if (report.violations.length === 0) {
    console.log('\nCLEAN: no unexpected clears, nothing newly quarantined.')
  } else {
    console.log(`\n${report.violations.length} VIOLATION(S) — hand-review required:`)
    for (const v of report.violations) {
      console.log(
        `  - ${v.skillId}: ${v.outcome} (before=${v.before}, after=${v.after}, ` +
          `riskScore=${v.afterRiskScore}, highestSeverity=${v.afterHighestSeverity ?? 'none'})`
      )
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
}

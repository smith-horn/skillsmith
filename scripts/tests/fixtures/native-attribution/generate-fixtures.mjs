#!/usr/bin/env node
// scripts/tests/fixtures/native-attribution/generate-fixtures.mjs
// SMI-6684 Wave 3 — regenerates the DERIVED fixtures in cases/ mechanically
// from the REAL/REAL-PAIRED ones already committed alongside them, per the
// SMI-6684 plan's Wave 3 fixture rule ("Build the synthetic and derived
// files mechanically from the real ones... keep the generator next to
// them").
//
// Scope, honestly stated: only the three cases below have an actual
// mechanical relationship to a real capture (this is exactly the ADR-165 /
// the DERIVED provenance label — "computed mechanically from a real
// capture"). Every other fixture under cases/ is provenance-labeled
// `synthetic-*` because it was hand-built and never observed live (§3.3) --
// N-norep/synthetic-stdout included (SMI-6684 Wave 3 review F-16b): it is
// hand-reconstructed from the checker's SOURCE text, not computed from a
// `real-*` capture, so it does not qualify as `derived-`. There is nothing
// to mechanically derive these FROM, so this script does not touch them.
// Re-running this script is idempotent and reproduces the three
// `derived-*` files byte-for-byte from their real- siblings.
//
// Run: node scripts/tests/fixtures/native-attribution/generate-fixtures.mjs

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CASES = join(HERE, 'cases')

function read(caseId, name) {
  return readFileSync(join(CASES, caseId, name), 'utf8')
}
function write(caseId, name, content) {
  writeFileSync(join(CASES, caseId, name), content)
}

// ---------------------------------------------------------------------
// 1. R-wt-degraded/derived-report — built from R-wt-degraded/real-stdout
//    (the smi-6676-handle-relative-removal-spike-dev-1.out real capture,
//    host path already normalised to /HOST/skillsmith). missing_destinations
//    is every `FAIL [A2] declared but NOT mounted: <path>` line's resolved
//    path; findings is every `FAIL [` line (A2 + A4 combined); mounted =
//    in_scope_expected - missing. Matches check-mount-composition.sh's own
//    counting (:255, :392-397): findings increments per fail(), missing is
//    the A2-only subset.
// ---------------------------------------------------------------------
function deriveWtDegradedReport() {
  const stdout = read('R-wt-degraded', 'real-stdout')
  const lines = stdout.split('\n')
  const missing = []
  let findings = 0
  for (const line of lines) {
    if (line.startsWith('FAIL [')) findings += 1
    const m = line.match(/^FAIL \[A2\] declared but NOT mounted: (\S+) /)
    if (m) missing.push(m[1])
  }
  const inScopeExpected = 167
  const mounted = inScopeExpected - missing.length
  const report = {
    schema: 2,
    at: 'DERIVED',
    report_key: 'DERIVED',
    container: 'DERIVED',
    scope_host_path: 'DERIVED',
    mode: 'worktree',
    service: 'dev',
    scope: '/app',
    declared_entries: 178,
    parse_errors: 0,
    in_scope_expected: inScopeExpected,
    mounted,
    missing: missing.length,
    backing_checked: mounted,
    backing_substituted: 0,
    findings,
    not_evaluated: 0,
    skipped: 1,
    live_probes: 1,
    live_write: 0,
    missing_destinations: missing,
  }
  write('R-wt-degraded', 'derived-report', JSON.stringify(report) + '\n')
}

// ---------------------------------------------------------------------
// 2. T-partial-evidence/derived-stdout — the first 40 lines of
//    R-wt-degraded/real-stdout, i.e. the same real 6676 capture cut right
//    after its last FALL-THROUGH FAIL line (spec §3.3: "first 40 lines of
//    6676, ending in the fall-through line") — simulating a checker killed
//    by `timeout` (rc=124) after emitting that evidence but before its
//    summary line.
// ---------------------------------------------------------------------
function deriveTPartialEvidenceStdout() {
  const stdout = read('R-wt-degraded', 'real-stdout')
  const lines = stdout.split('\n')
  const first40 = lines.slice(0, 40).join('\n') + '\n'
  write('T-partial-evidence', 'derived-stdout', first40)
}

// ---------------------------------------------------------------------
// 3. T-partial-lastline/derived-stdout — the same real partial capture as
//    R-timeout-partial/real-stdout (smi-6684-wire-mount-composition-detector's
//    890B capture, cut mid-A4 at rc=124). T-partial-lastline pairs this with
//    a SYNTHETIC final line with no trailing newline
//    (synthetic-nonl, hand-authored, not derived) to exercise the "the held
//    -back last line is dropped" rule (spec §1.2).
// ---------------------------------------------------------------------
function deriveTPartialLastlineStdout() {
  const stdout = read('R-timeout-partial', 'real-stdout')
  write('T-partial-lastline', 'derived-stdout', stdout)
}

// N-norep/synthetic-stdout is NOT generated here (SMI-6684 Wave 3 review
// F-16b): it is the exact early-exit A1 line
// scripts/lib/check-mount-composition.sh's own `fail A1 "no compose
// file..."` call (:157) produces when it finds no compose file at all --
// `fail()`'s `FAIL [%s] %s` format (sh:77) applied to A1 with root=/app --
// but it is hand-reconstructed from checker SOURCE, not computed from a
// `real-*` capture this script reads, so it is committed as its own
// synthetic-* source of truth alongside the other hand-built fixtures.

deriveWtDegradedReport()
deriveTPartialEvidenceStdout()
deriveTPartialLastlineStdout()

console.log('Regenerated 3 derived-* fixtures from their real-*/real-paired-* siblings.')

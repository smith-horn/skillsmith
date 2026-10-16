#!/usr/bin/env node
// SMI-7128: the W5 verdict must not score a MIXED group as one run, and RECORD-ONLY must
// not mask a short or never-run row.
//
// Before this fix w5Verdict scored a (row, fs) group with the first candidate's target
// and platform without asking whether the rest agreed, and `row.recordOnly` overwrote
// whatever verdict aggregateCell had reached -- including INCOMPLETE and NEVER-RAN --
// with RECORD-ONLY. Both are the same defect: a confident label standing in for evidence
// that is missing or inconsistent. C4's tallyCell/targetState is the precedent: an
// inconsistent target is INCOMPLETE, and a failure still beats it.
//
// Every INCOMPLETE case is paired with a consistent group from the same builder that must
// NOT be INCOMPLETE, so a verdict function that returned INCOMPLETE for everything fails.
//
// DECLARED FAILURES (pre-fix): "mixed target/platform/run ... is INCOMPLETE" get a PASS
// verdict; "record-only: a short run stays INCOMPLETE" and "... never-ran stays NEVER-RAN"
// get RECORD-ONLY.

import { makeCheck } from './w5-test-util.mjs'
import { makeRecord } from './result-schema.mjs'
import {
  W5_ROWS,
  w5Verdict,
  W5_CONTRADICTS,
  w5GroupMixed,
  w5VariantCount,
} from './control-spec.w5.mjs'
import { w5SummarySection } from './w5-summary.mjs'

const { check, done, notRun } = makeCheck('[control-spec-w5]')

/** One W5 record. `cell` overrides are applied AFTER makeRecord, which drops cell.target. */
function rec(attack, candidate, { lost = 0, status = 'quarantined', cell = {}, run = 0 } = {}) {
  const r = makeRecord({
    cell: { attack, candidate, fs: 'apfs', runner: 'run-w5-rows' },
    run,
    precondition: { hookFired: true, mutationApplied: true },
    outcome: { status },
    userFiles: { checked: 1, lost, changed: 0 },
    fsCheck: { ok: true, failures: [] },
  })
  Object.assign(r.cell, { platform: 'darwin', target: 3, ...cell })
  return r
}
const many = (n, attack, candidate, o = {}) =>
  Array.from({ length: n }, (_, i) => rec(attack, candidate, { ...o, run: i }))
const verdictOf = (rowId, cand, ctl, target) =>
  w5Verdict(rowId, cand, ctl, W5_CONTRADICTS, target, 'darwin').agg.verdict

// Q6: one control arm, C4-stateroot, which must itself record a failure for a PASS.
const ctl = () => ({ 'C4-stateroot': many(3, 'W5-Q6', 'C4-stateroot', { lost: 1 }) })

// --- known-positive: a consistent group is PASS ---------------------------------------
check('consistent group is PASS', verdictOf('Q6', many(3, 'W5-Q6', 'candidate'), ctl(), 3), 'PASS')
check(
  'consistent group: nothing is mixed',
  w5GroupMixed(many(3, 'W5-Q6', 'candidate'), ctl()).length,
  0
)

// --- mixed groups are INCOMPLETE -------------------------------------------------------
const mixedTarget = [
  ...many(2, 'W5-Q6', 'candidate'),
  rec('W5-Q6', 'candidate', { cell: { target: 4 }, run: 2 }),
]
check(
  'mixed target is INCOMPLETE',
  verdictOf('Q6', mixedTarget, ctl(), 3),
  'INCOMPLETE (inconsistent target in one group)'
)
const mixedPlatform = [
  ...many(2, 'W5-Q6', 'candidate'),
  rec('W5-Q6', 'candidate', { cell: { platform: 'linux' }, run: 2 }),
]
check(
  'mixed platform is INCOMPLETE',
  verdictOf('Q6', mixedPlatform, ctl(), 3),
  'INCOMPLETE (inconsistent platform in one group)'
)
const mixedRun = [
  ...many(2, 'W5-Q6', 'candidate'),
  rec('W5-Q6', 'candidate', { cell: { node: 'v0.0.0-other' }, run: 2 }),
]
check(
  'mixed run identity is INCOMPLETE',
  verdictOf('Q6', mixedRun, ctl(), 3),
  'INCOMPLETE (inconsistent run in one group)'
)
const linuxControl = {
  'C4-stateroot': many(3, 'W5-Q6', 'C4-stateroot', { lost: 1, cell: { platform: 'linux' } }),
}
check(
  'a control made on another platform is a mixed group',
  verdictOf('Q6', many(3, 'W5-Q6', 'candidate'), linuxControl, 3),
  'INCOMPLETE (inconsistent platform in one group)'
)
// a loss still beats the inconsistency: failures win, as in cellVerdict()
const mixedWithLoss = [
  ...many(2, 'W5-Q6', 'candidate'),
  rec('W5-Q6', 'candidate', { lost: 1, cell: { platform: 'linux' }, run: 2 }),
]
check(
  'a loss beats a mixed group (FAIL)',
  /^FAIL/.test(verdictOf('Q6', mixedWithLoss, ctl(), 3)),
  true
)

// --- the summary section carries it -------------------------------------------------------
const goodSec = w5SummarySection([...many(3, 'W5-Q6', 'candidate'), ...ctl()['C4-stateroot']])
check(
  'summary: a consistent group renders PASS',
  /\| W5-Q6 \| apfs \| PASS \|/.test(goodSec.lines[0]),
  true
)
const badSec = w5SummarySection([...mixedPlatform, ...ctl()['C4-stateroot']])
check(
  'summary: a mixed group renders INCOMPLETE',
  /\| W5-Q6 \| apfs \| INCOMPLETE \(inconsistent platform in one group\) \|/.test(badSec.lines[0]),
  true
)

// --- RECORD-ONLY never masks INCOMPLETE / NEVER-RAN ------------------------------------------
// P2r is record-only with no controls.
check(
  'record-only: a full clean run is RECORD-ONLY',
  verdictOf('P2r', many(5, 'W5-P2r', 'candidate', { cell: { target: 5 } }), {}, 5),
  'RECORD-ONLY'
)
check(
  'record-only: a short run stays INCOMPLETE',
  verdictOf('P2r', many(3, 'W5-P2r', 'candidate', { cell: { target: 5 } }), {}, 5),
  'INCOMPLETE (ran 3/5)'
)
check(
  'record-only: a never-ran row stays NEVER-RAN',
  /^NEVER-RAN/.test(
    verdictOf(
      'P2r',
      many(5, 'W5-P2r', 'candidate', { status: 'harness-error', cell: { target: 5 } }),
      {},
      5
    )
  ),
  true
)
check(
  'record-only: a loss is still recorded as RECORD-ONLY (n lost)',
  verdictOf(
    'P2r',
    [
      rec('W5-P2r', 'candidate', { lost: 1, cell: { target: 3 } }),
      ...many(2, 'W5-P2r', 'candidate', { cell: { target: 3 } }),
    ],
    {},
    3
  ),
  'RECORD-ONLY (1 lost)'
)

// --- SMI-7128: the summary's expected run count (no cell.target on real records) ----------
// Real W5 records carry no cell.target, so the summary scores a group against the design
// count target x variants. A short group must read INCOMPLETE; a full one PASS.
// DECLARED FAILURE (pre-fix w5-summary.mjs): the short group renders PASS, because with no
// target aggregateCell compares the records to their own count.
const sec = (recs) => w5SummarySection(recs).lines[0]
const q6Ctl = ctl()['C4-stateroot']
const noTarget = (recs) => recs.map((r) => (delete r.cell.target, r))
check(
  'summary: a short group (5 of design 10) renders INCOMPLETE (ran 5/10)',
  /\| W5-Q6 \| apfs \| INCOMPLETE \(ran 5\/10\) \|/.test(
    sec([...noTarget(many(5, 'W5-Q6', 'candidate')), ...noTarget(q6Ctl)])
  ),
  true
)
check(
  'summary: a full group (10 of design 10) renders PASS',
  /\| W5-Q6 \| apfs \| PASS \|/.test(
    sec([
      ...noTarget(many(10, 'W5-Q6', 'candidate')),
      ...noTarget(many(3, 'W5-Q6', 'C4-stateroot', { lost: 1 })),
    ])
  ),
  true
)
// Q7 defines 3 variants on darwin and 5 on linux, so the design count follows cell.platform.
const q7 = (n, platform) => [
  ...noTarget(many(n, 'W5-Q7', 'candidate', { cell: { platform } })),
  ...noTarget(many(3, 'W5-Q7', 'C4-consolation', { lost: 1, cell: { platform } })),
]
// SMI-7132 F5: win32 has no Q7 design count. DECLARED FAILURE (pre-fix w5-summary.mjs): the group
// is scored against its own record count and renders PASS.
check(
  'summary: no design count for the platform renders INCOMPLETE, never PASS',
  /\| W5-Q7 \| apfs \| INCOMPLETE \(no design count for platform win32\) \|/.test(
    sec(q7(30, 'win32'))
  ),
  true
)
// The no-design-count override applies ONLY to a PASS-family verdict (SMI-7134). DECLARED
// FAILURE (pre-fix w5-summary.mjs): the never-ran group below is rewritten to INCOMPLETE (no
// design count ...), hiding that nothing ran. The full PASS-shaped group above is the paired
// case that must still become INCOMPLETE.
const q7NeverRan = [
  ...noTarget(
    many(30, 'W5-Q7', 'candidate', { status: 'harness-error', cell: { platform: 'win32' } })
  ),
  ...noTarget(many(3, 'W5-Q7', 'C4-consolation', { lost: 1, cell: { platform: 'win32' } })),
]
check(
  'summary: no design count + zero runs stays NEVER-RAN',
  /\| W5-Q7 \| apfs \| NEVER-RAN/.test(sec(q7NeverRan)),
  true
)
check(
  'summary: no design count + zero runs is not rewritten to INCOMPLETE',
  /INCOMPLETE \(no design count/.test(sec(q7NeverRan)),
  false
)
check(
  'summary: no design count + full PASS-shaped group becomes INCOMPLETE (paired with the above)',
  /\| W5-Q7 \| apfs \| INCOMPLETE \(no design count for platform win32\) \|/.test(
    sec(q7(30, 'win32'))
  ),
  true
)
check(
  'summary: Q7 on linux wants 50 (10 x 5): 30 is INCOMPLETE (ran 30/50)',
  /INCOMPLETE \(ran 30\/50\)/.test(sec(q7(30, 'linux'))),
  true
)
check(
  'summary: Q7 on darwin wants 30 (10 x 3): 30 is complete',
  /\| W5-Q7 \| apfs \| PASS \|/.test(sec(q7(30, 'darwin'))),
  true
)

// --- the variants counts match the attack modules (they cannot drift) -----------------------
// Loaded exactly as run-w5-rows.mjs's rowDef does. A platform-keyed count is checked for the
// platform this process runs on; the other platform's value cannot be loaded here.
{
  const modules = {}
  const rowDef = async (r) => {
    const file = r.startsWith('Q')
      ? 'w5-rows-q.mjs'
      : ['R1', 'P5', 'P6', 'W1'].includes(r)
        ? 'w5-rows-r.mjs'
        : 'w5-rows-p.mjs'
    modules[file] ??= await import(`./${file}`)
    const m = modules[file]
    return (m.Q_ROWS ?? {})[r] ?? (m.R_ROWS ?? {})[r] ?? (m.P_ROWS ?? {})[r]
  }
  // P1's Linux count is the root run's (two mount kinds x three timings). Without root the
  // module defines one 'no-mounts' variant, so the comparison is meaningless there: it is
  // NOT RUN, not a pass or a failure. A non-root run itself scores INCOMPLETE against the
  // design count, which is the intended reading of a run that could not mount.
  const nonRootLinux = process.platform === 'linux' && process.getuid?.() !== 0
  let compared = 0
  let skippedRows = 0
  for (const row of Object.keys(W5_ROWS)) {
    if (row === 'P1' && nonRootLinux) {
      notRun('variants: P1', 'linux without root defines no mounts')
      skippedRows += 1
      continue
    }
    const def = await rowDef(row)
    check(
      `variants: ${row} matches its module (${process.platform})`,
      w5VariantCount(row),
      def?.variants.length
    )
    compared += 1
  }
  check(
    'variants: every row was compared or reported NOT RUN',
    compared + skippedRows,
    Object.keys(W5_ROWS).length
  )
}
done()

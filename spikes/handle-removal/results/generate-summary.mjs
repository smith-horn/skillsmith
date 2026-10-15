#!/usr/bin/env node
// SMI-6676 plan §8 step 14: regenerates results/SUMMARY.md from
// results/raw/*.jsonl only -- no hand-typed counts. Every runner in this
// spike wrote records via harness/result-schema.mjs's makeRecord(), and
// none of them used a non-trivial isContradictory predicate (all passed
// `() => false`), so classifyRecord() reproduces each run's own verdict
// exactly from the recorded fields alone.
//
// The verdict column implements the WHOLE plan §9 rule, control clause
// included: "PASS only when ran == target, never-ran == 0 and failed == 0,
// AND the attack's control cell on the same filesystem recorded failed >= 1
// ... if the control didn't fail, the fixture is invalid: the cell is
// NEVER-RAN (control)". An earlier version of this file had its own local
// verdict() that dropped the control clause entirely, so a cell whose control
// never ran was indistinguishable from one whose control bit -- which is the
// exact failure this spike's own three-way classification exists to prevent,
// reproduced one level up. The Control column now names, per cell, which
// control the plan requires and what happened to it.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { classifyRecord } from '../harness/result-schema.mjs'
import { tallyCell, cellVerdict } from '../harness/cell-tally.mjs'
import {
  resolveControl,
  controlFailedFlag,
  controlTag,
  verdictTallyKey,
} from '../harness/control-spec.mjs'
import { isW5, w5SummarySection } from '../harness/w5-summary.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const RAW_DIR = path.join(HERE, 'raw')
const OUT_PATH = path.join(HERE, 'SUMMARY.md')

/**
 * Attack-cell records carry `cell`. Measurement artifacts written to the same
 * directory carry a `schema` instead (e.g. `c4-guard-window/1`) and are not
 * cells, so they are set aside BY NAME and reported in the summary header.
 *
 * SMI-6711, 2026-10-12: `c4-guard-window.jsonl` (2026-09-17) holds 210
 * schema-only records, and this loader passed them to `cellKey()`, which threw
 * on `r.cell.attack`. So SUMMARY.md could not be regenerated at all from that
 * day on. A record with neither `cell` nor `schema` still throws: it is
 * neither a cell nor a known measurement, and dropping it silently would
 * change the tallies with nothing saying so. Malformed lines are still
 * skipped, but are now counted and reported rather than vanishing.
 */
function loadAllRecords() {
  const records = []
  const measurementFiles = new Map()
  const attackFiles = new Set()
  let malformed = 0
  for (const file of fs.readdirSync(RAW_DIR).sort()) {
    // TOP-LEVEL REGULAR FILES ONLY: superseded runs kept in subdirectories
    // (w5-superseded/, step1b-superseded/, ...) are never read.
    if (!file.endsWith('.jsonl') || !fs.statSync(path.join(RAW_DIR, file)).isFile()) continue
    const lines = fs.readFileSync(path.join(RAW_DIR, file), 'utf8').split('\n').filter(Boolean)
    for (const line of lines) {
      let r
      try {
        r = JSON.parse(line)
      } catch {
        malformed += 1
        continue
      }
      if (r && typeof r.cell === 'object' && r.cell !== null) {
        records.push({ ...r, _file: file })
        attackFiles.add(file)
      } else if (r && typeof r.schema === 'string') {
        measurementFiles.set(file, (measurementFiles.get(file) ?? 0) + 1)
      } else {
        throw new Error(`${file}: a record with neither "cell" nor "schema" -- refusing to guess`)
      }
    }
  }
  return { records, attackFiles, measurementFiles, malformed }
}

function cellKey(r) {
  const parts = [r.cell.attack, r.cell.variant, r.cell.candidate, r.cell.fs]
  // A cell scaled by a directory count is a different cell; only when present, so
  // every record that has no `dirs` keys exactly as before.
  if (r.cell.dirs !== undefined) parts.push('dirs=' + r.cell.dirs)
  return parts.join('\u0000')
}

function aggregate(records) {
  const byCell = new Map()
  for (const r of records) {
    const key = cellKey(r)
    if (!byCell.has(key)) {
      byCell.set(key, {
        attack: r.cell.attack,
        variant: r.cell.variant,
        candidate: r.cell.candidate,
        fs: r.cell.fs,
        ...(r.cell.dirs !== undefined ? { dirs: r.cell.dirs } : {}),
        records: [],
      })
    }
    byCell.get(key).records.push(r)
  }
  const rows = []
  for (const cell of byCell.values()) {
    const t = tallyCell(cell.records, (r) => classifyRecord(r, () => false), records)
    rows.push({ ...cell, ...t })
  }
  return rows
}

/** The plan §9 rule in full, control clause included. */
function verdict(row, controlState) {
  // The §9 rule now lives in control-spec.mjs's verdictFor(), because R6 added a
  // clause that must not drift between this generator and aggregateCell(): a
  // PROBABILISTIC attack is scored on the LANDED SUBSET, so a run where the
  // racer never landed leaves the denominator instead of counting against the
  // cell. Two copies of a verdict rule is how this file got its control clause
  // wrong the first time.
  return cellVerdict(row, row.attack, controlFailedFlag(controlState), controlState)
}

function main() {
  const { records, attackFiles, measurementFiles, malformed } = loadAllRecords()
  // SMI-7123 W5: W5 rows are scored by their own verdict function (control-spec.w5.mjs,
  // via harness/w5-summary.mjs) in their own section. As generic cells they had no
  // control spec and read `NEVER-RAN (control unspecified)`, with controls as FAIL.
  const w5Records = records.filter(isW5)
  const generic = records.filter((r) => !isW5(r))
  const rows = aggregate(generic).sort((a, b) =>
    (a.attack + a.fs + a.candidate + a.variant).localeCompare(
      b.attack + b.fs + b.candidate + b.variant
    )
  )
  for (const row of rows) {
    const c = resolveControl(row, rows)
    row.controlState = c.state
    row.controlDetail = c.detail
    row.verdict = verdict(row, c.state)
  }

  const tally = {}
  // RECORD-ONLY verdicts carry a count parenthetical; tally them under one key.
  for (const row of rows) {
    const key = verdictTallyKey(row.verdict)
    tally[key] = (tally[key] ?? 0) + 1
  }
  const controlTally = {}
  for (const row of rows) controlTally[row.controlState] = (controlTally[row.controlState] ?? 0) + 1

  const lines = []
  lines.push('# SMI-6676 spike results summary')
  lines.push('')
  lines.push(
    `Regenerated from ${attackFiles.size} \`results/raw/*.jsonl\` files, ${records.length} total records. Do not hand-edit -- run \`node results/generate-summary.mjs\` after any new attack run.`
  )
  lines.push('')
  const measured = [...measurementFiles].map(([f, n]) => `\`${f}\` (${n})`).join(', ')
  lines.push(
    `Not attack cells, so not counted above: measurement files ${measured || 'none'}; malformed lines skipped: ${malformed}.`
  )
  lines.push('')
  lines.push('## Verdict tally')
  lines.push('')
  lines.push('| Verdict | Cells |')
  lines.push('|---|---|')
  for (const [k, v] of Object.entries(tally).sort()) lines.push(`| ${k} | ${v} |`)
  lines.push('')
  lines.push(
    'The verdict applies the WHOLE plan §9 rule: `PASS` requires `ran == target`, ' +
      '`never-ran == 0`, `failed == 0` **and** a same-filesystem control cell with ' +
      '`failed >= 1`. `NEVER-RAN (control)` means the candidate itself was clean but ' +
      "the plan's named control never demonstrated the loss on that filesystem, so the " +
      'fixture proves nothing. `PASS (control unverified)` means the control the plan ' +
      'names is real but lives outside this JSONL (a feasibility script, or a cited ' +
      'earlier experiment) and this harness can neither confirm nor refute it.'
  )
  if (rows.some((r) => verdictTallyKey(r.verdict) === 'RECORD-ONLY')) {
    lines.push('')
    lines.push(
      '`RECORD-ONLY` marks a cell that is recorded, not scored (ADR-166 D-0: the out-of-model ' +
        'window). It is never a `PASS` or a `FAIL`; the count after it, when present, is the ' +
        'number of runs that lost user bytes (`lost`) or never ran (`never-ran`), shown so the ' +
        'loss stays visible without being scored as a falsifier. The tally counts all of them ' +
        'under one `RECORD-ONLY` row.'
    )
  }
  lines.push('')
  lines.push('## Control status tally')
  lines.push('')
  lines.push('| Control state | Cells |')
  lines.push('|---|---|')
  for (const [k, v] of Object.entries(controlTally).sort())
    lines.push(`| ${controlTag(k)} | ${v} |`)
  lines.push('')
  lines.push('## Cells')
  lines.push('')
  lines.push(
    '| Attack | Variant | Candidate | FS | Ran | Passed | Failed | Never-ran | Control | Verdict |'
  )
  lines.push('|---|---|---|---|---|---|---|---|---|---|')
  for (const row of rows) {
    lines.push(
      `| ${row.attack} | ${row.variant ?? ''}${row.dirs !== undefined ? ` [dirs=${row.dirs}]` : ''} | ${row.candidate} | ${row.fs} | ${row.ran} | ${row.passed} | ${row.failed} | ${row.neverRan} | ${controlTag(row.controlState)} | ${row.verdict} |`
    )
  }
  lines.push('')
  lines.push(`Total: ${rows.length} cells, ${generic.length} runs.`)
  lines.push('')
  if (rows.some((r) => r.excluded > 0 || r.callerIntentExcluded > 0)) {
    lines.push('## Cells with excluded runs')
    lines.push('')
    lines.push(
      'A C4 run flagged `vacuous-check` (its only check was vacuous, e.g. a partial race that ' +
        'left no user-created path) leaves the denominator like a non-landing and does not count ' +
        'toward the 100-landing floor. A non-landing whose moved tree is proved equal to the tree ' +
        'the caller hashed (`pre-caller-hash`, caller-intent) is excluded the same way. Counts are shown here so they stay visible.'
    )
    lines.push('')
    lines.push(
      '| Attack | Variant | Candidate | FS | Ran | Excluded (vacuous) | Excluded (caller-intent) | Verdict |'
    )
    lines.push('|---|---|---|---|---|---|---|---|')
    for (const row of rows) {
      if (row.excluded > 0 || row.callerIntentExcluded > 0) {
        lines.push(
          `| ${row.attack} | ${row.variant ?? ''} | ${row.candidate} | ${row.fs} | ${row.ran} | ${row.excluded} | ${row.callerIntentExcluded} | ${row.verdict} |`
        )
      }
    }
    lines.push('')
  }
  lines.push('## Cells whose control did not bite')
  lines.push('')
  lines.push('| Attack | Variant | Candidate | FS | Control state | Why |')
  lines.push('|---|---|---|---|---|---|')
  for (const row of rows) {
    if (row.controlState !== 'absent' && row.controlState !== 'did-not-fail') continue
    lines.push(
      `| ${row.attack} | ${row.variant ?? ''} | ${row.candidate} | ${row.fs} | ${controlTag(row.controlState)} | ${row.controlDetail} |`
    )
  }
  lines.push('')

  if (w5Records.length > 0) {
    const w5 = w5SummarySection(w5Records)
    lines.push('## W5 rows (scored by control-spec.w5.mjs)')
    lines.push('')
    lines.push(
      'One line per (row, filesystem), scored by the same verdict function `harness/run-w5-rows.mjs` ' +
        'prints (`w5Verdict`), with the control evidence from that run. `RECORD-ONLY` rows record an ' +
        'out-of-model residual and are never counted as PASS or FAIL. These records are not in the ' +
        `Cells table or its tallies above. ${w5Records.length} records, ${w5.rows} rows.`
    )
    lines.push('')
    lines.push('| W5 verdict | Rows |')
    lines.push('|---|---|')
    for (const [k, v] of Object.entries(w5.tally).sort()) lines.push(`| ${k} | ${v} |`)
    lines.push('')
    lines.push('| Row | FS | Verdict | Ran | Passed | Failed | Never-ran | Control |')
    lines.push('|---|---|---|---|---|---|---|---|')
    for (const l of w5.lines) lines.push(l)
    lines.push('')
  }

  fs.writeFileSync(OUT_PATH, lines.join('\n') + '\n')
  console.log(
    `Wrote ${OUT_PATH} (${rows.length} cells from ${generic.length} records; W5: ${w5Records.length} records; ${records.length} records in all)`
  )
  console.log('verdicts:', JSON.stringify(tally))
  console.log('control  :', JSON.stringify(controlTally))
}

main()

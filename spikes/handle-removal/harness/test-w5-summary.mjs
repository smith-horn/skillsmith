#!/usr/bin/env node
// SMI-7123 Wave 5: results/generate-summary.mjs must score every W5-* record with
// the SAME verdict function run-w5-rows.mjs uses (control-spec.w5.mjs), one line
// per (row, fs), and keep W5 out of the generic attack-cell table and tallies.
//
// It runs the real generator (which writes results/SUMMARY.md) and ALWAYS restores
// the working copy's own bytes afterwards (saved before the run), so a regenerated,
// uncommitted SUMMARY.md is never lost. Comparisons are against HEAD's copy, read with
// `git show HEAD:...`.
//
// The runner's verdict lines come from the committed fixture
// results/w5-runner-verdicts.tsv (made by results/extract-w5-verdicts.mjs from the
// owner-approved run logs; Sol PR #3091 finding PR-12). If results/raw is absent
// the generator has nothing to score: this suite prints NOT RUN and exits 2.
//
//   node test-w5-summary.mjs [--committed <file>]
//
// --committed replaces the committed SUMMARY text in the COMPARISONS only (the
// restore always uses HEAD). It exists to show the W5-section case go red.
//
// DECLARED FAILURES:
//  - pre-fix generator: no W5 section (none of the 95 verdicts match the fixture),
//    and W5 records land in the generic Cells table, so the pre-W5 part is no
//    longer byte-identical to the committed SUMMARY;
//  - --committed with one W5 verdict altered: "the committed W5 section equals the
//    regenerated one" fails (Sol PR #3091 finding PR-16).
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { makeCheck } from './w5-test-util.mjs'

const TAG = '[w5-summary]'
const { check, done } = makeCheck(TAG)
const SPIKE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WT = path.resolve(SPIKE, '..', '..')
const SUMMARY = path.join(SPIKE, 'results', 'SUMMARY.md')
const RAW = path.join(SPIKE, 'results', 'raw')
const FIXTURE = path.join(SPIKE, 'results', 'w5-runner-verdicts.tsv')
const REL = 'spikes/handle-removal/results/SUMMARY.md'
const W5_HEADING = '\n## W5 rows (scored by control-spec.w5.mjs)'

if (!fs.existsSync(RAW)) {
  console.log(`${TAG} NOT RUN: results/raw unavailable`)
  process.exit(2)
}
const at = process.argv.indexOf('--committed')
const override = at === -1 ? null : process.argv[at + 1]

// The runner's verdict lines: (row, fs) -> fields, from the committed fixture.
const FIELDS = ['verdict', 'ran', 'passed', 'failed', 'neverRan', 'control']
const expected = new Map()
check('premise: the runner-verdict fixture is present', fs.existsSync(FIXTURE), true)
if (fs.existsSync(FIXTURE)) {
  for (const l of fs.readFileSync(FIXTURE, 'utf8').split('\n')) {
    if (l === '' || l.startsWith('#')) continue
    const c = l.split('\t')
    if (c.length !== 8) continue
    expected.set(`${c[0]}\0${c[1]}`, Object.fromEntries(FIELDS.map((k, i) => [k, c[i + 2]])))
  }
}
check('the fixture holds 19 rows x 5 filesystems', expected.size, 95)

const head = execFileSync('git', ['-C', WT, 'show', `HEAD:${REL}`]).toString()
const committed = override === null ? head : fs.readFileSync(override, 'utf8')
// The working copy's own bytes (null when the file is absent), saved BEFORE the generator
// overwrites it, so a developer's regenerated, uncommitted SUMMARY.md survives this suite.
const saved = fs.existsSync(SUMMARY) ? fs.readFileSync(SUMMARY) : null
let generated = null
let genOut = ''
try {
  genOut = execFileSync(process.execPath, [path.join(SPIKE, 'results', 'generate-summary.mjs')], {
    encoding: 'utf8',
  })
  generated = fs.readFileSync(SUMMARY, 'utf8')
} finally {
  if (saved === null) fs.rmSync(SUMMARY, { force: true })
  else fs.writeFileSync(SUMMARY, saved)
}
check(
  'premise: SUMMARY.md restored to the working copy it had before the run',
  saved === null ? !fs.existsSync(SUMMARY) : fs.readFileSync(SUMMARY).equals(saved),
  true
)

// --- the W5 section: one row per (row, fs), equal to the runner's line ---------------
const lines = generated.split('\n')
const start = lines.indexOf(W5_HEADING.slice(1))
const w5 = new Map()
if (start !== -1) {
  for (const l of lines.slice(start + 1)) {
    if (l.startsWith('## ')) break
    const c = l.split(' | ')
    if (c.length === 8 && c[0].startsWith('| W5-')) {
      const vals = [c[2], c[3], c[4], c[5], c[6], c[7].replace(/ \|$/, '')]
      w5.set(`${c[0].slice(2)}\0${c[1]}`, Object.fromEntries(FIELDS.map((k, i) => [k, vals[i]])))
    }
  }
}
check('the W5 section has one line per (row, fs)', w5.size, 95)
let equal = 0
const diffs = []
for (const [k, want] of expected) {
  const got = w5.get(k)
  if (got && JSON.stringify(got) === JSON.stringify(want)) equal += 1
  else if (diffs.length < 3)
    diffs.push(
      `${k.replace('\0', '/')}: want ${JSON.stringify(want)} got ${JSON.stringify(got ?? null)}`
    )
}
check(`every W5 verdict equals the runner's line${diffs.length ? ` (${diffs[0]})` : ''}`, equal, 95)

// --- the committed W5 section is exactly the regenerated one (PR-16) -----------------
// From the W5 heading to the next `## ` heading or the end of the file.
const sectionOf = (text) => {
  const s = text.indexOf(W5_HEADING)
  if (s === -1) return null
  const e = text.indexOf('\n## ', s + W5_HEADING.length)
  return e === -1 ? text.slice(s) : text.slice(s, e)
}
const firstDiff = (a, b) => {
  const x = (a ?? '').split('\n')
  const y = (b ?? '').split('\n')
  for (let i = 0; i < Math.max(x.length, y.length); i += 1)
    if (x[i] !== y[i]) return ` (line ${i}: committed ${JSON.stringify(x[i] ?? null)})`
  return ''
}
const cw5 = sectionOf(committed)
const gw5 = sectionOf(generated)
check('premise: the committed SUMMARY has a W5 section', cw5 !== null, true)
check(
  `the committed W5 section equals the regenerated one${cw5 === gw5 ? '' : firstDiff(cw5, gw5)}`,
  cw5 !== null && cw5 === gw5,
  true
)

// --- nothing else moves: everything BEFORE the W5 section equals the committed file,
// byte for byte, except the header's totals line (file and record counts). An
// earlier version stripped the section line by line and also dropped the file's
// final blank line, so it compared one newline short -- measured with a diff.
const dropHeader = (text) =>
  text
    .split('\n')
    .filter((l) => !l.startsWith('Regenerated from '))
    .join('\n')
// Both sides are cut at the W5 heading. Comparing the generated prefix with the WHOLE
// committed file held only while the committed copy had no W5 section; once the W5
// results were committed it could never match (found on the C4 merge branch).
const prefixOf = (text) => {
  const s = text.indexOf(W5_HEADING)
  return s === -1 ? text : text.slice(0, s) + '\n'
}
check(
  'everything before the W5 section is byte-identical to the committed SUMMARY (header totals aside)',
  dropHeader(prefixOf(generated)) === dropHeader(prefixOf(committed)),
  true
)
check(
  'no W5 record appears in the generic Cells table',
  /^\| W5-/m.test(generated.split('## W5 ')[0]),
  false
)
check(
  'the header counts every top-level record (154,600)',
  /154600 total records/.test(generated),
  true
)
console.log(`${TAG} generator said: ${genOut.trim().split('\n')[0]}`)
done()

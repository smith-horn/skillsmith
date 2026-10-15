#!/usr/bin/env node
// SMI-7123 Wave 5: results/generate-summary.mjs must score every W5-* record with
// the SAME verdict function run-w5-rows.mjs uses (control-spec.w5.mjs), one line
// per (row, fs), and keep W5 out of the generic attack-cell table and tallies.
//
// It runs the real generator (which writes results/SUMMARY.md) and ALWAYS restores
// the committed SUMMARY.md afterwards with `git show HEAD:...`, a read of the repo.
//
// DECLARED FAILURES ON THE PRE-FIX GENERATOR:
//  - no W5 section: none of the 95 (row, fs) verdicts match the runner's lines;
//  - W5 records land in the generic Cells table (316 extra cells, most reading
//    `NEVER-RAN (control unspecified)`), so the pre-W5 part is no longer
//    byte-identical to the committed SUMMARY.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { makeCheck } from './w5-test-util.mjs'

const { check, done } = makeCheck('[w5-summary]')
const SPIKE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WT = path.resolve(SPIKE, '..', '..')
const SUMMARY = path.join(SPIKE, 'results', 'SUMMARY.md')
const REL = 'spikes/handle-removal/results/SUMMARY.md'
const RUN =
  '/private/tmp/claude-501/-Users-williamsmith-Documents-GitHub-Smith-Horn-skillsmith/a40f91eb-a376-4707-9bd4-1f9f17abb39a/scratchpad/w5run'
const LOGS = {
  apfs: path.join(RUN, 'w5-apfs-full.log'),
  overlayfs: path.join(RUN, 'out-overlayfs', 'w5-rows-overlayfs.txt'),
  tmpfs: path.join(RUN, 'out-tmpfs', 'w5-rows-tmpfs.txt'),
  ext4: path.join(RUN, 'out-ext4', 'w5-rows-ext4.txt'),
  virtiofs: path.join(RUN, 'out-virtiofs', 'w5-rows-virtiofs.txt'),
}
const LINE =
  /^(.+)\t(W5-\S+)\tran=(\d+) passed=(\d+)(?: held=\d+)? failed=(\d+) never-ran=(\d+)\tcontrol=(.*)$/

// The runner's printed verdict lines: (row, fs) -> fields.
const expected = new Map()
for (const [fsLabel, file] of Object.entries(LOGS)) {
  if (!fs.existsSync(file)) {
    console.log(
      `[w5-summary] ${file} is absent: this suite checks the owner-approved W5 run and cannot run without its logs`
    )
    process.exit(1)
  }
  for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = LINE.exec(l)
    if (m)
      expected.set(`${m[2]}\0${fsLabel}`, {
        verdict: m[1],
        ran: m[3],
        passed: m[4],
        failed: m[5],
        neverRan: m[6],
        control: m[7],
      })
  }
}
check('the runner logs hold 19 rows x 5 filesystems', expected.size, 95)

const committed = execFileSync('git', ['-C', WT, 'show', `HEAD:${REL}`]).toString()
let generated = null
let genOut = ''
try {
  genOut = execFileSync(process.execPath, [path.join(SPIKE, 'results', 'generate-summary.mjs')], {
    encoding: 'utf8',
  })
  generated = fs.readFileSync(SUMMARY, 'utf8')
} finally {
  fs.writeFileSync(SUMMARY, committed)
}
check(
  'premise: SUMMARY.md restored to the committed copy',
  fs.readFileSync(SUMMARY, 'utf8') === committed,
  true
)

// --- the W5 section: one row per (row, fs), equal to the runner's line ---------------
const lines = generated.split('\n')
const start = lines.indexOf('## W5 rows (scored by control-spec.w5.mjs)')
const w5 = new Map()
if (start !== -1) {
  for (const l of lines.slice(start + 1)) {
    if (l.startsWith('## ')) break
    const c = l.split(' | ')
    if (c.length === 8 && c[0].startsWith('| W5-')) {
      w5.set(`${c[0].slice(2)}\0${c[1]}`, {
        verdict: c[2],
        ran: c[3],
        passed: c[4],
        failed: c[5],
        neverRan: c[6],
        control: c[7].replace(/ \|$/, ''),
      })
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

// --- nothing else moves: everything BEFORE the W5 section equals the committed file,
// byte for byte, except the header's totals line (file and record counts). The W5
// section is appended last, so the committed text is exactly that prefix. (An
// earlier version stripped the section line by line and also dropped the file's
// final blank line, so it compared one newline short -- measured with a diff.)
const dropHeader = (text) =>
  text
    .split('\n')
    .filter((l) => !l.startsWith('Regenerated from '))
    .join('\n')
// Both sides are cut at the W5 heading. Comparing the generated prefix with the WHOLE
// committed file held only while the committed copy had no W5 section; once the W5
// results were committed it could never match (found on the C4 merge branch).
const W5_HEADING = '\n## W5 rows (scored by control-spec.w5.mjs)'
const prefixOf = (text) => {
  const at = text.indexOf(W5_HEADING)
  return at === -1 ? text : text.slice(0, at) + '\n'
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
console.log(`[w5-summary] generator said: ${genOut.trim().split('\n')[0]}`)
done()

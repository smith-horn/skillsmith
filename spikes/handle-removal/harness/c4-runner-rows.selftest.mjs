// SMI-6715 Step 1b part 2, item 6: the runner rows and control rows for B0-C4
// and A13-C4-POSTHASH. Drives run-c4-attacks.mjs as a child, one run per arm at
// a small --dirs, writing to a throwaway --out (never results/raw).
//
// DECLARED FAILURE ON THE PRE-CHANGE HARNESS: '--only b0' / '--only a13p' are
// unknown entries (exit 2, "unknown --only entry"); B0-C4 has no control row
// (resolveControl -> 'unspecified'), A13-C4-POSTHASH has none either and is not
// probabilistic.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolveControl, isProbabilistic, controlFailedFlag } from './control-spec.mjs'

const TAG = '[c4-runner-rows self-test]'
let allOk = true
function check(label, actual, expected) {
  const ok = actual === expected
  allOk = allOk && ok
  console.log(
    `${TAG} ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)} -- ${ok ? 'PASS' : 'FAIL'}`
  )
}
const here = path.dirname(fileURLToPath(import.meta.url))

// --- control rows -------------------------------------------------------------
check(
  'C1 B0-C4 control is none by design',
  resolveControl({ attack: 'B0-C4', candidate: 'C4', fs: 'f' }, []).state,
  'none'
)
{
  const rows = [
    {
      attack: 'A13-C4-POSTHASH',
      variant: 'racer/post-hash',
      candidate: 'C4',
      fs: 'f',
      failed: 0,
      controlFailures: 0,
    },
    {
      attack: 'A13-C4-POSTHASH',
      variant: 'racer/post-hash',
      candidate: 'C4-naive',
      fs: 'f',
      failed: 3,
      controlFailures: 3,
    },
  ]
  check(
    'C2 A13-C4-POSTHASH is controlled by C4-naive',
    resolveControl(rows[0], rows).state,
    'satisfied'
  )
  check('C2b and the naive cell is the control', resolveControl(rows[1], rows).state, 'is-control')
  check(
    'C2c a naive that did not fail leaves the C4 cell uncontrolled',
    controlFailedFlag(
      resolveControl(rows[0], [rows[0], { ...rows[1], failed: 0, controlFailures: 0 }]).state
    ),
    false
  )
}
check('C3 A13-C4-POSTHASH is probabilistic (R6)', isProbabilistic('A13-C4-POSTHASH'), true)
check('C3b B0-C4 is not', isProbabilistic('B0-C4'), false)

// --- runner rows ----------------------------------------------------------------
function runRunner(only, extra = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's6715-rows-'))
  try {
    const out = path.join(dir, 'out.jsonl')
    const r = spawnSync(
      process.execPath,
      [
        path.join(here, 'run-c4-attacks.mjs'),
        '--out',
        out,
        '--only',
        only,
        '--target',
        '1',
        ...extra,
      ],
      { encoding: 'utf8', timeout: 300000 }
    )
    const records = fs.existsSync(out)
      ? fs
          .readFileSync(out, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : []
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', records }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
{
  const r = runRunner('b0', ['--dirs', '50'])
  check('R1 --only b0 runs (exit 0)', r.status, 0)
  if (r.status !== 0) console.log(r.stderr.slice(0, 400))
  check('R1b one record per arm', r.records.length, 2)
  check(
    'R1c labelled B0-C4/untouched/dirs=50',
    r.records.length > 0 &&
      r.records.every((x) => x.cell.attack === 'B0-C4' && x.cell.variant === 'untouched/dirs=50'),
    true
  )
  check(
    'R1d both arms quarantined',
    r.records.map((x) => x.outcome.status).join(','),
    'quarantined,quarantined'
  )
  check(
    'R1e the verdict line names the cell',
    /B0-C4\/untouched\/dirs=50\/C4\t/.test(r.stdout),
    true
  )
}
{
  const r = runRunner('a13p', ['--dirs', '50'])
  check('R2 --only a13p runs (exit 0)', r.status, 0)
  if (r.status !== 0) console.log(r.stderr.slice(0, 400))
  check('R2b one record per arm', r.records.length, 2)
  check(
    'R2c every record is A13-C4-POSTHASH/racer/post-hash/dirs=50',
    r.records.length > 0 &&
      r.records.every(
        (x) => x.cell.attack === 'A13-C4-POSTHASH' && x.cell.variant === 'racer/post-hash/dirs=50'
      ),
    true
  )
  check(
    'R2d phase classes are recorded',
    r.records.length > 0 && r.records.every((x) => Array.isArray(x.extra?.phaseClasses)),
    true
  )
  check(
    'R2e the verdict lines name the cell',
    /A13-C4-POSTHASH\/racer\/post-hash\/dirs=50\/C4-naive\t/.test(r.stdout),
    true
  )
}

if (!allOk) {
  console.log(`${TAG} SOME CASES FAILED`)
  process.exit(1)
}
console.log(`${TAG} all cases passed`)

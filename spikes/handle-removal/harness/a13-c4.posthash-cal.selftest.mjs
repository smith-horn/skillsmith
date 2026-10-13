// SMI-6715 Step 1b part 2, change A: A13-C4-POSTHASH calibrates its racer delay
// per filesystem and per invocation, openly.
//
//  K1-K3  calibrateWindow (pure, probe injected): median/p10/p90 of C4's
//         hash-end -> rename-call window, ceiling = FRACTION x median, n.
//  K4-K6  a degenerate or unmeasurable window FAILS LOUDLY (throws) -- never a
//         silent fixed default.
//  K7-K9  a real run records the calibration it used, and its delay is drawn
//         under that ceiling.
//
// DECLARED FAILURE ON THE PRE-CHANGE CODE: calibrateWindow does not exist (its
// dynamic import fails, reported as a FAIL line) and a real POSTHASH record has
// no extra.posthashCalibration; its ceiling is the fixed 0.233 ms.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as posthash from './attacks/a13-c4.posthash.mjs'
import { resolveHarnessRoot } from './fixture-root.mjs'

const TAG = '[a13-c4 posthash calibration self-test]'
let allOk = true
function check(label, actual, expected) {
  const ok = actual === expected
  allOk = allOk && ok
  console.log(
    `${TAG} ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)} -- ${ok ? 'PASS' : 'FAIL'}`
  )
}
const throwsMsg = (fn) => {
  try {
    fn()
    return 'did not throw'
  } catch (err) {
    return String(err.message)
  }
}

const cal = typeof posthash.calibrateWindow === 'function' ? posthash.calibrateWindow : null
check('K0 calibrateWindow is exported', cal !== null, true)
if (cal) {
  // 11 windows: sorted 0.1..1.1 -> median 0.6, p10 0.2, p90 1.0.
  const ws = [1.1, 0.1, 0.5, 0.9, 0.3, 0.7, 0.2, 1.0, 0.4, 0.8, 0.6]
  let i = 0
  const c = cal({ n: ws.length, probe: () => ws[i++] })
  check('K1 median of the measured windows', c.medianMs, 0.6)
  check('K1b p10 / p90', `${c.p10Ms}/${c.p90Ms}`, '0.2/1')
  check('K2 ceiling is FRACTION x median', c.ceilingMs, posthash.DELAY_FRACTION * 0.6)
  check('K3 n and fraction are recorded', `${c.n}/${c.fraction}`, `11/${posthash.DELAY_FRACTION}`)
  check(
    'K4 a median under the floor fails loudly',
    /degenerate/.test(throwsMsg(() => cal({ n: 5, probe: () => posthash.MIN_WINDOW_MS / 2 }))),
    true
  )
  check(
    'K5 an unmeasurable probe fails loudly',
    /unmeasured/.test(throwsMsg(() => cal({ n: 5, probe: () => null }))),
    true
  )
  check(
    'K6 a probe that throws fails loudly, naming calibration',
    /calibration/.test(
      throwsMsg(() =>
        cal({
          n: 3,
          probe: () => {
            throw new Error('boom')
          },
        })
      )
    ),
    true
  )
}

// --- a real run records the calibration it used -----------------------------
{
  const traceDir = fs.mkdtempSync(path.join(os.tmpdir(), 's6715-caltr-'))
  let raw
  try {
    raw = await posthash.runOnce({ harnessRoot: resolveHarnessRoot(), candidate: 'C4', traceDir })
  } finally {
    fs.rmSync(traceDir, { recursive: true, force: true })
  }
  const k = raw.extra.posthashCalibration
  check(
    'K7 the record carries median, p10, p90, ceiling and n',
    k != null &&
      ['medianMs', 'p10Ms', 'p90Ms', 'ceilingMs', 'n'].every((f) => typeof k[f] === 'number'),
    true
  )
  check('K8 the ceiling used is the calibrated one', raw.extra.posthashDelayCeilingMs, k?.ceilingMs)
  check(
    'K9 and the drawn delay lies under it',
    typeof raw.extra.posthashDelayMs === 'number' && raw.extra.posthashDelayMs < k?.ceilingMs,
    true
  )
}

if (!allOk) {
  console.log(`${TAG} SOME CASES FAILED`)
  process.exit(1)
}
console.log(`${TAG} all cases passed`)

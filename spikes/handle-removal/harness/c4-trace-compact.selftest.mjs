#!/usr/bin/env node
// SMI-6715: records carry extra.traceCompact, not the full extra.trace (a full trace is
// ~3.4 MB per record at 1630 directories). Plain node; PASS/FAIL per case; non-zero exit
// on failure.
//
//   node harness/c4-trace-compact.selftest.mjs

import { c4Extra } from './attacks/c4-score.mjs'
import { runMountCase } from './attacks/a1-c4.mjs'
import * as a3 from './attacks/a3-c4.mjs'
import * as a4 from './attacks/a4-c4.mjs'
import { makeSelftest } from './c4-selftest-util.mjs'

const { check, harnessRoot, finish } = makeSelftest(import.meta.url)

const ARMS = ['C4', 'C4-naive']

for (const arm of ARMS) {
  check(`A3 --dirs 50 ${arm}: extra has traceCompact and no full trace`, () => {
    const { extra } = a3.runOnce({ harnessRoot, candidate: arm, dirs: 50 })
    return typeof extra.traceCompact === 'object' &&
      extra.traceCompact !== null &&
      typeof extra.traceCompact.schema === 'string' &&
      !('trace' in extra)
      ? true
      : `keys=${Object.keys(extra).join()}`
  })
  check(`A3 --dirs 50 ${arm}: a matched trace drops the full copy (full === null)`, () => {
    const { extra, precondition } = a3.runOnce({ harnessRoot, candidate: arm, dirs: 50 })
    return precondition.traceMatched === true && extra.traceCompact.full === null
      ? true
      : `traceMatched=${precondition.traceMatched} full=${typeof extra.traceCompact.full}`
  })
  check(`A4 --dirs 50 ${arm}: record extra stays small (< 20 KB) despite the padded tree`, () => {
    const { extra } = a4.runOnce({ harnessRoot, candidate: arm, dirs: 50 })
    const bytes = JSON.stringify(extra).length
    return bytes < 20000 ? true : `${bytes} bytes`
  })
}

// A forced mismatch must keep the evidence. c4Extra is called with a stand-in run result
// (a real mismatch is hard to provoke), once per traceMatched value.
const fakeRun = (traceMatched, trace) => ({
  trace,
  traceMatched,
  firedAt: null,
  times: {},
  guardHash: 'h',
  opId: 'o',
  onFireInvoked: true,
  mutationError: null,
})
check('c4Extra: traceMatched false keeps the full trace inside traceCompact', () => {
  const t = [{ fn: 'FIRE', at: 1, endAt: 2, threw: null }]
  const e = c4Extra(fakeRun(false, t), 'X', 'pre-call', {})
  return 'trace' in e === false &&
    Array.isArray(e.traceCompact.full) &&
    e.traceCompact.full.length === 1
    ? true
    : JSON.stringify(e.traceCompact).slice(0, 160)
})
check('c4Extra: traceMatched true drops the full trace', () => {
  const t = [{ fn: 'FIRE', at: 1, endAt: 2, threw: null }]
  const e = c4Extra(fakeRun(true, t), 'X', 'pre-call', {})
  return e.traceCompact.full === null ? true : 'full kept'
})
check('c4Extra: a malformed trace is kept whole and flagged, never thrown away', () => {
  const e = c4Extra(fakeRun(true, 'not-an-array'), 'X', 'pre-call', {})
  return e.traceCompact.malformed === true && e.traceCompact.full === 'not-an-array'
    ? true
    : JSON.stringify(e.traceCompact)
})

// a1-c4 builds its own extra; mount, umount and /proc/mounts are replaced through its seam.
const withLinux = (fn) => {
  const orig = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
  try {
    return fn()
  } finally {
    Object.defineProperty(process, 'platform', orig)
  }
}
check('a1 extra: traceCompact and no full trace', () => {
  const r = withLinux(() =>
    runMountCase({
      harnessRoot,
      candidate: 'C4',
      subcase: 'bind',
      window: 'pre-call',
      _test: {
        doMount: () => {},
        detachAll: () => ({ found: 0, umounted: 0, failed: [], lazyUsed: 0, remaining: 0 }),
        mountsUnder: () => [],
      },
    })
  )
  return typeof r.extra.traceCompact === 'object' && !('trace' in r.extra)
    ? true
    : `keys=${Object.keys(r.extra).join()}`
})

await finish()

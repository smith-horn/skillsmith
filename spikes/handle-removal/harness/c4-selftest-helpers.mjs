// Shared fixtures and the check() convention for the C4 self-tests
// (result-schema.c4*.selftest.mjs), split out to keep each file under 500 lines.
// Every file calls finish() last; a FAIL in any one exits non-zero.

let allOk = true
export function check(label, actual, expected) {
  const ok = actual === expected
  allOk = allOk && ok
  console.log(
    `[result-schema c4 self-test] ${label}: expected ${expected}, got ${actual} -- ${ok ? 'PASS' : 'FAIL'}`
  )
}
export function finish() {
  if (!allOk) {
    console.error('[result-schema c4 self-test] FAIL')
    process.exit(1)
  }
  console.log('[result-schema c4 self-test] all cases passed')
  process.exit(0)
}

// --- classifyRecord, C4 --------------------------------------------------
export const C4CELL = {
  attack: 'A3-C4',
  variant: 'x/after-bind',
  candidate: 'C4',
  fs: 'f',
  runner: 't',
}
export const goodPre = () => ({
  hookFired: true,
  mutationApplied: true,
  traceMatched: true,
  controlExpected: true,
})
export const goodUf = () => ({ checked: 3, lost: 0, changed: 0, displaced: 0, deleted: 0 })
export const rec = (o = {}) => ({
  cell: o.cell ?? C4CELL,
  precondition: o.precondition ?? goodPre(),
  outcome: o.outcome ?? { status: 'quarantined' },
  userFiles: o.userFiles ?? goodUf(),
})
export const legacyCell = { attack: 'A3', candidate: 'baseline', fs: 'f', runner: 't' }
export class UfInst {
  constructor() {
    this.checked = 3
    this.changed = 0
  }
  get lost() {
    return 0
  }
}

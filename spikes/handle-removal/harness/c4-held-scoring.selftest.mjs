// SMI-6715 Step 1b part 2, item 2: held displacement and the held scoring
// location, end to end through the REAL attack modules on darwin.
//
// A held run leaves the tree whole in the trash and the origin empty. Scored at
// the origin, every user file reads `lost`, and with no destination it reads
// `deleted` -- so a held run whose bytes are all safe scored as data loss. The
// held copy is the location of record (design §9 item 3): the module scores the
// user files there, records heldEvidence (location, sidecar verification,
// origin re-creation), whereFor names the held copy as the destination, and the
// leftover scan reports the op dir as expected-held with its sidecar verified.
//
// DECLARED FAILURE ON THE PRE-CHANGE HARNESS: every C4 case classifies 'failed'
// with lost >= 1 (scored at the empty origin), displaced 0 / deleted >= 1
// (whereFor gives a held run no destination), no heldEvidence, and a
// quarantineLeft scan of 'c4-scan-needs-status:held'. The C4-naive controls
// still lose (quarantined, displaced) both before and after.

import fs from 'node:fs'
import path from 'node:path'
import { resolveHarnessRoot, makeFixtureRoot } from './fixture-root.mjs'
import { makeRecord, classifyRecord } from './result-schema.mjs'
import { scanC4Leftovers } from './result-schema.c4.mjs'
import { whereFor } from './attacks/c4-score.mjs'
import * as a4 from './attacks/a4-c4.mjs'
import * as a7 from './attacks/a7-c4.mjs'
import { runMountCase } from './attacks/a1-c4.mjs'

const TAG = '[c4-held-scoring self-test]'
const harnessRoot = resolveHarnessRoot()
let allOk = true
function check(label, actual, expected) {
  const ok = actual === expected
  allOk = allOk && ok
  console.log(
    `${TAG} ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)} -- ${ok ? 'PASS' : 'FAIL'}`
  )
}
const classOf = (raw, attack) =>
  classifyRecord(
    makeRecord({
      cell: { attack, variant: 'v', candidate: 'C4', fs: 'f', runner: 't', target: 30 },
      run: 0,
      precondition: raw.precondition,
      outcome: raw.outcome,
      userFiles: raw.userFiles,
    })
  )

function heldChecks(label, raw, attack) {
  check(`${label} C4 ends held`, raw.outcome.status, 'held')
  check(
    `${label} scored with nothing lost or changed`,
    raw.userFiles.lost + raw.userFiles.changed,
    0
  )
  check(`${label} checked >= 1`, raw.userFiles.checked >= 1, true)
  check(`${label} heldEvidence.location`, raw.outcome.heldEvidence?.location, 'held-copy')
  check(`${label} heldEvidence.sidecarVerified`, raw.outcome.heldEvidence?.sidecarVerified, true)
  check(
    `${label} leftover scan: this op dir is expected-held`,
    raw.outcome.quarantineLeft?.expected?.held,
    true
  )
  check(
    `${label} leftover scan: its sidecar verifies`,
    raw.outcome.quarantineLeft?.expected?.sidecarVerified,
    true
  )
  check(`${label} leftover scan: nothing unexpected`, raw.outcome.quarantineLeft?.entries, 0)
  check(`${label} classifies held`, classOf(raw, attack), 'held')
}

// --- A4 (directory swap at post-hash) ------------------------------------------
heldChecks('A4', a4.runOnce({ harnessRoot, candidate: 'C4', window: 'post-hash' }), 'A4-C4')
{
  const naive = a4.runOnce({ harnessRoot, candidate: 'C4-naive', window: 'post-hash' })
  check('A4 control: C4-naive quarantines', naive.outcome.status, 'quarantined')
  check('A4 control: and its loss is displaced, not deleted', naive.userFiles.displaced, 1)
  check('A4 control: classifies failed', classOf(naive, 'A4-C4'), 'failed')
}

// --- A7 late subcases ----------------------------------------------------------
for (const args of [
  { subcase: 'late', entryKind: 'file' },
  { subcase: 'late', entryKind: 'symlink' },
  ...a7.EDIT_SUBCASES.map((subcase) => ({ subcase })),
]) {
  const label = `A7 ${args.subcase}${args.entryKind ? `-${args.entryKind}` : ''}`
  heldChecks(label, a7.runOnce({ harnessRoot, candidate: 'C4', ...args }), 'A7-C4')
}

// --- A1 through its _test seam: a user file written at post-hash ----------------
// The real mount cannot run on darwin; the seam writes the user file into the
// target at C4's re-check, which is the same post-hash change C4 now holds.
{
  const orig = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
  let raw
  try {
    raw = runMountCase({
      harnessRoot,
      candidate: 'C4',
      subcase: 'bind',
      window: 'post-hash',
      _test: {
        detachAll: () => ({ found: 0, umounted: 0, failed: [], lazyUsed: 0, remaining: 0 }),
        mountsUnder: () => [],
        doMount: ({ targetAbs, userContent }) =>
          fs.writeFileSync(path.join(targetAbs, 'mounted-user.txt'), userContent),
      },
    })
  } finally {
    Object.defineProperty(process, 'platform', orig)
  }
  check('A1-seam C4 ends held', raw.outcome.status, 'held')
  check('A1-seam scored with nothing lost', raw.userFiles.lost, 0)
  check('A1-seam heldEvidence.location', raw.outcome.heldEvidence?.location, 'held-copy')
  check('A1-seam heldEvidence.sidecarVerified', raw.outcome.heldEvidence?.sidecarVerified, true)
}

// --- whereFor: the held copy is a held run's destination ------------------------
{
  const r = { result: { status: 'held', path: '/x/.skillsmith-trash/op/tree-1' } }
  check(
    'W1 whereFor(held).destination is result.path',
    whereFor('/x', r, '/x/tree/target').destination,
    '/x/.skillsmith-trash/op/tree-1'
  )
  check(
    'W2 whereFor(kept).destination is null (control)',
    whereFor('/x', { result: { status: 'kept', path: '/x/tree' } }, '/x/tree').destination,
    null
  )
}

// --- the leftover scan on a hand-built held layout, sidecar NOT verifying -------
{
  const fx = makeFixtureRoot({ harnessRoot })
  try {
    const op = path.join(fx.root, '.skillsmith-trash', 'op-h')
    const heldPath = path.join(op, 'tree-aa')
    fs.mkdirSync(heldPath, { recursive: true })
    const originPath = path.join(fx.root, 'tree')
    const sc = (obj) => fs.writeFileSync(`${heldPath}.json`, JSON.stringify(obj))
    const scan = () =>
      scanC4Leftovers(fx.root, {
        status: 'held',
        opId: 'op-h',
        heldPath,
        originPath,
        sidecarPath: `${heldPath}.json`,
      })
    sc({ hold: true, heldPath, originPath })
    check('L1 a good held sidecar verifies', scan().expected?.sidecarVerified, true)
    sc({ hold: false, heldPath, originPath })
    check('L2 hold:false does not verify', scan().expected?.sidecarVerified, false)
    sc({ hold: true, heldPath: `${heldPath}-other`, originPath })
    check('L3 a heldPath mismatch does not verify', scan().expected?.sidecarVerified, false)
    fs.writeFileSync(`${heldPath}.json`, '{not json')
    check('L4 an unparseable sidecar does not verify', scan().expected?.sidecarVerified, false)
    check('L5 the held op dir is never counted as unexpected', scan().entries, 0)
  } finally {
    fx.cleanup()
  }
}

if (!allOk) {
  console.log(`${TAG} SOME CASES FAILED`)
  process.exit(1)
}
console.log(`${TAG} all cases passed`)

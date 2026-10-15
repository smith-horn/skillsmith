// C4 scan self-test (SMI-6715): quarantineTree-built scratch fixtures.
// Shared fixtures: c4-selftest-helpers.mjs.

import { scanQuarantineLeftovers } from './result-schema.mjs'
import fs from 'node:fs'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { quarantineTree, computePathTreeHash } from '../quarantine.mjs'
import { check, finish } from './c4-selftest-helpers.mjs'

// The V2 no-leak check needs a V2-shaped parent; build a tiny one here.
const qReal = mkdtempSync(path.join(tmpdir(), 's6715-selftest-v2-'))
mkdirSync(path.join(qReal, '.skillsmith-rm-beef', 'leftover'), { recursive: true })

// ---------------------------------------------------------------------------
// C4 (SMI-6715). Scan cases are built by EXECUTING quarantineTree on scratch
// fixtures; classify cases attack the record SHAPE. Every negative has a
// positive control beside it.
// ---------------------------------------------------------------------------
const cTmp = mkdtempSync(path.join(tmpdir(), 's6715-selftest-c4-'))
function c4Fixture() {
  const root = mkdtempSync(path.join(cTmp, 'fx-'))
  mkdirSync(path.join(root, 'tree', 'sub'), { recursive: true })
  writeFileSync(path.join(root, 'tree', 'sub', 'f.txt'), 'x')
  return root
}
// kept AFTER the op dir exists: swap the tree at the 3rd lstat of the origin
// (bind, hash-root-visit, re-check), so the identity re-check refuses.
function keptAfterMkdir(root, opId) {
  const origin = path.join(root, 'tree')
  const guardHash = computePathTreeHash(origin).treeHash
  const real = fs.lstatSync
  let n = 0
  fs.lstatSync = function (p, ...a) {
    if (p === origin && ++n === 3) {
      real.call(fs, p)
      fs.renameSync(origin, origin + '.aside')
      fs.mkdirSync(origin)
    }
    return real.call(fs, p, ...a)
  }
  try {
    return quarantineTree(root, 'tree', { guardHash, opId })
  } finally {
    fs.lstatSync = real
  }
}

// C1 quarantined: the op dir's contents are EXPECTED, not leftovers.
const c1root = c4Fixture()
const c1res = quarantineTree(c1root, 'tree', {
  guardHash: computePathTreeHash(path.join(c1root, 'tree')).treeHash,
  opId: 'opq',
})
check('C1 precondition: really quarantined', c1res.status, 'quarantined')
const c1 = scanQuarantineLeftovers(c1root, 'C4', { status: 'quarantined', opId: 'opq' })
check('C1 expected present', c1.expected.present, true)
check('C1 expected = tree entry + sidecar', c1.expected.entries, 2)
check('C1 expected path', c1.expected.path, '.skillsmith-trash/opq')
check('C1 expected excluded from dirs', c1.dirs, 0)
check('C1 expected excluded from entries', c1.entries, 0)
check('C1 no litter', c1.litter, 0)
check('C1 no scan error', c1.scanError, null)
// C1b negative: the SAME disk read as a kept outcome is NOT expected -> counted.
const c1b = scanQuarantineLeftovers(c1root, 'C4-naive', { status: 'kept', opId: 'opq' })
check('C1b same dir under status kept is counted (dirs)', c1b.dirs, 1)
check('C1b same dir under status kept is counted (entries)', c1b.entries, 2)
check('C1b expected not claimed under kept', c1b.expected.present, false)
// C1c: an unexpected sibling op dir next to the expected one still counts.
mkdirSync(path.join(c1root, '.skillsmith-trash', 'other-op', 'stranded'), { recursive: true })
const c1c = scanQuarantineLeftovers(c1root, 'C4', { status: 'quarantined', opId: 'opq' })
check('C1c sibling op dir counted', c1c.dirs, 1)
check('C1c sibling entry counted', c1c.entries, 1)
check('C1c expected still reported', c1c.expected.entries, 2)
check('C1c sibling path named', c1c.paths[0], '.skillsmith-trash/other-op/stranded')
// C1d: a V2-style leftover beside a C4 trash root counts too.
mkdirSync(path.join(c1root, '.skillsmith-rm-zz', 'left'), { recursive: true })
const c1d = scanQuarantineLeftovers(c1root, 'C4', { status: 'quarantined', opId: 'opq' })
check('C1d .skillsmith-rm-* beside trash counted', c1d.dirs, 2)
// C1e: a stray FILE directly in the trash root counts.
writeFileSync(path.join(c1root, '.skillsmith-trash', 'stray.txt'), 'x')
const c1e = scanQuarantineLeftovers(c1root, 'C4', { status: 'quarantined', opId: 'opq' })
check('C1e stray trash-root file counted', c1e.entries, c1d.entries + 1)

// C2 kept after mkdir: the empty op dir is LITTER, not entries.
const c2root = c4Fixture()
const c2res = keptAfterMkdir(c2root, 'opk')
check('C2 precondition: really kept after mkdir', c2res.status, 'kept')
check(
  'C2 precondition: op dir exists and is empty',
  fs.readdirSync(path.join(c2root, '.skillsmith-trash', 'opk')).length,
  0
)
const c2 = scanQuarantineLeftovers(c2root, 'C4', { status: 'kept', opId: 'opk' })
check('C2 litter counted', c2.litter, 1)
check('C2 litter not in dirs', c2.dirs, 0)
check('C2 litter not in entries', c2.entries, 0)
check('C2 nothing expected', c2.expected.present, false)
// C2b negative: litter must NOT be hidden when the opId is a different one.
const c2b = scanQuarantineLeftovers(c2root, 'C4', { status: 'kept', opId: 'not-it' })
check('C2b empty op dir under another opId is counted as a dir', c2b.dirs, 1)
check('C2b no litter claimed for another opId', c2b.litter, 0)

// C3 kept before mkdir: nothing on disk -> a real zero, with expected absent.
const c3root = c4Fixture()
const c3res = quarantineTree(c3root, 'tree', { guardHash: 'bad', opId: 'opw' })
check('C3 precondition: kept', c3res.status, 'kept')
const c3 = scanQuarantineLeftovers(c3root, 'C4', { status: 'kept', opId: 'opw' })
check('C3 real zero dirs', c3.dirs, 0)
check('C3 real zero litter', c3.litter, 0)
check('C3 expected absent', c3.expected.present, false)
// C3b: quarantined outcome but nothing on disk -> expected.present false (the
// scan does not invent the move).
const c3b = scanQuarantineLeftovers(c3root, 'C4', { status: 'quarantined', opId: 'opw' })
check('C3b quarantined claimed but nothing on disk', c3b.expected.present, false)

// C4 cannot-run cases report nulls, never 0.
for (const [label, opts] of [
  ['no options', undefined],
  ['no status', { opId: 'x' }],
  ['bad status', { status: 'removed', opId: 'x' }],
  ['no opId', { status: 'kept' }],
  ['opId with slash', { status: 'kept', opId: 'a/b' }],
  ['opId ..', { status: 'kept', opId: '..' }],
]) {
  const r = scanQuarantineLeftovers(c3root, 'C4', opts)
  check('C4 ' + label + ': dirs null', r.dirs, null)
  check('C4 ' + label + ': entries null', r.entries, null)
  check('C4 ' + label + ': litter null', r.litter, null)
  check('C4 ' + label + ': scanError set', typeof r.scanError, 'string')
}
const cMissing = scanQuarantineLeftovers(path.join(cTmp, 'nope'), 'C4', {
  status: 'kept',
  opId: 'x',
})
check('C4 missing parent: null not 0', cMissing.dirs, null)
check('C4 missing parent: ENOENT', cMissing.scanError, 'ENOENT')
// V2 / V0 behaviour unchanged: no C4 fields leak into them.
check('V2 result has no expected field', 'expected' in scanQuarantineLeftovers(qReal, 'V2'), false)
check('V0 stays n/a', scanQuarantineLeftovers(c1root, 'V0').scanError, 'n/a:no-quarantine-in-V0')

rmSync(cTmp, { recursive: true, force: true })
rmSync(qReal, { recursive: true, force: true })

finish()

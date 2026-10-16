#!/usr/bin/env node
// SMI-7134: post-move verification compared where the op directory RESOLVES, not which
// directory it is. After the rename returned, the op directory could be renamed aside, a
// fresh directory created at the same path (any mode), and the entry moved in: the path
// resolved identically, so C4 reported `quarantined` with the tree in a directory it never
// validated. Verification now also requires the op directory's identity (type included)
// and the F12 owner/mode check (one shared definition, opDirOwnerModeProblem).
//
// DECLARED FAILURE ON THE PRE-FIX CODE (a scratch copy of cc16a17e0), per case:
//   G, G2 (SMI-7134) status 'quarantined' where 'held' is expected: the op directory is renamed
//      aside after the rename and a FRESH directory (mode 0777 / 0700) is created at the same
//      path with the entry moved in; the path resolves identically, so only identity can tell.
//   H  (SMI-7134) status 'quarantined' where 'held' is expected: the SAME op directory is
//      chmod'ed 0777 after the rename; only the owner/mode re-check can tell.
//   I  (SMI-7134) detail contains "safe at" after a containment failure (it must not claim
//      safety); I5-I6 are a paired control: after a hash mismatch the location IS confirmed, so the
//      detail keeps the "safe at" wording (passes on both).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { quarantineTree, computePathTreeHash } from '../quarantine.mjs'
import { runWithHooks } from './postmove-seam.mjs'
import { makeCheck } from './w5-test-util.mjs'

// makeCheck's done() fails a run in which no case executed (SMI-7128).
const { check, done } = makeCheck('[quarantine-op-recheck]')

function fixture(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const parent = path.join(root, 'parent')
  fs.mkdirSync(path.join(parent, 'tree', 'sub'), { recursive: true })
  fs.writeFileSync(path.join(parent, 'tree', 'sub', 'f.txt'), 'USERBYTES')
  return { root, parent, origin: path.join(parent, 'tree') }
}
const readBytes = (p) => {
  try {
    return fs.readFileSync(p, 'utf8')
  } catch (err) {
    return `UNREADABLE:${err.code}`
  }
}

// --- G / G2 / H. the op directory must still be the one C4 validated (SMI-7134) ----------
// Swaps the op directory for a fresh one at the same path, with the entry moved in.
function swapOpDir(f, opId, mode) {
  const guardHash = computePathTreeHash(f.origin).treeHash
  const trash = path.join(f.parent, '.skillsmith-trash')
  const opDir = path.join(trash, opId)
  const run = runWithHooks({
    quarantine: quarantineTree,
    parentAbs: f.parent,
    name: 'tree',
    options: { opId, guardHash },
    onAfterRename: () => {
      const aside = path.join(trash, `${opId}-aside`)
      fs.renameSync(opDir, aside)
      fs.mkdirSync(opDir)
      fs.chmodSync(opDir, mode)
      const entry = fs.readdirSync(aside).find((n) => n.startsWith('tree-'))
      fs.renameSync(path.join(aside, entry), path.join(opDir, entry))
    },
  })
  return { run, opDir }
}
for (const [id, mode, label] of [
  ['G', 0o777, 'a fresh world-writable directory'],
  ['G2', 0o700, 'a fresh 0700 directory of ours'],
]) {
  const f = fixture(`s7134-${id.toLowerCase()}-`)
  const { run, opDir } = swapOpDir(f, `op-${id.toLowerCase()}`, mode)
  const r = run.result
  check(
    `${id}-1 the op-directory replacement fired without error`,
    run.fired.afterRename && run.hookErrors.length === 0,
    true
  )
  check(`${id}-2 ${label} at the op path is held`, r.status, 'held')
  check(`${id}-3 with the changed-during-move reason`, r.reason, 'changed-during-move')
  check(
    `${id}-4 and the diagnosis names the op-directory identity check`,
    /op directory identity check failed/.test(r.detail ?? ''),
    true
  )
  const parked = fs.existsSync(opDir)
    ? fs.readdirSync(opDir).filter((n) => n.startsWith('tree-') && !n.endsWith('.json'))
    : []
  check(
    `${id}-5 the tree is whole where rename left it`,
    parked.length === 1 && readBytes(path.join(opDir, parked[0], 'sub', 'f.txt')) === 'USERBYTES',
    true
  )
  check(`${id}-6 nothing was moved back to the origin`, fs.existsSync(f.origin), false)
  fs.rmSync(f.root, { recursive: true, force: true })
}
{
  const f = fixture('s7134-h-')
  const guardHash = computePathTreeHash(f.origin).treeHash
  const opDir = path.join(f.parent, '.skillsmith-trash', 'op-h')
  const run = runWithHooks({
    quarantine: quarantineTree,
    parentAbs: f.parent,
    name: 'tree',
    options: { opId: 'op-h', guardHash },
    onAfterRename: () => fs.chmodSync(opDir, 0o777),
  })
  const r = run.result
  check(
    'H1 the post-rename chmod fired without error',
    run.fired.afterRename && run.hookErrors.length === 0,
    true
  )
  check('H2 a same-directory chmod to 0777 is held', r.status, 'held')
  check(
    'H3 and the diagnosis names the owner/mode check',
    /op directory owner\/mode check failed/.test(r.detail ?? ''),
    true
  )
  check('H4 and the mode it saw', /mode 777/.test(r.detail ?? ''), true)
  check('H5 nothing was moved back to the origin', fs.existsSync(f.origin), false)
  fs.chmodSync(opDir, 0o700)
  fs.rmSync(f.root, { recursive: true, force: true })
}

// --- I. a held result must not claim safety when containment failed (SMI-7134) ----------
{
  const f = fixture('s7134-i-')
  const guardHash = computePathTreeHash(f.origin).treeHash
  const opDir = path.join(f.parent, '.skillsmith-trash', 'op-i')
  const outside = path.join(f.root, 'attacker-storage')
  const run = runWithHooks({
    quarantine: quarantineTree,
    parentAbs: f.parent,
    name: 'tree',
    options: { opId: 'op-i', guardHash },
    onAfterRename: () => {
      fs.renameSync(opDir, outside)
      fs.symlinkSync(outside, opDir)
    },
  })
  const r = run.result
  check('I1 the containment failure is held', r.status, 'held')
  check('I2 the detail makes no safety claim', /safe/i.test(r.detail ?? ''), false)
  check(
    'I3 it says the location could not be confirmed',
    /could not be confirmed/.test(r.detail ?? ''),
    true
  )
  check(
    'I4 and names the reported path and the reason',
    (r.detail ?? '').includes(r.path) &&
      /reason: op directory resolves elsewhere/.test(r.detail ?? ''),
    true
  )
  fs.rmSync(f.root, { recursive: true, force: true })
}
{
  // Paired control: the location IS confirmed here, so the "safe at" wording stays.
  const f = fixture('s7134-i2-')
  const guardHash = computePathTreeHash(f.origin).treeHash
  const run = runWithHooks({
    quarantine: quarantineTree,
    parentAbs: f.parent,
    name: 'tree',
    options: { opId: 'op-i2', guardHash },
    onAfterRename: ({ destPath }) => fs.appendFileSync(path.join(destPath, 'sub', 'f.txt'), 'X'),
  })
  const r = run.result
  check('I5 control: a post-move content change is held', r.status, 'held')
  check(
    'I6 control: a confirmed location keeps the "safe at" wording',
    /your tree is safe at /.test(r.detail ?? ''),
    true
  )
  fs.rmSync(f.root, { recursive: true, force: true })
}

done()

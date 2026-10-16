#!/usr/bin/env node
// SMI-7130: identity compared (dev, ino, birthtimeNs) and nothing else, so on
// Linux overlayfs a SYMLINK created where the op directory had just been
// deleted (same inode number, same birthtime within one tick) passed the rebind
// before rename(2). rename(2) then moved the user's tree through the symlink
// into attacker storage, and post-move verification passed too: rename keeps the
// inode and the tree, and nothing checked where the destination resolved.
//
// Case A cannot rely on the real filesystem reusing an inode (darwin never does),
// so it SIMULATES an identity-forging substitution: on the op directory's rebind
// lstat only, the stub reports a symlink whose dev, ino and birthtimeNs equal the
// validated directory's. Everything else is the real filesystem.
//
// DECLARED FAILURE ON THE PRE-FIX CODE (a scratch copy), per case:
//   A  status 'quarantined' where 'kept' is expected (the rebind accepts it).
//   B  status 'quarantined' where 'held' is expected (no containment check).
//   C1 status 'quarantined' where 'kept' is expected (a type-less identity
//      compared equal); C2 is a control and passes on both.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { quarantineTree, computePathTreeHash } from '../quarantine.mjs'
import { runWithHooks } from './postmove-seam.mjs'
import { makeCheck } from './w5-test-util.mjs'

const S_IFMT = 0o170000n
const S_IFLNK = 0o120000n
// makeCheck's done() fails a run in which no case executed (SMI-7128).
const { check, done } = makeCheck('[quarantine-identity-type]')

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
const countEntries = (d) => (fs.existsSync(d) ? fs.readdirSync(d).length : -1)

// --- A. the rebind must compare the file type ------------------------------
{
  const f = fixture('s7128-a-')
  const opDir = path.join(f.parent, '.skillsmith-trash', 'op-forged')
  const realLstat = fs.lstatSync
  let opCalls = 0
  let forged = false
  let validated = null
  // Calls on the op directory with bigint: 1st is the validation, 2nd the rebind.
  fs.lstatSync = (p, ...rest) => {
    const out = realLstat(p, ...rest)
    if (String(p) === opDir && rest[0]?.bigint === true) {
      opCalls += 1
      if (opCalls === 1) validated = out
      if (opCalls === 2) {
        forged = true
        return {
          ...validated,
          mode: (validated.mode & ~S_IFMT) | S_IFLNK,
          isSymbolicLink: () => true,
          isDirectory: () => false,
        }
      }
    }
    return out
  }
  let r
  try {
    r = quarantineTree(f.parent, 'tree', { opId: 'op-forged' })
  } finally {
    fs.lstatSync = realLstat
  }
  check('A1 the stub really forged the rebind stat', forged, true)
  check('A2 a same-identity symlink at the op directory is refused', r.status, 'kept')
  check('A3 and the reason names the destination', r.reason, 'quarantine-destination-changed')
  check(
    'A4 and it is the rebind refusing',
    r.detail,
    'op directory was substituted between validation and rename'
  )
  check('A5 the origin survives', readBytes(path.join(f.origin, 'sub', 'f.txt')), 'USERBYTES')
  check('A6 nothing was moved into the op directory', countEntries(opDir), 0)
  fs.rmSync(f.root, { recursive: true, force: true })
}

// --- B. the destination must resolve inside the trash root -----------------
{
  // B0 control: an honest guarded call is verified and quarantined.
  const f0 = fixture('s7128-b0-')
  const g0 = computePathTreeHash(f0.origin).treeHash
  const r0 = quarantineTree(f0.parent, 'tree', { opId: 'op-ok', guardHash: g0 })
  check('B0 an honest guarded call is quarantined', r0.status, 'quarantined')
  fs.rmSync(f0.root, { recursive: true, force: true })

  const f = fixture('s7128-b-')
  const guardHash = computePathTreeHash(f.origin).treeHash
  const outside = path.join(f.root, 'attacker-storage')
  const opDir = path.join(f.parent, '.skillsmith-trash', 'op-out')
  // After rename(2) returns and before verification: the op directory (now
  // holding the tree) moves out of the trash root and a symlink takes its place.
  // The tree keeps its inode, so identity and the hash cannot tell.
  const run = runWithHooks({
    quarantine: quarantineTree,
    parentAbs: f.parent,
    name: 'tree',
    options: { opId: 'op-out', guardHash },
    onAfterRename: () => {
      fs.renameSync(opDir, outside)
      fs.symlinkSync(outside, opDir)
    },
  })
  const r = run.result
  check(
    'B1 the post-rename swap fired without error',
    run.fired.afterRename && run.hookErrors.length === 0,
    true
  )
  check('B2 a destination outside the trash root is held', r.status, 'held')
  check('B3 with the changed-during-move reason', r.reason, 'changed-during-move')
  check(
    'B4 and the diagnosis names the containment',
    /outside the trash root/.test(r.detail ?? ''),
    true
  )
  const moved = fs.existsSync(outside)
    ? fs.readdirSync(outside).filter((n) => !n.endsWith('.json'))
    : []
  check(
    'B5 the tree is whole where rename left it',
    moved.length === 1 && readBytes(path.join(outside, moved[0], 'sub', 'f.txt')) === 'USERBYTES',
    true
  )
  check('B6 nothing was moved back to the origin', fs.existsSync(f.origin), false)
  fs.rmSync(f.root, { recursive: true, force: true })
}

// --- C. a caller's type-less expectIdentity fails closed -------------------
{
  const f = fixture('s7128-c-')
  const st = fs.lstatSync(f.origin, { bigint: true })
  const typeless = { dev: st.dev, ino: st.ino, birthtimeNs: st.birthtimeNs }
  const r1 = quarantineTree(f.parent, 'tree', { opId: 'op-c1', expectIdentity: typeless })
  check('C1 an identity with no file type never compares equal', r1.status, 'kept')
  check('C1b with the identity-changed reason', r1.reason, 'identity-changed')
  check('C1c and the origin survives', readBytes(path.join(f.origin, 'sub', 'f.txt')), 'USERBYTES')
  fs.rmSync(f.root, { recursive: true, force: true })
  const g = fixture('s7128-c2-')
  const st2 = fs.lstatSync(g.origin, { bigint: true })
  const typed = { dev: st2.dev, ino: st2.ino, birthtimeNs: st2.birthtimeNs, fmt: st2.mode & S_IFMT }
  const r2 = quarantineTree(g.parent, 'tree', { opId: 'op-c2', expectIdentity: typed })
  check('C2 control: an identity with its file type is accepted', r2.status, 'quarantined')
  fs.rmSync(g.root, { recursive: true, force: true })
}

done()

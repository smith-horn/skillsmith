#!/usr/bin/env node
// SMI-6676 B2: quarantineTree verified one tree and moved another.
//
// `computePathTreeHash(originPath)` walks by path; `renameSync(originPath, ...)`
// resolves that path again, independently. Anything that can write to the parent
// can swap what the name refers to in between, so the caller's guard hash
// certified tree X while rename(2) moved tree Y into quarantine.
//
// THE EXPLOIT THESE CASES USE IS THE ONE A GUARD HASH CANNOT SEE: the
// replacement has BYTE-IDENTICAL CONTENT, so its tree hash equals the guard
// hash exactly. Only identity -- (dev, ino, birthtimeNs) per UD24 -- separates
// them. A test that swapped in *different* content would pass against the
// unfixed code, because the hash comparison would catch it, and would prove
// nothing about B2.
//
// The fix applies the A1 plan's mechanism (UD24 identity binding + UD25's clock
// gate) rather than inventing a second one, so these cases also pin the
// interface A1's callers use: `expectIdentity` and `maxBirthtimeNs`.

import { quarantineTree, computePathTreeHash } from '../quarantine.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let allOk = true
function check(label, actual, expected) {
  const ok = actual === expected
  allOk = allOk && ok
  console.log(
    `[quarantine-identity] ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)} -- ${ok ? 'PASS' : 'FAIL'}`
  )
}

const ident = (p) => {
  const st = fs.lstatSync(p, { bigint: true })
  return { dev: st.dev, ino: st.ino, birthtimeNs: st.birthtimeNs }
}

/** A parent holding `tree/` with fixed content, plus an identical spare. */
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 's6676-qid-'))
  const parent = path.join(root, 'parent')
  const build = (dir) => {
    fs.mkdirSync(path.join(dir, 'sub'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'sub', 'f.txt'), 'exact same bytes')
    fs.writeFileSync(path.join(dir, 'top.txt'), 'also identical')
  }
  fs.mkdirSync(parent, { recursive: true })
  build(path.join(parent, 'tree'))
  build(path.join(root, 'replacement'))
  return { root, parent, origin: path.join(parent, 'tree'), spare: path.join(root, 'replacement') }
}

// --- 0. the premise: the replacement really is hash-identical -------------
// If this fails, every case below is testing the hash check, not identity.
{
  const f = fixture()
  const a = computePathTreeHash(f.origin)
  const b = computePathTreeHash(f.spare)
  check('0a the replacement hashes identically', a.treeHash === b.treeHash, true)
  check('0b but it is a different inode', ident(f.origin).ino !== ident(f.spare).ino, true)
  fs.rmSync(f.root, { recursive: true, force: true })
}

// --- 1. the B2 exploit: swap after the caller bound identity --------------
// Revert (drop expectIdentity handling and the pre-rename re-check): the
// replacement is quarantined and `status` is 'quarantined'.
{
  const f = fixture()
  const bound = ident(f.origin)
  const guardHash = computePathTreeHash(f.origin).treeHash

  // The swap: original aside, hash-identical replacement into its place.
  fs.renameSync(f.origin, path.join(f.root, 'aside'))
  fs.renameSync(f.spare, f.origin)

  const r = quarantineTree(f.parent, 'tree', { guardHash, expectIdentity: bound })

  check('1a a swapped-in tree is not quarantined', r.status, 'kept')
  check('1b and the reason names identity', r.reason, 'identity-changed')
  check('1c the replacement is still in place', fs.existsSync(f.origin), true)
  // Read defensively. Against the UNFIXED code this file is gone, and a bare
  // readFileSync throws ENOENT and kills the process -- which reports 5 of 12
  // cases and leaves the clock-gate cases below unexercised. A red exit that
  // only ran part of the suite is not evidence about the part that did not run.
  let bytes
  try {
    bytes = fs.readFileSync(path.join(f.origin, 'sub', 'f.txt'), 'utf8')
  } catch (err) {
    bytes = `UNREADABLE:${err.code}`
  }
  check('1d the replacement bytes are intact', bytes, 'exact same bytes')
  fs.rmSync(f.root, { recursive: true, force: true })
}

// --- 2. the honest case still works --------------------------------------
// A guard that refuses everything is not a guard. No swap: it must quarantine.
{
  const f = fixture()
  const bound = ident(f.origin)
  const guardHash = computePathTreeHash(f.origin).treeHash
  const r = quarantineTree(f.parent, 'tree', { guardHash, expectIdentity: bound })
  check('2a an unswapped tree is quarantined', r.status, 'quarantined')
  check('2b and it left the origin', fs.existsSync(f.origin), false)
  fs.rmSync(f.root, { recursive: true, force: true })
}

// --- 3. UD25's clock gate: a replacement cannot be older than probe 2 -----
// E47 measured overlayfs returning the SAME inode and birthtime on 1703 of 2000
// immediate delete-recreate pairs, so dev/ino/birthtime alone is forgeable.
// The gate rejects anything not strictly older than the probe.
{
  const f = fixture()
  const bound = ident(f.origin)
  const guardHash = computePathTreeHash(f.origin).treeHash
  // A probe birthtime at or below the tree's own: the tree is not strictly older.
  const r = quarantineTree(f.parent, 'tree', {
    guardHash,
    expectIdentity: bound,
    maxBirthtimeNs: bound.birthtimeNs,
  })
  check('3a not strictly older than probe 2 -> kept', r.status, 'kept')
  check('3b reason names the gate', r.reason, 'identity-not-older-than-probe')
  check('3c the tree is untouched', fs.existsSync(f.origin), true)

  // And a probe strictly newer than the tree lets it through.
  const r2 = quarantineTree(f.parent, 'tree', {
    guardHash,
    expectIdentity: bound,
    maxBirthtimeNs: bound.birthtimeNs + 1n,
  })
  check('3d strictly older than probe 2 -> quarantined', r2.status, 'quarantined')
  fs.rmSync(f.root, { recursive: true, force: true })
}

if (!allOk) {
  console.error('[quarantine-identity] FAIL')
  process.exit(1)
}
console.log('[quarantine-identity] all cases passed')
process.exit(0)

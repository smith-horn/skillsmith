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

// --- 4. THE PRE-RENAME RE-CHECK, which cases 1-3 do NOT pin ---------------
//
// Found by the SMI-6711 gate review, and confirmed by deleting the 21-line
// re-check block and watching this whole suite stay GREEN. Cases 1-3 swap the
// tree BEFORE quarantineTree is called, so the FIRST identity comparison
// catches it and the re-check immediately before rename(2) never matters. The
// block commented "THE RE-CHECK THAT ACTUALLY CLOSES B2" was therefore
// unpinned, in a commit whose message said the fix was red-tested. It was --
// but the red test covered a different clause than the one it claimed.
//
// To exercise the real window the swap must land BETWEEN the hash verification
// and the rename. `ensureTrashRoot` and the op-directory `mkdirSync` both run
// in that gap, so stubbing mkdirSync to swap after it creates the op directory
// is a genuine mid-flight attack, not a simulation of one.
{
  const f = fixture()
  const bound = ident(f.origin)
  const guardHash = computePathTreeHash(f.origin).treeHash

  const origMkdir = fs.mkdirSync
  let swapped = false
  fs.mkdirSync = (p, ...rest) => {
    const out = origMkdir(p, ...rest)
    // Swap once, after the op directory exists: the hash has been verified and
    // the identity bound, and rename(2) has not happened yet.
    if (!swapped && String(p).includes('.skillsmith-trash')) {
      swapped = true
      origMkdir(path.join(f.root, 'holder'), { recursive: true })
      fs.renameSync(f.origin, path.join(f.root, 'holder', 'aside'))
      fs.renameSync(f.spare, f.origin)
    }
    return out
  }

  let r
  try {
    r = quarantineTree(f.parent, 'tree', { guardHash, expectIdentity: bound })
  } finally {
    fs.mkdirSync = origMkdir
  }

  check('4a the swap actually landed mid-flight', swapped, true)
  check('4b a mid-flight swap is not quarantined', r.status, 'kept')
  check('4c and the reason names identity', r.reason, 'identity-changed')
  check('4d the replacement is still in place', fs.existsSync(f.origin), true)
  let bytes
  try {
    bytes = fs.readFileSync(path.join(f.origin, 'sub', 'f.txt'), 'utf8')
  } catch (err) {
    bytes = `UNREADABLE:${err.code}`
  }
  check('4e the replacement bytes survived', bytes, 'exact same bytes')
  fs.rmSync(f.root, { recursive: true, force: true })
}

// --- 5. THE GATE MUST WORK WITHOUT A guardHash ---------------------------
//
// Gate review FINDING 2. The identity binding and the clock gate used to sit
// inside `if (guardHash != null)`, so a caller supplying expectIdentity and
// maxBirthtimeNs but NO hash got neither — silently. No error, no field, no
// difference in the result shape. That caller is the shape the function's own
// comment describes, since expectIdentity exists precisely so a caller can bind
// identity independently of the hash.
//
// Every case above passes a guardHash, which is exactly why the suite could not
// see it. These cases are the negative control the suite was missing.
{
  // 5a/5b: the clock gate, with no hash anywhere.
  const f = fixture()
  const bound = ident(f.origin)
  const r = quarantineTree(f.parent, 'tree', {
    expectIdentity: bound,
    maxBirthtimeNs: bound.birthtimeNs,
  })
  check('5a clock gate fires without a guardHash', r.status, 'kept')
  check('5b and names the gate', r.reason, 'identity-not-older-than-probe')
  check('5c the tree is untouched', fs.existsSync(f.origin), true)
  fs.rmSync(f.root, { recursive: true, force: true })
}
{
  // 5d/5e: expectIdentity mismatch, with no hash anywhere. The swap is
  // hash-identical, so a hash would not have caught it even if one were given.
  const f = fixture()
  const bound = ident(f.origin)
  fs.renameSync(f.origin, path.join(f.root, 'aside'))
  fs.renameSync(f.spare, f.origin)
  const r = quarantineTree(f.parent, 'tree', { expectIdentity: bound })
  check('5d expectIdentity is honoured without a guardHash', r.status, 'kept')
  check('5e and names identity', r.reason, 'identity-changed')
  check('5f the replacement survived', fs.existsSync(f.origin), true)
  fs.rmSync(f.root, { recursive: true, force: true })
}
{
  // 5g: and a caller supplying NEITHER still gets the old behaviour — the
  // guard is opt-in, not newly mandatory. Without this, the fix could pass by
  // refusing everything, which is not a guard.
  const f = fixture()
  const r = quarantineTree(f.parent, 'tree', {})
  check('5g no identity, no hash -> still quarantines', r.status, 'quarantined')
  fs.rmSync(f.root, { recursive: true, force: true })
}

// --- 6. THE DESTINATION GETS THE SAME RE-CHECK AS THE SOURCE -------------
//
// Gate review FINDING 3. `ensureTrashRoot` validated `.skillsmith-trash` once --
// not a symlink, a directory, same device -- and the value was then trusted
// across mkdirSync(opDir), randSuffix(), an lstat and renameSync. Nothing
// rebound it. So the B2 fix hardened the SOURCE end of a rename(2) and left the
// DESTINATION validated once, far upstream, under the identical threat model.
//
// The reviewer was honest that it could not win this with a natural racer --
// 6,600 APFS trials, zero wins, because a win needs the swap absent at the
// lstat then present and stable across two later operations. It is blocking as
// a RESIDUAL STATEMENT, not as a demonstrated exploit: the code's residual
// paragraph described only the source-side window, so a reader deciding whether
// C4 is safe enough was reading coverage it never gave.
//
// Forced deterministically here by swapping the trash root after the op
// directory exists, which is inside the window and needs no race.
{
  const f = fixture()
  const bound = ident(f.origin)
  const guardHash = computePathTreeHash(f.origin).treeHash
  const trashRoot = path.join(f.parent, '.skillsmith-trash')

  const origMkdir = fs.mkdirSync
  let swapped = false
  fs.mkdirSync = (p, ...rest) => {
    const out = origMkdir(p, ...rest)
    // Once the op dir exists, replace the whole trash root with a different
    // directory: same name, different inode.
    if (!swapped && String(p).startsWith(trashRoot) && String(p) !== trashRoot) {
      swapped = true
      // Swap the trash root for a different directory, but RECREATE the op
      // directory inside it at the same path. A cruder swap that destroys the
      // op dir is caught earlier by the opDir lstat as stopped/
      // quarantine-failed -- also safe, but it tests a different clause. The
      // threat Finding 3 describes is a destination that still LOOKS right, so
      // the test has to preserve the structure and change only the identity.
      const opDirPath = String(p)
      fs.renameSync(trashRoot, path.join(f.root, 'trash-aside'))
      origMkdir(opDirPath, { recursive: true })
    }
    return out
  }

  let r
  try {
    r = quarantineTree(f.parent, 'tree', { guardHash, expectIdentity: bound })
  } finally {
    fs.mkdirSync = origMkdir
  }

  check('6a the destination swap landed', swapped, true)
  check('6b a swapped destination is not used', r.status, 'kept')
  check('6c and the reason names the destination', r.reason, 'quarantine-destination-changed')
  check('6d the source tree is untouched', fs.existsSync(f.origin), true)
  let bytes
  try {
    bytes = fs.readFileSync(path.join(f.origin, 'sub', 'f.txt'), 'utf8')
  } catch (err) {
    bytes = `UNREADABLE:${err.code}`
  }
  check('6e the source bytes are intact', bytes, 'exact same bytes')
  fs.rmSync(f.root, { recursive: true, force: true })
}

if (!allOk) {
  console.error('[quarantine-identity] FAIL')
  process.exit(1)
}
console.log('[quarantine-identity] all cases passed')
process.exit(0)

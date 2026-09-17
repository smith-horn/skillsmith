#!/usr/bin/env node
// SMI-6676: quarantine.mjs must close every descriptor it opens.
//
// WHY THIS FILE EXISTS. `ensureTrashRoot`'s best-effort `mnt_id` check read
// `statAt(openDir(parentAbs).fd, '.')` on two consecutive lines and discarded
// both handles -- two leaked descriptors per call. Three things hid it:
//
//   1. the spike's dispatcher never passes `options.nativeShim`, so the block
//      does not execute in any run in the corpus;
//   2. its `catch` swallows every failure silently;
//   3. M2's held-fd audit was scoped to walk.mjs, not this file.
//
// It matters now because the owner's 2026-09-17 decision ships C4, so this is
// the file that runs in production, and D1 asks for exactly this mnt_id check
// -- wiring it as specified is what activates the leak.
//
// The test drives a COUNTING FAKE SHIM rather than the real one, because the
// property under test is the open/close balance, not the syscall behaviour. A
// fake also lets the mismatch branch be forced, which is the case a
// close-at-the-end fix would still leak on: it returns early.

import { quarantineTree } from '../quarantine.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let allOk = true
function check(label, actual, expected) {
  const ok = actual === expected
  allOk = allOk && ok
  console.log(
    `[quarantine-fd] ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)} -- ${ok ? 'PASS' : 'FAIL'}`
  )
}

/** A shim that records every descriptor it hands out and every one closed. */
function countingShim({ mntIds }) {
  const opened = []
  const closed = []
  let next = 1000
  return {
    stats: { opened, closed },
    openDir() {
      const fd = next++
      opened.push(fd)
      return { fd, errno: 0 }
    },
    statAt(fd) {
      // Return whichever mntId the case wants for this call index.
      const i = opened.indexOf(fd)
      return { mntId: mntIds[i] ?? 1 }
    },
    closeFd(fd) {
      closed.push(fd)
    },
  }
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 's6676-qfd-'))
  const parent = path.join(root, 'parent')
  fs.mkdirSync(path.join(parent, 'tree', 'sub'), { recursive: true })
  fs.writeFileSync(path.join(parent, 'tree', 'sub', 'f.txt'), 'user bytes')
  return { root, parent }
}

function run(mntIds) {
  const { root, parent } = fixture()
  const shim = countingShim({ mntIds })
  try {
    quarantineTree(parent, 'tree', { nativeShim: shim })
  } catch {
    // The result is not what this test asserts; the fd balance is.
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
  return shim.stats
}

// --- 1. matching mnt_ids: the block runs to completion -------------------
// Revert (drop the finally): opened 2, closed 0.
const same = run([7, 7])
check('1a matching mntId -- every opened fd is closed', same.closed.length, same.opened.length)
check('1b and at least one was actually opened', same.opened.length > 0, true)

// --- 2. MISMATCHED mnt_ids: the function RETURNS from inside the block ---
// This is the case a naive "close at the end of the block" fix still leaks on,
// because the mismatch branch returns before reaching it. Only try/finally
// covers it, which is why the fix uses one.
const diff = run([7, 9])
check('2a mismatched mntId -- still closes every fd', diff.closed.length, diff.opened.length)
check('2b the early-return branch really was taken', diff.opened.length >= 2, true)

// --- 3. no leak across repeated calls ------------------------------------
// A per-call leak of 2 is invisible in one call and fatal in a loop; uninstall
// and doctor prune both call this per skill.
let totalOpened = 0
let totalClosed = 0
for (let i = 0; i < 25; i += 1) {
  const s = run([7, 7])
  totalOpened += s.opened.length
  totalClosed += s.closed.length
}
check('3a 25 calls leak nothing', totalClosed, totalOpened)
check('3b and the loop did real work', totalOpened >= 25, true)

if (!allOk) {
  console.error('[quarantine-fd] FAIL')
  process.exit(1)
}
console.log('[quarantine-fd] all cases passed')
process.exit(0)

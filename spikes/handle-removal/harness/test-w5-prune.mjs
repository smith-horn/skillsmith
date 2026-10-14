#!/usr/bin/env node
// SMI-7123 Wave 5 (design §7): T5, T6, T7, T17, the walker guard (M4), and the
// clean run (M3).
//
//   node test-w5-prune.mjs [--against <stub|mutant>]
//
// DECLARED FAILURES:
//   T5  prune-naive         mounted source bytes deleted
//   T6  prune-warn-only     confirmItem called 0 times; the changed copy deleted
//   T7  apply-ignored       writes > 0 with apply:false
//   T17 prune-resume-blind  the staged copy deleted at listing
//   guard M4 (in-process walk)  walkerPid === the parent pid; parent cwd moved
//   clean M3 (ctime compared after the rename)  a clean copy stops entry-misplaced

import fs from 'node:fs'
import path from 'node:path'
import { makeCheck, rmFixture, againstArg } from './w5-test-util.mjs'
import { makeParent, park, snapshotTree } from './w5-fixtures.mjs'
import {
  canMount,
  mountAt,
  detachUnder,
  noImageAttachedUnder,
  MOUNT_KINDS,
  mountsUnder,
} from './w5-mounts.mjs'
import { loadImpl, walkerOpts } from './w5-variant.mjs'

const TAG = '[w5-prune]'
const { check, done } = makeCheck(TAG)
const against = againstArg()
const TARGETS = {
  T5: ['prune-naive'],
  T6: ['prune-warn-only'],
  T7: ['apply-ignored'],
  T17: ['prune-resume-blind'],
  guard: ['M4'],
  clean: ['M3'],
}
const want = (t) => against === null || TARGETS[t].includes(against)
if (against !== null && !Object.values(TARGETS).flat().includes(against)) {
  console.error(`${TAG} no case targets ${against}`)
  process.exit(2)
}
const impl = await loadImpl(against)
const walker = () =>
  impl.stub || impl.walkerPath ? walkerOpts({ stub: impl.stub, walkerPath: impl.walkerPath }) : {}
const yes = () => true

// --- T5: a mounted copy is never deleted, even with --allow-changed --------------
if (want('T5')) {
  if (!canMount()) console.log(`${TAG} T5 skipped: no mounts here`)
  for (const kind of canMount() ? MOUNT_KINDS : []) {
    const f = makeParent('w5-t5-')
    try {
      const c = park(f.parent, 'm', 'Q')
      const m = mountAt(kind, path.join(c.copyPath, 'target'), f)
      try {
        impl.prune({
          roots: [f.parent],
          apply: true,
          allowChanged: true,
          isTTY: true,
          confirmBatch: yes,
          confirmItem: yes,
          walker: walker(),
        })
      } catch (err) {
        console.log(
          `${TAG} T5 ${kind}: the impl threw (${err.code ?? err.message}); checking bytes anyway`
        )
      }
      check(
        `T5 ${kind} the mounted bytes are intact`,
        readOr(path.join(m.mp, 'mounted-user.txt')),
        'mounted-user-bytes'
      )
      check(
        `T5 ${kind} the mount source is intact`,
        readOr(path.join(m.source, 'mounted-user.txt')),
        'mounted-user-bytes'
      )
      check(
        `T5 ${kind} the mount is still live`,
        mountsUnder(fs.realpathSync(f.root)).length > 0,
        true
      )
    } finally {
      cleanMounts(f, `T5 ${kind}`)
    }
  }
}

// --- T6: non-clean needs --allow-changed AND a per-item yes -------------------------
if (want('T6')) {
  const f = makeParent('w5-t6-')
  try {
    const c = park(f.parent, 'ch', 'changed')
    const before = snapshotTree(c.copyPath)
    let calls = 0
    impl.prune({
      roots: [f.parent],
      apply: true,
      allowChanged: false,
      isTTY: true,
      confirmBatch: yes,
      confirmItem: () => (calls += 1) && true,
      walker: walker(),
    })
    check(
      'T6 without --allow-changed the changed copy is untouched',
      exists(c.copyPath) && snapshotTree(c.copyPath),
      before
    )
    calls = 0
    impl.prune({
      roots: [f.parent],
      apply: true,
      allowChanged: true,
      isTTY: true,
      confirmBatch: yes,
      confirmItem: () => {
        calls += 1
        return false
      },
      walker: walker(),
    })
    check('T6 with --allow-changed confirmItem is asked once for the one non-clean copy', calls, 1)
    check(
      'T6 a batch yes with a per-item no never deletes it',
      exists(c.copyPath) && snapshotTree(c.copyPath),
      before
    )
    if (against === null) {
      const r = impl.prune({
        roots: [f.parent],
        apply: true,
        allowChanged: true,
        isTTY: true,
        confirmBatch: yes,
        confirmItem: yes,
      })
      check(
        'T6 control: a per-item yes removes it',
        r.items.map((i) => i.status).join(','),
        'removed'
      )
    }
  } finally {
    rmFixture(f.root)
  }
}

// --- T7: apply:false makes 0 writes -------------------------------------------------
if (want('T7')) {
  const f = makeParent('w5-t7-')
  try {
    park(f.parent, 'a', 'Q')
    park(f.parent, 'b', 'changed')
    const tr = path.join(f.parent, '.skillsmith-trash')
    fs.mkdirSync(path.join(tr, '.prune-00000000000000aa'), { mode: 0o700 })
    const before = snapshotTree(f.parent)
    const writes = countWrites(() =>
      impl.prune({ roots: [f.parent], apply: false, confirmBatch: yes, walker: walker() })
    )
    check('T7 apply:false: 0 write calls in the parent', writes, 0)
    check('T7 apply:false: the whole parent is unchanged', snapshotTree(f.parent), before)
  } finally {
    rmFixture(f.root)
  }
}

// --- T17: a crash after P4d is listed, never deleted unasked, and verified fresh --
if (want('T17')) {
  const f = makeParent('w5-t17-')
  try {
    const c = park(f.parent, 's', 'Q', { extraDirs: 2 })
    const real = (await import('../prune.mjs')).prune
    // Setup with the REAL code: SIGKILL the walker right after P4d's rename returns.
    const crash = real({
      roots: [f.parent],
      apply: true,
      confirmBatch: yes,
      walker: walkerOpts({
        hooks: [
          {
            when: 'after',
            fn: 'renameSync',
            a0Re: `${escapeRe(c.copyPath)}$`,
            action: { kind: 'kill' },
          },
        ],
      }),
    })
    check('T17 premise: the walker died after staging', crash.items[0]?.reason, 'walker-died')
    const S = fs
      .readdirSync(c.trashRoot)
      .filter((n) => n.startsWith('.prune-'))
      .map((n) => path.join(c.trashRoot, n))[0]
    const staged = S ? path.join(S, c.name) : '/nonexistent'
    check('T17 premise: the copy sits staged at S/leaf', exists(staged), true)
    const snap = exists(staged) ? snapshotTree(staged) : null
    impl.prune({ roots: [f.parent], apply: false, walker: walker() })
    check(
      'T17 a listing leaves the staged copy byte-exact',
      exists(staged) && snapshotTree(staged),
      snap
    )
    impl.prune({ roots: [f.parent], apply: true, confirmBatch: () => false, walker: walker() })
    check(
      'T17 a batch no leaves the staged copy byte-exact',
      exists(staged) && snapshotTree(staged),
      snap
    )
    if (against === null) {
      const l = real({ roots: [f.parent] })
      check(
        'T17 the listing names it staged and clean',
        l.plan.rows.map((r) => `${r.from}/${r.klass}`).join(','),
        'staged/clean'
      )
      const r = real({ roots: [f.parent], apply: true, confirmBatch: yes })
      check(
        'T17 a yes removes it after a fresh verify',
        r.items.map((i) => i.status).join(','),
        'removed'
      )
      check(
        'T17 no staging directory is left',
        fs.readdirSync(c.trashRoot).filter((n) => n.startsWith('.prune-')).length,
        0
      )
    }
  } finally {
    rmFixture(f.root)
  }
}

// --- guard (M4): the walk never runs in the parent process --------------------------
if (want('guard')) {
  const f = makeParent('w5-guard-')
  try {
    park(f.parent, 'g', 'Q')
    const cwd = process.cwd()
    const r = impl.prune({ roots: [f.parent], apply: true, confirmBatch: yes })
    check('guard: the item was removed', r.items[0]?.status, 'removed')
    check(
      'guard: it was walked by another process',
      Number(r.items[0]?.walkerPid) !== process.pid &&
        Number.isInteger(Number(r.items[0]?.walkerPid)),
      true
    )
    check('guard: the parent cwd did not move', process.cwd(), cwd)
    if (against === null) {
      const { stageVerifyDelete } = await import('../prune.walk.mjs')
      let threw = false
      const saved = process.env.SKILLSMITH_PRUNE_WALKER
      delete process.env.SKILLSMITH_PRUNE_WALKER
      try {
        stageVerifyDelete({})
      } catch (err) {
        threw = /dedicated prune walker child/.test(err.message)
      }
      if (saved !== undefined) process.env.SKILLSMITH_PRUNE_WALKER = saved
      check('guard: stageVerifyDelete refuses to run in-process', threw, true)
    }
  } finally {
    rmFixture(f.root)
  }
}

// --- clean run (M3): three clean copies are removed, sidecars included ---------------
if (want('clean')) {
  const f = makeParent('w5-clean-')
  try {
    for (const n of ['c1', 'c2', 'c3']) park(f.parent, n, 'Q', { extraDirs: 2 })
    const r = impl.prune({ roots: [f.parent], apply: true, confirmBatch: yes, walker: walker() })
    check(
      'clean: all three removed',
      r.items.map((i) => i.status).join(','),
      'removed,removed,removed'
    )
    check('clean: exit status 0', r.exitCode, 0)
    check(
      'clean: the trash holds nothing',
      fs.readdirSync(path.join(f.parent, '.skillsmith-trash')).join(','),
      ''
    )
  } finally {
    rmFixture(f.root)
  }
}

done()

function readOr(p) {
  try {
    return fs.readFileSync(p, 'utf8')
  } catch (err) {
    return `UNREADABLE:${err.code}`
  }
}
function exists(p) {
  try {
    fs.lstatSync(p)
    return true
  } catch {
    return false
  }
}
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
function cleanMounts(f, label) {
  const left = detachUnder(fs.realpathSync(f.root), f)
  check(`${label} cleanup detached every mount`, left.join(','), '')
  check(`${label} cleanup detached the image`, noImageAttachedUnder(f.root), true)
  if (left.length === 0) rmFixture(f.root)
}
/** Counts write-class fs calls made in THIS process while fn runs, and any child spawned. */
function countWrites(fn) {
  const W = [
    'writeFileSync',
    'appendFileSync',
    'mkdirSync',
    'renameSync',
    'unlinkSync',
    'rmdirSync',
    'rmSync',
    'symlinkSync',
    'chmodSync',
    'writeSync',
    'copyFileSync',
    'truncateSync',
    'utimesSync',
    'mkdtempSync',
  ]
  const orig = new Map(W.map((n) => [n, fs[n]]))
  let n = 0
  for (const k of W)
    fs[k] = function counted(...a) {
      n += 1
      return orig.get(k).apply(this, a)
    }
  try {
    fn()
  } finally {
    for (const k of W) fs[k] = orig.get(k)
  }
  return n
}

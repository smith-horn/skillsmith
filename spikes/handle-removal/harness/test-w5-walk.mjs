#!/usr/bin/env node
// SMI-7123 Wave 5 (design §7): T8-T14 and the mutations M1, M2. Every case
// runs a real prune whose walker child carries the fs interposer.
//
//   node test-w5-walk.mjs [--against <stub|mutant>]
//
// DECLARED FAILURES:
//   T8  mkdir-eexist-ok             a pre-made 0777 S accepted (the item proceeds)
//   T9  stage-fallback-rm           destructive calls > 0 on a failed staging rename
//   T10 sidecar-same-inode-rewrite  the rewritten sidecar unlinked (M6: case i only)
//   T11 prune-in-place              the trace has no read under S
//   T12 walk-no-meta-check          the fd-written file deleted
//   T13 walk-delete-unknown         the intruder deleted (M2: the by-name intruder)
//   T14 prune-follow                the outside sentinel deleted (M1: a call runs
//                                   with its cwd outside S)

import fs from 'node:fs'
import path from 'node:path'
import { makeCheck, rmFixture, againstArg, linkedBase } from './w5-test-util.mjs'
import { makeParent, park, snapshotTree } from './w5-fixtures.mjs'
import { loadImpl, walkerOpts, readTrace } from './w5-variant.mjs'
import { matchPruneTrace, canonicalizer } from './prune-trace-match.mjs'

const TAG = '[w5-walk]'
const { check, done } = makeCheck(TAG)
const against = againstArg()
const TARGETS = {
  T8: ['mkdir-eexist-ok'],
  T9: ['stage-fallback-rm'],
  T10: ['sidecar-same-inode-rewrite', 'M6'],
  T11: ['prune-in-place'],
  T12: ['walk-no-meta-check'],
  T13: ['walk-delete-unknown', 'M2'],
  T14: ['prune-follow', 'M1'],
}
if (against !== null && !Object.values(TARGETS).flat().includes(against)) {
  console.error(`${TAG} no case targets ${against}`)
  process.exit(2)
}
const want = (t) => against === null || TARGETS[t].includes(against)
const impl = await loadImpl(against)
const yes = () => true
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const exists = (p) => {
  try {
    fs.lstatSync(p)
    return true
  } catch {
    return false
  }
}
const read = (p) => {
  try {
    return fs.readFileSync(p, 'utf8')
  } catch (err) {
    return `UNREADABLE:${err.code}`
  }
}
const stagings = (trashRoot) =>
  fs
    .readdirSync(trashRoot)
    .filter((n) => n.startsWith('.prune-'))
    .map((n) => path.join(trashRoot, n))

/** One prune of every copy under `parent` with `hooks` in the walker child. */
function run(f, hooks, { allowChanged = false, extraFds = [] } = {}) {
  const traceFile = path.join(f.root, `trace-${Math.random().toString(16).slice(2)}.json`)
  const walker = walkerOpts({
    stub: impl.stub,
    walkerPath: impl.walkerPath,
    hooks,
    traceFile,
    extraFds,
  })
  const r = impl.prune({
    roots: [f.parent],
    apply: true,
    allowChanged,
    isTTY: true,
    confirmBatch: yes,
    confirmItem: yes,
    walker,
  })
  return { r, item: r.items[0] ?? {}, t: readTrace(traceFile) }
}

// --- T8: S is exclusive, 0700 and ours ----------------------------------------------
if (want('T8')) {
  const f = makeParent('w5-t8-')
  try {
    const c = park(f.parent, 't', 'Q')
    const snap = snapshotTree(c.copyPath)
    const { item, t } = run(f, [
      {
        when: 'before',
        fn: 'mkdirSync',
        a0Re: '\\.prune-[0-9a-f]{16}$',
        action: { kind: 'mkdir0777' },
      },
    ])
    check(
      'T8 premise: the 0777 S was pre-made at the walker mkdir',
      (t?.fired ?? []).some((x) => x.kind === 'mkdir0777'),
      true
    )
    check(
      'T8 a pre-made 0777 S is refused: kept/staging-unusable',
      `${item.status}/${item.reason}`,
      'kept/staging-unusable'
    )
    check(
      'T8 the copy is untouched at its trash path',
      exists(c.copyPath) && snapshotTree(c.copyPath),
      snap
    )
  } finally {
    rmFixture(f.root)
  }
}

// --- T9: a staging rename failure leaves everything and deletes nothing -------------
if (want('T9')) {
  const f = makeParent('w5-t9-')
  try {
    const c = park(f.parent, 't', 'Q')
    const snap = snapshotTree(c.copyPath)
    const { item, t } = run(f, [
      {
        when: 'before',
        fn: 'renameSync',
        a0Re: `^${esc(c.copyPath)}$`,
        action: { kind: 'throw', code: 'EXDEV' },
      },
    ])
    check('T9 kept/stage-failed', `${item.status}/${item.reason}`, 'kept/stage-failed')
    check('T9 errno reported', item.errno, 'EXDEV')
    const userDestructive = (t?.trace ?? []).filter(
      (e) =>
        ['unlinkSync', 'rmdirSync', 'rmSync'].includes(e.fn) &&
        !/\.prune-[0-9a-f]{16}(\/intent\.json)?$/.test(e.a0 ?? '')
    )
    check('T9 0 destructive calls on user entries', userDestructive.length, 0)
    check('T9 the copy is untouched', exists(c.copyPath) && snapshotTree(c.copyPath), snap)
    check('T9 no staging directory is left', stagings(c.trashRoot).length, 0)
  } finally {
    rmFixture(f.root)
  }
}

// --- T10 (P8): the sidecar is staged and verified byte-exact -------------------------
if (want('T10')) {
  for (const [label, hook, expect] of [
    [
      "(i) before P4d'",
      {
        when: 'before',
        fn: 'renameSync',
        a1Re: '/sidecar\\.json$',
        action: { kind: 'rewriteInPlace', path: '$a0' },
      },
      'held/sidecar-changed-in-staging',
    ],
    [
      '(ii) after P4e',
      {
        when: 'before',
        fn: 'writeFileSync',
        a0Re: '^deleting$',
        action: { kind: 'rewriteInPlace', path: '$cwd/sidecar.json' },
      },
      'stopped/changed-during-delete',
    ],
  ]) {
    const f = makeParent('w5-t10-')
    try {
      park(f.parent, 't', 'Q')
      const { item, t } = run(f, [hook])
      check(
        `T10 ${label} premise: the in-place rewrite fired`,
        (t?.fired ?? []).some((x) => x.kind === 'rewriteInPlace' && !x.hookError),
        true
      )
      check(`T10 ${label} ${expect}`, `${item.status}/${item.reason}`, expect)
      const S =
        item.stagingPath ?? stagings(path.join(f.parent, '.skillsmith-trash'))[0] ?? '/nonexistent'
      const sc = read(path.join(S, 'sidecar.json'))
      check(`T10 ${label} the rewritten sidecar is intact in S`, /^Z+$/.test(sc), true)
    } finally {
      rmFixture(f.root)
    }
  }
}

// --- T11: verify at S catches a change made after P3 --------------------------------
// Run twice: on the real fixture root, and on a root reached THROUGH A SYMLINK
// (the regression case: macOS's default tmpdir is /var -> /private/var).
function t11(label, base) {
  const f = makeParent('w5-t11-', base)
  try {
    const c = park(f.parent, 't', 'Q')
    const { item, t } = run(f, [
      {
        when: 'before',
        fn: 'lstatSync',
        a0Re: `^${esc(c.copyPath)}$`,
        nth: 1,
        action: {
          kind: 'writeAbs',
          path: path.join(c.copyPath, 'top.txt'),
          data: 'top-bytes-CHANGED-after-approval',
        },
      },
    ])
    // One canonical spelling from the fixture root, decided up front (see canonicalizer).
    const C = canonicalizer(f.root)
    const realTrash = C(c.trashRoot)
    const readsUnderS = (t?.trace ?? []).filter((e) => {
      if (
        !['lstatSync', 'openSync', 'readFileSync', 'readdirSync'].includes(e.fn) ||
        typeof e.a0 !== 'string'
      )
        return false
      const p = C(path.resolve(e.cwd ?? '/', e.a0))
      return /\/\.prune-[0-9a-f]{16}\//.test(p) && p.startsWith(realTrash + path.sep)
    })
    check(
      `T11${label} the trace has reads under S (verified at the staging path)`,
      readsUnderS.length > 0,
      true
    )
    check(
      `T11${label} held/changed-in-staging`,
      `${item.status}/${item.reason}`,
      'held/changed-in-staging'
    )
    check(
      `T11${label} the changed bytes are intact at S/leaf`,
      read(path.join(item.heldPath ?? '/nonexistent', 'top.txt')),
      'top-bytes-CHANGED-after-approval'
    )
  } finally {
    rmFixture(f.root)
  }
}
if (want('T11')) {
  t11('', undefined)
  const lb = linkedBase()
  try {
    t11(' [symlinked root]', lb.base)
  } finally {
    lb.cleanup()
  }
}

// --- T12 (P2): an fd write before the pre-touch check stops the walk -----------------
if (want('T12')) {
  const f = makeParent('w5-t12-')
  let fd = null
  try {
    const c = park(f.parent, 't', 'Q')
    const victim = path.join(c.copyPath, 'target', 'orig-f1')
    const ino = fs.lstatSync(victim).ino
    fd = fs.openSync(victim, 'r+')
    // SAME SIZE as 'original-content-f1' (19 bytes), so only the ns mtime/ctime can tell.
    const { item, t } = run(
      f,
      [
        {
          when: 'before',
          fn: 'lstatSync',
          a0Re: '^orig-f1$',
          action: { kind: 'writeFd', fd: 3, data: 'ORIGINAL-CONTENT-F1', pos: 0 },
        },
      ],
      { extraFds: [fd] }
    )
    check(
      'T12 premise: the fd write fired',
      (t?.fired ?? []).some((x) => x.kind === 'writeFd' && !x.hookError),
      true
    )
    check(
      'T12 stopped/changed-during-delete',
      `${item.status}/${item.reason}`,
      'stopped/changed-during-delete'
    )
    const found = findIno(path.join(f.parent, '.skillsmith-trash'), ino)
    check(
      'T12 the written file survives byte-exact',
      found ? read(found) : 'GONE',
      'ORIGINAL-CONTENT-F1'
    )
  } finally {
    if (fd !== null) fs.closeSync(fd)
    rmFixture(f.root)
  }
}

// --- T13 (P4): an entry added mid-walk stops it; M2's by-name intruder ---------------
if (want('T13')) {
  // The by-name intruder lands right after the FIRST rename the walk makes. That
  // copy has no sidecar (approved per-item), so the first rename is the tree's
  // first leaf (`link` sorts first) and M2's unlink-by-original-name meets the
  // intruder before anything else can stop the walk (with a sidecar, M2 dies at
  // W1's own unlink with ENOENT and never reaches the tree -- measured).
  const cases = [
    [
      'added in an unvisited dir',
      'Q',
      {
        when: 'before',
        fn: 'lstatSync',
        a0Re: '^link$',
        action: { kind: 'writeRel', name: 'target/intruder.txt', data: 'intruder-bytes' },
      },
      'intruder.txt',
      ['walk-delete-unknown'],
    ],
    [
      'by-name, after the rename',
      'orphan',
      {
        when: 'after',
        fn: 'renameSync',
        a0Re: '^link$',
        action: { kind: 'writeRel', name: 'link', data: 'intruder-bytes' },
      },
      'link',
      ['M2'],
    ],
  ]
  for (const [label, shape, hook, name, targets] of cases) {
    if (against !== null && !targets.includes(against)) continue
    const f = makeParent('w5-t13-')
    try {
      park(f.parent, 't', shape)
      const { item, t } = run(f, [hook], { allowChanged: shape !== 'Q' })
      check(
        `T13 ${label}: premise, the intruder was written`,
        (t?.fired ?? []).some((x) => x.kind === 'writeRel' && !x.hookError),
        true
      )
      check(
        `T13 ${label}: stopped/entry-added-during-delete`,
        `${item.status}/${item.reason}`,
        'stopped/entry-added-during-delete'
      )
      check(
        `T13 ${label}: the intruder survives`,
        findByContent(path.join(f.parent, '.skillsmith-trash'), name, 'intruder-bytes'),
        true
      )
    } finally {
      rmFixture(f.root)
    }
  }
}

// --- T14 (P7): neither an outward symlink nor a dir swapped for one leads outside ----
if (want('T14')) {
  for (const label of ['outward symlink', 'dir swapped for a symlink after P4e']) {
    const f = makeParent('w5-t14-')
    try {
      const outside = path.join(f.root, 'outside')
      fs.mkdirSync(outside)
      fs.writeFileSync(path.join(outside, 'sentinel.txt'), 'sentinel-bytes')
      park(f.parent, 't', 'Q', label === 'outward symlink' ? { outLink: outside } : {})
      const hooks =
        label === 'outward symlink'
          ? []
          : [
              {
                when: 'before',
                fn: 'chdir',
                a0Re: '^\\.d-',
                nth: 1,
                action: { kind: 'symlinkSwap', outside, awayDir: f.root },
              },
            ]
      const { t } = run(f, hooks)
      if (hooks.length)
        check(
          `T14 ${label}: premise, the swap fired`,
          (t?.fired ?? []).some((x) => x.kind === 'symlinkSwap' && !x.hookError),
          true
        )
      check(
        `T14 ${label}: the outside sentinel is byte-exact`,
        read(path.join(outside, 'sentinel.txt')),
        'sentinel-bytes'
      )
      const realOut = fs.realpathSync(outside)
      // Excluded: the identity check right after a chdir (it is what detects the
      // swap) and chdir entries themselves (their cwd is the pre-call directory,
      // and a chdir does no I/O there -- it is how the walker leaves).
      const outsideCalls = (t?.trace ?? []).filter(
        (e, i, a) =>
          typeof e.cwd === 'string' &&
          (e.cwd === realOut || e.cwd.startsWith(realOut + '/')) &&
          e.fn !== 'chdir' &&
          !(e.fn === 'statSync' && e.a0 === '.' && a[i - 1]?.fn === 'chdir')
      )
      check(
        `T14 ${label}: no call other than the identity check ran inside the outside dir`,
        outsideCalls.length,
        0
      )
    } finally {
      rmFixture(f.root)
    }
  }
  // The trace invariant holds on a clean run (real code only).
  if (against === null) {
    const traceCase = (label, base) => {
      const f = makeParent('w5-trace-', base)
      try {
        const c = park(f.parent, 't', 'Q', { extraDirs: 2 })
        const { item, t } = run(f, [])
        check(`trace${label}: the clean run removed the copy`, item.status, 'removed')
        const m = matchPruneTrace(t, {
          root: f.root,
          S: item.stagingPath ?? findS(t, c.trashRoot),
          copyPath: c.copyPath,
          opDir: c.opDir,
        })
        check(
          `trace${label} invariant holds (${m.destructive} destructive calls)${m.violations.length ? ` ${m.violations[0]}` : ''}`,
          m.ok,
          true
        )
      } finally {
        rmFixture(f.root)
      }
    }
    traceCase('', undefined)
    const lb = linkedBase()
    try {
      traceCase(' [symlinked root]', lb.base)
    } finally {
      lb.cleanup()
    }
  }
}

done()

function findIno(root, ino) {
  for (const n of fs.readdirSync(root)) {
    const p = path.join(root, n)
    const st = fs.lstatSync(p)
    if (st.ino === ino && st.isFile()) return p
    if (st.isDirectory()) {
      const r = findIno(p, ino)
      if (r) return r
    }
  }
  return null
}
function findByContent(root, name, content) {
  for (const n of fs.readdirSync(root)) {
    const p = path.join(root, n)
    const st = fs.lstatSync(p)
    if (st.isFile() && n === name && read(p) === content) return true
    if (st.isDirectory() && findByContent(p, name, content)) return true
  }
  return false
}
function findS(t, trashRoot) {
  const e = (t?.trace ?? []).find(
    (x) => x.fn === 'mkdirSync' && /\.prune-[0-9a-f]{16}$/.test(x.a0 ?? '')
  )
  return e ? e.a0 : path.join(trashRoot, '.prune-unknown')
}

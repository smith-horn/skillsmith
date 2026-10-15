#!/usr/bin/env node
// SMI-7123 Wave 5 (design §3.3, §7): T15 swap-after-precheck, T16
// darwin-cover-before-rename (darwin only), T18 late bind mount (Linux only),
// and the P9 trace invariant (M8 / misplace-revert).
//
//   node test-w5-misplace.mjs [--against <stub|mutant>]
//
// DECLARED FAILURES:
//   T15 misplace-silent / M7   `misplaced` null
//   T16 misplace-silent        a renamed source path not in misplaced[]
//   T18 prune-c0 (linux)       the bind-source bytes lost
//   P9-trace misplace-revert / M8   the trace invariant fails (a hidden name renamed back)

import fs from 'node:fs'
import path from 'node:path'
import { makeCheck, rmFixture, againstArg, linkedBase } from './w5-test-util.mjs'
import { makeParent, park } from './w5-fixtures.mjs'
import { loadImpl, walkerOpts, readTrace } from './w5-variant.mjs'
import { matchPruneTrace } from './prune-trace-match.mjs'
import {
  PLATFORM,
  canMount,
  makeImage,
  detachUnder,
  noImageAttachedUnder,
  mountsUnder,
} from './w5-mounts.mjs'

const TAG = '[w5-misplace]'
const { check, done } = makeCheck(TAG)
const against = againstArg()
const TARGETS = {
  T15: ['misplace-silent', 'M7'],
  T16: ['misplace-silent'],
  T18: ['prune-c0'],
  P9trace: ['misplace-revert', 'M8'],
}
if (against !== null && !Object.values(TARGETS).flat().includes(against)) {
  console.error(`${TAG} no case targets ${against}`)
  process.exit(2)
}
const want = (t) => against === null || TARGETS[t].includes(against)
const impl = await loadImpl(against)
const yes = () => true
const read = (p) => {
  try {
    return fs.readFileSync(p, 'utf8')
  } catch (err) {
    return `UNREADABLE:${err.code}`
  }
}
const readJson = (p) => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

function run(f, hooks) {
  const traceFile = path.join(f.root, `trace-${Math.random().toString(16).slice(2)}.json`)
  const walker = walkerOpts({ stub: impl.stub, walkerPath: impl.walkerPath, hooks, traceFile })
  const r = impl.prune({ roots: [f.parent], apply: true, confirmBatch: yes, walker })
  return { item: r.items[0] ?? {}, t: readTrace(traceFile) }
}

/** T15 / P9(i): the swap lands between the walker's pre-check of top.txt and its rename. */
function swapCase(label, extra, base = undefined) {
  const f = makeParent('w5-t15-', base)
  const rec = path.join(f.root, 'swap.json')
  try {
    const c = park(f.parent, 't', 'Q')
    const { item, t } = run(f, [
      {
        when: 'before',
        fn: 'renameSync',
        a0Re: '^top\\.txt$',
        a1Re: '^\\.d-',
        action: { kind: 'swap', awayDir: f.root, data: 'replacement-bytes', recordFile: rec },
      },
    ])
    const sw = readJson(rec)
    check(`${label} premise: the swap landed`, sw !== null, true)
    extra({ f, c, item, t, sw })
  } finally {
    rmFixture(f.root)
  }
}

if (want('T15')) {
  swapCase('T15', ({ item, t, sw }) => {
    check('T15 stopped/entry-misplaced', `${item.status}/${item.reason}`, 'stopped/entry-misplaced')
    const m = Array.isArray(item.misplaced) ? item.misplaced[0] : null
    check('T15 misplaced[0] is reported', m !== null, true)
    if (m === null) return
    let st = null
    try {
      st = fs.lstatSync(m.path, { bigint: true })
    } catch {
      /* gone */
    }
    check('T15 misplaced[0].path exists', st !== null, true)
    check(
      'T15 it is the replacement (dev, ino)',
      st ? `${st.dev}/${st.ino}` : null,
      sw ? `${sw.dev}/${sw.ino}` : 'no-record'
    )
    check('T15 with the replacement bytes', read(m.path), 'replacement-bytes')
    check('T15 originalRel', m.originalRel, 'top.txt')
    check('T15 cause', m.cause, 'swapped')
    const rec = readJson(path.join(item.stagingPath ?? '/nonexistent', 'misplaced.json'))
    check(
      'T15 S/misplaced.json matches the result',
      rec ? `${rec.path}|${rec.originalRel}|${rec.cause}` : null,
      `${m.path}|${m.originalRel}|${m.cause}`
    )
    const at = (t?.trace ?? []).findIndex((e) => e.fn === 'renameSync' && e.a0 === 'top.txt')
    const unlinksAfter = (t?.trace ?? [])
      .slice(at + 1)
      .filter((e) => e.fn === 'unlinkSync' && !/(deleting|intent\.json)$/.test(e.a0 ?? ''))
    check('T15 0 unlinks after the misplacement', at >= 0 ? unlinksAfter.length : -1, 0)
    check(
      'T15 the verified original the writer moved away is intact',
      read(sw?.away ?? '/nonexistent'),
      'top-bytes'
    )
  })
}

if (want('P9trace')) {
  // Once on the real root, once on a root reached through a symlink (regression case).
  const p9 = (label, base) =>
    swapCase(
      label,
      ({ f, c, item, t }) => {
        const m = matchPruneTrace(t, {
          root: f.root,
          S: item.stagingPath ?? null,
          copyPath: c.copyPath,
          opDir: c.opDir,
        })
        check(
          `${label} the trace invariant holds${m.violations.length ? ` (${m.violations[0]})` : ''}`,
          m.ok,
          true
        )
      },
      base
    )
  p9('P9-trace', undefined)
  const lb = linkedBase()
  try {
    p9('P9-trace [symlinked root]', lb.base)
  } finally {
    lb.cleanup()
  }
}

// --- T16 (P9 ii): a volume covers the walker's cwd right before its rename (darwin) -
if (want('T16')) {
  if (PLATFORM !== 'darwin') {
    console.log(
      `${TAG} T16 NEVER-RAN on ${PLATFORM}: darwin-only by design (Linux has no cwd-capturing cover)`
    )
  } else {
    const f = makeParent('w5-t16-')
    const rec = path.join(f.root, 'cover.json')
    try {
      park(f.parent, 't', 'Q')
      const img = makeImage(
        f.root,
        { 'orig-f1': 'volume-bytes', 'other.txt': 'other-volume-bytes' },
        f
      )
      const { item } = run(f, [
        {
          when: 'before',
          fn: 'renameSync',
          a0Re: '^orig-f1$',
          a1Re: '^\\.d-',
          action: { kind: 'cover', image: img, recordFile: rec },
        },
      ])
      const cov = readJson(rec)
      if (cov === null) {
        console.log(
          `${TAG} T16 NEVER-RAN: the cover did not land in its window (item ${item.status}/${item.reason})`
        )
        check('T16 premise: the cover landed before the rename', false, true)
      } else {
        const m = Array.isArray(item.misplaced) ? item.misplaced : []
        const named = new Set(m.map((x) => x.path))
        check(
          'T16 stopped/entry-misplaced',
          `${item.status}/${item.reason}`,
          'stopped/entry-misplaced'
        )
        check('T16 cause cwd-covered', m[0]?.cause, 'cwd-covered')
        // Every source path on the volume: unchanged, or named in misplaced[].
        const vol = cov.mountpoint
        const srcs = { 'orig-f1': 'volume-bytes', 'other.txt': 'other-volume-bytes' }
        for (const [n, bytes] of Object.entries(srcs)) {
          const unchanged = read(path.join(vol, n)) === bytes
          const renamedTo = m.find((x) => x.originalRel.endsWith(`/${n}`) || x.originalRel === n)
          const namedOk = renamedTo
            ? named.has(renamedTo.path) && read(renamedTo.path) === bytes
            : false
          check(`T16 volume ${n}: unchanged or named in misplaced[]`, unchanged || namedOk, true)
        }
        check(
          'T16 the volume is still mounted',
          mountsUnder(fs.realpathSync(f.root)).length > 0,
          true
        )
      }
    } finally {
      const left = detachUnder(fs.realpathSync(f.root), f)
      check('T16 cleanup detached every mount', left.join(','), '')
      check('T16 cleanup detached the image', noImageAttachedUnder(f.root), true)
      if (left.length === 0) rmFixture(f.root)
    }
  }
}

// --- T18 (P1): a late same-filesystem bind mount (Linux) ---------------------------
if (want('T18')) {
  if (PLATFORM !== 'linux' || !canMount()) {
    console.log(
      `${TAG} T18 NEVER-RAN on ${PLATFORM}: needs a Linux bind mount (root, throwaway container)`
    )
  } else {
    const f = makeParent('w5-t18-')
    try {
      const c = park(f.parent, 't', 'Q')
      const src = path.join(f.root, 'bind-src')
      fs.mkdirSync(src)
      fs.writeFileSync(path.join(src, 'bind-user.txt'), 'bind-user-bytes')
      // After verification, before deletion: the walker's `deleting` write (real)
      // or the c0 stub's own `deleting` marker.
      const rel =
        impl.stub === 'prune-c0'
          ? { base: c.copyPath, rel: 'target' }
          : { rel: path.join(c.name, 'target') }
      const { item } = run(f, [
        {
          when: 'before',
          fn: 'writeFileSync',
          a0Re: 'deleting$',
          action: {
            kind: 'mount',
            mount: 'bind',
            source: src,
            ...rel,
            recordFile: path.join(f.root, 'm.json'),
          },
        },
      ])
      check(
        'T18 premise: the bind mount landed',
        readJson(path.join(f.root, 'm.json')) !== null,
        true
      )
      check(
        'T18 the bind-source bytes are intact',
        read(path.join(src, 'bind-user.txt')),
        'bind-user-bytes'
      )
      check('T18 stopped or held, never removed', ['stopped', 'held'].includes(item.status), true)
    } finally {
      const left = detachUnder(fs.realpathSync(f.root), f)
      check('T18 cleanup detached every mount', left.join(','), '')
      if (left.length === 0) rmFixture(f.root)
    }
  }
}

done()

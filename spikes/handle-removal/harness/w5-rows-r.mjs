// SMI-7123 Wave 5 (design §6): R1 (the class matrix pruned in one batch), P5
// (SIGKILL at each §4 point), P6 (confirmation tiers), W1 (the trash warning).
import fs from 'node:fs'
import path from 'node:path'
import { CONFIRMATION_TEXT } from '../prune.mjs'
import { trashUsage, trashWarning } from '../trash-usage.mjs'
import { makeParent, park, snapshotTree } from './w5-fixtures.mjs'
import { canMount, mountAt, MOUNT_KINDS } from './w5-mounts.mjs'
import { loadImpl, walkerOpts } from './w5-variant.mjs'
import * as M from './w5-mutants.mjs'
import {
  raw,
  finishFixture,
  countWrites,
  prunePass,
  exists,
  esc,
  yes,
  read,
} from './w5-rows-common.mjs'

const realImpl = await loadImpl(null)

// --- R1 -------------------------------------------------------------------------------
const SCHEMA_EDITS = [
  (s) => ({ ...s, extra: 1 }),
  (s) => Object.fromEntries(Object.entries(s).filter(([k]) => k !== 'createdAt')),
  (s) => ({ ...s, opId: 'op-other' }),
  (s) => ({ ...s, bytes: -1 }),
]
function r1Fixture(f) {
  const clean = ['c1', 'c2', 'c3'].map((n) => park(f.parent, n, 'Q'))
  const others = [
    park(f.parent, 'ch', 'changed'),
    park(f.parent, 'h', 'H'),
    park(f.parent, 'u', 'U'),
    park(f.parent, 'unr', 'unreadable'),
  ]
  SCHEMA_EDITS.forEach((edit, i) => {
    const c = park(f.parent, `s${i}`, 'Q')
    fs.writeFileSync(
      c.sidecarPath,
      JSON.stringify(edit(JSON.parse(fs.readFileSync(c.sidecarPath, 'utf8'))), null, 2)
    )
    others.push(c)
  })
  let mounted = null
  if (canMount()) {
    mounted = park(f.parent, 'mnt', 'Q')
    mountAt(MOUNT_KINDS[0], path.join(mounted.copyPath, 'target'), f)
    others.push(mounted)
  }
  return { clean, others, mounted }
}
function r1(arm, variant) {
  const f = makeParent('w5-r1-')
  const fails = []
  try {
    const { clean, others, mounted } = r1Fixture(f)
    const snaps = new Map(others.map((c) => [c.copyPath, snapshotTree(c.copyPath)]))
    if (variant === 'dry') {
      const before = snapshotTree(f.parent)
      const w = countWrites(() =>
        realImpl.prune({ roots: [f.parent], apply: false, confirmBatch: yes })
      )
      if (w.n !== 0) fails.push(`${w.n} writes with apply:false`)
      if (snapshotTree(f.parent) !== before) fails.push('the tree changed with apply:false')
      if (w.out.plan.confirmationText !== CONFIRMATION_TEXT)
        fails.push('the plan lacks the §7.1 text')
      return raw({ variant, checked: others.length + 3, failures: fails, item: { status: 'kept' } })
    }
    const impl = arm === 'candidate' ? realImpl : { prune: M.pruneNaive }
    const { r } = prunePass(impl, f)
    let lost = 0
    for (const c of others) {
      const now = exists(c.copyPath) ? snapshotTree(c.copyPath) : null
      if (now !== snaps.get(c.copyPath)) {
        lost += 1
        fails.push(`${c.name} not byte-exact at the same inodes`)
      }
    }
    for (const c of clean) if (exists(c.copyPath)) fails.push(`clean ${c.name} not removed`)
    if (arm === 'candidate') {
      const removed = r.items.filter((i) => i.status === 'removed').length
      if (removed !== 3) fails.push(`${removed} removed, want 3`)
      if (r.plan.confirmationText !== CONFIRMATION_TEXT) fails.push('the plan lacks the §7.1 text')
      if (mounted && !r.items.some((i) => i.entry === mounted.name && i.reason === 'mounted'))
        fails.push('the mounted copy is not kept/mounted')
    }
    return raw({
      variant,
      checked: others.length,
      lost,
      failures: fails,
      item: { status: lost ? 'removed' : 'kept' },
    })
  } finally {
    finishFixture(f)
  }
}

// --- P5: SIGKILL at each §4 point ----------------------------------------------------
const P5_POINTS = {
  'after-P4b': { when: 'after', fn: 'mkdirSync', a0Re: '\\.prune-[0-9a-f]{16}$', expect: 'empty' },
  'after-P4c': {
    when: 'after',
    fn: 'writeFileSync',
    a0Re: 'intent\\.json$',
    expect: 'intent-only',
  },
  'after-P4d': {
    when: 'after',
    fn: 'renameSync',
    a1Re: '\\.prune-[0-9a-f]{16}/[^/]+$',
    a0Re: '/op-',
    expect: 'staged',
  },
  "after-P4d'": { when: 'after', fn: 'renameSync', a1Re: '/sidecar\\.json$', expect: 'staged' },
  'during-P4f': {
    when: 'after',
    fn: 'unlinkSync',
    a0Re: '^\\.d-',
    nth: 4,
    expect: 'interrupted-delete',
  },
  // After the walk's LAST user-entry delete -- rmdir of the staged leaf, by its exact
  // name -- and before any P4g metadata removal. It used to key on "before unlinkSync
  // of S/deleting", which P4g stopped making when metadata removal became
  // rename-to-random (c2): measured, the hook never fired and the point read NEVER-RAN
  // in the 9073ceffa APFS run. `leafRe` is resolved per run to ^<leaf name>$.
  'after-P4f': { when: 'after', fn: 'rmdirSync', leafRe: true, expect: 'finished' },
}
function p5(arm, point) {
  const f = makeParent('w5-p5-')
  const fails = []
  try {
    const c = park(f.parent, 'k', 'Q', { extraDirs: 2 })
    const spec = P5_POINTS[point]
    const { when, fn, a1Re, nth } = spec
    const a0Re = spec.leafRe ? `^${esc(c.name)}$` : spec.a0Re
    const crash = realImpl.prune({
      roots: [f.parent],
      apply: true,
      confirmBatch: yes,
      walker: walkerOpts({ hooks: [{ when, fn, a0Re, a1Re, nth, action: { kind: 'kill' } }] }),
    })
    if (crash.items[0]?.reason !== 'walker-died')
      return raw({
        hookFired: false,
        variant: point,
        extra: { neverRan: `no crash: ${crash.items[0]?.status}/${crash.items[0]?.reason}` },
      })
    const S =
      fs
        .readdirSync(c.trashRoot)
        .filter((n) => n.startsWith('.prune-'))
        .map((n) => path.join(c.trashRoot, n))[0] ?? null
    const tree =
      S && exists(path.join(S, c.name))
        ? path.join(S, c.name)
        : exists(c.copyPath)
          ? c.copyPath
          : null
    const snap = tree ? snapshotTree(tree) : null
    // c1's rule covers Skillsmith's own metadata too: the staging leftover (even an
    // empty or metadata-only one, as after P4f) must be unchanged by a listing and a
    // batch no. Without this, a control deleting it unasked recorded no failure.
    const sSnap = S && exists(S) ? snapshotTree(S) : null
    const impl = arm === 'candidate' ? realImpl : { prune: M.pruneResumeBlind }
    const listing = impl.prune({ roots: [f.parent], apply: false })
    if (arm === 'candidate') {
      const state = listing.plan.leftovers?.[0]?.state ?? 'none'
      if (state !== spec.expect) fails.push(`leftover state ${state}, want ${spec.expect}`)
    }
    impl.prune({
      roots: [f.parent],
      apply: true,
      confirmBatch: () => false,
      confirmItem: () => false,
      allowChanged: false,
    })
    if (sSnap !== null && (!exists(S) || snapshotTree(S) !== sSnap)) {
      fails.push('the staging leftover changed without a confirmation')
    }
    let lost = 0
    if (tree && (!exists(tree) || snapshotTree(tree) !== snap)) {
      lost = 1
      fails.push(
        `the ${tree === c.copyPath ? 'trash' : 'staged'} copy changed without a confirmation`
      )
    }
    if (arm === 'candidate') {
      const fin = realImpl.prune({
        roots: [f.parent],
        apply: true,
        confirmBatch: yes,
        allowChanged: true,
        isTTY: true,
        confirmItem: yes,
      })
      const st = fin.items.map((i) => i.status).join(',')
      if (tree && st !== 'removed') fails.push(`after confirmation: ${st}`)
      const left = fs.readdirSync(c.trashRoot).filter((n) => n.startsWith('.prune-'))
      if (left.length) fails.push(`staging left after confirmation: ${left.join(',')}`)
    }
    return raw({
      variant: point,
      checked: tree ? 1 : 0,
      lost,
      failures: fails,
      item: { status: lost ? 'removed' : 'kept' },
    })
  } finally {
    finishFixture(f)
  }
}

// --- P6: confirmation tiers --------------------------------------------------------
function p6(arm) {
  const f = makeParent('w5-p6-')
  const fails = []
  try {
    const clean = park(f.parent, 'c', 'Q')
    const non = ['changed', 'H', 'U', 'orphan'].map((s) => park(f.parent, `n${s}`, s))
    const snaps = new Map(non.map((c) => [c.copyPath, snapshotTree(c.copyPath)]))
    let calls = 0
    const impl = arm === 'candidate' ? realImpl : { prune: M.pruneWarnOnly }
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
    })
    if (calls !== non.length) fails.push(`confirmItem called ${calls}, want ${non.length}`)
    let lost = 0
    for (const c of non) {
      if (!exists(c.copyPath) || snapshotTree(c.copyPath) !== snaps.get(c.copyPath)) {
        lost += 1
        fails.push(`${c.name} deleted or changed by a batch yes`)
      }
    }
    if (exists(clean.copyPath)) fails.push('the clean copy was not removed by the batch yes')
    return raw({
      checked: non.length,
      lost,
      failures: fails,
      item: { status: lost ? 'removed' : 'kept' },
    })
  } finally {
    finishFixture(f)
  }
}

// --- W1: the warning ---------------------------------------------------------------
const GB = 1e9
const W1_CASES = {
  'free10-total0.6': [10 * GB, [0.6 * GB], true],
  'free10-total0.4': [10 * GB, [0.4 * GB], false],
  'free100-total0.9': [100 * GB, [0.9 * GB], false],
  'free100-total1.1': [100 * GB, [0.6 * GB, 0.5 * GB], true],
  'allocated-not-apparent': null,
}
function w1(arm, c) {
  const warn = arm === 'candidate' ? trashWarning : M.warnMaxNotMin
  const fails = []
  if (W1_CASES[c]) {
    const [free, sizes, over] = W1_CASES[c]
    const u = {
      volumes: [
        {
          dev: '1',
          freeBytes: free,
          totalBytes: 500 * GB,
          copies: sizes.map((b, i) => ({
            path: `/t/c${i}`,
            bytes: b,
            originPath: null,
            opId: `op-${i}`,
          })),
        },
      ],
    }
    const w = warn(u)
    if (w.over !== over) fails.push(`over ${w.over}, want ${over}`)
    if (over && arm === 'candidate' && !(w.message ?? '').includes('/t/c0'))
      fails.push('the message does not name the largest')
    return raw({ variant: c, checked: 1, failures: fails })
  }
  const f = makeParent('w5-w1-')
  try {
    park(f.parent, 'tiny', 'Q', { extraFiles: 300 })
    const statfs = () => ({ bavail: 1e12 / 4096, bsize: 4096, blocks: 2e12 / 4096 })
    const u = trashUsage({ roots: [f.parent], statfs })
    const alloc = u.volumes[0].copies[0].bytes
    const apparent = JSON.parse(
      read(
        fs
          .readdirSync(path.join(f.parent, '.skillsmith-trash'))
          .map((o) => path.join(f.parent, '.skillsmith-trash', o))
          .flatMap((d) =>
            fs
              .readdirSync(d)
              .filter((x) => x.endsWith('.json'))
              .map((x) => path.join(d, x))
          )[0]
      )
    ).bytes
    const cap = Math.floor((alloc + apparent) / 2)
    if (!(alloc > cap && apparent < cap))
      return raw({
        hookFired: false,
        variant: c,
        extra: { neverRan: `premise: alloc ${alloc} apparent ${apparent}` },
      })
    const w = warn(u, { capBytes: cap })
    if (!w.over) fails.push('the warning did not fire on allocated bytes')
    return raw({ variant: c, checked: 1, failures: fails, extra: { alloc, apparent, cap } })
  } finally {
    finishFixture(f)
  }
}

export const R_ROWS = {
  R1: {
    variants: ['batch', 'dry'],
    arms: {
      candidate: (v) => r1('candidate', v),
      'prune-naive': (v) => (v === 'dry' ? r1('prune-naive', 'batch') : r1('prune-naive', v)),
    },
  },
  P5: {
    variants: Object.keys(P5_POINTS),
    arms: { candidate: (v) => p5('candidate', v), 'prune-resume-blind': (v) => p5('control', v) },
  },
  P6: {
    variants: [null],
    arms: { candidate: () => p6('candidate'), 'prune-warn-only': () => p6('control') },
  },
  W1: {
    variants: Object.keys(W1_CASES),
    arms: { candidate: (v) => w1('candidate', v), 'warn-max-not-min': (v) => w1('control', v) },
  },
}
export { esc }

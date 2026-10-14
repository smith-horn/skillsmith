// SMI-7123 Wave 5 (design §6): the walker rows P1-P4 and P7-P9. Every candidate
// run is a real prune whose walker child carries the fs interposer; control
// arms run the named stub or mutant on the same fixture.
import fs from 'node:fs'
import path from 'node:path'
import { makeParent, park } from './w5-fixtures.mjs'
import { PLATFORM, canMount, makeImage, mountAt, mountsUnder, MOUNT_KINDS } from './w5-mounts.mjs'
import { loadImpl } from './w5-variant.mjs'
import { matchPruneTrace } from './prune-trace-match.mjs'
import {
  raw,
  neverRan,
  finishFixture,
  prunePass,
  fired,
  findIno,
  sourcesAccounted,
  read,
  readJson,
  esc,
  exists,
} from './w5-rows-common.mjs'

const impls = {}
const impl = async (name) => (impls[name] ??= await loadImpl(name === 'candidate' ? null : name))
await Promise.all(
  [
    'candidate',
    'prune-naive',
    'prune-c0',
    'prune-in-place',
    'prune-follow',
    'sidecar-same-inode-rewrite',
    'misplace-silent',
    'misplace-revert',
    'M5',
  ].map(impl)
)
const I = (n) => impls[n]

const SRC_FILES = { 'orig-f1': 'original-content-f1' }

// --- P1: a mount lands (pre-verify | post-verify | at the 50th rename) ---------------
const P1_VARIANTS = canMount()
  ? MOUNT_KINDS.flatMap((k) => ['pre-verify', 'post-verify', 'rename-50'].map((t) => `${k}/${t}`))
  : ['no-mounts']
function p1(arm, variant) {
  if (variant === 'no-mounts') return neverRan(variant, 'mounts need darwin or Linux root')
  const [kind, timing] = variant.split('/')
  const f = makeParent('w5-p1-')
  const fails = []
  try {
    const c = park(f.parent, 'm', 'Q', { extraDirs: 15 })
    // Mount content is hash-identical to the target dir, so only mountinfo (or
    // st_dev) can see a pre-verify mount (M5's observable).
    let source
    let action
    if (kind === 'bind') {
      source = fs.mkdtempSync(path.join(f.root, 'bind-src-'))
      for (const [n, b] of Object.entries(SRC_FILES)) fs.writeFileSync(path.join(source, n), b)
      fs.chmodSync(path.join(source, 'orig-f1'), 0o644)
      // mkdtemp makes 0700; the target dir is 0755. Equal modes keep the bind
      // HASH-IDENTICAL to the covered dir, so at pre-verify only mountinfo can
      // see it (measured: with 0700 the hash differed and M5 was caught by hash).
      fs.chmodSync(source, fs.statSync(path.join(c.copyPath, 'target')).mode & 0o7777)
      action = { kind: 'mount', mount: 'bind', source }
    } else if (kind === 'tmpfs') {
      action = { kind: 'mount', mount: 'tmpfs', files: SRC_FILES }
    } else {
      action = { kind: 'mount', mount: 'hdiutil', image: makeImage(f.root, SRC_FILES, f) }
    }
    const rec = path.join(f.root, 'mount.json')
    let r
    let item
    let t = null
    if (arm === 'candidate' || arm === 'M5') {
      const hook =
        timing === 'pre-verify'
          ? {
              when: 'after',
              fn: 'renameSync',
              a1Re: '/sidecar\\.json$',
              action: {
                ...action,
                baseFromA1Dir: true,
                rel: path.join(c.name, 'target'),
                recordFile: rec,
              },
            }
          : timing === 'post-verify'
            ? {
                when: 'before',
                fn: 'writeFileSync',
                a0Re: '^deleting$',
                action: { ...action, rel: path.join(c.name, 'target'), recordFile: rec },
              }
            : {
                when: 'before',
                fn: 'renameSync',
                a1Re: '^\\.d-',
                a0IsDir: true,
                from: 50,
                countAll: true,
                action: { ...action, target: '$a0', recordFile: rec },
              }
      ;({ r, item, t } = prunePass(I(arm), f, { hooks: [hook] }))
      if (!fired(t, 'mount'))
        return raw({
          hookFired: false,
          variant,
          extra: { neverRan: 'the mount did not land in its window', fired: t?.fired },
        })
    } else if (arm === 'prune-c0') {
      // prune-c0 runs as the walker child, AFTER the real P2 classification, so a
      // mount present before prune would be kept/mounted and c0 would never walk.
      // It lands at c0's own `deleting` marker, after c0's in-place verify (as T18).
      ;({ r, item, t } = prunePass(I(arm), f, {
        hooks: [
          {
            when: 'before',
            fn: 'writeFileSync',
            a0Re: 'deleting$',
            action: { ...action, base: c.copyPath, rel: 'target', recordFile: rec },
          },
        ],
      }))
      if (!fired(t, 'mount'))
        return raw({
          hookFired: false,
          variant,
          extra: { neverRan: "the mount did not land at c0's marker" },
        })
    } else {
      // prune-naive: the mount is present when it starts (it has no step to time against).
      const mp = path.join(c.copyPath, 'target')
      const m = mountAt(kind, mp, f, SRC_FILES)
      if (kind === 'bind') source = m.source
      fs.writeFileSync(rec, JSON.stringify({ target: mp }))
      ;({ r, item } = prunePass(I(arm), f))
    }
    const target = readJson(rec)?.target
    const sources =
      kind === 'bind'
        ? Object.fromEntries(Object.entries(SRC_FILES).map(([n, b]) => [path.join(source, n), b]))
        : Object.fromEntries(Object.entries(SRC_FILES).map(([n, b]) => [path.join(target, n), b]))
    const lostFails = sourcesAccounted(sources, item.misplaced)
    fails.push(...lostFails)
    if (mountsUnder(fs.realpathSync(f.root)).length === 0) fails.push('no mount is live any more')
    if (arm === 'candidate' || arm === 'M5') {
      const okStatus = [
        'held/mount-in-staging',
        'stopped/mount-appeared-during-delete',
        'stopped/entry-misplaced',
      ].includes(`${item.status}/${item.reason}`)
      if (!okStatus) fails.push(`status ${item.status}/${item.reason}`)
      if (
        timing === 'pre-verify' &&
        !(item.status === 'held' && item.reason === 'mount-in-staging')
      )
        fails.push(
          `pre-verify: a mount present at P4e must hold the copy, got ${item.status}/${item.reason} deleted=${item.deleted ?? 0}`
        )
    }
    return raw({
      variant,
      item,
      checked: Object.keys(sources).length,
      lost: lostFails.length,
      failures: fails,
      extra: {
        deleted: item.deleted ?? null,
        detail: item.detail ?? null,
        misplaced: item.misplaced ?? null,
        r: r?.exitCode,
      },
    })
  } finally {
    finishFixture(f)
  }
}

// --- P2 / P2r: an fd holder writes (before the pre-touch check | after the post-rename lstat)
function p2(arm, residual) {
  const f = makeParent('w5-p2-')
  const fails = []
  let fd = null
  try {
    const c = park(f.parent, 't', 'Q')
    const victim = path.join(c.copyPath, 'target', 'orig-f1')
    const ino = fs.lstatSync(victim).ino
    fd = fs.openSync(victim, 'r+')
    const data = 'ORIGINAL-CONTENT-F1' // same size: only ns metadata can tell
    let item
    let t = null
    if (arm === 'candidate') {
      const hook = residual
        ? {
            when: 'after',
            fn: 'lstatSync',
            a0Re: '^\\.d-',
            a0IsFile: true,
            nth: 2,
            action: { kind: 'writeFd', fd: 3, data, pos: 0 },
          }
        : {
            when: 'before',
            fn: 'lstatSync',
            a0Re: '^orig-f1$',
            action: { kind: 'writeFd', fd: 3, data, pos: 0 },
          }
      ;({ item, t } = prunePass(I('candidate'), f, { hooks: [hook], extraFds: [fd] }))
      if (!fired(t, 'writeFd'))
        return raw({
          hookFired: false,
          variant: residual ? 'P2r' : null,
          extra: { neverRan: 'the write did not land in its window' },
        })
    } else {
      fs.writeSync(fd, data, 0)
      ;({ item } = prunePass(I('prune-naive'), f))
    }
    const found = findIno(path.join(f.parent, '.skillsmith-trash'), ino)
    const intact = found !== null && read(found) === data
    if (!intact) fails.push('the fd-written file is gone or changed')
    if (
      !residual &&
      arm === 'candidate' &&
      `${item.status}/${item.reason}` !== 'stopped/changed-during-delete'
    )
      fails.push(`status ${item.status}/${item.reason}`)
    return raw({ item, checked: 1, lost: intact ? 0 : 1, failures: fails })
  } finally {
    if (fd !== null) fs.closeSync(fd)
    finishFixture(f)
  }
}

// --- P3: copyPath is recreated and written by path after P4d -------------------------
function p3(arm) {
  const f = makeParent('w5-p3-')
  const fails = []
  try {
    const c = park(f.parent, 't', 'Q')
    const data = 'new-bytes-written-by-path'
    const hook =
      arm === 'candidate'
        ? {
            when: 'after',
            fn: 'renameSync',
            a0Re: `^${esc(c.copyPath)}$`,
            action: { kind: 'recreate', path: c.copyPath, data },
          }
        : {
            when: 'before',
            fn: 'rmSync',
            a0Re: `^${esc(c.copyPath)}$`,
            action: { kind: 'writeAbs', path: path.join(c.copyPath, 'new-user-file.txt'), data },
          }
    const { item, t } = prunePass(I(arm === 'candidate' ? 'candidate' : 'prune-in-place'), f, {
      hooks: [hook],
    })
    if (!fired(t, hook.action.kind))
      return raw({ hookFired: false, extra: { neverRan: 'the writer did not land' } })
    const intact = read(path.join(c.copyPath, 'new-user-file.txt')) === data
    if (!intact) fails.push('the new bytes at the trash path were lost')
    if (arm === 'candidate' && item.status !== 'removed')
      fails.push(`the staged copy was not removed: ${item.status}/${item.reason}`)
    return raw({ item, checked: 1, lost: intact ? 0 : 1, failures: fails })
  } finally {
    finishFixture(f)
  }
}

// --- P4: an in-tree cwd holder adds a file mid-walk ----------------------------------
function p4(arm) {
  const f = makeParent('w5-p4-')
  const fails = []
  try {
    const c = park(f.parent, 't', 'Q')
    let item
    if (arm === 'candidate') {
      let t
      ;({ item, t } = prunePass(I('candidate'), f, {
        hooks: [
          {
            when: 'before',
            fn: 'lstatSync',
            a0Re: '^link$',
            action: { kind: 'writeRel', name: 'target/intruder.txt', data: 'intruder-bytes' },
          },
        ],
      }))
      if (!fired(t, 'writeRel'))
        return raw({ hookFired: false, extra: { neverRan: 'the intruder did not land' } })
      if (`${item.status}/${item.reason}` !== 'stopped/entry-added-during-delete')
        fails.push(`status ${item.status}/${item.reason}`)
    } else {
      fs.writeFileSync(path.join(c.copyPath, 'target', 'intruder.txt'), 'intruder-bytes')
      ;({ item } = prunePass(I('prune-naive'), f))
    }
    const found = walkFind(
      path.join(f.parent, '.skillsmith-trash'),
      'intruder.txt',
      'intruder-bytes'
    )
    if (!found) fails.push('the intruder was deleted')
    return raw({ item, checked: 1, lost: found ? 0 : 1, failures: fails })
  } finally {
    finishFixture(f)
  }
}

// --- P7: an outward symlink | a dir swapped for a symlink after P4e ------------------
function p7(arm, variant) {
  const f = makeParent('w5-p7-')
  const fails = []
  try {
    const outside = path.join(f.root, 'outside')
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, 'sentinel.txt'), 'sentinel-bytes')
    park(f.parent, 't', 'Q', variant === 'outward' ? { outLink: outside } : {})
    const hooks =
      variant === 'swap' && arm === 'candidate'
        ? [
            {
              when: 'before',
              fn: 'chdir',
              a0Re: '^\\.d-',
              nth: 1,
              action: { kind: 'symlinkSwap', outside, awayDir: f.root },
            },
          ]
        : []
    if (variant === 'swap' && arm !== 'candidate')
      return neverRan(
        variant,
        'prune-follow has no chdir to time the swap against; the outward case is its control'
      )
    const { item, t } = prunePass(I(arm === 'candidate' ? 'candidate' : 'prune-follow'), f, {
      hooks,
    })
    if (hooks.length && !fired(t, 'symlinkSwap'))
      return raw({ hookFired: false, variant, extra: { neverRan: 'the swap did not land' } })
    const intact = read(path.join(outside, 'sentinel.txt')) === 'sentinel-bytes'
    if (!intact) fails.push('the outside sentinel was deleted')
    return raw({ variant, item, checked: 1, lost: intact ? 0 : 1, failures: fails })
  } finally {
    finishFixture(f)
  }
}

// --- P8: the sidecar rewritten in place, same size (i) before P4d' (ii) after P4e ----
function p8(arm, variant) {
  const f = makeParent('w5-p8-')
  const fails = []
  try {
    park(f.parent, 't', 'Q')
    const hook =
      variant === 'i'
        ? {
            when: 'before',
            fn: 'renameSync',
            a1Re: '/sidecar\\.json$',
            action: { kind: 'rewriteInPlace', path: '$a0' },
          }
        : {
            when: 'before',
            fn: 'writeFileSync',
            a0Re: '^deleting$',
            action: { kind: 'rewriteInPlace', path: '$cwd/sidecar.json' },
          }
    const { item, t } = prunePass(
      I(arm === 'candidate' ? 'candidate' : 'sidecar-same-inode-rewrite'),
      f,
      { hooks: [hook] }
    )
    if (!fired(t, 'rewriteInPlace'))
      return raw({ hookFired: false, variant, extra: { neverRan: 'the rewrite did not land' } })
    const S =
      item.stagingPath ??
      fs
        .readdirSync(path.join(f.parent, '.skillsmith-trash'))
        .filter((n) => n.startsWith('.prune-'))
        .map((n) => path.join(f.parent, '.skillsmith-trash', n))[0]
    const intact = S ? /^Z+$/.test(read(path.join(S, 'sidecar.json'))) : false
    if (!intact) fails.push('the rewritten sidecar was deleted')
    const want =
      variant === 'i' ? 'held/sidecar-changed-in-staging' : 'stopped/changed-during-delete'
    if (arm === 'candidate' && `${item.status}/${item.reason}` !== want)
      fails.push(`status ${item.status}/${item.reason}, want ${want}`)
    return raw({ variant, item, checked: 1, lost: intact ? 0 : 1, failures: fails })
  } finally {
    finishFixture(f)
  }
}

// --- P9: misplacement (i) swap-after-precheck (ii) darwin-cover-before-rename --------
function p9(arm, variant) {
  if (variant === 'ii' && PLATFORM !== 'darwin')
    return neverRan(variant, 'darwin-only: Linux has no cwd-capturing cover')
  const f = makeParent('w5-p9-')
  const fails = []
  try {
    const c = park(f.parent, 't', 'Q')
    const rec = path.join(f.root, 'hook.json')
    const sources = {}
    let hook
    if (variant === 'i') {
      hook = {
        when: 'before',
        fn: 'renameSync',
        a0Re: '^top\\.txt$',
        a1Re: '^\\.d-',
        action: { kind: 'swap', awayDir: f.root, data: 'replacement-bytes', recordFile: rec },
      }
    } else {
      const files = { 'orig-f1': 'volume-bytes', 'other.txt': 'other-volume-bytes' }
      hook = {
        when: 'before',
        fn: 'renameSync',
        a0Re: '^orig-f1$',
        a1Re: '^\\.d-',
        action: { kind: 'cover', image: makeImage(f.root, files, f), recordFile: rec },
      }
      Object.assign(sources, files)
    }
    const { item, t } = prunePass(I(arm), f, { hooks: [hook] })
    const h = readJson(rec)
    if (h === null)
      return raw({
        hookFired: false,
        variant,
        extra: { neverRan: `the ${variant === 'i' ? 'swap' : 'cover'} did not land in its window` },
      })
    const m = Array.isArray(item.misplaced) ? item.misplaced : []
    if (`${item.status}/${item.reason}` !== 'stopped/entry-misplaced')
      fails.push(`status ${item.status}/${item.reason}`)
    if (variant === 'i') {
      const st = m[0]
        ? (() => {
            try {
              return fs.lstatSync(m[0].path, { bigint: true })
            } catch {
              return null
            }
          })()
        : null
      if (!m[0]) fails.push('the replacement is not named in misplaced[]')
      else {
        if (
          !st ||
          `${st.dev}/${st.ino}` !== `${h.dev}/${h.ino}` ||
          read(m[0].path) !== 'replacement-bytes'
        )
          fails.push('misplaced[0] is not the replacement')
        if (m[0].originalRel !== 'top.txt' || m[0].cause !== 'swapped')
          fails.push(`originalRel/cause ${m[0].originalRel}/${m[0].cause}`)
        const file = readJson(path.join(item.stagingPath ?? '/nonexistent', 'misplaced.json'))
        if (!file || file.path !== m[0].path) fails.push('S/misplaced.json does not match')
      }
    } else {
      const vol = h.mountpoint
      const map = Object.fromEntries(
        Object.entries(sources).map(([n, b]) => [path.join(vol, n), b])
      )
      fails.push(...sourcesAccounted(map, m))
      if (m[0] && m[0].cause !== 'cwd-covered') fails.push(`cause ${m[0].cause}`)
    }
    const victim = variant === 'i' ? 'top.txt' : 'orig-f1'
    const at = (t?.trace ?? []).findIndex((e) => e.fn === 'renameSync' && e.a0 === victim)
    if (
      at >= 0 &&
      t.trace.slice(at + 1).some((e) => e.fn === 'unlinkSync' && /^\.d-/.test(e.a0 ?? ''))
    )
      fails.push('an unlink followed the misplacement')
    const tm = matchPruneTrace(t, {
      root: f.root,
      S: item.stagingPath ?? null,
      copyPath: c.copyPath,
      opDir: c.opDir,
    })
    if (!tm.ok) fails.push(`trace invariant: ${tm.violations[0]}`)
    return raw({ variant, item, checked: 1, failures: fails, extra: { misplaced: m } })
  } finally {
    finishFixture(f)
  }
}

function walkFind(root, name, content) {
  for (const n of fs.readdirSync(root)) {
    const p = path.join(root, n)
    const st = fs.lstatSync(p)
    if (st.isFile() && n === name && read(p) === content) return true
    if (st.isDirectory() && walkFind(p, name, content)) return true
  }
  return false
}

export const P_ROWS = {
  P1: {
    variants: P1_VARIANTS,
    arms: {
      candidate: (v) => p1('candidate', v),
      'prune-naive': (v) => p1('prune-naive', v),
      'prune-c0': (v) =>
        v.startsWith('bind/')
          ? p1('prune-c0', v)
          : neverRan(v, 'prune-c0 is the Linux same-dev bind control only'),
    },
  },
  P2: {
    variants: [null],
    arms: { candidate: () => p2('candidate', false), 'prune-naive': () => p2('control', false) },
  },
  P2r: { variants: [null], arms: { candidate: () => p2('candidate', true) } },
  P3: {
    variants: [null],
    arms: { candidate: () => p3('candidate'), 'prune-in-place': () => p3('control') },
  },
  P4: {
    variants: [null],
    arms: { candidate: () => p4('candidate'), 'prune-naive': () => p4('control') },
  },
  P7: {
    variants: ['outward', 'swap'],
    arms: { candidate: (v) => p7('candidate', v), 'prune-follow': (v) => p7('control', v) },
  },
  P8: {
    variants: ['i', 'ii'],
    arms: {
      candidate: (v) => p8('candidate', v),
      'sidecar-same-inode-rewrite': (v) => p8('control', v),
    },
  },
  // (ii) is darwin-only by design (Linux has no cwd-capturing cover, measured:
  // statSync('.') and relative lookups stay on the covered directory), so the
  // Linux row runs (i) only; p9() still records NEVER-RAN if (ii) is asked for there.
  P9: {
    variants: PLATFORM === 'darwin' ? ['i', 'ii'] : ['i'],
    arms: {
      candidate: (v) => p9('candidate', v),
      'misplace-silent': (v) => p9('misplace-silent', v),
      'misplace-revert': (v) => p9('misplace-revert', v),
    },
  },
}
export const M5_P1 = (v) => p1('M5', v)
export { exists }

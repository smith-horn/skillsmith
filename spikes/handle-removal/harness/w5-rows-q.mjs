// SMI-7123 Wave 5 (design §6): rows Q6-Q10 -- the trash root itself.
// Each arm builds its own fixture, runs once, cleans up, and returns one raw record.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { quarantineTree, computePathTreeHash } from '../quarantine.mjs'
import { listTrash, formatTrashReport } from '../prune.classify.mjs'
import { compactParkedIndex, gitignoreSuggestion } from '../trash-index.mjs'
import { makeParent, park, buildTree, snapshotTree } from './w5-fixtures.mjs'
import { PLATFORM, canMount, run as sh, makeImage, attachImage } from './w5-mounts.mjs'
import * as M from './w5-mutants.mjs'
import { raw, neverRan, otherFs, finishFixture, countDestructive, read } from './w5-rows-common.mjs'

// --- Q6: the fixture parent on another filesystem than the state root ----------------
function q6(arm) {
  if (!canMount()) return neverRan(null, 'no second filesystem without mounts')
  const f = makeParent('w5-q6-')
  const fails = []
  try {
    const parent = path.join(otherFs(f), 'parent')
    fs.mkdirSync(parent)
    const state = path.join(f.root, 'state')
    fs.mkdirSync(state)
    const indexPath = path.join(state, 'parked-index.jsonl')
    const origin = buildTree(parent, 'tree')
    const pDev = fs.statSync(parent).dev
    const sDev = fs.statSync(state).dev
    if (pDev === sDev) return neverRan(null, 'premise: parent and state root share a device')
    const r =
      arm === 'candidate'
        ? quarantineTree(parent, 'tree', {
            guardHash: computePathTreeHash(origin).treeHash,
            indexPath,
          })
        : M.c4Stateroot(parent, 'tree', state)
    if (r.status !== 'quarantined') fails.push(`${r.status}/${r.reason ?? ''} errno=${r.errno}`)
    if (r.status === 'quarantined') {
      const cDev = fs.lstatSync(r.path).dev
      if (cDev !== pDev) fails.push('the copy is not on the parent device')
      if (arm === 'candidate') {
        const idx = read(indexPath)
        if (!idx.includes(r.path)) fails.push('the index does not record the other-device path')
        const c = listTrash({ roots: [parent], indexPath }).roots[0].copies.find(
          (x) => x.copyPath === r.path
        )
        if (c?.index !== 'present') fails.push(`listTrash index: ${c?.index}`)
      }
    }
    return raw({ item: r, checked: 1, failures: fails })
  } finally {
    finishFixture(f)
  }
}

// --- Q7: errnos on the park itself; nothing deleted --------------------------------
const Q7_VARIANTS =
  PLATFORM === 'linux'
    ? ['EXDEV', 'EBUSY', 'EROFS', 'ENOSPC', 'EACCES']
    : ['EACCES', 'symlinked-trash-root', 'tree-is-mount']
function q7Setup(variant, f) {
  const parent = f.parent
  const tree = path.join(parent, 'target')
  if (variant === 'ENOSPC') {
    sh('mount', ['-t', 'tmpfs', '-o', 'size=64k', 'none', parent])
    buildTree(parent, 'target')
    try {
      fs.writeFileSync(path.join(parent, 'fill'), Buffer.alloc(1024 * 1024))
    } catch {
      /* full now */
    }
    return 'ENOSPC'
  }
  buildTree(parent, 'target')
  if (variant === 'EXDEV') {
    fs.mkdirSync(path.join(parent, '.skillsmith-trash'))
    sh('mount', ['-t', 'tmpfs', '-o', 'size=1m', 'none', path.join(parent, '.skillsmith-trash')])
  } else if (variant === 'EBUSY') {
    sh('mount', ['-t', 'tmpfs', '-o', 'size=1m', 'none', tree])
    fs.writeFileSync(path.join(tree, 'mounted-user.txt'), 'mounted-user-bytes')
  } else if (variant === 'EROFS') {
    sh('mount', ['--bind', parent, parent])
    sh('mount', ['-o', 'remount,ro,bind', parent])
  } else if (variant === 'symlinked-trash-root') {
    const elsewhere = path.join(f.root, 'elsewhere')
    fs.mkdirSync(elsewhere)
    fs.symlinkSync(elsewhere, path.join(parent, '.skillsmith-trash'))
  } else if (variant === 'tree-is-mount') {
    attachImage(makeImage(f.root, { 'mounted-user.txt': 'mounted-user-bytes' }, f), tree, f)
  } else if (variant === 'EACCES' && PLATFORM !== 'linux') {
    fs.chmodSync(parent, 0o555)
  }
  return variant === 'symlinked-trash-root' ? null : variant === 'tree-is-mount' ? 'EXDEV' : variant
}
function q7(arm, variant) {
  if (!canMount() && variant !== 'EACCES' && variant !== 'symlinked-trash-root')
    return neverRan(variant, 'needs mounts')
  const f = makeParent('w5-q7-')
  const fails = []
  try {
    const wantErrno = q7Setup(variant, f)
    const tree = path.join(f.parent, 'target')
    const before = { hash: computePathTreeHash(tree).treeHash, ino: fs.lstatSync(tree).ino }
    let r
    let destructive
    if (variant === 'EACCES' && PLATFORM === 'linux') {
      // Root bypasses DAC, so the park runs as uid 1000 in a child (test-quarantine-errnos' rule).
      execFileSync('chown', ['-R', '1000:1000', f.root])
      fs.chmodSync(f.parent, 0o555)
      const child = spawnSync(
        process.execPath,
        [new URL('./w5-q7-child.mjs', import.meta.url).pathname, f.parent, arm],
        { uid: 1000, gid: 1000, encoding: 'utf8' }
      )
      try {
        ;({ r, destructive } = JSON.parse(child.stdout.trim().split('\n').pop()))
      } catch {
        return neverRan(variant, `child failed: ${child.stderr.slice(0, 200)}`)
      }
    } else {
      const fn = arm === 'candidate' ? quarantineTree : M.c4Consolation(quarantineTree, M.rmRf)
      const c = countDestructive(() => fn(f.parent, 'target', { opId: `q7-${process.pid}` }))
      r = c.out
      destructive = c.n
    }
    // ENOSPC can strike AFTER a successful rename (the sidecar write): the tree is
    // parked whole and only the metadata is missing. test-quarantine-errnos.mjs
    // accepts that shape as safe; so does this row, with the content checked.
    if (variant === 'ENOSPC' && r.status === 'quarantined' && r.sidecarError) {
      const okContent = computePathTreeHash(r.path).treeHash === before.hash
      if (!okContent) fails.push('ENOSPC after rename: the parked content differs')
      if (destructive !== 0) fails.push(`${destructive} destructive calls`)
      return raw({
        item: r,
        variant,
        checked: 1,
        failures: fails,
        extra: { enospcAfterRename: true },
      })
    }
    if (r.status !== 'stopped' || r.reason !== 'quarantine-failed')
      fails.push(`${r.status}/${r.reason}`)
    // A trash root on another device is refused BEFORE the rename (D1: validated
    // before use), so it carries the diagnosis `trash-other-mount` and no errno --
    // an earlier stop than the rename's EXDEV, and the one quarantine.mjs makes.
    const preRenameDiag =
      variant === 'EXDEV' && r.errno === null && r.detail === 'trash-other-mount'
    if (wantErrno !== null && r.errno !== wantErrno && !preRenameDiag)
      fails.push(`errno ${r.errno}, want ${wantErrno}`)
    if (wantErrno === null && r.detail !== 'trash-unusable') fails.push(`detail ${r.detail}`)
    if (!r.path || !r.entry) fails.push('path/entry missing')
    if (destructive !== 0) fails.push(`${destructive} destructive calls`)
    let after = null
    try {
      after = { hash: computePathTreeHash(tree).treeHash, ino: fs.lstatSync(tree).ino }
    } catch {
      /* gone */
    }
    const lost = after === null ? 1 : 0
    if (after === null) fails.push('the tree is gone')
    else if (after.hash !== before.hash || after.ino !== before.ino)
      fails.push('tree hash or ino changed')
    return raw({ item: r, variant, checked: 1, lost, failures: fails })
  } finally {
    try {
      fs.chmodSync(f.parent, 0o755)
    } catch {
      /* best effort */
    }
    finishFixture(f)
  }
}

// --- Q8: the index merges into the scan; it never replaces it ----------------------
const Q8_IMPL = {
  candidate: listTrash,
  'list-index-only': M.listIndexOnly,
  'list-throwing': M.listThrowing,
  'list-scan-path': M.listScanPath,
}
function q8(arm, variant) {
  const f = makeParent('w5-q8-')
  const fails = []
  try {
    const indexPath = path.join(f.root, 'parked-index.jsonl')
    const a = park(f.parent, 'a', 'Q', { indexPath })
    const list = Q8_IMPL[arm]
    const copies = (l) => l.roots.flatMap((r) => r.copies)
    if (variant === 'a') {
      const b = park(f.parent, 'b', 'Q')
      const l = list({ roots: [f.parent], indexPath })
      const cb = copies(l).find((c) => c.copyPath === b.copyPath)
      if (!cb) fails.push('the copy without an index line is not listed')
      else if (cb.index !== 'missing') fails.push(`index ${cb.index}, want missing`)
      if (!copies(l).some((c) => c.copyPath === a.copyPath))
        fails.push('the indexed copy is not listed')
    } else if (variant === 'b') {
      fs.rmSync(a.copyPath, { recursive: true })
      try {
        const l = list({ roots: [f.parent], indexPath })
        if ((l.index?.errors ?? []).length) fails.push('a stale line was reported as an error')
      } catch (err) {
        fails.push(`listing threw: ${err.message}`)
      }
      compactParkedIndex(indexPath)
      if (read(indexPath).includes(a.copyPath))
        fails.push('the compacted index still names the gone copy')
    } else {
      const g = makeParent('w5-q8c-')
      try {
        const other = park(g.parent, 'o', 'Q', { indexPath })
        const l = list({ roots: [f.parent], indexPath })
        if (copies(l).some((c) => c.copyPath === other.copyPath))
          fails.push('a copy under an unscanned root was listed')
      } finally {
        finishFixture(g)
      }
    }
    return raw({
      variant,
      checked: 1,
      failures: fails,
      item: { status: fails.length ? 'kept' : 'kept' },
    })
  } finally {
    finishFixture(f)
  }
}

// --- Q9: the report -------------------------------------------------------------------
function q9(arm) {
  const f = makeParent('w5-q9-')
  const fails = []
  try {
    const cs = ['Q', 'U', 'H'].map((s) => park(f.parent, `r${s}`, s))
    const listing = listTrash({ roots: [f.parent] })
    const text = arm === 'candidate' ? formatTrashReport(listing) : M.reportDropOrigin(listing)
    for (const c of cs) {
      if (!text.includes(c.copyPath)) fails.push(`path ${c.name} missing`)
      const origin = path.join(f.parent, c.name.replace(/-[0-9a-f]{8}$/, ''))
      if (!text.includes(`origin: ${origin}`)) fails.push(`origin of ${c.name} missing`)
    }
    for (const k of ['clean', 'unverified', 'held'])
      if (!text.includes(k)) fails.push(`class ${k} missing`)
    if (!/\d+(\.\d+)? (B|KB|MB|GB)/.test(text)) fails.push('no size')
    if (!/ \d+d /.test(text)) fails.push('no age')
    if (!text.includes('next to your own directory'))
      fails.push('no "next to your own directory" sentence')
    return raw({ checked: 3, failures: fails })
  } finally {
    finishFixture(f)
  }
}

// --- Q10: never edit .gitignore; suggest once per root per run ---------------------
function q10(arm) {
  try {
    execFileSync('git', ['--version'], { stdio: 'pipe' })
  } catch {
    return neverRan(null, 'no git on this host')
  }
  const f = makeParent('w5-q10-')
  const fails = []
  try {
    execFileSync('git', ['init', '-q', f.parent])
    const gi = path.join(f.parent, '.gitignore')
    fs.writeFileSync(gi, 'node_modules/\n')
    const before = fs.readFileSync(gi)
    const suggest = arm === 'candidate' ? gitignoreSuggestion : M.gitignoreEditor
    const got = []
    for (let runNo = 0; runNo < 2; runNo += 1) {
      const seen = new Set()
      for (const n of [`a${runNo}`, `b${runNo}`]) {
        park(f.parent, n, 'Q')
        got.push(suggest(f.parent, seen) === null ? 'none' : 'suggested')
      }
    }
    if (got.join(',') !== 'suggested,none,suggested,none')
      fails.push(`suggestions ${got.join(',')}`)
    if (!fs.readFileSync(gi).equals(before)) fails.push('.gitignore bytes changed')
    const st = execFileSync('git', ['-C', f.parent, 'status', '--porcelain']).toString().split('\n')
    if (!st.includes('?? .skillsmith-trash/')) fails.push('git does not show ?? .skillsmith-trash/')
    return raw({ checked: 1, changed: fs.readFileSync(gi).equals(before) ? 0 : 1, failures: fails })
  } finally {
    finishFixture(f)
  }
}

export const Q_ROWS = {
  Q6: {
    variants: [null],
    arms: { candidate: () => q6('candidate'), 'C4-stateroot': () => q6('control') },
  },
  Q7: {
    variants: Q7_VARIANTS,
    arms: { candidate: (v) => q7('candidate', v), 'C4-consolation': (v) => q7('control', v) },
  },
  Q8: {
    variants: ['a', 'b', 'c'],
    arms: Object.fromEntries(Object.keys(Q8_IMPL).map((k) => [k, (v) => q8(k, v)])),
  },
  Q9: {
    variants: [null],
    arms: { candidate: () => q9('candidate'), 'report-drop-origin': () => q9('control') },
  },
  Q10: {
    variants: [null],
    arms: { candidate: () => q10('candidate'), 'gitignore-editor': () => q10('control') },
  },
}
export { snapshotTree }

// E42 (UD18): identity-only substitutions in a completed staged tree whose §3.4 serialization still equals postTree.
// UD17 cleanup: identity of new/, park, whole-tree hash (§3.4: rel, type, mode, size, sha256 or link text), remove
// depth-first with lstat (unlink files and symlinks, rmdir directories). Then check every user file outside staging.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
const root = process.argv[2]
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')
function treeHash(dir) {
  // §3.4 serialization
  const h = crypto.createHash('sha256')
  const walk = (rel) => {
    for (const n of fs.readdirSync(path.join(dir, rel)).sort()) {
      const r = rel ? `${rel}/${n}` : n
      const a = path.join(dir, r)
      const s = fs.lstatSync(a)
      const mode = (s.mode & 0o7777).toString(8)
      if (s.isDirectory()) {
        h.update(`d\0${r}\0${mode}\n`)
        walk(r)
      } else if (s.isSymbolicLink()) h.update(`l\0${r}\0${mode}\0${fs.readlinkSync(a)}\n`)
      else if (s.isFile()) h.update(`f\0${r}\0${mode}\0${s.size}\0${sha(fs.readFileSync(a))}\n`)
      else throw new Error('unsupported')
    }
  }
  walk('')
  return h.digest('hex')
}
const ident = (p) => {
  const s = fs.lstatSync(p, { bigint: true })
  return `${s.dev}:${s.ino}:${s.birthtimeNs}`
}
function copyTree(src, dst) {
  // no-follow copy that preserves modes and link text
  fs.mkdirSync(dst)
  fs.chmodSync(dst, fs.lstatSync(src).mode & 0o7777)
  for (const n of fs.readdirSync(src).sort()) {
    const s = path.join(src, n),
      d = path.join(dst, n),
      st = fs.lstatSync(s)
    if (st.isDirectory()) copyTree(s, d)
    else if (st.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(s), d)
    else {
      fs.writeFileSync(d, fs.readFileSync(s), { flag: 'wx' })
      fs.chmodSync(d, st.mode & 0o7777)
    }
  }
}
function removeDepthFirst(p) {
  // lstat-based: never follows a symlink
  for (const n of fs.readdirSync(p)) {
    const a = path.join(p, n)
    const st = fs.lstatSync(a)
    if (st.isDirectory() && !st.isSymbolicLink()) removeDepthFirst(a)
    else fs.unlinkSync(a)
  }
  fs.rmdirSync(p)
}
function snapshotOutside(dir) {
  const m = new Map()
  const w = (d) => {
    for (const n of fs.readdirSync(d)) {
      const a = path.join(d, n)
      const st = fs.lstatSync(a)
      if (st.isDirectory()) w(a)
      else if (st.isFile()) m.set(a, sha(fs.readFileSync(a)))
    }
  }
  w(dir)
  return m
}

let n = 0
function scenario(name, mutate, { expectRemoved = true } = {}) {
  const base = path.join(root, `e42-${n++}`)
  fs.rmSync(base, { recursive: true, force: true })
  const outside = path.join(base, 'outside')
  fs.mkdirSync(path.join(outside, 'udir'), { recursive: true })
  fs.writeFileSync(path.join(outside, 'user.txt'), 'user file\n')
  fs.writeFileSync(path.join(outside, 'udir', 'inner.txt'), 'inner\n')
  fs.writeFileSync(path.join(outside, 'user-b.txt'), 'b\n')
  fs.chmodSync(path.join(outside, 'user-b.txt'), 0o644)
  // Live skill folder with a subdirectory, files and two symlinks pointing outside the root
  const T = path.join(base, 'skills', 'foo')
  fs.mkdirSync(path.join(T, 'sub'), { recursive: true })
  fs.writeFileSync(path.join(T, 'SKILL.md'), 'v1\n')
  fs.writeFileSync(path.join(T, 'b.txt'), 'b\n')
  fs.writeFileSync(path.join(T, 'sub', 'a.txt'), 'a\n')
  for (const f of ['SKILL.md', 'b.txt', 'sub/a.txt']) fs.chmodSync(path.join(T, f), 0o644)
  fs.symlinkSync(path.join(outside, 'user.txt'), path.join(T, 'link-file'))
  fs.symlinkSync(path.join(outside, 'udir'), path.join(T, 'link-dir'))
  // Staging and a completed build
  const OP = path.join(base, 'skills', '.skillsmith-staging', 'op')
  fs.mkdirSync(OP, { recursive: true })
  const N = path.join(OP, 'new')
  copyTree(T, N)
  fs.writeFileSync(path.join(N, 'SKILL.md'), 'v2\n')
  const buildIdentity = ident(N)
  const postTree = treeHash(N)
  // The user action, then snapshot every user file outside staging (including ones the action created)
  mutate({ N, outside })
  const outsideBefore = snapshotOutside(outside)
  const serializationEqual = treeHash(N) === postTree
  // UD17 cleanup: identity, park, hash, remove or keep
  let disposition
  if (ident(N) !== buildIdentity) disposition = 'left (identity)'
  else {
    const PARK = path.join(OP, '.abort')
    fs.renameSync(N, PARK)
    if (treeHash(PARK) === postTree) {
      removeDepthFirst(PARK)
      disposition = 'removed'
    } else disposition = 'kept (edited-new)'
  }
  const outsideAfter = snapshotOutside(outside)
  const lost = [...outsideBefore]
    .filter(([p, h]) => outsideAfter.get(p) !== h)
    .map(([p]) => path.relative(base, p))
  const ok = lost.length === 0 && (disposition === 'removed') === expectRemoved
  console.log(
    JSON.stringify({
      name,
      serializationEqual,
      disposition,
      outsideFiles: outsideBefore.size,
      outsideLostOrChanged: lost,
      ok,
    })
  )
  return ok
}
let allOk = true
const run = (...a) => {
  allOk = scenario(...a) && allOk
}
run('plain byte-identical replacement file', ({ N }) => {
  const p = path.join(N, 'b.txt')
  fs.unlinkSync(p)
  fs.writeFileSync(p, 'b\n')
  fs.chmodSync(p, 0o644)
})
run('replacement directory with identical contents', ({ N }) => {
  const d = path.join(N, 'sub')
  const mode = fs.lstatSync(d).mode & 0o7777
  fs.rmSync(d, { recursive: true })
  fs.mkdirSync(d)
  fs.chmodSync(d, mode)
  fs.writeFileSync(path.join(d, 'a.txt'), 'a\n')
  fs.chmodSync(path.join(d, 'a.txt'), 0o644)
})
run('same-text symlink to a user file outside staging', ({ N, outside }) => {
  const p = path.join(N, 'link-file')
  fs.unlinkSync(p)
  fs.symlinkSync(path.join(outside, 'user.txt'), p)
})
run('same-text symlink to a user directory outside staging', ({ N, outside }) => {
  const p = path.join(N, 'link-dir')
  fs.unlinkSync(p)
  fs.symlinkSync(path.join(outside, 'udir'), p)
})
run('staged file replaced by a hard link to a user file outside staging', ({ N, outside }) => {
  const p = path.join(N, 'b.txt')
  fs.unlinkSync(p)
  fs.linkSync(path.join(outside, 'user-b.txt'), p)
})
run(
  'user hard-links a staged file from outside staging (topology change only)',
  ({ N, outside }) => {
    fs.linkSync(path.join(N, 'sub', 'a.txt'), path.join(outside, 'kept-a.txt'))
  }
)
run(
  'replacement directory holding a hard link to a user file outside staging',
  ({ N, outside }) => {
    const d = path.join(N, 'sub')
    const mode = fs.lstatSync(d).mode & 0o7777
    fs.rmSync(d, { recursive: true })
    fs.mkdirSync(d)
    fs.chmodSync(d, mode)
    fs.writeFileSync(path.join(outside, 'user-a.txt'), 'a\n')
    fs.chmodSync(path.join(outside, 'user-a.txt'), 0o644)
    fs.linkSync(path.join(outside, 'user-a.txt'), path.join(d, 'a.txt'))
  }
)
// Negative controls: a serialization difference keeps the tree
run(
  'control: symlink with different text',
  ({ N, outside }) => {
    const p = path.join(N, 'link-file')
    fs.unlinkSync(p)
    fs.symlinkSync(path.join(outside, 'udir', 'inner.txt'), p)
  },
  { expectRemoved: false }
)
run(
  'control: hard link to a user file with different bytes',
  ({ N, outside }) => {
    const p = path.join(N, 'b.txt')
    fs.unlinkSync(p)
    fs.linkSync(path.join(outside, 'user.txt'), p)
  },
  { expectRemoved: false }
)
// Control for the removal walk: a remover that follows symlinks into directories deletes the user's directory contents
{
  const base = path.join(root, `e42-follow`)
  fs.rmSync(base, { recursive: true, force: true })
  const outside = path.join(base, 'outside', 'udir')
  fs.mkdirSync(outside, { recursive: true })
  fs.writeFileSync(path.join(outside, 'inner.txt'), 'inner\n')
  const PARK = path.join(base, 'park')
  fs.mkdirSync(PARK)
  fs.symlinkSync(outside, path.join(PARK, 'link-dir'))
  const followRemove = (p) => {
    for (const n of fs.readdirSync(p)) {
      const a = path.join(p, n)
      if (fs.statSync(a).isDirectory()) followRemove(a)
      else fs.unlinkSync(a)
    }
    try {
      fs.rmdirSync(p)
    } catch {
      fs.unlinkSync(p)
    }
  }
  try {
    followRemove(PARK)
  } catch {}
  console.log(
    JSON.stringify({
      name: 'control: remover that follows symlinks',
      outsideInnerSurvives: fs.existsSync(path.join(outside, 'inner.txt')),
    })
  )
}
console.log('all expected outcomes:', allOk)

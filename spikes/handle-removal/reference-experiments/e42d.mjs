// E42d: (1) keep paths for a remnant still holding a mount; (2) stubbed removal error in abort cleanup, rule vs control.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')
function treeHash(dir) {
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
      else h.update(`f\0${r}\0${mode}\0${s.size}\0${sha(fs.readFileSync(a))}\n`)
    }
  }
  walk('')
  return h.digest('hex')
}
const removeWalk = (p, io = fs) => {
  const rm = (q) => {
    for (const n of io.readdirSync(q)) {
      const a = path.join(q, n)
      if (io.lstatSync(a).isDirectory()) rm(a)
      else io.unlinkSync(a)
    }
    io.rmdirSync(q)
  }
  rm(p)
}
const copyTree = (s, d) => {
  const st = fs.lstatSync(s)
  if (st.isDirectory()) {
    fs.mkdirSync(d)
    for (const n of fs.readdirSync(s)) copyTree(path.join(s, n), path.join(d, n))
    fs.chmodSync(d, st.mode & 0o7777)
  } else if (st.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(s), d)
  else {
    fs.copyFileSync(s, d)
    fs.chmodSync(d, st.mode & 0o7777)
  }
}
const out = []
function fixture(tag) {
  const base = `/work/d-${tag}`
  fs.mkdirSync(base, { recursive: true })
  const ud = path.join(base, 'outside', 'userdir')
  fs.mkdirSync(ud, { recursive: true })
  fs.writeFileSync(path.join(ud, 'a.txt'), 'a\n')
  const OP = path.join(base, 'staging', 'op')
  const P = path.join(OP, '.abort')
  fs.mkdirSync(path.join(P, 'sub'), { recursive: true })
  fs.writeFileSync(path.join(P, 'SKILL.md'), 'v2\n')
  fs.writeFileSync(path.join(P, 'sub', 'a.txt'), 'a\n')
  fs.chmodSync(path.join(P, 'sub'), fs.statSync(ud).mode & 0o7777)
  execFileSync('mount', ['--bind', ud, path.join(P, 'sub')])
  return { base, ud, OP, P }
}
const umountAll = (p) => {
  try {
    execFileSync('umount', [p])
  } catch {}
}
// (1a) same-device keep: rename the remnant (ancestor of a mount point) into a backup area on the same fs
{
  const f = fixture('rename-same-dev')
  const dest = path.join(f.base, 'backups', 'x.abort-remnant')
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  let r
  try {
    fs.renameSync(f.P, dest)
    r = 'renamed'
  } catch (e) {
    r = `error:${e.code}`
  }
  const mountFollowed = fs.existsSync(path.join(dest, 'sub', 'a.txt'))
  out.push({
    case: 'keep on one device: rename a remnant holding a mount point',
    result: r,
    userFileSurvives: fs.existsSync(path.join(f.ud, 'a.txt')),
    mountVisibleAtDest: mountFollowed,
  })
  umountAll(path.join(dest, 'sub'))
  umountAll(path.join(f.P, 'sub'))
}
// (1b) cross-device keep (publishTree EXDEV path, UD11/UD14): copy, verify, remove source
{
  const f = fixture('exdev')
  const dest = `/other/x.abort-remnant`
  fs.rmSync(dest, { recursive: true, force: true })
  copyTree(f.P, dest)
  const verified = treeHash(dest) === treeHash(f.P)
  let r
  try {
    removeWalk(f.P)
    r = 'source removed'
  } catch (e) {
    r = `stopped:${e.code}`
  }
  out.push({
    case: 'keep across devices: copy, verify, remove source holding a mount',
    verified,
    result: r,
    userFileSurvives: fs.existsSync(path.join(f.ud, 'a.txt')),
    copyHoldsBytes: fs.existsSync(path.join(dest, 'sub', 'a.txt')),
  })
  umountAll(path.join(f.P, 'sub'))
}
// (2) stubbed error: EBUSY at rmdir of sub, and EACCES at an unlink. Rule stops; control continues.
function cleanup(P, OP, io, mode) {
  const errors = []
  const rm = (q) => {
    for (const n of io.readdirSync(q)) {
      const a = path.join(q, n)
      try {
        if (io.lstatSync(a).isDirectory()) rm(a)
        else io.unlinkSync(a)
      } catch (e) {
        if (mode === 'rule') throw e
        errors.push(e)
      }
    }
    try {
      io.rmdirSync(q)
    } catch (e) {
      if (mode === 'rule') throw e
      errors.push(e)
    }
  }
  try {
    rm(P)
  } catch (e) {
    return {
      staged: 'left',
      path: P,
      entry: e.path,
      error: e.code,
      metadataKept: fs.existsSync(path.join(OP, 'owner.json')),
      opKept: fs.existsSync(OP),
    }
  }
  // metadata step
  for (const m of ['record.json', 'owner.json'])
    try {
      fs.unlinkSync(path.join(OP, m))
    } catch {}
  try {
    fs.rmdirSync(OP)
  } catch (e) {
    errors.push(e)
  }
  return {
    staged: 'removed',
    errorsSwallowed: errors.map((e) => e.code),
    remnantStillPresent: fs.existsSync(P),
    metadataKept: fs.existsSync(path.join(OP, 'owner.json')),
  }
}
for (const [errno, op, target] of [
  ['EBUSY', 'rmdirSync', 'sub'],
  ['EACCES', 'unlinkSync', 'SKILL.md'],
])
  for (const mode of ['rule', 'control-continue']) {
    const OP = `/work/stub-${errno}-${mode}/op`
    const P = path.join(OP, '.abort')
    fs.mkdirSync(path.join(P, 'sub'), { recursive: true })
    fs.writeFileSync(path.join(P, 'SKILL.md'), 'v2\n')
    fs.writeFileSync(path.join(P, 'sub', 'a.txt'), 'a\n')
    fs.writeFileSync(path.join(P, 'z.txt'), 'z\n')
    fs.writeFileSync(path.join(OP, 'owner.json'), '{}')
    fs.writeFileSync(path.join(OP, 'record.json'), '{}')
    const io = {
      ...fs,
      [op]: (p) => {
        if (path.basename(p) === target)
          throw Object.assign(new Error(errno), { code: errno, path: p })
        return fs[op](p)
      },
    }
    out.push({ case: `stubbed ${errno} at ${op}(${target})`, mode, ...cleanup(P, OP, io, mode) })
  }
for (const o of out) console.log(JSON.stringify(o))

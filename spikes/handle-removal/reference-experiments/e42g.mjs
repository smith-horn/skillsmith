// E42g: (a) what Node's recursive rm does at a mount point vs the stop-at-first-error walk;
// (b) uninstall's removeIfSame with a stubbed removal error, rule vs control;
// (c) repeated doctor runs keeping a remnant across devices with a persistent stubbed EBUSY (keep, --abandon, resume), rule vs control;
// (d) the same with a real bind mount, then unmount and run again.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
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
const copyTree = (s, d) => {
  const st = fs.lstatSync(s)
  if (st.isDirectory()) {
    fs.mkdirSync(d)
    for (const n of fs.readdirSync(s).sort()) copyTree(path.join(s, n), path.join(d, n))
    fs.chmodSync(d, st.mode & 0o7777)
  } else if (st.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(s), d)
  else {
    fs.copyFileSync(s, d)
    fs.chmodSync(d, st.mode & 0o7777)
  }
}
function walkRemove(p, io, mode) {
  const errs = []
  const rm = (q) => {
    for (const n of io.readdirSync(q).sort()) {
      const a = path.join(q, n)
      try {
        if (io.lstatSync(a).isDirectory()) rm(a)
        else io.unlinkSync(a)
      } catch (e) {
        if (mode === 'rule') throw e
        errs.push(e)
      }
    }
    try {
      io.rmdirSync(q)
    } catch (e) {
      if (mode === 'rule') throw e
      errs.push(e)
    }
  }
  rm(p)
  return errs
}
const out = []
const mkTree = (d) => {
  fs.mkdirSync(path.join(d, 'm'), { recursive: true })
  fs.writeFileSync(path.join(d, 'a.txt'), 'a\n')
  fs.writeFileSync(path.join(d, 'z.txt'), 'z\n')
  fs.mkdirSync(path.join(d, 'zdir'))
  fs.writeFileSync(path.join(d, 'zdir', 'f.txt'), 'f\n')
}
const mkUser = (u) => {
  fs.mkdirSync(u, { recursive: true })
  fs.writeFileSync(path.join(u, 'u.txt'), 'u\n')
}
// (a)
for (const remover of [
  'fsp.rm recursive force',
  'fs.rmSync recursive force',
  'lstat walk, stop at first error',
]) {
  const base = `/work/a-${remover.replace(/\W+/g, '-')}`
  const T = path.join(base, 'tree')
  const U = path.join(base, 'user')
  mkTree(T)
  mkUser(U)
  execFileSync('mount', ['--bind', U, path.join(T, 'm')])
  let err = null
  try {
    if (remover.startsWith('fsp')) await fsp.rm(T, { recursive: true, force: true })
    else if (remover.startsWith('fs.rmSync')) fs.rmSync(T, { recursive: true, force: true })
    else walkRemove(T, fs, 'rule')
  } catch (e) {
    err = e.code
  }
  const left = fs.existsSync(T) ? fs.readdirSync(T).sort() : []
  try {
    execFileSync('umount', [path.join(T, 'm')])
  } catch {}
  out.push({
    part: 'a',
    remover,
    error: err,
    entriesLeftInTree: left,
    userFileSurvives: fs.existsSync(path.join(U, 'u.txt')),
  })
}
// (b) uninstall: removeIfSame with the walk
function removeIfSameWalk(target, expected, io, mode) {
  const before = fs.lstatSync(target)
  if (before.dev !== expected.dev || before.ino !== expected.ino)
    return { removed: false, reason: 'replaced' }
  const parked = path.join(
    path.dirname(target),
    `.${path.basename(target)}.skillsmith-removing-${crypto.randomBytes(16).toString('hex')}`
  )
  fs.renameSync(target, parked)
  const now = fs.lstatSync(parked)
  if (now.dev !== expected.dev || now.ino !== expected.ino)
    return { removed: false, reason: 'replaced', parked }
  try {
    const errs = walkRemove(parked, io, mode)
    return { removed: true, errorsSwallowed: errs.map((e) => e.code) }
  } catch (e) {
    return { removed: false, reason: `could not be removed (${e.code})`, entry: e.path, parked }
  }
}
function uninstall(root, name, io, mode) {
  const manifest = path.join(root, 'manifest.json')
  const target = path.join(root, 'skills', name)
  const st = fs.lstatSync(target)
  const r = removeIfSameWalk(target, { dev: st.dev, ino: st.ino }, io, mode)
  if (!r.removed)
    return {
      success: false,
      message: `Skill "${name}" was not removed: ${target} ${r.reason}; what is left of it is at ${r.parked}`,
      entry: r.entry,
    }
  const m = JSON.parse(fs.readFileSync(manifest, 'utf8'))
  delete m[name]
  fs.writeFileSync(manifest, JSON.stringify(m))
  return { success: true, message: `Uninstalled ${name}`, errorsSwallowed: r.errorsSwallowed }
}
const stub = (op, base, errno) => ({
  ...fs,
  [op]: (p) => {
    if (path.basename(p) === base) throw Object.assign(new Error(errno), { code: errno, path: p })
    return fs[op](p)
  },
})
for (const [errno, op, base] of [
  ['EBUSY', 'rmdirSync', 'm'],
  ['EACCES', 'unlinkSync', 'z.txt'],
])
  for (const mode of ['rule', 'control']) {
    const root = `/work/b-${errno}-${mode}`
    const T = path.join(root, 'skills', 'foo')
    mkTree(T)
    fs.writeFileSync(path.join(T, 'm', 'x.txt'), 'x\n')
    fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ foo: {} }))
    const r = uninstall(root, 'foo', stub(op, base, errno), mode)
    const parkedLeft = fs
      .readdirSync(path.join(root, 'skills'))
      .filter((n) => n.includes('.skillsmith-removing-'))
    const manifestKept =
      'foo' in JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'))
    out.push({
      part: 'b uninstall',
      stub: `${errno} at ${op}(${base})`,
      mode,
      success: r.success,
      message: r.message.replace(/[0-9a-f]{32}/, '<hex>'),
      remnantLeft: parkedLeft.length,
      manifestEntryKept: manifestKept,
      silentSuccess: r.success && parkedLeft.length > 0,
    })
  }
// (c)/(d) repeated doctor runs on OP/.abort, cross-device keep, persistent mount (stubbed or real)
function doctorRun(OP, area, io, mode, action) {
  const P = path.join(OP, '.abort')
  if (!fs.existsSync(P)) return { state: 'done: no remnant' }
  const dests = fs
    .readdirSync(area)
    .filter((n) => /^op\.abort-remnant(\.\d+)?$/.test(n))
    .sort((x, y) => x.length - y.length || x.localeCompare(y))
  const last = dests.at(-1)
  let state,
    newKeep = false
  if (!last) {
    state = 'P5 + .abort: keep as abort-remnant'
    newKeep = true
  } else if (treeHash(P) === treeHash(path.join(area, last))) state = 'P4: retry last step'
  else {
    state = 'P4, source changed: anything else'
    if (action !== '--abandon') return { state, action, result: 'refused (only --abandon)' }
    newKeep = true
  }
  if (newKeep) {
    const name = dests.length ? `op.abort-remnant.${dests.length}` : 'op.abort-remnant'
    const tmp = path.join(area, `.tmp-${name}`)
    copyTree(P, tmp)
    if (treeHash(tmp) !== treeHash(P)) return { state, action, result: 'copy mismatch' }
    fs.renameSync(tmp, path.join(area, name))
  }
  try {
    const errs = walkRemove(P, io, mode)
    return {
      state,
      action,
      result: 'removed',
      errorsSwallowed: errs.map((e) => e.code),
      remnantLeft: fs.existsSync(P),
    }
  } catch (e) {
    return {
      state,
      action,
      result: `stopped: ${e.code} at ${path.relative(P, e.path)}`,
      remnantLeft: fs.existsSync(P),
    }
  }
}
for (const variant of ['stubbed EBUSY at rmdir(sub)', 'real bind mount on sub'])
  for (const mode of variant.startsWith('stub') ? ['rule', 'control'] : ['rule']) {
    const base = `/work/c-${variant.replace(/\W+/g, '-')}-${mode}`
    const OP = path.join(base, 'op')
    const P = path.join(OP, '.abort')
    const area = `/other/${path.basename(base)}`
    fs.mkdirSync(area, { recursive: true })
    fs.mkdirSync(path.join(P, 'sub'), { recursive: true })
    fs.writeFileSync(path.join(P, 'SKILL.md'), 'v2\n')
    fs.writeFileSync(path.join(P, 'z.txt'), 'z\n')
    let io = fs
    const U = path.join(base, 'user')
    if (variant.startsWith('stub')) {
      fs.writeFileSync(path.join(P, 'sub', 'a.txt'), 'a\n')
      fs.writeFileSync(path.join(P, 'sub', 'b.txt'), 'b\n')
      io = stub('rmdirSync', 'sub', 'EBUSY')
    } else {
      fs.writeFileSync(path.join(P, 'sub', 'hidden.txt'), 'staged\n')
      fs.mkdirSync(U)
      fs.writeFileSync(path.join(U, 'a.txt'), 'a\n')
      fs.writeFileSync(path.join(U, 'b.txt'), 'b\n')
      execFileSync('mount', ['--bind', U, path.join(P, 'sub')])
    }
    const runs = []
    const plan = ['--apply', '--apply', '--abandon', '--abandon', '--abandon']
    for (const [i, action] of plan.entries()) {
      if (!variant.startsWith('stub') && i === 4) {
        execFileSync('umount', [path.join(P, 'sub')])
        runs.push({ note: 'user unmounted sub' })
      }
      const r = doctorRun(OP, area, io, mode, action)
      r.keptCopies = fs.readdirSync(area).filter((n) => !n.startsWith('.')).length
      runs.push({ run: i + 1, ...r })
    }
    if (!variant.startsWith('stub')) {
      try {
        execFileSync('umount', [path.join(P, 'sub')])
      } catch {}
    }
    out.push({ part: 'c/d doctor on a mounted remnant across devices', variant, mode, runs })
  }
for (const o of out) console.log(JSON.stringify(o))

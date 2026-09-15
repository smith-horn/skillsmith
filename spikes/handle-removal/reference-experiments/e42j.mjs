// E42j (UD21): the rmdir-first removal walk end to end on each removal path, vs the empty-first walk (control),
// with a real mount (Linux bind mount / macOS disk image), a stubbed EBUSY, a mount made mid-walk (race),
// and the doctor loop on a mounted remnant across devices.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
const [platform, BASE, OTHER, REPS] = process.argv.slice(2)
const reps = Number(REPS || 3)
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
// UD21 walk: lstat; non-directory -> unlink; directory -> rmdir, go in only on ENOTEMPTY/EEXIST, rmdir again; any other error stops.
function rmdirFirst(p, io = fs, hook = () => {}) {
  const st = io.lstatSync(p)
  if (!st.isDirectory()) return io.unlinkSync(p)
  try {
    io.rmdirSync(p)
    return
  } catch (e) {
    if (e.code !== 'ENOTEMPTY' && e.code !== 'EEXIST') throw e
  }
  hook(p)
  for (const n of io.readdirSync(p).sort()) rmdirFirst(path.join(p, n), io, hook)
  io.rmdirSync(p)
}
// Control: the empty-first walk (round-9 text).
function emptyFirst(p, io = fs, hook = () => {}) {
  const st = io.lstatSync(p)
  if (!st.isDirectory()) return io.unlinkSync(p)
  hook(p)
  for (const n of io.readdirSync(p).sort()) emptyFirst(path.join(p, n), io, hook)
  io.rmdirSync(p)
}
const WALKS = { 'rmdir-first (UD21)': rmdirFirst, 'empty-first (control)': emptyFirst }
let img = null
const devs = new Map()
let imgN = 0
function mountDir(userDir, target) {
  if (platform === 'linux') {
    execFileSync('mount', ['--bind', userDir, target])
    return
  }
  const copy = path.join(BASE, `img-${++imgN}.dmg`)
  fs.copyFileSync(img, copy)
  const out = execFileSync('hdiutil', [
    'attach',
    '-nobrowse',
    '-mountpoint',
    target,
    copy,
  ]).toString()
  const dev = out
    .split('\n')
    .map((l) => l.trim().split(/\s+/)[0])
    .filter((d) => d && d.startsWith('/dev/disk'))[0]
  devs.set(target, dev)
  for (const n of fs.readdirSync(userDir))
    fs.copyFileSync(path.join(userDir, n), path.join(target, n))
}
function unmount(target) {
  if (platform === 'linux') {
    try {
      execFileSync('umount', [target], { stdio: 'ignore' })
    } catch {}
    return
  }
  for (const [t, dev] of devs) {
    if (t === target || !fs.existsSync(t)) {
      try {
        execFileSync('diskutil', ['unmount', 'force', dev], { stdio: 'ignore' })
      } catch {}
      try {
        execFileSync('hdiutil', ['detach', dev, '-force'], { stdio: 'ignore' })
      } catch {}
      devs.delete(t)
    }
  }
}
process.on('exit', () => {
  if (platform !== 'linux')
    for (const dev of devs.values()) {
      try {
        execFileSync('diskutil', ['unmount', 'force', dev], { stdio: 'ignore' })
      } catch {}
      try {
        execFileSync('hdiutil', ['detach', dev, '-force'], { stdio: 'ignore' })
      } catch {}
    }
})
const mounted = (target) => {
  try {
    return fs.statSync(target).dev !== fs.statSync(path.dirname(target)).dev
  } catch {
    return false
  }
}
const userFileAt = (target) => path.join(target, 'u.txt')
function tree(d) {
  fs.mkdirSync(path.join(d, 'sub'), { recursive: true })
  fs.writeFileSync(path.join(d, 'SKILL.md'), 'v2\n')
  fs.writeFileSync(path.join(d, 'sub', 'u.txt'), 'u\n')
  fs.writeFileSync(path.join(d, 'z.txt'), 'z\n')
}
function userDir(d) {
  fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(d, 'u.txt'), 'u\n')
}
const results = []
if (platform !== 'linux') {
  img = path.join(BASE, 'img.dmg')
  fs.mkdirSync(BASE, { recursive: true })
  execFileSync(
    'hdiutil',
    ['create', '-size', '2m', '-fs', 'HFS+', '-volname', 'e42j', '-layout', 'NONE', '-o', img],
    { stdio: 'ignore' }
  )
}
function runPath(name, rep, walkName) {
  const walk = WALKS[walkName]
  const base = path.join(BASE, `${name}-${walkName.split(' ')[0]}-${rep}`)
  fs.mkdirSync(base, { recursive: true })
  const U = path.join(base, 'user')
  userDir(U)
  let T,
    target,
    hashOk = null,
    report
  if (name === 'abort cleanup') {
    const OP = path.join(base, 'op')
    T = path.join(OP, 'new')
    tree(T)
    fs.chmodSync(path.join(T, 'sub'), fs.statSync(U).mode & 0o7777)
    const postTree = treeHash(T)
    target = path.join(T, 'sub')
    mountDir(U, target)
    hashOk = treeHash(T) === postTree
    const P = path.join(OP, '.abort')
    fs.renameSync(T, P)
    target = path.join(P, 'sub')
    T = P
  }
  if (name === 'move last step') {
    const OP = path.join(base, 'op')
    T = path.join(OP, 'old')
    tree(T)
    target = path.join(T, 'sub')
    mountDir(U, target)
    const dest = path.join(OTHER, `dest-${path.basename(base)}`)
    fs.rmSync(dest, { recursive: true, force: true })
    copyTree(T, dest)
    hashOk = treeHash(dest) === treeHash(T)
    const P = path.join(OP, '.abort')
    fs.renameSync(T, P)
    target = path.join(P, 'sub')
    T = P
  }
  if (name === 'prune --apply') {
    const area = path.join(base, 'area')
    T = path.join(area, 'op1')
    tree(T)
    fs.chmodSync(path.join(T, 'sub'), fs.statSync(U).mode & 0o7777)
    const side = treeHash(T)
    target = path.join(T, 'sub')
    mountDir(U, target)
    const trash = path.join(area, '.trash', 'r1')
    fs.mkdirSync(path.dirname(trash), { recursive: true })
    fs.renameSync(T, trash)
    hashOk = treeHash(trash) === side
    T = trash
    target = path.join(trash, 'sub')
  }
  if (name === 'uninstall') {
    const skills = path.join(base, 'skills')
    T = path.join(skills, 'foo')
    tree(T)
    target = path.join(T, 'sub')
    mountDir(U, target)
    const st = fs.lstatSync(T)
    const parked = path.join(
      skills,
      `.foo.skillsmith-removing-${crypto.randomBytes(16).toString('hex')}`
    )
    fs.renameSync(T, parked)
    const now = fs.lstatSync(parked)
    hashOk = `identity ${now.dev === st.dev && now.ino === st.ino}`
    T = parked
    target = path.join(parked, 'sub')
  }
  const wasMounted = mounted(target)
  try {
    walk(T)
    report = 'removed'
  } catch (e) {
    report = `stopped: ${e.code} at ${path.relative(T, e.path)}`
  }
  const survives = fs.existsSync(userFileAt(target))
  const left = fs.existsSync(T) ? fs.readdirSync(T).sort() : []
  unmount(target)
  return {
    path: name,
    walk: walkName,
    rep,
    mountActive: wasMounted,
    checkPassed: hashOk,
    result: report,
    userFileSurvives: survives,
    entriesLeft: left,
  }
}
for (const name of ['abort cleanup', 'move last step', 'prune --apply', 'uninstall'])
  for (const walkName of Object.keys(WALKS))
    for (let rep = 1; rep <= reps; rep++) results.push(runPath(name, rep, walkName))
// Stubbed EBUSY on a subdirectory's rmdir, no mount.
for (const walkName of Object.keys(WALKS))
  for (let rep = 1; rep <= reps; rep++) {
    const T = path.join(BASE, `stub-${walkName.split(' ')[0]}-${rep}`)
    tree(T)
    const io = {
      ...fs,
      rmdirSync: (p) => {
        if (path.basename(p) === 'sub')
          throw Object.assign(new Error('EBUSY'), { code: 'EBUSY', path: p })
        return fs.rmdirSync(p)
      },
    }
    let r
    try {
      WALKS[walkName](T, io)
      r = 'removed'
    } catch (e) {
      r = `stopped: ${e.code} at ${path.relative(T, e.path)}`
    }
    results.push({
      path: 'stubbed EBUSY at sub',
      walk: walkName,
      rep,
      result: r,
      fileInsideSubSurvives: fs.existsSync(path.join(T, 'sub', 'u.txt')),
    })
  }
// Race: a mount made over sub after its rmdir attempt, before its contents are removed.
for (let rep = 1; rep <= reps; rep++) {
  const base = path.join(BASE, `race-${rep}`)
  const T = path.join(base, 'tree')
  tree(T)
  const U = path.join(base, 'user')
  userDir(U)
  let target = null
  const hook = (p) => {
    if (path.basename(p) === 'sub' && !target) {
      target = p
      mountDir(U, p)
    }
  }
  let r
  try {
    rmdirFirst(T, fs, hook)
    r = 'removed'
  } catch (e) {
    r = `stopped: ${e.code} at ${path.relative(T, e.path)}`
  }
  const survives =
    platform === 'linux'
      ? fs.existsSync(path.join(U, 'u.txt'))
      : target && fs.existsSync(path.join(target, 'u.txt'))
  if (target) unmount(target)
  results.push({
    path: 'race: mount made mid-walk (rmdir-first)',
    rep,
    result: r,
    userFileSurvives: survives,
  })
}
// Doctor loop on a mounted remnant across devices, with the UD21 walk.
function doctorRun(OP, area, action) {
  const P = path.join(OP, '.abort')
  if (!fs.existsSync(P)) return { state: 'done' }
  const dests = fs
    .readdirSync(area)
    .filter((n) => /^op\.abort-remnant(\.\d+)?$/.test(n))
    .sort((a, b) => a.length - b.length || a.localeCompare(b))
  const last = dests.at(-1)
  let state,
    keep = false
  if (!last) {
    state = 'P5 + .abort: keep'
    keep = true
  } else if (treeHash(P) === treeHash(path.join(area, last))) {
    state = 'P4: retry last step'
  } else {
    state = 'P4 source changed: anything else'
    if (action !== '--abandon') return { state, action, result: 'refused' }
    keep = true
  }
  if (keep) {
    const name = dests.length ? `op.abort-remnant.${dests.length}` : 'op.abort-remnant'
    copyTree(P, path.join(area, name))
  }
  try {
    rmdirFirst(P)
    return { state, action, result: 'removed' }
  } catch (e) {
    return { state, action, result: `stopped: ${e.code} at ${path.relative(P, e.path)}` }
  }
}
for (let rep = 1; rep <= reps; rep++) {
  const base = path.join(BASE, `loop-${rep}`)
  const OP = path.join(base, 'op')
  const P = path.join(OP, '.abort')
  tree(P)
  const U = path.join(base, 'user')
  userDir(U)
  const area = path.join(OTHER, `area-${rep}`)
  fs.rmSync(area, { recursive: true, force: true })
  fs.mkdirSync(area, { recursive: true })
  mountDir(U, path.join(P, 'sub'))
  const runs = []
  for (const [i, action] of ['--apply', '--apply', '--abandon', '--abandon'].entries()) {
    const r = doctorRun(OP, area, action)
    runs.push({
      run: i + 1,
      ...r,
      keptCopies: fs.readdirSync(area).length,
      userFileSurvives: fs.existsSync(path.join(P, 'sub', 'u.txt')),
    })
  }
  unmount(path.join(P, 'sub'))
  const r5 = doctorRun(OP, area, '--abandon')
  runs.push({
    run: 5,
    note: 'after unmount',
    ...r5,
    keptCopies: fs.readdirSync(area).length,
    remnantLeft: fs.existsSync(P),
  })
  results.push({ path: 'doctor loop on a mounted remnant (rmdir-first)', rep, runs })
}
for (const r of results) console.log(JSON.stringify(r))

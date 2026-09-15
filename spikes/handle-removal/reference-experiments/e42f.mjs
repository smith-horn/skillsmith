// E42f (UD20): stubbed removal errors in the cross-device move's last step and in prune --apply, rule vs control;
// then, with a real bind mount, a doctor keep of a remnant across devices run twice.
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
// The shared walk. mode 'rule' stops at the first error; 'control' logs and continues.
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
const stub = (op, base, errno) => ({
  ...fs,
  [op]: (p) => {
    if (path.basename(p) === base) throw Object.assign(new Error(errno), { code: errno, path: p })
    return fs[op](p)
  },
})
const tree = (d) => {
  fs.mkdirSync(path.join(d, 'sub'), { recursive: true })
  fs.writeFileSync(path.join(d, 'SKILL.md'), 'v1\n')
  fs.writeFileSync(path.join(d, 'sub', 'a.txt'), 'a\n')
  fs.writeFileSync(path.join(d, 'z.txt'), 'z\n')
}
const out = []
// (1) move's last step: dest verified; park src at OP/.abort; walk.
function moveLastStep(OP, src, dest, io, mode) {
  if (treeHash(dest) !== treeHash(src)) return { result: 'refused: hashes differ' }
  const parked = path.join(OP, '.abort')
  fs.renameSync(src, parked)
  try {
    const errs = walkRemove(parked, io, mode)
    fs.unlinkSync(path.join(OP, 'record.json'))
    return { result: 'moved', errorsSwallowed: errs.map((e) => e.code) }
  } catch (e) {
    return { result: 'stopped', remnant: parked, entry: e.path, error: e.code }
  }
}
// (2) prune one tree: park in .trash, re-hash vs sidecar, walk.
function pruneOne(area, name, io, mode) {
  const t = path.join(area, name)
  const side = JSON.parse(fs.readFileSync(`${t}.json`, 'utf8'))
  const trash = path.join(area, '.trash')
  fs.mkdirSync(trash, { recursive: true })
  const parked = path.join(trash, crypto.randomBytes(6).toString('hex'))
  fs.renameSync(t, parked)
  if (treeHash(parked) !== side.treeHash) {
    fs.renameSync(parked, t)
    return { result: 'skipped: changed' }
  }
  try {
    const errs = walkRemove(parked, io, mode)
    fs.unlinkSync(`${t}.json`)
    return { result: 'pruned', errorsSwallowed: errs.map((e) => e.code) }
  } catch (e) {
    fs.renameSync(parked, t)
    return { result: 'stopped', remnant: t, entry: e.path, error: e.code }
  }
}
for (const [errno, op, base] of [
  ['EBUSY', 'rmdirSync', 'sub'],
  ['EACCES', 'unlinkSync', 'z.txt'],
])
  for (const mode of ['rule', 'control']) {
    // move
    {
      const root = `/work/f-move-${errno}-${mode}`
      const OP = path.join(root, 'op')
      const src = path.join(OP, 'old')
      const dest = `/other/f-${errno}-${mode}-dest`
      tree(src)
      fs.writeFileSync(path.join(OP, 'record.json'), '{}')
      copyTree(src, dest)
      const r = moveLastStep(OP, src, dest, stub(op, base, errno), mode)
      const remnantPresent = fs.existsSync(path.join(OP, '.abort'))
      out.push({
        path: 'cross-device move, last step',
        stub: `${errno} at ${op}(${base})`,
        mode,
        ...r,
        remnantPresent,
        recordKept: fs.existsSync(path.join(OP, 'record.json')),
        silentSuccess: r.result === 'moved' && remnantPresent,
      })
    }
    // prune
    {
      const area = `/work/f-prune-${errno}-${mode}/backups/update/skill-a`
      const t = path.join(area, 'op1')
      tree(t)
      fs.writeFileSync(`${t}.json`, JSON.stringify({ kind: 'backup', treeHash: treeHash(t) }))
      const r = pruneOne(area, 'op1', stub(op, base, errno), mode)
      const trashLeft = fs.existsSync(path.join(area, '.trash'))
        ? fs.readdirSync(path.join(area, '.trash')).length
        : 0
      const remnantPresent = fs.existsSync(t) || trashLeft > 0
      let second = null
      if (fs.existsSync(t) && fs.existsSync(`${t}.json`))
        second = pruneOne(area, 'op1', fs, 'rule').result
      out.push({
        path: 'prune --apply',
        stub: `${errno} at ${op}(${base})`,
        mode,
        ...r,
        remnantPresent,
        sidecarKept: fs.existsSync(`${t}.json`),
        remnantInTrash: trashLeft,
        secondPruneWithoutAllowChanged: second,
        silentSuccess: r.result === 'pruned' && remnantPresent,
      })
    }
  }
// (3) real mount: a remnant at OP/.abort holding a bind mount, kept across devices by doctor, run twice.
{
  const base = '/work/f-mount'
  const ud = path.join(base, 'outside', 'userdir')
  fs.mkdirSync(ud, { recursive: true })
  fs.writeFileSync(path.join(ud, 'a.txt'), 'a\n')
  fs.writeFileSync(path.join(ud, 'b.txt'), 'b\n')
  const OP = path.join(base, 'staging', 'op')
  const P = path.join(OP, '.abort')
  fs.mkdirSync(path.join(P, 'sub'), { recursive: true })
  fs.writeFileSync(path.join(P, 'SKILL.md'), 'v2\n')
  fs.writeFileSync(path.join(P, 'z.txt'), 'z\n')
  fs.chmodSync(path.join(P, 'sub'), fs.statSync(ud).mode & 0o7777)
  execFileSync('mount', ['--bind', ud, path.join(P, 'sub')])
  const area = '/other/area'
  fs.mkdirSync(area, { recursive: true })
  const dest = path.join(area, 'op.abort-remnant')
  const side = `${dest}.json`
  const runs = []
  for (let run = 1; run <= 2; run++) {
    let state
    if (!fs.existsSync(side)) {
      fs.writeFileSync(side, JSON.stringify({ treeHash: treeHash(P) }))
      const tmp = path.join(area, '.tmp-op.abort-remnant')
      copyTree(P, tmp)
      if (treeHash(tmp) !== treeHash(P)) {
        state = 'P2'
      } else {
        fs.renameSync(tmp, dest)
        state = 'P3->copied'
      }
    } else if (fs.existsSync(dest) && fs.existsSync(P))
      state = treeHash(P) === treeHash(dest) ? 'P4' : 'P4 source changed: anything else'
    let r = null
    if (state === 'P3->copied' || state === 'P4') {
      try {
        walkRemove(P, fs, 'rule')
        r = 'removed'
      } catch (e) {
        r = `stopped:${e.code} at ${path.relative(P, e.path)}`
      }
    }
    const copies = fs
      .readdirSync(area)
      .filter((n) => !n.endsWith('.json') && !n.startsWith('.tmp')).length
    runs.push({
      run,
      state,
      removal: r,
      keptCopies: copies,
      userFilesLeft: fs.readdirSync(ud).length,
      remnantPresent: fs.existsSync(P),
    })
  }
  try {
    execFileSync('umount', [path.join(P, 'sub')])
  } catch {}
  out.push({ path: 'doctor keeps a mounted remnant across devices, twice', runs })
}
for (const o of out) console.log(JSON.stringify(o))

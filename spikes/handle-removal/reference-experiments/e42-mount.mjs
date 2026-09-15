// E42b: a directory in the completed staged tree replaced by a bind mount of a user directory whose contents serialize identically.
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
const removeDepthFirst = (p, { sameDevice } = {}) => {
  const dev = fs.lstatSync(p).dev
  const rm = (q) => {
    for (const n of fs.readdirSync(q)) {
      const a = path.join(q, n)
      const st = fs.lstatSync(a)
      if (sameDevice && st.dev !== dev)
        throw Object.assign(new Error('crosses device'), { code: 'EXDEV-TREE' })
      if (st.isDirectory()) rm(a)
      else fs.unlinkSync(a)
    }
    fs.rmdirSync(q)
  }
  rm(p)
}
for (const variant of ['lstat-walk', 'lstat-walk+same-device-check']) {
  const base = `/work/mnt-${variant}`
  fs.rmSync(base, { recursive: true, force: true })
  const userDir = path.join(base, 'outside', 'userdir')
  fs.mkdirSync(userDir, { recursive: true })
  fs.writeFileSync(path.join(userDir, 'a.txt'), 'a\n')
  fs.chmodSync(path.join(userDir, 'a.txt'), 0o644)
  const mountSrc = `/mnt-src-${variant}`
  fs.rmSync(mountSrc, { recursive: true, force: true })
  fs.mkdirSync(mountSrc)
  fs.writeFileSync(path.join(mountSrc, 'a.txt'), 'a\n')
  fs.chmodSync(path.join(mountSrc, 'a.txt'), 0o644)
  const N = path.join(base, 'staging', 'new')
  fs.mkdirSync(path.join(N, 'sub'), { recursive: true })
  fs.writeFileSync(path.join(N, 'SKILL.md'), 'v2\n')
  fs.writeFileSync(path.join(N, 'sub', 'a.txt'), 'a\n')
  fs.chmodSync(path.join(N, 'sub', 'a.txt'), 0o644)
  fs.chmodSync(path.join(N, 'sub'), fs.statSync(mountSrc).mode & 0o7777)
  const postTree = treeHash(N)
  // User action: bind-mount a user directory (on another filesystem) over new/sub
  execFileSync('mount', ['--bind', mountSrc, path.join(N, 'sub')])
  const equal = treeHash(N) === postTree
  let result
  try {
    removeDepthFirst(N, { sameDevice: variant.includes('same-device') })
    result = 'removed'
  } catch (e) {
    result = `stopped: ${e.code}`
  }
  const srcSurvives = fs.existsSync(path.join(mountSrc, 'a.txt'))
  try {
    execFileSync('umount', [path.join(N, 'sub')])
  } catch {}
  console.log(
    JSON.stringify({
      variant,
      serializationEqual: equal,
      result,
      mountSourceFileSurvives: srcSurvives,
    })
  )
}

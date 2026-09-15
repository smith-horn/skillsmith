// E42c: mount-point substitution inside a completed staged tree. Repeats x3 per case.
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
const removers = {
  'lstat-walk': (p) => {
    const rm = (q) => {
      for (const n of fs.readdirSync(q)) {
        const a = path.join(q, n)
        if (fs.lstatSync(a).isDirectory()) rm(a)
        else fs.unlinkSync(a)
      }
      fs.rmdirSync(q)
    }
    rm(p)
  },
  'lstat-walk+st_dev': (p) => {
    const dev = fs.lstatSync(p).dev
    const rm = (q) => {
      for (const n of fs.readdirSync(q)) {
        const a = path.join(q, n)
        const st = fs.lstatSync(a)
        if (st.dev !== dev) throw Object.assign(new Error('dev'), { code: 'DEV-DIFFERS' })
        if (st.isDirectory()) rm(a)
        else fs.unlinkSync(a)
      }
      fs.rmdirSync(q)
    }
    rm(p)
  },
  'lstat-walk+mountinfo': (p) => {
    const real = fs.realpathSync(p)
    const mounts = fs
      .readFileSync('/proc/self/mountinfo', 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => l.split(' ')[4].replace(/\\040/g, ' '))
    if (mounts.some((m) => m === real || m.startsWith(real + '/')))
      throw Object.assign(new Error('mount'), { code: 'MOUNT-INSIDE' })
    removers['lstat-walk'](p)
  },
}
const results = []
for (const kind of ['dir-other-fs', 'dir-same-fs', 'file-other-fs', 'file-same-fs'])
  for (const [rname, remove] of Object.entries(removers))
    for (let rep = 1; rep <= 3; rep++) {
      const base = `/work/c-${kind}-${rname}-${rep}`
      fs.mkdirSync(base, { recursive: true })
      const otherBase = `/other/c-${kind}-${rname}-${rep}`
      fs.mkdirSync(otherBase, { recursive: true })
      const srcRoot = kind.endsWith('other-fs') ? otherBase : path.join(base, 'outside')
      fs.mkdirSync(srcRoot, { recursive: true })
      const N = path.join(base, 'staging', 'new')
      fs.mkdirSync(path.join(N, 'sub'), { recursive: true })
      fs.writeFileSync(path.join(N, 'SKILL.md'), 'v2\n')
      fs.chmodSync(path.join(N, 'SKILL.md'), 0o644)
      fs.writeFileSync(path.join(N, 'sub', 'a.txt'), 'a\n')
      fs.chmodSync(path.join(N, 'sub', 'a.txt'), 0o644)
      let target, userFile
      if (kind.startsWith('dir')) {
        const ud = path.join(srcRoot, 'userdir')
        fs.mkdirSync(ud)
        fs.chmodSync(ud, fs.statSync(path.join(N, 'sub')).mode & 0o7777)
        userFile = path.join(ud, 'a.txt')
        fs.writeFileSync(userFile, 'a\n')
        fs.chmodSync(userFile, 0o644)
        target = path.join(N, 'sub')
        var src = ud
      } else {
        userFile = path.join(srcRoot, 'user-SKILL.md')
        fs.writeFileSync(userFile, 'v2\n')
        fs.chmodSync(userFile, 0o644)
        target = path.join(N, 'SKILL.md')
        var src = userFile
      }
      const postTree = treeHash(N)
      execFileSync('mount', ['--bind', src, target])
      const equal = treeHash(N) === postTree
      let result
      try {
        remove(N)
        result = 'removed'
      } catch (e) {
        result = `stopped:${e.code}`
      }
      const survives =
        fs.existsSync(userFile) &&
        fs.readFileSync(userFile, 'utf8') === (kind.startsWith('dir') ? 'a\n' : 'v2\n')
      try {
        execFileSync('umount', [target])
      } catch {}
      results.push({
        kind,
        remover: rname,
        rep,
        serializationEqual: equal,
        result,
        outsideUserFileSurvives: survives,
      })
    }
for (const r of results) console.log(JSON.stringify(r))

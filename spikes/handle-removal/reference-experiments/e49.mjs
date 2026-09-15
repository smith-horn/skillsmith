// E49: a file substituted between the walk's entry lstat/identity check and its unlink (UD24 walk, no gate).
import fs from 'node:fs'
import path from 'node:path'
const [BASE, TRIALS] = process.argv.slice(2)
const trials = Number(TRIALS || 3)
if (!/exp8|^\/tmp\/e49|^\/work|^\/exp\/e49/.test(BASE)) throw new Error('unsafe base')
fs.rmSync(BASE, { recursive: true, force: true })
fs.mkdirSync(BASE, { recursive: true })
const fsType = (() => {
  try {
    return fs
      .readFileSync('/proc/mounts', 'utf8')
      .split('\n')
      .map((l) => l.split(' '))
      .filter((p) => p[1] && BASE.startsWith(p[1]))
      .sort((x, y) => y[1].length - x[1].length)[0]?.[2]
  } catch {
    return 'apfs (host)'
  }
})()
const L = (p) => fs.lstatSync(p, { bigint: true })
const idOf = (s) => `${s.dev}:${s.ino}:${s.birthtimeNs}`
class Stop extends Error {
  constructor(c) {
    super(c)
    this.code = c
  }
}
function walk(p, knownId, hooks) {
  const st = L(p)
  if (!st.isDirectory()) return fs.unlinkSync(p)
  const id = idOf(st)
  if (knownId && knownId !== id) throw new Stop('identity-changed')
  try {
    fs.rmdirSync(p)
    return
  } catch (e) {
    if (e.code !== 'ENOTEMPTY' && e.code !== 'EEXIST') throw e
  }
  const check = () => {
    if (idOf(L(p)) !== id) throw new Stop('identity-changed')
  }
  const names = fs.readdirSync(p).sort()
  check()
  for (const n of names) {
    const c = path.join(p, n)
    check()
    const cs = L(c)
    if (cs.isDirectory()) walk(c, idOf(cs), hooks)
    else {
      check()
      hooks.beforeUnlink?.(c)
      fs.unlinkSync(c)
    }
  }
  check()
  fs.rmdirSync(p)
}
const tally = {}
for (const kind of ['file', 'symlink-to-user-file'])
  for (let t = 0; t < trials; t++) {
    const dir = path.join(BASE, `${kind}-${t}`)
    const top = path.join(dir, 'tree')
    fs.mkdirSync(path.join(top, 'sub'), { recursive: true })
    fs.writeFileSync(path.join(top, 'sub', 'a.txt'), 'built\n')
    const userFile = path.join(dir, 'user-outside.txt')
    fs.writeFileSync(userFile, 'USER outside\n')
    const target = path.join(top, 'sub', 'a.txt')
    let swapped = false
    const hooks = {
      beforeUnlink: (p) => {
        if (p !== target || swapped) return
        swapped = true
        fs.renameSync(target, path.join(dir, 'aside.txt'))
        if (kind === 'file') fs.writeFileSync(target, 'USER substituted\n')
        else fs.symlinkSync(userFile, target)
      },
    }
    let result
    try {
      walk(top, idOf(L(top)), hooks)
      result = 'removed'
    } catch (e) {
      result = e instanceof Stop ? e.code : `error ${e.code}`
    }
    const k = JSON.stringify({
      kind,
      result,
      substitutedEntryAtPath:
        fs.existsSync(target) ||
        (() => {
          try {
            fs.lstatSync(target)
            return true
          } catch {
            return false
          }
        })(),
      originalAside: fs.existsSync(path.join(dir, 'aside.txt')),
      outsideUserFileIntact: fs.readFileSync(userFile, 'utf8') === 'USER outside\n',
    })
    tally[k] = (tally[k] || 0) + 1
  }
fs.rmSync(BASE, { recursive: true, force: true })
console.log(JSON.stringify({ node: process.version, fsType, trials }))
for (const [k, v] of Object.entries(tally)) console.log(`${v}x ${k}`)

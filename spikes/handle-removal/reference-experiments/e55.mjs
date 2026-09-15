// E55: a file (and a symlink) substituted after the caller's bind/guard and before the walk, with the UD25 gate before the bind.
import fs from 'node:fs'
import path from 'node:path'
const [BASE] = process.argv.slice(2)
if (!/exp8|^\/tmp\/e55|^\/work|^\/exp\/e55/.test(BASE)) throw new Error('unsafe base')
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
class Stop extends Error {
  constructor(code) {
    super(code)
    this.code = code
  }
}
const L = (p) => fs.lstatSync(p, { bigint: true })
const idOf = (s) => `${s.dev}:${s.ino}:${s.birthtimeNs}`
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
function gate(d) {
  const mk = (n) => {
    const p = path.join(d, `.skillsmith-probe-op1-${n}`)
    fs.mkdirSync(p)
    const b = L(p).birthtimeNs
    fs.rmdirSync(p)
    return b
  }
  const p1 = mk(1)
  let p2 = mk(2)
  const dl = Date.now() + 100
  while (p2 <= p1 && Date.now() < dl) {
    sleep(1)
    p2 = mk(2)
  }
  if (p2 <= p1) throw new Stop('identity-unverifiable')
  return p2
}
function walk(p, knownId, th) {
  const st = L(p)
  if (!st.isDirectory()) return fs.unlinkSync(p)
  if (!(st.birthtimeNs < th)) throw new Stop('identity-unverifiable')
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
    if (cs.isDirectory()) walk(c, idOf(cs), th)
    else {
      check()
      fs.unlinkSync(c)
    }
  }
  check()
  fs.rmdirSync(p)
}
const tally = {}
for (const kind of ['file', 'symlink'])
  for (let t = 0; t < 3; t++) {
    const dir = path.join(BASE, `${kind}-${t}`)
    const top = path.join(dir, 'tree')
    fs.mkdirSync(path.join(top, 'sub'), { recursive: true })
    fs.writeFileSync(path.join(top, 'sub', 'a.txt'), 'built\n')
    const outside = path.join(dir, 'outside.txt')
    fs.writeFileSync(outside, 'USER outside\n')
    const target = path.join(top, 'sub', 'a.txt')
    let result
    try {
      const th = gate(dir)
      const bound = idOf(L(top))
      fs.renameSync(target, path.join(dir, 'aside.txt'))
      if (kind === 'file') fs.writeFileSync(target, 'USER\n')
      else fs.symlinkSync(outside, target)
      walk(top, bound, th)
      result = 'removed'
    } catch (e) {
      result = e.code
    }
    let present = true
    try {
      fs.lstatSync(target)
    } catch {
      present = false
    }
    const k = JSON.stringify({
      kind,
      result,
      substitutedEntryPresent: present,
      asideIntact: fs.existsSync(path.join(dir, 'aside.txt')),
      outsideIntact: fs.readFileSync(outside, 'utf8') === 'USER outside\n',
    })
    tally[k] = (tally[k] || 0) + 1
  }
fs.rmSync(BASE, { recursive: true, force: true })
console.log(JSON.stringify({ node: process.version, fsType }))
for (const [k, v] of Object.entries(tally)) console.log(`${v}x ${k}`)

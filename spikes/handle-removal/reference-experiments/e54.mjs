// E54: where the UD25 gate runs relative to the caller's bind/guard. A replacement lands after the caller
// binds the top directory's identity (and would have hashed the tree) but before the walk starts.
//  top : the walked directory itself is deleted and recreated (its file moved out first) with user content
//  sub : a directory inside it is deleted and recreated with user content
// orders: none (UD24 only), walk-start (gate between the replacement and the walk), before-bind (gate before the bind)
import fs from 'node:fs'
import path from 'node:path'
const [BASE, TRIALS] = process.argv.slice(2)
const trials = Number(TRIALS || 300)
if (!/exp8|^\/tmp\/e54|^\/work|^\/exp\/e54/.test(BASE)) throw new Error('unsafe base')
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
function gate(probeDir) {
  const mk = (n) => {
    const p = path.join(probeDir, `.skillsmith-probe-op1-${n}`)
    fs.mkdirSync(p)
    const b = L(p).birthtimeNs
    fs.rmdirSync(p)
    return b
  }
  const p1 = mk(1)
  let p2 = mk(2)
  const deadline = Date.now() + 100
  while (p2 <= p1 && Date.now() < deadline) {
    sleep(1)
    p2 = mk(2)
  }
  if (p1 === 0n || p2 <= p1) throw new Stop('identity-unverifiable')
  return p2
}
function walk(p, knownId, threshold) {
  const st = L(p)
  if (!st.isDirectory()) return fs.unlinkSync(p)
  if (threshold !== null && !(st.birthtimeNs < threshold)) throw new Stop('identity-unverifiable')
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
    if (cs.isDirectory()) walk(c, idOf(cs), threshold)
    else {
      check()
      fs.unlinkSync(c)
    }
  }
  check()
  fs.rmdirSync(p)
}
for (const target of ['top', 'sub'])
  for (const order of ['none', 'walk-start', 'before-bind']) {
    const r = {
      removed: 0,
      'identity-changed': 0,
      'identity-unverifiable': 0,
      userFileLost: 0,
      sharedInoAndBirth: 0,
    }
    for (let t = 0; t < trials; t++) {
      const dir = path.join(BASE, `${target}-${order}-${t}`)
      const top = path.join(dir, 'tree')
      const sub = path.join(top, 'sub')
      fs.mkdirSync(top, { recursive: true })
      if (target === 'top') fs.writeFileSync(path.join(top, 'z.txt'), 'built\n')
      else {
        fs.mkdirSync(sub)
        fs.writeFileSync(path.join(sub, 'a.txt'), 'built\n')
        fs.writeFileSync(path.join(top, 'z.txt'), 'built\n')
      }
      const victim = target === 'top' ? top : sub
      const inner = target === 'top' ? 'z.txt' : 'a.txt'
      try {
        let threshold = order === 'before-bind' ? gate(dir) : null
        const bound = idOf(L(top))
        const orig = L(victim)
        fs.renameSync(path.join(victim, inner), path.join(dir, 'moved-out.txt'))
        fs.rmdirSync(victim)
        fs.mkdirSync(victim)
        const repl = L(victim)
        fs.writeFileSync(path.join(victim, 'user.txt'), 'USER\n')
        if (repl.ino === orig.ino && repl.birthtimeNs === orig.birthtimeNs) r.sharedInoAndBirth++
        if (order === 'walk-start') threshold = gate(dir)
        walk(top, bound, threshold)
        r.removed++
      } catch (e) {
        if (!(e instanceof Stop)) throw e
        r[e.code]++
      }
      if (!fs.existsSync(path.join(victim, 'user.txt'))) r.userFileLost++
      fs.rmSync(dir, { recursive: true, force: true })
    }
    console.log(`${target} ${order.padEnd(11)}`, JSON.stringify(r))
  }
fs.rmSync(BASE, { recursive: true, force: true })
console.log(JSON.stringify({ node: process.version, fsType, trials }))

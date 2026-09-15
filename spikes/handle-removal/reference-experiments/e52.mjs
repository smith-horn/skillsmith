// E52 (E51 with the file moved out of the directory before the replacement, so only its inode is freed): UD25 gate C against UD24 alone and against a first-probe threshold, plus stuck-clock and 0n stubs.
//  none : UD24 identity checks only
//  C    : wait (1 ms sleeps, 100 ms cap) until probe2 birth > probe1 birth; every directory's birth < probe2
//  C1   : the same wait; every directory's birth < probe1
import fs from 'node:fs'
import path from 'node:path'
const [BASE, TRIALS] = process.argv.slice(2)
const trials = Number(TRIALS || 300)
if (!/exp8|^\/tmp\/e52|^\/work|^\/exp\/e52/.test(BASE)) throw new Error('unsafe base')
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
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
function run(variant, top, hook, stub) {
  const probeHits = { n: 0 }
  const L = (p) => {
    const s = fs.lstatSync(p, { bigint: true })
    if (!stub) return s
    const isProbe = path.basename(p).startsWith('.skillsmith-probe-')
    const birth = stub === 'zero' ? 0n : isProbe ? 1000n : s.birthtimeNs
    return new Proxy(s, {
      get: (t, k) =>
        k === 'birthtimeNs' ? birth : typeof t[k] === 'function' ? t[k].bind(t) : t[k],
    })
  }
  const idOf = (s) => `${s.dev}:${s.ino}:${s.birthtimeNs}`
  const boundId = idOf(L(top))
  let threshold = null
  let waited = 0
  if (variant !== 'none') {
    if (L(top).birthtimeNs === 0n) throw new Stop('identity-unverifiable')
    const mk = (n) => {
      const p = path.join(path.dirname(top), `.skillsmith-probe-op1-${n}`)
      fs.mkdirSync(p)
      const b = L(p).birthtimeNs
      fs.rmdirSync(p)
      return b
    }
    const p1 = mk(1)
    if (p1 === 0n) throw new Stop('identity-unverifiable')
    let p2 = mk(2)
    const deadline = Date.now() + 100
    while (p2 <= p1 && Date.now() < deadline) {
      sleep(1)
      waited++
      p2 = mk(2)
    }
    if (p2 <= p1) throw new Stop('identity-unverifiable')
    threshold = variant === 'C' ? p2 : p1
  }
  const walk = (p, knownId) => {
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
    hook?.(p)
    const check = () => {
      if (idOf(L(p)) !== id) throw new Stop('identity-changed')
    }
    const names = fs.readdirSync(p).sort()
    check()
    for (const n of names) {
      const c = path.join(p, n)
      check()
      const cs = L(c)
      if (cs.isDirectory()) walk(c, idOf(cs))
      else {
        check()
        fs.unlinkSync(c)
      }
    }
    check()
    fs.rmdirSync(p)
  }
  walk(top, boundId)
  return waited
}
const cells = [
  ['none', true],
  ['C', true],
]
for (const [variant, race, stub] of cells) {
  const n = stub ? 20 : trials
  const r = {
    removed: 0,
    'identity-changed': 0,
    'identity-unverifiable': 0,
    replacementEmptied: 0,
    sharedInoAndBirth: 0,
    treeUntouchedOnStop: 0,
    maxWaitIters: 0,
    ms: 0,
  }
  for (let t = 0; t < n; t++) {
    const dir = path.join(BASE, `${variant}-${race}-${stub}-${t}`)
    const top = path.join(dir, 'tree')
    const sub = path.join(top, 'sub')
    fs.mkdirSync(top, { recursive: true })
    fs.writeFileSync(path.join(top, 'SKILL.md'), 'v2\n')
    fs.mkdirSync(sub)
    fs.writeFileSync(path.join(sub, 'a.txt'), 'built\n')
    const orig = fs.lstatSync(sub, { bigint: true })
    let repl = null
    const hook = race
      ? (p) => {
          if (p !== sub || repl) return
          fs.renameSync(path.join(sub, 'a.txt'), path.join(dir, 'a-moved-out.txt'))
          fs.rmdirSync(sub)
          fs.mkdirSync(sub)
          repl = fs.lstatSync(sub, { bigint: true })
          fs.writeFileSync(path.join(sub, 'user.txt'), 'USER\n')
        }
      : null
    const t0 = Date.now()
    try {
      const w = run(variant, top, hook, stub)
      r.removed++
      r.maxWaitIters = Math.max(r.maxWaitIters, w)
    } catch (e) {
      if (!(e instanceof Stop)) throw e
      r[e.code]++
      if (
        !race &&
        fs.existsSync(path.join(sub, 'a.txt')) &&
        fs.existsSync(path.join(top, 'SKILL.md'))
      )
        r.treeUntouchedOnStop++
    }
    r.ms = Math.max(r.ms, Date.now() - t0)
    if (race && repl) {
      if (repl.ino === orig.ino && repl.birthtimeNs === orig.birthtimeNs) r.sharedInoAndBirth++
      if (!fs.existsSync(path.join(sub, 'user.txt'))) r.replacementEmptied++
    }
    fs.rmSync(dir, { recursive: true, force: true })
  }
  console.log(
    `${variant.padEnd(4)} ${race ? 'same-tick race' : 'no race       '} ${(stub || '').padEnd(5)} n=${n}`,
    JSON.stringify(r)
  )
}
fs.rmSync(BASE, { recursive: true, force: true })
console.log(JSON.stringify({ node: process.version, fsType }))

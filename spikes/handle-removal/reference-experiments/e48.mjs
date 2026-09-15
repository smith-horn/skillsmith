// E48: same-tick replacement during the removal walk. Gate variants:
//  A  queen's gate: root birth != 0, probe birth != 0 and != root birth; identity {dev, ino, birthtimeNs}
//  B  A + every directory's birthtimeNs must be < the probe's (else identity-unverifiable)
//  C  B, but the gate first waits (bounded) until a second probe's birthtime exceeds the first; threshold = second probe
import fs from 'node:fs'
import path from 'node:path'
const [BASE, TRIALS] = process.argv.slice(2)
const trials = Number(TRIALS || 300)
if (!/exp8|^\/tmp\/e48|^\/work|^\/exp\/e48/.test(BASE)) throw new Error('unsafe base')
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
function gate(variant, top) {
  const st = L(top)
  if (st.birthtimeNs === 0n) throw new Stop('identity-unverifiable')
  const mk = (n) => {
    const p = path.join(path.dirname(top), `.probe-${n}`)
    fs.mkdirSync(p)
    const s = L(p)
    fs.rmdirSync(p)
    return s.birthtimeNs
  }
  const p1 = mk(1)
  if (p1 === 0n || p1 === st.birthtimeNs) {
    if (variant !== 'C') throw new Stop('identity-unverifiable')
  }
  if (variant === 'A') return { id: idOf(st), threshold: null }
  if (variant === 'B') return { id: idOf(st), threshold: p1 }
  let p2 = mk(2)
  const deadline = Date.now() + 100
  let waited = 0
  while (p2 <= p1 && Date.now() < deadline) {
    sleep(1)
    waited++
    p2 = mk(2)
  }
  if (p2 <= p1) throw new Stop('identity-unverifiable')
  return { id: idOf(L(top)), threshold: p2, waited }
}
function run(variant, top, hook) {
  const g = gate(variant, top)
  const walk = (p, knownId) => {
    const st = L(p)
    if (!st.isDirectory()) return fs.unlinkSync(p)
    if (g.threshold !== null && st.birthtimeNs >= g.threshold)
      throw new Stop('identity-unverifiable')
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
  walk(top, g.id)
  return g.waited
}
const res = {}
for (const variant of ['A', 'B', 'C'])
  for (const race of [true, false]) {
    const k = `${variant} ${race ? 'same-tick replacement' : 'no race'}`
    const r = (res[k] = {
      removed: 0,
      'identity-changed': 0,
      'identity-unverifiable': 0,
      replacementEmptied: 0,
      replacementSharedInoAndBirth: 0,
      maxWaitIters: 0,
    })
    for (let t = 0; t < trials; t++) {
      const dir = path.join(BASE, `${variant}-${race}-${t}`)
      const top = path.join(dir, 'tree')
      const sub = path.join(top, 'sub')
      fs.mkdirSync(top, { recursive: true })
      fs.writeFileSync(path.join(top, 'SKILL.md'), 'v2\n')
      fs.mkdirSync(sub)
      fs.writeFileSync(path.join(sub, 'a.txt'), 'built\n')
      const orig = L(sub)
      let repl = null
      const hook = race
        ? (p) => {
            if (p !== sub || repl) return
            fs.unlinkSync(path.join(sub, 'a.txt'))
            fs.rmdirSync(sub)
            fs.mkdirSync(sub)
            repl = L(sub)
            fs.writeFileSync(path.join(sub, 'user.txt'), 'USER\n')
          }
        : null
      try {
        const w = run(variant, top, hook)
        r.removed++
        if (w) r.maxWaitIters = Math.max(r.maxWaitIters, w)
      } catch (e) {
        if (!(e instanceof Stop)) throw e
        r[e.code]++
      }
      if (race && repl) {
        if (repl.ino === orig.ino && repl.birthtimeNs === orig.birthtimeNs)
          r.replacementSharedInoAndBirth++
        if (!fs.existsSync(path.join(sub, 'user.txt'))) r.replacementEmptied++
      }
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
fs.rmSync(BASE, { recursive: true, force: true })
console.log(JSON.stringify({ node: process.version, fsType, trials }))
for (const [k, v] of Object.entries(res)) console.log(k.padEnd(26), JSON.stringify(v))

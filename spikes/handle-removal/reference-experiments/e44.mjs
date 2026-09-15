// E44 (UD24): a directory swapped by another process during the rmdir-first walk, with and without identity checks.
import fs from 'node:fs'
import path from 'node:path'
const [BASE, REPS] = process.argv.slice(2)
const reps = Number(REPS || 3)
if (!BASE.includes('exp8') && !BASE.startsWith('/work')) throw new Error('unsafe base')
const idOf = (st) => `${st.dev}:${st.ino}:${st.birthtimeNs}`
const lst = (p) => fs.lstatSync(p, { bigint: true })
class Stop extends Error {
  constructor(code, p) {
    super(code)
    this.code = code
    this.path = p
  }
}
// variant: 'none' (UD21 walk, control); 'after-enotempty' (identity recorded after ENOTEMPTY, as first worded); 'pre-rmdir' (identity from the lstat before rmdir)
function walk(p, variant, hooks, knownId) {
  const st = lst(p)
  if (!st.isDirectory()) {
    return fs.unlinkSync(p)
  }
  const preId = idOf(st)
  if (variant === 'pre-rmdir' && knownId && knownId !== preId) throw new Stop('identity-changed', p)
  try {
    fs.rmdirSync(p)
    return
  } catch (e) {
    if (e.code !== 'ENOTEMPTY' && e.code !== 'EEXIST') throw e
  }
  hooks.afterRmdirProbe?.(p)
  let id = null
  if (variant === 'pre-rmdir') id = preId
  if (variant === 'after-enotempty') id = idOf(lst(p))
  const check = () => {
    if (id && idOf(lst(p)) !== id) throw new Stop('identity-changed', p)
  }
  const names = fs.readdirSync(p).sort()
  check()
  hooks.afterReaddir?.(p)
  for (const n of names) {
    const c = path.join(p, n)
    check()
    const cst = lst(c)
    if (cst.isDirectory()) walk(c, variant, hooks, variant === 'pre-rmdir' ? idOf(cst) : null)
    else {
      check()
      fs.unlinkSync(c)
    }
  }
  check()
  fs.rmdirSync(p)
}
function fixture(dir) {
  fs.rmSync(dir, { recursive: true, force: true })
  const T = path.join(dir, 'tree')
  fs.mkdirSync(path.join(T, 'sub'), { recursive: true })
  fs.writeFileSync(path.join(T, 'SKILL.md'), 'v2\n')
  fs.writeFileSync(path.join(T, 'sub', 'a.txt'), 'built a\n')
  fs.writeFileSync(path.join(T, 'sub', 'b.txt'), 'built b\n')
  fs.writeFileSync(path.join(T, 'z.txt'), 'z\n')
  fs.mkdirSync(path.join(dir, 'aside'))
  return T
}
const out = []
for (const scenario of ['swap after first rmdir', 'swap between readdir and unlink'])
  for (const variant of ['none', 'after-enotempty', 'pre-rmdir'])
    for (let rep = 1; rep <= reps; rep++) {
      const dir = path.join(BASE, `${scenario.replace(/\W+/g, '-')}-${variant}-${rep}`)
      const T = fixture(dir)
      const sub = path.join(T, 'sub')
      const aside = path.join(dir, 'aside', 'sub-original')
      let swapped = false
      const swap = (p) => {
        if (swapped || p !== sub) return
        swapped = true
        fs.renameSync(sub, aside)
        fs.mkdirSync(sub)
        fs.writeFileSync(path.join(sub, 'a.txt'), 'USER replacement a\n')
        fs.writeFileSync(path.join(sub, 'user-only.txt'), 'USER only\n')
      }
      const hooks = scenario.startsWith('swap after')
        ? { afterRmdirProbe: swap }
        : { afterReaddir: swap }
      let result
      try {
        walk(T, variant, hooks, null)
        result = 'removed'
      } catch (e) {
        result = `stopped: ${e.code} at ${path.relative(T, e.path)}`
      }
      const replacementA =
        fs.existsSync(path.join(sub, 'a.txt')) &&
        fs.readFileSync(path.join(sub, 'a.txt'), 'utf8').startsWith('USER')
      const replacementOnly = fs.existsSync(path.join(sub, 'user-only.txt'))
      out.push({
        scenario,
        variant,
        rep,
        swapped,
        result,
        replacementEntriesSurvive: replacementA && replacementOnly,
        originalAsideIntact:
          fs.existsSync(path.join(aside, 'a.txt')) && fs.existsSync(path.join(aside, 'b.txt')),
      })
    }
fs.rmSync(BASE, { recursive: true, force: true })
const agg = {}
for (const r of out) {
  const k = `${r.scenario} | ${r.variant} | ${r.result} | replacementSurvives=${r.replacementEntriesSurvive} | originalAside=${r.originalAsideIntact}`
  agg[k] = (agg[k] || 0) + 1
}
console.log(JSON.stringify({ node: process.version, platform: process.platform }))
for (const [k, v] of Object.entries(agg)) console.log(`${v}x ${k}`)

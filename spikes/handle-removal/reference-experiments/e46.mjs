// E46: birthtime gate and inode-reuse replacement during the removal walk; file substituted between lstat and unlink.
import fs from 'node:fs'
import path from 'node:path'
const [BASE, REPS] = process.argv.slice(2)
const reps = Number(REPS || 3)
if (!/exp8|^\/tmp\/e46|^\/work/.test(BASE)) throw new Error('unsafe base')
const fsType = (() => {
  try {
    return fs
      .readFileSync('/proc/mounts', 'utf8')
      .split('\n')
      .map((l) => l.split(' '))
      .filter((p) => p[1] && BASE.startsWith(p[1]))
      .sort((x, y) => y[1].length - x[1].length)[0]?.[2]
  } catch {
    return process.platform === 'darwin' ? 'apfs (host)' : 'n/a'
  }
})()
class Stop extends Error {
  constructor(code, p) {
    super(code)
    this.code = code
    this.path = p
  }
}
function makeWalk({ idFields, lstat = (p) => fs.lstatSync(p, { bigint: true }), hooks = {} }) {
  const idOf = (st) => idFields.map((f) => String(st[f])).join(':')
  function gate(top) {
    const st = lstat(top)
    if (idFields.includes('birthtimeNs')) {
      if (st.birthtimeNs === 0n) throw new Stop('identity-unverifiable', top)
      const probe = path.join(path.dirname(top), `.skillsmith-probe-${process.pid}-${Date.now()}`)
      fs.mkdirSync(probe)
      const pst = lstat(probe)
      fs.rmdirSync(probe)
      if (pst.birthtimeNs === 0n || pst.birthtimeNs === st.birthtimeNs)
        throw new Stop('identity-unverifiable', top)
    }
    return idOf(st)
  }
  function walk(p, knownId) {
    const st = lstat(p)
    if (!st.isDirectory()) {
      hooks.beforeUnlink?.(p)
      return fs.unlinkSync(p)
    }
    const id = idOf(st)
    if (knownId && knownId !== id) throw new Stop('identity-changed', p)
    try {
      fs.rmdirSync(p)
      return
    } catch (e) {
      if (e.code !== 'ENOTEMPTY' && e.code !== 'EEXIST') throw e
    }
    hooks.afterRmdirProbe?.(p)
    const check = () => {
      if (idOf(lstat(p)) !== id) throw new Stop('identity-changed', p)
    }
    const names = fs.readdirSync(p).sort()
    check()
    for (const n of names) {
      const c = path.join(p, n)
      check()
      const cst = lstat(c)
      if (cst.isDirectory()) walk(c, idOf(cst))
      else {
        check()
        hooks.beforeUnlink?.(c)
        fs.unlinkSync(c)
      }
    }
    check()
    fs.rmdirSync(p)
  }
  return (top) => walk(top, gate(top))
}
function fixture(dir) {
  fs.rmSync(dir, { recursive: true, force: true })
  const T = path.join(dir, 'op', 'tree')
  fs.mkdirSync(path.join(T, 'sub'), { recursive: true })
  fs.writeFileSync(path.join(T, 'SKILL.md'), 'v2\n')
  fs.writeFileSync(path.join(T, 'sub', 'a.txt'), 'built a\n')
  fs.writeFileSync(path.join(T, 'sub', 'b.txt'), 'built b\n')
  fs.writeFileSync(path.join(T, 'z.txt'), 'z\n')
  return T
}
const out = []
const sleepMs = (ms) => {
  const end = Date.now() + ms
  while (Date.now() < end);
}
for (let rep = 1; rep <= reps; rep++) {
  // (1) inode-reuse replacement: after the first rmdir probe of sub, another process deletes sub and recreates it with user content
  for (const [label, idFields] of [
    ['dev+ino only (control)', ['dev', 'ino']],
    ['dev+ino+birthtimeNs (UD24)', ['dev', 'ino', 'birthtimeNs']],
  ]) {
    const dir = path.join(BASE, `reuse-${rep}-${label.replace(/\W+/g, '-')}`)
    const T = fixture(dir)
    const sub = path.join(T, 'sub')
    let before, after
    const hooks = {
      afterRmdirProbe: (p) => {
        if (p !== sub || before) return
        before = fs.lstatSync(sub, { bigint: true })
        for (const n of fs.readdirSync(sub)) fs.unlinkSync(path.join(sub, n))
        fs.rmdirSync(sub)
        fs.mkdirSync(sub)
        fs.writeFileSync(path.join(sub, 'a.txt'), 'USER a\n')
        fs.writeFileSync(path.join(sub, 'user-only.txt'), 'USER only\n')
        after = fs.lstatSync(sub, { bigint: true })
      },
    }
    let result
    try {
      makeWalk({ idFields, hooks })(T)
      result = 'removed'
    } catch (e) {
      result = `stopped: ${e.code}`
    }
    out.push({
      case: 'inode-reuse replacement',
      variant: label,
      rep,
      inoReused: before && after ? before.ino === after.ino && before.dev === after.dev : null,
      birthSame: before && after ? before.birthtimeNs === after.birthtimeNs : null,
      result,
      replacementSurvives: fs.existsSync(path.join(sub, 'user-only.txt')),
    })
  }
  // (2) gate with birthtimeNs stubbed to 0n
  {
    const dir = path.join(BASE, `zero-${rep}`)
    const T = fixture(dir)
    const lstat = (p) => {
      const s = fs.lstatSync(p, { bigint: true })
      return new Proxy(s, {
        get: (t, k) =>
          k === 'birthtimeNs' ? 0n : typeof t[k] === 'function' ? t[k].bind(t) : t[k],
      })
    }
    let result
    try {
      makeWalk({ idFields: ['dev', 'ino', 'birthtimeNs'], lstat })(T)
      result = 'removed'
    } catch (e) {
      result = `stopped: ${e.code}`
    }
    out.push({
      case: 'birthtimeNs stubbed to 0n',
      rep,
      result,
      treeUntouched:
        fs.existsSync(path.join(T, 'sub', 'a.txt')) && fs.existsSync(path.join(T, 'SKILL.md')),
    })
  }
  // (3) probe distinctness on this filesystem
  {
    const dir = path.join(BASE, `probe-${rep}`)
    const T = fixture(dir)
    const st = fs.lstatSync(T, { bigint: true })
    const probe = path.join(path.dirname(T), '.probe')
    fs.mkdirSync(probe)
    const pst = fs.lstatSync(probe, { bigint: true })
    fs.rmdirSync(probe)
    out.push({
      case: 'probe directory birthtime',
      rep,
      rootBirthNonZero: st.birthtimeNs !== 0n,
      probeBirthNonZero: pst.birthtimeNs !== 0n,
      distinct: pst.birthtimeNs !== st.birthtimeNs,
    })
  }
  // (4) residual: a file substituted between its lstat and unlink
  {
    const dir = path.join(BASE, `fileswap-${rep}`)
    const T = fixture(dir)
    const target = path.join(T, 'sub', 'a.txt')
    let swapped = false
    const hooks = {
      beforeUnlink: (p) => {
        if (p !== target || swapped) return
        swapped = true
        fs.renameSync(target, path.join(dir, 'aside-a.txt'))
        fs.writeFileSync(target, 'USER substituted file\n')
      },
    }
    let result
    try {
      makeWalk({ idFields: ['dev', 'ino', 'birthtimeNs'], hooks })(T)
      result = 'removed'
    } catch (e) {
      result = `stopped: ${e.code}`
    }
    out.push({
      case: 'file substituted between lstat and unlink (residual)',
      rep,
      result,
      substitutedFileSurvives: fs.existsSync(target),
      originalAside: fs.existsSync(path.join(dir, 'aside-a.txt')),
    })
  }
}
fs.rmSync(BASE, { recursive: true, force: true })
const agg = {}
for (const r of out) {
  const { rep, ...rest } = r
  const k = JSON.stringify(rest)
  agg[k] = (agg[k] || 0) + 1
}
console.log(JSON.stringify({ node: process.version, platform: process.platform, fsType }))
for (const [k, v] of Object.entries(agg)) console.log(`${v}x ${k}`)

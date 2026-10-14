// SMI-7123 Wave 5: loaded with `--import` into the prune WALKER CHILD only.
// Records every fs *Sync call and process.chdir (with the REAL cwd from
// getcwd, not a tracked guess) and runs declarative hooks at exact calls.
//
// env W5_INTERPOSE = JSON {hooks:[...]}, W5_TRACE = file the trace is written to at exit.
// A hook: {when:'before'|'after', fn, a0Re?, a1Re?, a0IsDir?, nth?, from?, action:{kind,...}}
//   nth: fire on the nth matching call (1-based); from: fire on the first match at or after it.
// Hook side effects run UNRECORDED (their own fs calls are not in the trace).
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const spec = JSON.parse(process.env.W5_INTERPOSE ?? '{"hooks":[]}')
const traceFile = process.env.W5_TRACE ?? null
const SYNC = Object.keys(fs).filter((k) => k.endsWith('Sync') && typeof fs[k] === 'function')
const ORIG = new Map(SYNC.map((n) => [n, fs[n]]))
const O = (n, ...a) => ORIG.get(n)(...a)
const TWO = new Set(['renameSync', 'linkSync', 'copyFileSync', 'cpSync', 'symlinkSync'])
const trace = []
const fired = []
let inHook = false
const counts = new Map()

const str = (p) =>
  typeof p === 'string'
    ? p
    : Buffer.isBuffer(p)
      ? p.toString('utf8')
      : p instanceof URL
        ? p.pathname
        : typeof p === 'number'
          ? `fd:${p}`
          : null
const realCwd = () => {
  try {
    return process.cwd()
  } catch {
    return null
  }
}
const abs = (p) => (p === null ? null : path.resolve(realCwd() ?? '/', p))
const record = (file, obj) => {
  if (file) O('writeFileSync', file, JSON.stringify(obj))
}

function matches(h, i, fn, a0, a1) {
  if (h.when !== i.when || h.fn !== fn) return false
  if (h.a0Re && !(a0 !== null && new RegExp(h.a0Re).test(a0))) return false
  if (h.a1Re && !(a1 !== null && new RegExp(h.a1Re).test(a1))) return false
  // countAll: `nth`/`from` count every call that matched fn/a0Re/a1Re, BEFORE the
  // type filters ("the first directory rename at or after the 50th rename").
  if (h.countAll) counts.set(h, (counts.get(h) ?? 0) + 1)
  if (h.a0IsDir || h.a0IsFile) {
    try {
      const s = O('lstatSync', a0)
      if (h.a0IsDir && !s.isDirectory()) return false
      if (h.a0IsFile && !s.isFile()) return false
    } catch {
      return false
    }
  }
  const c = h.countAll ? counts.get(h) : (counts.get(h) ?? 0) + 1
  if (!h.countAll) counts.set(h, c)
  if (h.done) return false
  if (h.nth !== undefined && c !== h.nth) return false
  if (h.from !== undefined && c < h.from) return false
  h.done = true
  return true
}

function act(a, a0, a1) {
  switch (a.kind) {
    case 'throw':
      return Object.assign(new Error(`injected ${a.code}`), { code: a.code })
    case 'kill':
      process.kill(process.pid, 'SIGKILL')
      return null
    case 'mkdir0777':
      O('mkdirSync', a0)
      O('chmodSync', a0, 0o777)
      return null
    case 'writeFd':
      O('writeSync', a.fd, Buffer.from(a.data), 0, Buffer.byteLength(a.data), a.pos ?? 0)
      return null
    case 'writeAbs':
      O('writeFileSync', a.path, a.data)
      return null
    case 'writeRel':
      O('writeFileSync', path.join(realCwd(), a.name), a.data)
      return null
    case 'rewriteInPlace': {
      const p =
        a.path === '$cwd/sidecar.json'
          ? path.join(realCwd(), 'sidecar.json')
          : a.path === '$a0'
            ? abs(a0)
            : a.path
      const fd = O('openSync', p, 'r+')
      const st = O('fstatSync', fd)
      const buf = Buffer.alloc(st.size, a.fill ?? 'Z')
      O('writeSync', fd, buf, 0, buf.length, 0)
      O('closeSync', fd)
      record(a.recordFile, { path: p, bytes: buf.toString('utf8') })
      return null
    }
    case 'swap': {
      // after the walker's pre-check of a0, move a0 away and put a replacement there
      const n = abs(a0)
      O('renameSync', n, path.join(a.awayDir, `away-${path.basename(n)}`))
      O('writeFileSync', n, a.data)
      const s = O('lstatSync', n, { bigint: true })
      record(a.recordFile, {
        replacement: n,
        dev: String(s.dev),
        ino: String(s.ino),
        data: a.data,
        away: path.join(a.awayDir, `away-${path.basename(n)}`),
      })
      return null
    }
    case 'symlinkSwap': {
      const n = abs(a0)
      O('renameSync', n, path.join(a.awayDir, 'swapped-away-dir'))
      O('symlinkSync', a.outside, n)
      record(a.recordFile, { swapped: n })
      return null
    }
    case 'recreate': {
      O('mkdirSync', a.path)
      O('writeFileSync', path.join(a.path, 'new-user-file.txt'), a.data)
      return null
    }
    case 'cover': {
      const mp = realCwd()
      const out = execFileSync('hdiutil', ['attach', '-nobrowse', '-mountpoint', mp, a.image], {
        stdio: 'pipe',
      }).toString()
      record(a.recordFile, { mountpoint: mp, hdiutil: out.trim().split('\n').slice(-1)[0] })
      return null
    }
    case 'mount': {
      const base = a.baseFromA1Dir
        ? path.dirname(path.resolve(realCwd(), a1))
        : (a.base ?? realCwd())
      const target = a.target === '$a0' ? abs(a0) : path.resolve(base, a.rel)
      if (a.mount === 'bind') execFileSync('mount', ['--bind', a.source, target], { stdio: 'pipe' })
      else if (a.mount === 'tmpfs') {
        execFileSync('mount', ['-t', 'tmpfs', '-o', 'size=4m', 'none', target], { stdio: 'pipe' })
        for (const [k, v] of Object.entries(a.files ?? {}))
          O('writeFileSync', path.join(target, k), v)
      } else
        execFileSync('hdiutil', ['attach', '-nobrowse', '-quiet', '-mountpoint', target, a.image], {
          stdio: 'pipe',
        })
      record(a.recordFile, { target, mount: a.mount })
      return null
    }
    default:
      throw new Error(`w5-interposer: unknown action ${a.kind}`)
  }
}

function runHooks(when, fn, a0, a1) {
  for (const h of spec.hooks ?? []) {
    if (!matches(h, { when }, fn, a0, a1)) continue
    inHook = true
    let err = null
    try {
      err = act(h.action, a0, a1)
      fired.push({ fn, a0, kind: h.action.kind })
    } catch (e) {
      fired.push({ fn, a0, kind: h.action.kind, hookError: String(e?.message ?? e) })
    } finally {
      inHook = false
    }
    if (err) throw err
  }
}

for (const n of SYNC) {
  fs[n] = function interposed(...args) {
    if (inHook) return ORIG.get(n).apply(this, args)
    const a0 = str(args[0])
    const a1 = TWO.has(n) ? str(args[1]) : null
    runHooks('before', n, a0, a1)
    const e = { fn: n, a0, a1, cwd: realCwd() }
    trace.push(e)
    try {
      const out = ORIG.get(n).apply(this, args)
      runHooks('after', n, a0, a1)
      return out
    } catch (err) {
      e.err = err.code ?? String(err.message)
      throw err
    }
  }
}
const origChdir = process.chdir.bind(process)
process.chdir = function interposedChdir(d) {
  const a0 = str(d)
  if (!inHook) runHooks('before', 'chdir', a0, null)
  trace.push({ fn: 'chdir', a0, a1: null, cwd: realCwd() })
  return origChdir(d)
}
process.on('exit', () => {
  if (traceFile) O('writeFileSync', traceFile, JSON.stringify({ trace, fired }))
})

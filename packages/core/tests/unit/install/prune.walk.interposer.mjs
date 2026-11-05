// SMI-6531 (A1 step 6c-i): loaded with `--import` into the prune WALKER CHILD
// only, ported from the SMI-6676 spike's `harness/w5-interposer.mjs`. Records
// every fs *Sync call and process.chdir (with the real cwd) and runs
// declarative hooks at exact calls. It patches the `node:fs` DEFAULT export
// object, which every prune module calls through at call time (the boundary
// test pins that), so it sees every call the walker makes.
//
// env PRUNE_INTERPOSE = JSON {hooks:[...]}, PRUNE_TRACE = file the trace is written to at exit.
// A hook: {when:'before'|'after', fn, a0Re?, a1Re?, a0IsDir?, a0IsFile?, nth?, action:{kind,...}}
//   nth: fire on the nth matching call (1-based); otherwise on the first.
// Hook side effects run UNRECORDED (their own fs calls are not in the trace).
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const spec = JSON.parse(process.env.PRUNE_INTERPOSE ?? '{"hooks":[]}')
const traceFile = process.env.PRUNE_TRACE ?? null
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

function matches(h, when, fn, a0, a1) {
  if (h.when !== when || h.fn !== fn) return false
  if (h.a0Re && !(a0 !== null && new RegExp(h.a0Re).test(a0))) return false
  if (h.a1Re && !(a1 !== null && new RegExp(h.a1Re).test(a1))) return false
  if (h.a0IsDir || h.a0IsFile) {
    try {
      const s = O('lstatSync', a0)
      if (h.a0IsDir && !s.isDirectory()) return false
      if (h.a0IsFile && !s.isFile()) return false
    } catch {
      return false
    }
  }
  const c = (counts.get(h) ?? 0) + 1
  counts.set(h, c)
  if (h.done) return false
  if (h.nth !== undefined && c !== h.nth) return false
  h.done = true
  return true
}

/** Busy-waits `ms`, so a write lands in a later timestamp tick than the walker's last stat. */
function waitPast(ms) {
  const end = process.hrtime.bigint() + BigInt(Math.round(ms * 1e6))
  while (process.hrtime.bigint() < end) {
    /* spin */
  }
}

function act(a, a0) {
  if (a.waitMs !== undefined) waitPast(a.waitMs)
  switch (a.kind) {
    case 'kill':
      process.kill(process.pid, 'SIGKILL')
      return null
    case 'writeFd':
      O('writeSync', a.fd, Buffer.from(a.data), 0, Buffer.byteLength(a.data), a.pos ?? 0)
      return null
    case 'writeRel':
      O('writeFileSync', path.join(realCwd(), a.name), a.data)
      return null
    case 'rewriteInPlace': {
      const p = a.path === '$cwd/sidecar.json' ? path.join(realCwd(), 'sidecar.json') : abs(a0)
      const fd = O('openSync', p, 'r+')
      const st = O('fstatSync', fd)
      const buf = Buffer.alloc(st.size, 'Z')
      O('writeSync', fd, buf, 0, buf.length, 0)
      O('closeSync', fd)
      record(a.recordFile, { path: p })
      return null
    }
    case 'swap': {
      // After the walker's check of a0: move a0 away and put a replacement there.
      const n = abs(a0)
      const away = path.join(a.awayDir, `away-${path.basename(n)}`)
      O('renameSync', n, away)
      O('writeFileSync', n, a.data)
      const s = O('lstatSync', n, { bigint: true })
      record(a.recordFile, {
        replacement: n,
        dev: String(s.dev),
        ino: String(s.ino),
        data: a.data,
        away,
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
    case 'mount': {
      // Linux tmpfs only; runs where the process may mount (see canMount()).
      const base = a.baseFromA1Dir ? path.dirname(abs(a.a1 ?? '')) : realCwd()
      const target = path.resolve(base, a.rel)
      execFileSync('mount', ['-t', 'tmpfs', '-o', 'size=4m', 'none', target], { stdio: 'pipe' })
      for (const [k, v] of Object.entries(a.files ?? {}))
        O('writeFileSync', path.join(target, k), v)
      record(a.recordFile, { target })
      return null
    }
    default:
      throw new Error(`prune interposer: unknown action ${a.kind}`)
  }
}

function runHooks(when, fn, a0, a1) {
  for (const h of spec.hooks ?? []) {
    if (!matches(h, when, fn, a0, a1)) continue
    inHook = true
    try {
      act(h.action.kind === 'mount' ? { ...h.action, a1 } : h.action, a0)
      fired.push({ fn, a0, kind: h.action.kind })
    } catch (e) {
      fired.push({ fn, a0, kind: h.action.kind, hookError: String(e?.message ?? e) })
    } finally {
      inHook = false
    }
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

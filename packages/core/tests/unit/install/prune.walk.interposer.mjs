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
//   armedBy: {fn, a0Re?}: count only calls made after one matching it returned (so a
//   writeSync made inside an earlier writeFileSync is not the nth).
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
  if (h.armedBy && !h.armed) return false
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

/**
 * Writes, then fstats, until the file's mtime and ctime have both moved past
 * `before` (a same-tick write is invisible to any timestamp check), in at
 * most 400 tries 0.25 ms apart. Throws if they never move, so the hook is
 * recorded as failed and the row fails its precondition instead of passing.
 */
function writeUntilMoved(fd, write) {
  const before = O('fstatSync', fd, { bigint: true })
  for (let i = 0; i < 400; i += 1) {
    write()
    const now = O('fstatSync', fd, { bigint: true })
    if (now.mtimeNs !== before.mtimeNs && now.ctimeNs !== before.ctimeNs) return { moved: true }
    const end = process.hrtime.bigint() + 250000n
    while (process.hrtime.bigint() < end) {
      /* spin */
    }
  }
  throw new Error('the timestamps never moved')
}

// A seam for the walker's parent-alive check: `fakeOrphan` makes process.ppid
// read as another pid from then on, as it does once the parent has died.
let orphaned = false
const realPpid = Object.getOwnPropertyDescriptor(process, 'ppid')
Object.defineProperty(process, 'ppid', {
  configurable: true,
  get() {
    const real = realPpid?.get ? realPpid.get.call(process) : realPpid?.value
    return orphaned ? 1 : real
  },
})

function act(a, a0, a1) {
  switch (a.kind) {
    case 'throw':
      return Object.assign(new Error(`injected ${a.code}`), { code: a.code })
    case 'kill':
      process.kill(process.pid, 'SIGKILL')
      return null
    case 'writeFd':
      return writeUntilMoved(a.fd, () =>
        O('writeSync', a.fd, Buffer.from(a.data), 0, Buffer.byteLength(a.data), a.pos ?? 0)
      )
    case 'writeRel':
      O('writeFileSync', path.join(realCwd(), a.name), a.data)
      return null
    case 'writeBeside':
      // A file named a.name in the directory of the call's path (a0).
      O('writeFileSync', path.join(path.dirname(abs(a0)), a.name), a.data)
      return null
    case 'rewriteInPlace': {
      const p = a.path === '$cwd/sidecar.json' ? path.join(realCwd(), 'sidecar.json') : abs(a0)
      const fd = O('openSync', p, 'r+')
      try {
        const buf = Buffer.alloc(O('fstatSync', fd).size, 'Z')
        const res = writeUntilMoved(fd, () => O('writeSync', fd, buf, 0, buf.length, 0))
        record(a.recordFile, { path: p })
        return res
      } finally {
        O('closeSync', fd)
      }
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
    case 'appendA1':
      // After a rename: change the entry at its new (random) name.
      O('appendFileSync', abs(a1), a.data)
      return null
    case 'reinode': {
      // The same bytes at a new inode, under the same name.
      const n = abs(a0)
      const tmp = `${n}.reinode-tmp`
      O('copyFileSync', n, tmp)
      O('renameSync', tmp, n)
      return null
    }
    case 'fakeOrphan':
      orphaned = true
      return null
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
    let res = null
    try {
      res = act(h.action.kind === 'mount' ? { ...h.action, a1 } : h.action, a0, a1)
      fired.push({ fn, a0, kind: h.action.kind, ...(res instanceof Error ? {} : (res ?? {})) })
    } catch (e) {
      fired.push({ fn, a0, kind: h.action.kind, hookError: String(e?.message ?? e) })
    } finally {
      inHook = false
    }
    if (res instanceof Error) throw res
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
      for (const h of spec.hooks ?? []) {
        const b = h.armedBy
        if (b && b.fn === n && (!b.a0Re || (a0 !== null && new RegExp(b.a0Re).test(a0))))
          h.armed = true
      }
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

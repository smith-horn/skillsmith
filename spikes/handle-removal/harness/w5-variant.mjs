// SMI-7123 Wave 5: run a prune with a named stub, mutant, or interposer.
//
// materialize(mutant) applies a SOURCE MUTANT's exact text edits to a temporary
// copy of the real module (each edit must match exactly once, or `all:true` and
// at least once), rewrites the copy's relative imports to this spike's absolute
// paths, and returns the copy's path. Nothing in the spike is edited.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const SPIKE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const INTERPOSER = path.join(SPIKE, 'harness', 'w5-interposer.mjs')
export const STUB_WALKER = path.join(SPIKE, 'harness', 'w5-walker-stub.mjs')
const made = []
process.on('exit', () => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true })
})

export function applyEdits(src, edits, label) {
  let out = src
  for (const e of edits) {
    const n = out.split(e.find).length - 1
    if (e.all ? n < 1 : n !== 1) {
      throw new Error(
        `mutant ${label}: edit matched ${n} times (want ${e.all ? '>=1' : 'exactly 1'}): ${JSON.stringify(e.find.slice(0, 80))}`
      )
    }
    out = out.split(e.find).join(e.replace)
  }
  return out
}

export function materialize(mutant) {
  const src = fs.readFileSync(path.join(SPIKE, mutant.file), 'utf8')
  let out = applyEdits(src, mutant.edits, mutant.name)
  out = out.replace(
    /from '\.\/([^']+)'/g,
    (_, f) => `from '${pathToFileURL(path.join(SPIKE, f)).href}'`
  )
  out = out.replace(
    /new URL\('\.\/([^']+)', import\.meta\.url\)/g,
    (_, f) => `new URL('${pathToFileURL(path.join(SPIKE, f)).href}')`
  )
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `w5-variant-${mutant.name}-`))
  made.push(dir)
  const p = path.join(dir, mutant.file)
  fs.writeFileSync(p, out)
  return p
}

/**
 * Builds the `walker` option for prune(): an optional walker path (a mutant or
 * the stub entry), the interposer with its hooks, and a trace file.
 */
export function walkerOpts({ walkerPath, stub, hooks = [], traceFile = null, extraFds = [] } = {}) {
  const env = { W5_INTERPOSE: JSON.stringify({ hooks }) }
  if (traceFile) env.W5_TRACE = traceFile
  if (stub) env.W5_STUB = stub
  return {
    path: stub ? STUB_WALKER : walkerPath,
    execArgv: ['--import', pathToFileURL(INTERPOSER).href],
    env,
    stdio: ['pipe', 'pipe', 'pipe', ...extraFds],
  }
}

const PRUNE_STUBS = {
  'prune-naive': 'pruneNaive',
  'prune-warn-only': 'pruneWarnOnly',
  'apply-ignored': 'applyIgnored',
  'prune-resume-blind': 'pruneResumeBlind',
}

/**
 * What a test runs for `--against <name>` (null = the real code):
 *   {prune, walkerPath?, stub?, label}
 */
export async function loadImpl(name) {
  const m = await import('./w5-mutants.mjs')
  const realPrune = async () => (await import('../prune.mjs')).prune
  if (name === null) return { prune: await realPrune(), label: 'real' }
  if (PRUNE_STUBS[name]) return { prune: m[PRUNE_STUBS[name]], label: name }
  if (m.WALKER_STUBS[name]) return { prune: await realPrune(), stub: name, label: name }
  if (m.WALKER_MUTANTS[name])
    return {
      prune: await realPrune(),
      walkerPath: materialize(m.WALKER_MUTANTS[name]),
      label: name,
    }
  if (m.MUTATIONS[name]) {
    const mu = m.MUTATIONS[name]
    if (mu.file === 'prune.mjs')
      return { prune: (await import(pathToFileURL(materialize(mu)).href)).prune, label: name }
    return { prune: await realPrune(), walkerPath: materialize(mu), label: name }
  }
  throw new Error(`no stub or mutant named ${name}`)
}

/** Reads a trace file the interposer wrote: {trace, fired}, or null. */
export function readTrace(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

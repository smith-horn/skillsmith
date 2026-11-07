/**
 * SMI-6531 (A1 step 6c-i): fixtures for the prune walker's product tests,
 * ported from the SMI-6676 spike's `harness/w5-fixtures.mjs` and
 * `w5-rows-common.mjs`.
 *
 * Every copy is parked by the REAL `parkTree` (guarded, so its sidecar is the
 * `Q` shape the park writes), and the job is what a listing would hand the
 * walker for it: the root identity bound by lstat, the sidecar stable-read,
 * and the hash the sidecar recorded (`parseSidecarStrict`). The walker runs as
 * its own process, `node --import tsx --import <interposer> prune.walk.ts`,
 * exactly as the CLI will spawn its bundled entry (UD59), with the interposer
 * carrying the row's hooks.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parkTree, computePathTreeHash } from '../../../src/install/park-tree.js'
import { readStable, parseSidecarStrict } from '../../../src/install/prune.sidecar.js'
import { encodeJob } from '../../../src/install/prune.job.js'
import type { FreshJob, ResumeJob } from '../../../src/install/prune.job.js'
import crypto from 'node:crypto'
import { CALLER, CLIENT, KIND, populate } from './park-tree.helpers.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const WALKER = path.resolve(HERE, '../../../src/install/prune.walk.ts')
const INTERPOSER = pathToFileURL(path.join(HERE, 'prune.walk.interposer.mjs')).href
export const PARKED = '.skillsmith-parked'

export interface PruneFixture {
  root: string
  parent: string
}

/** A throwaway root (real path) with an empty skills parent. */
export function makeParent(prefix = 'prune-'): PruneFixture {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  const parent = path.join(root, 'parent')
  fs.mkdirSync(parent)
  return { root, parent }
}

/** Removes a fixture, restoring permissions first. */
export function removeFixture(f: PruneFixture): void {
  fs.rmSync(f.root, { recursive: true, force: true })
}

export interface ParkedCopy {
  name: string
  copyPath: string
  sidecarPath: string
  opDir: string
  stagingRoot: string
}

/** Builds parent/name (populate, plus `extraDirs` dirs of 4 files and an optional outward link) and parks it guarded. */
export function parkCopy(
  parent: string,
  name: string,
  { extraDirs = 0, outLink = null }: { extraDirs?: number; outLink?: string | null } = {}
): ParkedCopy {
  const origin = path.join(parent, name)
  populate(origin)
  if (outLink !== null) fs.symlinkSync(outLink, path.join(origin, 'out-link'))
  for (let d = 0; d < extraDirs; d += 1) {
    const sub = path.join(origin, `d${String(d).padStart(3, '0')}`)
    fs.mkdirSync(sub)
    for (let i = 0; i < 4; i += 1) fs.writeFileSync(path.join(sub, `f${i}.txt`), `d${d}-f${i}`)
  }
  const h = computePathTreeHash(origin)
  if (!h.ok) throw new Error(`parkCopy: hash failed (${h.reason})`)
  const r = parkTree(parent, name, {
    client: CLIENT,
    caller: CALLER,
    kind: KIND,
    guardHash: h.treeHash,
    opId: `op-${name}-${process.pid}`,
  })
  if (r.status !== 'parked' || r.path === null || r.sidecarPath === null) {
    throw new Error(`parkCopy: park returned ${r.status}/${r.reason}`)
  }
  return {
    name: path.basename(r.path),
    copyPath: r.path,
    sidecarPath: r.sidecarPath,
    opDir: path.dirname(r.path),
    stagingRoot: path.join(parent, PARKED),
  }
}

/** The job a listing hands the walker for a clean parked copy, approved by the batch yes. */
export function jobFor(c: ParkedCopy, over: Partial<FreshJob> = {}): FreshJob {
  const st = fs.lstatSync(c.copyPath, { bigint: true })
  const rs = readStable(c.sidecarPath)
  if (!rs.ok) throw new Error(`jobFor: sidecar unreadable (${rs.reason})`)
  const parsed = parseSidecarStrict(rs.bytes, {
    copyPath: c.copyPath,
    parentName: path.basename(c.opDir),
    store: 'parked',
  })
  if (!parsed.ok || parsed.recordedHash === null) {
    throw new Error(`jobFor: sidecar does not parse (${parsed.ok ? 'no hash' : parsed.detail})`)
  }
  return {
    copyPath: c.copyPath,
    sidecarPath: c.sidecarPath,
    sidecarRead: {
      bytes: rs.bytes,
      ino: rs.ino,
      size: rs.size,
      mtimeNs: rs.mtimeNs,
      ctimeNs: rs.ctimeNs,
    },
    leaf: c.name,
    rootIdentity: {
      dev: st.dev,
      ino: st.ino,
      birthtimeNs: st.birthtimeNs,
      fmt: st.mode & 0o170000n,
    },
    approvedHash: parsed.recordedHash,
    klass: 'clean',
    authorization: 'batch',
    stagingRoot: c.stagingRoot,
    opDir: c.opDir,
    ...over,
  }
}

export interface Hook {
  when: 'before' | 'after'
  fn: string
  a0Re?: string
  a1Re?: string
  a0IsDir?: boolean
  a0IsFile?: boolean
  nth?: number
  /** Count only calls after one matching this has returned. */
  armedBy?: { fn: string; a0Re?: string }
  action: Record<string, unknown> & { kind: string }
}

export interface TraceEntry {
  fn: string
  a0: string | null
  a1: string | null
  cwd: string | null
  err?: string
}

export interface WalkRun {
  /** The walker's one result, or null when it printed none (it died). */
  item: Record<string, unknown> | null
  status: number | null
  signal: NodeJS.Signals | null
  stderr: string
  trace: {
    trace: TraceEntry[]
    fired: { kind: string; hookError?: string; moved?: boolean }[]
  } | null
}

/**
 * Runs the walker child on `job`. `extraFds` are passed as fd 3, 4, ... so a
 * hook can write through a descriptor the test opened (P2).
 */
export function runWalker(
  job: FreshJob | ResumeJob,
  {
    hooks = [],
    extraFds = [],
    env = {},
    traceDir,
  }: {
    hooks?: Hook[]
    extraFds?: number[]
    env?: Record<string, string>
    traceDir?: string
  } = {}
): WalkRun {
  const traceFile =
    traceDir === undefined
      ? null
      : path.join(traceDir, `trace-${Math.random().toString(16).slice(2)}.json`)
  const r = spawnSync(process.execPath, ['--import', 'tsx', '--import', INTERPOSER, WALKER], {
    input: JSON.stringify(encodeJob(job)),
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe', ...extraFds],
    env: {
      ...process.env,
      SKILLSMITH_PRUNE_WALKER: '1',
      PRUNE_INTERPOSE: JSON.stringify({ hooks }),
      ...(traceFile === null ? {} : { PRUNE_TRACE: traceFile }),
      ...env,
    },
  })
  let item: Record<string, unknown> | null = null
  const last = r.stdout.trim().split('\n').pop() ?? ''
  try {
    item = last === '' ? null : (JSON.parse(last) as Record<string, unknown>)
  } catch {
    item = null
  }
  let trace: WalkRun['trace'] = null
  if (traceFile !== null && fs.existsSync(traceFile)) {
    trace = JSON.parse(fs.readFileSync(traceFile, 'utf8')) as WalkRun['trace']
  }
  return { item, status: r.status, signal: r.signal, stderr: r.stderr, trace }
}

/** The hook of `kind` ran without error. */
/** Writes that must move the timestamps to count as landed (`writeUntilMoved`). */
const MUST_MOVE: ReadonlySet<string> = new Set(['writeFd', 'rewriteInPlace'])

/** The hook of `kind` ran without error and, for a timestamp-sensitive write, moved them. */
export const fired = (run: WalkRun, kind: string): boolean =>
  (run.trace?.fired ?? []).some(
    (x) =>
      x.kind === kind && x.hookError === undefined && (!MUST_MOVE.has(kind) || x.moved === true)
  )

export const statusOf = (run: WalkRun): string =>
  run.item === null
    ? `no result (${run.signal ?? run.status}): ${run.stderr.trim()}`
    : `${String(run.item.status)}/${String(run.item.reason)}`

export const read = (p: string): string => {
  try {
    return fs.readFileSync(p, 'utf8')
  } catch (err) {
    return `UNREADABLE:${(err as NodeJS.ErrnoException).code}`
  }
}

export const exists = (p: string): boolean => {
  try {
    fs.lstatSync(p)
    return true
  } catch {
    return false
  }
}

export const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The `.prune-*` staging directories under `stagingRoot`. */
export function stagingDirs(stagingRoot: string): string[] {
  return fs
    .readdirSync(stagingRoot)
    .filter((n) => n.startsWith('.prune-'))
    .map((n) => path.join(stagingRoot, n))
}

/** Every entry under `abs`: rel -> {ino, type, bytes|link}, as one string. */
export function snapshotTree(abs: string): string {
  const out: Record<string, Record<string, string>> = {}
  const visit = (rel: string, p: string): void => {
    const st = fs.lstatSync(p, { bigint: true })
    const e: Record<string, string> = { ino: String(st.ino) }
    if (st.isDirectory()) {
      e.type = 'dir'
      out[rel] = e
      for (const n of fs.readdirSync(p).sort()) visit(rel ? `${rel}/${n}` : n, path.join(p, n))
      return
    }
    if (st.isSymbolicLink()) Object.assign(e, { type: 'symlink', link: fs.readlinkSync(p) })
    else if (st.isFile()) Object.assign(e, { type: 'file', bytes: fs.readFileSync(p, 'base64') })
    else e.type = 'other'
    out[rel] = e
  }
  visit('', abs)
  return JSON.stringify(out)
}

/** Finds a regular file by inode anywhere under `root`. */
export function findIno(root: string, ino: bigint | number): string | null {
  let names: string[] = []
  try {
    names = fs.readdirSync(root)
  } catch {
    return null
  }
  for (const n of names) {
    const p = path.join(root, n)
    const st = fs.lstatSync(p, { bigint: true })
    if (st.isFile() && st.ino === BigInt(ino)) return p
    if (st.isDirectory()) {
      const r = findIno(p, ino)
      if (r !== null) return r
    }
  }
  return null
}

/**
 * Whether this process can make a tmpfs mount (Linux, with CAP_SYS_ADMIN).
 * Measured by trying one, never inferred from the uid.
 */
export function canMount(): boolean {
  if (process.platform !== 'linux') return false
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-mount-probe-'))
  try {
    execFileSync('mount', ['-t', 'tmpfs', '-o', 'size=64k', 'none', d], { stdio: 'pipe' })
    execFileSync('umount', [d], { stdio: 'pipe' })
    return true
  } catch {
    return false
  } finally {
    fs.rmdirSync(d)
  }
}

/**
 * A resume job for the leftover `S`, built straight from disk: the job a
 * listing would hand the walker, bound to the inventory bytes now in `S`
 * (`inventorySha256`). It approves nothing new. Used also to force a resume
 * the listing would not offer, so the walker's own checks are what a test
 * observes. `over` replaces any field.
 */
export function resumeJobAt(S: string, over: Partial<ResumeJob> = {}): ResumeJob {
  const inv = readStable(path.join(S, 'inventory.json'))
  if (!inv.ok) throw new Error(`resumeJobAt: no inventory in ${S}`)
  const leaf = (JSON.parse(inv.bytes.toString('utf8')) as { leaf: string }).leaf
  const intentRead = readStable(path.join(S, 'intent.json'))
  const opDir = intentRead.ok
    ? path.dirname((JSON.parse(intentRead.bytes.toString('utf8')) as { copyPath: string }).copyPath)
    : S
  const meta: Record<string, { ino: string; bytes: string }> = {}
  for (const m of ['intent.json', 'deleting']) {
    const r = readStable(path.join(S, m))
    if (r.ok) meta[m] = { ino: String(r.ino), bytes: r.bytes.toString('base64') }
  }
  return {
    S,
    copyPath: path.join(S, leaf),
    leaf,
    klass: 'held',
    authorization: 'per-item',
    stagingRoot: path.dirname(S),
    opDir,
    inventorySha256: crypto.createHash('sha256').update(inv.bytes).digest('hex'),
    inheritedMeta: meta,
    ...over,
  }
}

/**
 * A walk killed right after it wrote the inventory and its `deleting` marker,
 * before any delete or rename: a resumable leftover with nothing deleted yet.
 */
export function stagedWithInventory(c: ParkedCopy): string {
  const run = runWalker(jobFor(c), {
    hooks: [{ when: 'after', fn: 'writeFileSync', a0Re: '/deleting$', action: { kind: 'kill' } }],
  })
  if (run.signal !== 'SIGKILL') throw new Error(`precondition: no crash (${statusOf(run)})`)
  const dirs = stagingDirs(c.stagingRoot)
  if (dirs.length !== 1) throw new Error(`precondition: ${dirs.length} staging dirs`)
  return dirs[0] as string
}

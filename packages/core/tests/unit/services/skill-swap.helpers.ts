/**
 * SMI-6531 (A1 step 4a): shared fixtures for the skill-swap suites.
 *
 * Each test gets a real temp skills root and state root (from
 * `skill-tree.helpers.ts`'s `tmp`, removed after the test), a fake
 * `ManifestPort` whose entry lives in memory so a CAS can be made to fail, an
 * in-memory journal sink and the trace recorder.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { expect } from 'vitest'
import { bindIdentity } from '../../../src/install/park-tree.identity.js'
import type { BoundIdentity } from '../../../src/install/park-tree.identity.js'
import type { JournalRecordInput } from '../../../src/journal/types.js'
import { computeRecordSha256, swapInPlace } from '../../../src/services/skill-swap.js'
import type {
  ManifestCommitHandle,
  ManifestPort,
  SwapInput,
  SwapOptions,
  SwapRecord,
  SwapResult,
  SwapWriteEntry,
  TraceOp,
} from '../../../src/services/skill-swap.js'
import type { EntryState } from '../../../src/services/skill-manifest.entry.js'
import { ManifestLockLost } from '../../../src/services/skill-manifest.lock.js'
import { treeHashOf } from '../../../src/services/skill-tree.js'
import type { TreeRecord } from '../../../src/install/tree-hash.js'
import { listTree, tmp } from './skill-tree.helpers.js'

export { listTree, tmp, useTmpCleanup } from './skill-tree.helpers.js'

/** A fixed opId per test, so paths are predictable. */
export const OP_ID = 'a'.repeat(32)

export function hashOf(p: string): string {
  const r = treeHashOf(p)
  if (!r.ok) throw new Error(`hash failed at ${p}: ${r.reason}`)
  return r.hash
}

export function recordOf(p: string): TreeRecord {
  const r = treeHashOf(p)
  if (!r.ok) throw new Error(`hash failed at ${p}: ${r.reason}`)
  return r.record
}

export interface Fixture {
  base: string
  skillsDir: string
  stateRoot: string
  dirName: string
  realDir: string
  staging: string
  opDir: string
  outside: string
}

/** A skills root holding one skill folder with `files` (relative path → content). */
export function makeFixture(files: Record<string, string>): Fixture {
  const base = tmp('skill-swap-')
  const skillsDir = path.join(base, 'skills')
  const stateRoot = path.join(base, 'state')
  const outside = path.join(base, 'outside')
  const dirName = 'my-skill'
  const realDir = path.join(skillsDir, dirName)
  fs.mkdirSync(realDir, { recursive: true })
  fs.mkdirSync(stateRoot)
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside bytes\n')
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(realDir, rel)), { recursive: true })
    fs.writeFileSync(path.join(realDir, rel), content)
  }
  const staging = path.join(skillsDir, '.skillsmith-staging')
  return {
    base,
    skillsDir,
    stateRoot,
    dirName,
    realDir,
    staging,
    opDir: path.join(staging, OP_ID),
    outside,
  }
}

/**
 * A fake lock-3 port: the raw entry lives here; `failCasOnCall` makes the Nth CAS fail.
 * `preCommitError` is what the pre-commit lock check would find, so `write()` (where
 * the real port runs that check, inside the atomic write) throws `ManifestLockLost`.
 */
export class FakeManifest implements ManifestPort {
  entry: unknown
  casCalls = 0
  writes = 0
  failCasOnCall: number | null = null
  preCommitError: Error | null = null
  constructor(
    readonly preEntry: unknown,
    readonly postEntry: unknown
  ) {
    this.entry = preEntry
  }
  private stateOf(): EntryState {
    const now = JSON.stringify(this.entry)
    if (now === JSON.stringify(this.preEntry)) return 'pre'
    return now === JSON.stringify(this.postEntry) ? 'post' : 'other'
  }
  async withManifestLock<T>(fn: (m: ManifestCommitHandle) => Promise<T>): Promise<T> {
    return fn({
      classify: async () => this.stateOf(),
      casMatches: async () => {
        this.casCalls++
        if (this.failCasOnCall === this.casCalls) return false
        return this.stateOf() === 'pre'
      },
      write: async () => {
        if (this.preCommitError !== null) {
          throw new ManifestLockLost('fake-manifest.json.lock', this.preCommitError.message)
        }
        this.writes++
        this.entry = this.postEntry
      },
    })
  }
}

export interface Planned {
  input: SwapInput
  manifest: FakeManifest
  oldIdentity: BoundIdentity
}

/** Plans an update of the fixture's folder with `writeSet` (identity and preTree taken now). */
export function plan(fx: Fixture, writeSet: SwapWriteEntry[]): Planned {
  const id = bindIdentity(fx.realDir)
  if (!id.ok) throw new Error('fixture folder missing')
  const manifest = new FakeManifest({ version: '1.0.0' }, { version: '2.0.0' })
  const input: SwapInput = {
    skillsDir: fx.skillsDir,
    client: 'claude-code',
    scope: 'user',
    stateRoot: fx.stateRoot,
    manifestPath: path.join(fx.stateRoot, 'manifest.json'),
    manifestKey: fx.dirName,
    comparedPath: fx.realDir,
    realDir: fx.realDir,
    dirName: fx.dirName,
    oldIdentity: id,
    preTree: hashOf(fx.realDir),
    writeSet,
    preEntry: manifest.preEntry,
    postEntry: manifest.postEntry,
    manifest,
  }
  return { input, manifest, oldIdentity: id }
}

export const modify = (rel: string, text: string): SwapWriteEntry => ({
  rel,
  kind: 'modify',
  bytes: Buffer.from(text),
})
export const create = (rel: string, text: string): SwapWriteEntry => ({
  rel,
  kind: 'create',
  bytes: Buffer.from(text),
})

export interface Run {
  result: SwapResult
  trace: TraceOp[]
  journal: JournalRecordInput[]
}

/** Runs `swapInPlace` with the fixed opId, a trace recorder and an in-memory journal. */
export async function run(p: Planned, options: SwapOptions = {}): Promise<Run> {
  const traced: TraceOp[] = []
  const journal: JournalRecordInput[] = []
  const result = await swapInPlace(p.input, {
    opId: OP_ID,
    trace: (op) => traced.push(op),
    appendJournal: async (j) => {
      journal.push(j)
    },
    // Abort cleanup's one-line notices; a test that asserts them passes its own sink.
    stderr: () => undefined,
    ...options,
  })
  return { result, trace: traced, journal }
}

/** `<state>/backups/update/<client>/<rootKey>/<dirName>` for the fixture. */
export function areaOf(fx: Fixture): string {
  const root = fs.realpathSync.native(fx.skillsDir)
  const key = crypto.createHash('sha256').update(root).digest('hex').slice(0, 16)
  return path.join(fx.stateRoot, 'backups', 'update', 'claude-code', key, fx.dirName)
}

/**
 * Parses `record.json` and asserts its `recordSha256` verifies, computed here
 * independently (sha256 of the compact JSON of every other field, in the
 * file's own key order) as well as through `computeRecordSha256`.
 */
export function readRecord(recordPath: string): SwapRecord {
  return parseRecord(fs.readFileSync(recordPath, 'utf8'))
}

/** `readRecord` on text already read. */
export function parseRecord(text: string): SwapRecord {
  const rec = JSON.parse(text) as SwapRecord
  const { recordSha256, ...rest } = rec
  expect(crypto.createHash('sha256').update(JSON.stringify(rest)).digest('hex')).toBe(recordSha256)
  expect(computeRecordSha256(rest)).toBe(recordSha256)
  return rec
}

/** Every entry and the tree hash of `dir`: compare before/after to prove nothing changed there. */
export function snapshot(dir: string): { entries: string[]; hash: string } {
  return { entries: listTree(dir), hash: hashOf(dir) }
}

/** True when the trace holds `want` as a subsequence (each item matched in order). */
export function isSubsequence(
  traced: TraceOp[],
  want: Array<Partial<TraceOp> & { op: TraceOp['op'] }>
): { ok: true } | { ok: false; missing: number } {
  let i = 0
  for (const t of traced) {
    if (i === want.length) break
    const w = want[i] as Record<string, unknown>
    if (Object.entries(w).every(([k, v]) => (t as Record<string, unknown>)[k] === v)) i++
  }
  return i === want.length ? { ok: true } : { ok: false, missing: i }
}

/** `n` files under `dir` across a few subdirectories. */
export function manyFiles(n: number): Record<string, string> {
  const files: Record<string, string> = { 'SKILL.md': '# skill v1\n' }
  for (let i = 1; i < n; i++) files[`d${i % 7}/f${i}.txt`] = `file ${i}\n`
  return files
}

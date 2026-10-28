/**
 * SMI-6531 (A1 step 6a-i): fixtures for the `doctor recovery` classifier suites.
 *
 * Every state is made by a real `swapInPlace` run that stops where a crash
 * would (a hook that throws, or the fake manifest's pre-commit error), so the
 * classifier is proven against what the writer leaves, not against a record
 * built by hand. The few states a run cannot stop in (a kill inside undo, a
 * kept tree) are then made by moving the trees the way the transaction does.
 *
 * The classifier reads the manifest from disk, so `syncManifest` writes the
 * fake manifest's entry to `manifest.json` in the fixture's state root.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { expect } from 'vitest'
import { listRoot } from '../../../../src/services/skill-recovery.listing.js'
import type {
  ListOptions,
  OpReport,
  RootReport,
} from '../../../../src/services/skill-recovery.listing.js'
import { areaOf, hashOf, modify, OP_ID, plan, run } from '../skill-swap.helpers.js'
import type { Fixture, Planned } from '../skill-swap.helpers.js'
import { crashIncomplete, crashStopped } from '../skill-swap.scan.helpers.js'

export const PRE = { version: '1.0.0' }
export const POST = { version: '2.0.0' }

/** One crashed update: the fixture, its plan, its op dir. */
export interface State {
  fx: Fixture
  p: Planned
  opId: string
  opDir: string
}

/** Sets `entry` as the manifest's entry for `key`, keeping every other entry already there. */
export function setEntry(fx: Fixture, key: string, entry: unknown): void {
  const file = path.join(fx.stateRoot, 'manifest.json')
  const have = fs.existsSync(file)
    ? (JSON.parse(fs.readFileSync(file, 'utf8')) as { installedSkills: Record<string, unknown> })
    : { installedSkills: {} }
  have.installedSkills[key] = entry
  fs.writeFileSync(
    file,
    JSON.stringify({ version: '1.0.0', installedSkills: have.installedSkills })
  )
}

/** Writes the fake manifest's current entry where the classifier reads it. */
export function syncManifest(st: Pick<State, 'fx' | 'p'>): void {
  setEntry(st.fx, st.fx.dirName, st.p.manifest.entry)
}

/** Writes `entry` (not the fake's) as the manifest's entry for the fixture's skill. */
export function writeEntry(fx: Fixture, entry: unknown): void {
  setEntry(fx, fx.dirName, entry)
}

/** S2: swapped, the commit not done (T new, O in OP, manifest `pre`). */
export async function s2(fx: Fixture, opId: string = OP_ID): Promise<State> {
  const c = await crashStopped(fx, opId)
  const st = { fx, p: c.p, opId, opDir: c.opDir }
  syncManifest(st)
  return st
}

/** S3: committed, the audit append failed (T new, O in OP, manifest `post`). */
export async function s3(fx: Fixture, opId: string = OP_ID): Promise<State> {
  const c = await crashIncomplete(fx, opId)
  const st = { fx, p: c.p, opId, opDir: c.opDir }
  syncManifest(st)
  return st
}

/** S1: between the renames (T absent, O and N in OP, manifest `pre`). */
export async function s1(fx: Fixture, opId: string = OP_ID): Promise<State> {
  const p = plan(fx, [modify('SKILL.md', '# staged\n')])
  const r = await run(p, {
    opId,
    hooks: {
      afterRename1Syncs: () => {
        throw new Error('killed between the renames')
      },
    },
  })
  expect(r.result.status).toBe('stopped')
  const st = { fx, p, opId, opDir: path.join(fx.staging, opId) }
  syncManifest(st)
  return st
}

/** S0: nothing swapped (T old, O absent, N in OP, manifest `pre`): S1 with O renamed back. */
export async function s0(fx: Fixture, opId: string = OP_ID): Promise<State> {
  const st = await s1(fx, opId)
  fs.renameSync(path.join(st.opDir, 'old'), fx.realDir)
  return st
}

/** UN1: undo set T aside (T absent, O in OP, U in OP): S2 with T renamed to `undone/`. */
export async function un1(fx: Fixture, opId: string = OP_ID): Promise<State> {
  const st = await s2(fx, opId)
  fs.renameSync(fx.realDir, path.join(st.opDir, 'undone'))
  return st
}

/** UN2: undo restored O (T old, U in OP): UN1 with O renamed to T. */
export async function un2(fx: Fixture, opId: string = OP_ID): Promise<State> {
  const st = await un1(fx, opId)
  fs.renameSync(path.join(st.opDir, 'old'), fx.realDir)
  return st
}

const FMT = 0o170000n

/** The sidecar `publishTree` writes for the tree at `src`, as `kind`. */
export function sidecarFor(
  st: State,
  src: string,
  kind: string,
  over: Record<string, unknown> = {}
) {
  const s = fs.lstatSync(src, { bigint: true })
  return {
    opId: st.opId,
    kind,
    dirName: st.fx.dirName,
    createdAt: new Date().toISOString(),
    treeHash: hashOf(src),
    identity: {
      dev: s.dev.toString(),
      ino: s.ino.toString(),
      birthtimeNs: s.birthtimeNs.toString(),
      fmt: (s.mode & FMT).toString(),
    },
    client: 'claude-code',
    skillsDir: fs.realpathSync(st.fx.skillsDir),
    scope: 'global',
    manifestKey: st.fx.dirName,
    ...over,
  }
}

/** `<area>/<opId>` for the backup, else `<area>/<opId>.<kind>`. */
export function destOf(st: State, kind: string): string {
  const area = areaOf(st.fx)
  return path.join(area, kind === 'backup' ? st.opId : `${st.opId}.${kind}`)
}

export interface KeepOptions {
  /** Publish the sidecar (default). `false`: a keep with a tree and no sidecar. */
  sidecar?: boolean
  /** Rename the tree out of OP (default). `false`: the sidecar only (P1). */
  move?: boolean
  /** Sidecar fields to override (a wrong kind, identity or hash). */
  over?: Record<string, unknown>
}

/**
 * Keeps the tree at `OP/<from>` as `kind` the way `publishTree` does: sidecar
 * first, then the rename. Returns the tree's destination.
 */
export function keepTree(
  st: State,
  from: 'old' | 'new' | 'undone',
  kind: string,
  opts: KeepOptions = {}
): string {
  const src = path.join(st.opDir, from)
  const dest = destOf(st, kind)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  if (opts.sidecar !== false) {
    fs.writeFileSync(
      `${dest}.json`,
      JSON.stringify(sidecarFor(st, src, kind, opts.over), null, 2) + '\n'
    )
  }
  if (opts.move !== false) fs.renameSync(src, dest)
  return dest
}

/** `copy`'s tree, copied (never moved) so it is a new directory with the same content. */
export function copyTree(from: string, to: string): void {
  fs.cpSync(from, to, { recursive: true })
}

export const journalOf = (fx: Fixture): string => path.join(fx.base, 'journal', 'journal.jsonl')

/** Lists the fixture's skills root and returns its report. */
export async function report(st: Pick<State, 'fx'>, over: ListOptions = {}): Promise<RootReport> {
  return listRoot(st.fx.skillsDir, {
    euid: process.geteuid?.() ?? 0,
    journalFile: journalOf(st.fx),
    stateRoots: [fs.realpathSync(st.fx.stateRoot)],
    ...over,
  })
}

/** The report of one op of the fixture. */
export async function opReport(st: State, over: ListOptions = {}): Promise<OpReport> {
  const root = await report(st, over)
  const op = root.ops.find((o) => o.opId === st.opId)
  if (op === undefined) throw new Error(`no op ${st.opId} listed: ${JSON.stringify(root)}`)
  return op
}

/** Appends an audit line for `opId` the way the journal holds one (only the fields doctor reads). */
export function writeJournalLine(fx: Fixture, opId: string, tool = 'update', torn = false): void {
  const file = journalOf(fx)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const line = JSON.stringify({ tool, suggestion_id: opId, action: 'apply' })
  fs.appendFileSync(file, torn ? line.slice(0, -4) : `${line}\n`)
}

/** sha256 of a file's bytes. */
export const sha = (p: string): string =>
  crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')

/**
 * SMI-6531 (A1 step 5): shared fixtures for the record-scan suites
 * (`skill-swap.scan.test.ts`, `skill-swap.scan.root.test.ts`).
 *
 * Crash states are made by real `swapInPlace` runs, so the scan is proven to
 * accept what the writer writes; `validRecord` builds the rest by hand.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { expect } from 'vitest'
import { computeRecordSha256 } from '../../../src/services/skill-swap.js'
import type { SwapOptions, SwapRecord } from '../../../src/services/skill-swap.js'
import { areaOf, modify, OP_ID, plan, run } from './skill-swap.helpers.js'
import type { Fixture, Planned } from './skill-swap.helpers.js'

/** A distinct 32-character opId per letter. */
export const opIdN = (c: string): string => c.repeat(32)

/** `ST/<opId>` for the fixture's root. */
export const opDirOf = (fx: Fixture, opId: string): string => path.join(fx.staging, opId)

/** The fixture's `fx` with another skill folder in the same root (and the same staging). */
export function otherSkill(fx: Fixture, dirName: string, files: Record<string, string>): Fixture {
  const realDir = path.join(fx.skillsDir, dirName)
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(realDir, rel)), { recursive: true })
    fs.writeFileSync(path.join(realDir, rel), content)
  }
  return { ...fx, dirName, realDir }
}

/** Plans and runs an update of `fx` under `opId` (default content names the opId). */
export async function attempt(fx: Fixture, opId: string, options: SwapOptions = {}) {
  const p = plan(fx, [modify('SKILL.md', `# next ${opId.slice(0, 2)}\n`)])
  const r = await run(p, { ...options, opId })
  return { p, opId, ...r }
}

/** A real run that stops after the swap (`stopped`), its record kept in `ST/<opId>`. */
export async function crashStopped(fx: Fixture, opId: string = OP_ID) {
  const p = plan(fx, [modify('SKILL.md', '# crashed\n')])
  p.manifest.preCommitError = new Error('manifest lock lost')
  const r = await run(p, { opId })
  expect(r.result).toMatchObject({
    status: 'stopped',
    reason: 'pre-commit-check-failed',
    recordPath: path.join(opDirOf(fx, opId), 'record.json'),
  })
  return { p, opId, opDir: opDirOf(fx, opId) }
}

/** A real run that commits but stops at the audit append (`incomplete`), its record kept. */
export async function crashIncomplete(fx: Fixture, opId: string = OP_ID) {
  const p = plan(fx, [modify('SKILL.md', '# crashed\n')])
  const r = await run(p, {
    opId,
    appendJournal: async () => {
      throw new Error('ENOSPC: no space left on device')
    },
  })
  expect(r.result).toMatchObject({
    status: 'committed',
    incomplete: { step: 'audit', reason: 'journal-append-failed' },
    recordPath: path.join(opDirOf(fx, opId), 'record.json'),
  })
  return { p, opId, opDir: opDirOf(fx, opId) }
}

export interface SnapOpts {
  /** Entries to leave out (and everything under them). */
  skip?: (abs: string) => boolean
  /**
   * Compare entries, not directory bookkeeping: a directory's mtime and link
   * count are left out, and a directory whose every entry was skipped (or so
   * dropped) is dropped too, so a directory made only to hold skipped entries
   * does not show. An empty directory still shows.
   */
  prune?: boolean
}

/**
 * Every entry under `p` (links never followed): type, mode, inode, link count,
 * mtime, and the bytes of a file or the text of a link. `absent` for a missing
 * path. Compare before and after to prove nothing there changed.
 */
export function deepSnapshot(p: string, opts: SnapOpts = {}): string {
  /** null: skipped, or (pruned) a directory holding only skipped entries. */
  const walk = (abs: string, rel: string): string[] | null => {
    if (opts.skip?.(abs) === true) return null
    const s = fs.lstatSync(abs, { bigint: true, throwIfNoEntry: false })
    if (s === undefined) return [`${rel}: absent`]
    const kind = s.isSymbolicLink()
      ? 'link'
      : s.isDirectory()
        ? 'dir'
        : s.isFile()
          ? 'file'
          : 'other'
    let body = ''
    if (kind === 'link') body = fs.readlinkSync(abs)
    if (kind === 'file')
      body = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex')
    const mode = (s.mode & 0o7777n).toString(8)
    const walked =
      kind === 'dir'
        ? fs
            .readdirSync(abs)
            .sort()
            .map((n) => walk(path.join(abs, n), `${rel}/${n}`))
        : []
    const kids = walked.flatMap((k) => k ?? [])
    if (opts.prune === true && kind === 'dir') {
      const onlySkipped = walked.length > 0 && walked.every((k) => k === null)
      return onlySkipped && rel !== '' ? null : [`${rel}: dir mode=${mode} ino=${s.ino}`, ...kids]
    }
    return [
      `${rel}: ${kind} mode=${mode} ino=${s.ino} nlink=${s.nlink} mtime=${s.mtimeNs} ${body}`,
      ...kids,
    ]
  }
  return (walk(p, '') ?? []).join('\n')
}

const manifestOf = (p: Planned): string =>
  JSON.stringify({ entry: p.manifest.entry, writes: p.manifest.writes, cas: p.manifest.casCalls })

/** The skill, a crashed op dir, the skill's backup area and its manifest: what a crash left. */
export function frozen(fx: Fixture, crashed: { p: Planned; opDir: string }) {
  return {
    skill: deepSnapshot(fx.realDir),
    opDir: deepSnapshot(crashed.opDir),
    area: deepSnapshot(areaOf(fx)),
    manifest: manifestOf(crashed.p),
  }
}

/**
 * T-R1's snapshot, for runs that must change nothing but their own leftovers:
 * all of staging, the whole state root (the backup area and the parked index
 * included), the skill folder and the manifest. Excluded are only the refused
 * runs' own op dirs (`ST/<id>`), their parked copies
 * (`ST/.skillsmith-parked/<id>`), their clock-gate probes, any kept copy in
 * the state root (a name starting with `<id>`) and their own lines of the
 * parked index, which is compared line by line without them.
 */
export function frozenWide(fx: Fixture, crashed: { p: Planned }, refusedOpIds: string[]) {
  const staging = fx.staging
  const own = (rel: string): boolean =>
    refusedOpIds.some(
      (id) =>
        rel === id ||
        rel === `.skillsmith-parked/${id}` ||
        rel.startsWith(`.skillsmith-probe-${id}`)
    )
  return {
    skill: deepSnapshot(fx.realDir),
    staging: deepSnapshot(staging, {
      prune: true,
      skip: (abs) => own(path.relative(staging, abs)),
    }),
    state: deepSnapshot(fx.stateRoot, {
      prune: true,
      skip: (abs) =>
        path.basename(abs) === 'parked-index.jsonl' ||
        refusedOpIds.some((id) => path.basename(abs).startsWith(id)),
    }),
    index: othersIndexLines(fx, refusedOpIds),
    manifest: manifestOf(crashed.p),
  }
}

/**
 * The parked index without the refused runs' own lines (each line carries its
 * `opId`). No file reads as no lines: the refused run's park may create it.
 */
function othersIndexLines(fx: Fixture, refusedOpIds: string[]): string[] {
  const file = path.join(fx.stateRoot, 'parked-index.jsonl')
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l !== '' && !refusedOpIds.some((id) => l.includes(id)))
}

const ID = { dev: '1', ino: '1', birthtimeNs: '1', fmt: '1' }

/** A record that verifies (opId, hash) for `opId`, naming `target` in `fx`'s root unless overridden. */
export function validRecord(
  fx: Fixture,
  opId: string,
  over: { realDir?: string; comparedPath?: string; skillsDir?: string } = {}
): SwapRecord {
  const body: Omit<SwapRecord, 'recordSha256'> = {
    schema: 1,
    op: 'update',
    opId,
    pid: process.pid,
    host: 'test-host',
    uid: 0,
    target: {
      comparedPath: over.comparedPath ?? fx.realDir,
      realDir: over.realDir ?? fx.realDir,
      skillsDir: over.skillsDir ?? fs.realpathSync(fx.skillsDir),
      manifestPath: path.join(fx.stateRoot, 'manifest.json'),
      manifestKey: fx.dirName,
      client: 'claude-code',
      scope: 'global',
      dirName: fx.dirName,
    },
    rootIdentity: ID,
    opDirIdentity: ID,
    oldIdentity: ID,
    newIdentity: ID,
    preTree: 'a'.repeat(64),
    postTree: 'b'.repeat(64),
    preEntry: { version: '1.0.0' },
    postEntry: { version: '2.0.0' },
    backupDest: path.join(fx.stateRoot, 'backups', opId),
  }
  return { ...body, recordSha256: computeRecordSha256(body) }
}

/** Writes `ST/<opId>/record.json` with `text` (the op dir is made if absent). */
export function plantRecordText(fx: Fixture, opId: string, text: string): string {
  const dir = opDirOf(fx, opId)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'record.json')
  fs.writeFileSync(file, text)
  return file
}

/** Plants a verified record naming `fx`'s skill (or the override) in `ST/<opId>`. */
export const plantRecord = (
  fx: Fixture,
  opId: string,
  over: Parameters<typeof validRecord>[2] = {}
): string => plantRecordText(fx, opId, JSON.stringify(validRecord(fx, opId, over)))

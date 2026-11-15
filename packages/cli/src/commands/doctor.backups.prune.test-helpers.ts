/**
 * @fileoverview Fixtures for the `doctor backups --prune` suites (SMI-6531 step
 * 6c-ii-b): kept trees in the update backup area with sidecars that pass the
 * strict schema, parked copies with a verified ("Q") sidecar, an unreadable
 * update record, and a way to make `/proc/self/mountinfo` read as a given text.
 * Everything is built as real directories under a temporary base. Used only by
 * `doctor.backups.prune*.test.ts`.
 * @module @skillsmith/cli/commands/doctor.backups.prune.test-helpers
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { vi } from 'vitest'
import { treeHashOf } from '@skillsmith/core'

/** A throwaway real-path base. */
export function mkBase(prefix = 'doctor-prune-'): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
}

/** The state root `hermeticDiscovery(base)` finds: `<base>/.skillsmith`, created. */
export function stateRootOf(base: string): string {
  const s = path.join(base, '.skillsmith')
  fs.mkdirSync(s, { recursive: true })
  return fs.realpathSync(s)
}

/** A client's skills root as `hermeticDiscovery(base)` places it, created, as its real path. */
export function clientRoot(base: string, id: string): string {
  const dir = path.join(base, 'clients', id)
  fs.mkdirSync(dir, { recursive: true })
  return fs.realpathSync(dir)
}

/** The claude-code skills root. */
export const claudeRoot = (base: string): string => clientRoot(base, 'claude-code')

const sha16 = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16)

const hashOf = (dir: string): string => {
  const h = treeHashOf(dir)
  if (!h.ok) throw new Error(`fixture: cannot hash ${dir}`)
  return h.hash
}

export interface MadeBackup {
  areaPath: string
  copyPath: string
  sidecarPath: string
}

export interface BackupSpec {
  state: string
  skillsDir: string
  client?: string
  dirName?: string
  opId?: string
  kind?: string
  /** How old the sidecar says the tree is. */
  ageDays?: number
  /** A `createdAt` that does not parse as a date: the tree has no trusted age. */
  badCreatedAt?: boolean
  files?: Record<string, string>
}

/** A kept tree in `<state>/backups/update/<client>/<rootKey>/<dirName>/`, with a sidecar the strict schema accepts. */
export function putBackup(s: BackupSpec): MadeBackup {
  const client = s.client ?? 'claude-code'
  const dirName = s.dirName ?? 'foo'
  const opId = s.opId ?? 'op-1'
  const kind = s.kind ?? 'backup'
  const areaPath = path.join(s.state, 'backups', 'update', client, sha16(s.skillsDir), dirName)
  const copyPath = path.join(areaPath, kind === 'backup' ? opId : `${opId}.${kind}`)
  fs.mkdirSync(copyPath, { recursive: true })
  for (const [rel, body] of Object.entries(s.files ?? { 'SKILL.md': `skill ${dirName}\n` })) {
    fs.writeFileSync(path.join(copyPath, rel), body)
  }
  const st = fs.lstatSync(copyPath, { bigint: true })
  const created = new Date(Date.now() - (s.ageDays ?? 0) * 86_400_000).toISOString()
  const sidecar = {
    opId,
    kind,
    dirName,
    createdAt: s.badCreatedAt === true ? 'not-a-date' : created,
    treeHash: hashOf(copyPath),
    identity: {
      dev: String(st.dev),
      ino: String(st.ino),
      birthtimeNs: String(st.birthtimeNs),
      fmt: String(st.mode & 0o170000n),
    },
    client,
    skillsDir: s.skillsDir,
    scope: 'user',
    manifestKey: `${client}:${dirName}`,
  }
  const sidecarPath = `${copyPath}.json`
  fs.writeFileSync(sidecarPath, JSON.stringify(sidecar, null, 2) + '\n')
  return { areaPath, copyPath, sidecarPath }
}

export interface MadeParked {
  copyPath: string
  sidecarPath: string
  opDir: string
}

export interface ParkedSpec {
  /** The skills root whose `.skillsmith-parked` holds the copy. */
  root: string
  name?: string
  opId?: string
  kind?: string
  ageDays?: number
  /** No sidecar: the copy classes held. */
  noSidecar?: boolean
}

/** A parked copy with a verified sidecar (the "Q" shape: hash recorded and checked after the move). */
export function putParked(s: ParkedSpec): MadeParked {
  const name = s.name ?? 'foo'
  const opId = s.opId ?? 'op-p1'
  const opDir = path.join(s.root, '.skillsmith-parked', opId)
  const copyPath = path.join(opDir, `${name}-${sha16(`${s.root}/${name}/${opId}`).slice(0, 8)}`)
  fs.mkdirSync(copyPath, { recursive: true })
  fs.writeFileSync(path.join(copyPath, 'SKILL.md'), `parked ${name}\n`)
  const hash = hashOf(copyPath)
  const sidecar = {
    opId,
    kind: s.kind ?? 'uninstall',
    client: 'claude-code',
    rootKey: sha16(s.root),
    originPath: path.join(s.root, name),
    treeHash: hash,
    bytes: 20,
    createdAt: new Date(Date.now() - (s.ageDays ?? 0) * 86_400_000).toISOString(),
    skillsmithVersion: 'test',
    postMoveVerified: true,
    postMoveTreeHash: hash,
  }
  const sidecarPath = `${copyPath}.json`
  if (s.noSidecar !== true) fs.writeFileSync(sidecarPath, JSON.stringify(sidecar))
  return { copyPath, sidecarPath, opDir }
}

/** An update record in `root`'s staging area that cannot be read: it blocks writes there. */
export function putBrokenRecord(root: string, opId: string): string {
  const staging = path.join(root, '.skillsmith-staging')
  fs.mkdirSync(staging, { recursive: true, mode: 0o700 })
  const dir = path.join(staging, opId)
  fs.mkdirSync(dir, { mode: 0o700 })
  const file = path.join(dir, 'record.json')
  fs.writeFileSync(file, 'this is not json')
  return file
}

/** One mountinfo line whose mount point (field 5) is `mountPoint`. */
export const mountinfoLine = (mountPoint: string): string =>
  `99 1 0:99 / ${mountPoint} rw,relatime - tmpfs tmpfs rw\n`

/** Makes `/proc/self/mountinfo` read as `text`; every other read passes through. Restore with `vi.restoreAllMocks()`. */
export function injectMountinfo(text: string): void {
  const real = fs.readFileSync.bind(fs) as (...a: unknown[]) => unknown
  vi.spyOn(fs, 'readFileSync').mockImplementation(((p: unknown, ...rest: unknown[]) =>
    p === '/proc/self/mountinfo' ? text : real(p, ...rest)) as typeof fs.readFileSync)
}

/** The shape of the `--prune --json` document the tests read. */
export interface PlanDoc {
  dryRun: boolean
  noSelector: boolean
  preconditions: { code: string; root?: string; path?: string }[]
  groups: {
    lock: { kind: string; path: string }
    digest: string
    items: { copyPath: string; store: string; kind: string | null; class: string; tier: string }[]
  }[]
  excluded: { copyPath: string; reason: { code: string; [k: string]: unknown } }[]
  unmatchedPaths: { path: string; why: string }[]
  totals: { trees: number; allocatedBytes: number }
}

/** Every selected copy path, in plan order. */
export const selectedOf = (d: PlanDoc): string[] =>
  d.groups.flatMap((g) => g.items.map((i) => i.copyPath))

// ---- the zero-mutation instrument (the R2 pattern: every write family, in all three forms) ----

const WRITE_NAMES = [
  'unlink',
  'rmdir',
  'rm',
  'rename',
  'mkdir',
  'mkdtemp',
  'writeFile',
  'appendFile',
  'copyFile',
  'cp',
  'symlink',
  'link',
  'truncate',
  'ftruncate',
  'chmod',
  'fchmod',
  'lchmod',
  'chown',
  'fchown',
  'lchown',
  'utimes',
  'futimes',
  'lutimes',
  'write',
  'writev',
  'createWriteStream',
] as const

interface Spied {
  label: string
  spy: { mock: { calls: unknown[][] } }
  write: (args: unknown[]) => boolean
}

const O = fs.constants
const WRITE_BITS = O.O_WRONLY | O.O_RDWR | O.O_CREAT | O.O_APPEND | O.O_TRUNC
/** `open` with a write flag: a number carrying a write bit, or a string with w, a or +. */
const writeFlag = (flags: unknown): boolean =>
  typeof flags === 'number'
    ? (flags & WRITE_BITS) !== 0
    : typeof flags === 'string' && /[wa+]/.test(flags)

let spied: Spied[] = []

/**
 * Spies every write-family member of `fs` (callback and sync) and `fs.promises`; calls pass
 * through. Spies on the default `fs` object are invisible to a named or namespace ESM import
 * of `node:fs` (core loads from `dist` as ESM, and `config/file-lock.ts` imports by name)
 * until the builtin's live bindings are re-synced, so this does that after installing.
 */
export function installWriteSpies(): void {
  const add = (
    obj: Record<string, unknown>,
    name: string,
    label: string,
    write: Spied['write']
  ): void => {
    if (typeof obj[name] !== 'function') return
    spied.push({ label, spy: vi.spyOn(obj as never, name as never) as never, write })
  }
  for (const n of WRITE_NAMES) {
    add(fs as never, n, `fs.${n}`, () => true)
    add(fs as never, `${n}Sync`, `fs.${n}Sync`, () => true)
    add(fs.promises as never, n, `fs.promises.${n}`, () => true)
  }
  add(fs as never, 'open', 'fs.open', (a) => writeFlag(a[1]))
  add(fs as never, 'openSync', 'fs.openSync', (a) => writeFlag(a[1]))
  add(fs.promises as never, 'open', 'fs.promises.open', (a) => writeFlag(a[1]))
  syncBuiltinESMExports()
}

/** Forgets the spies and re-syncs the ESM bindings to the restored originals (call after `vi.restoreAllMocks()`). */
export const clearWriteSpies = (): void => {
  spied = []
  syncBuiltinESMExports()
}

/** Every write the spies saw: `fs.mkdirSync /path`. */
export function seenWrites(): string[] {
  return spied.flatMap((s) =>
    s.spy.mock.calls.filter((c) => s.write(c)).map((c) => `${s.label} ${String(c[0])}`)
  )
}

/** Every entry under `p`: type, mode, size, and the sha256 of file bytes. Reads only. */
export function snapshot(p: string): string[] {
  const lines: string[] = []
  const walk = (abs: string): void => {
    const s = fs.lstatSync(abs)
    const body = s.isFile() ? createHash('sha256').update(fs.readFileSync(abs)).digest('hex') : ''
    lines.push(`${abs} ${s.mode.toString(8)} ${s.isDirectory() ? 'd' : s.size} ${body}`)
    if (s.isDirectory()) for (const n of fs.readdirSync(abs).sort()) walk(path.join(abs, n))
  }
  walk(p)
  return lines
}

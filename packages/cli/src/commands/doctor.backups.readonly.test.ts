/**
 * @fileoverview `doctor backups` writes nothing (SMI-6531 step 6c-ii-a): a full
 * run over a fixture holding every store, with every write-family fs member
 * spied in all three forms (callback, sync, promises), plus a hash of every
 * fixture entry before and after. One family alone misses a recursive `rm`
 * (the R2 pattern), so all three are watched.
 *
 * The instrument is checked before it is trusted: a known-positive (a real
 * write in each form is seen) and a known-negative (a read is not). Its
 * control against the product: a `mkdir` injected into `listBackups` must be
 * reported and must fail this test.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runDoctorBackups } from './doctor.backups.js'
import { hermeticDiscovery, plantCrashedUpdate } from './doctor.test-helpers.js'

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
  'chown',
  'lchown',
  'utimes',
  'futimes',
  'lutimes',
  'write',
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

/** Spies every write-family member of `fs` (callback and sync) and `fs.promises`; calls pass through. */
function installSpies(): void {
  const add = (
    obj: Record<string, unknown>,
    name: string,
    label: string,
    write: Spied['write']
  ) => {
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
}

/** Every write the spies saw: `fs.mkdirSync /path`. */
function seenWrites(): string[] {
  return spied.flatMap((s) =>
    s.spy.mock.calls.filter((c) => s.write(c)).map((c) => `${s.label} ${String(c[0])}`)
  )
}

/** Every entry under `p`: type, mode, size, and the sha256 of file bytes. Reads only. */
function snapshot(p: string): string[] {
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

let base = ''
beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-backups-ro-')))
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  process.exitCode = undefined
})
afterEach(() => {
  vi.restoreAllMocks()
  spied = []
  process.exitCode = undefined
  fs.rmSync(base, { recursive: true, force: true })
})

/** A fixture holding every store `doctor backups` reads, so the run walks all of them. */
function plantEverything(): ReturnType<typeof hermeticDiscovery> {
  const d = hermeticDiscovery(base, true)
  const u = plantCrashedUpdate(base)
  const put = (p: string, text: string): void => {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, text)
  }
  // A parked copy with and without its sidecar, an orphan sidecar, and a staging leftover.
  put(path.join(u.root, '.skillsmith-parked', 'op-1', 'foo-12345678', 'SKILL.md'), 'a')
  put(path.join(u.root, '.skillsmith-parked', 'op-1', 'foo-12345678.json'), '{}')
  put(path.join(u.root, '.skillsmith-parked', 'op-1', 'ghost-87654321.json'), '{}')
  fs.mkdirSync(path.join(u.root, '.skillsmith-parked', '.prune-0123456789abcdef'))
  // The staging area's own parked area.
  put(
    path.join(u.root, '.skillsmith-staging', '.skillsmith-parked', 'op-2', 'bar-0badc0de', 'f'),
    'b'
  )
  // The update backup store: a tree, its temp, an orphan sidecar, a leftover, and unrelated files.
  put(path.join(u.backupDest, 'SKILL.md'), 'old')
  put(`${u.backupDest}.json`, '{}')
  put(path.join(path.dirname(u.backupDest), `.tmp-${u.opId}`, 'f'), 'x')
  put(path.join(path.dirname(u.backupDest), 'zzz.json'), '{}')
  fs.mkdirSync(path.join(path.dirname(u.backupDest), '.prune-0123456789abcdef'))
  put(path.join(u.stateRoot, 'backups', 'purge-dead-quarantines-1.csv'), 'a,b')
  // The older MCP store, a legacy removal leftover, and an index with good and bad lines.
  put(path.join(u.root, '.backups', 'skill', '20260101_edit', 'SKILL.md'), 'm')
  fs.mkdirSync(path.join(u.root, `.foo.skillsmith-removing-${'0123456789abcdef'.repeat(2)}`))
  const good = path.join(u.root, '.skillsmith-parked', 'op-1', 'foo-12345678')
  put(
    path.join(u.stateRoot, 'parked-index.jsonl'),
    `${JSON.stringify({ path: good, opId: 'op-1' })}\n${JSON.stringify({ path: '/etc/passwd' })}\nnot json\n`
  )
  return d
}

describe('the write spies themselves (known positive and known negative)', () => {
  it('see a write in every form, and do not see a read', async () => {
    installSpies()
    const dir = path.join(base, 'probe')
    fs.mkdirSync(dir)
    fs.mkdir(path.join(dir, 'a'), () => undefined)
    await fs.promises.mkdir(path.join(dir, 'b'))
    fs.writeFileSync(path.join(dir, 'f'), 'x')
    const fd = fs.openSync(path.join(dir, 'g'), 'w')
    fs.closeSync(fd)
    const afterWrites = seenWrites()
    for (const w of [
      `fs.mkdirSync ${dir}`,
      `fs.mkdir ${path.join(dir, 'a')}`,
      `fs.promises.mkdir ${path.join(dir, 'b')}`,
      `fs.writeFileSync ${path.join(dir, 'f')}`,
      `fs.openSync ${path.join(dir, 'g')}`,
    ]) {
      expect(afterWrites).toContain(w)
    }
    const before = seenWrites().length
    fs.readdirSync(dir)
    fs.readFileSync(path.join(dir, 'f'))
    fs.closeSync(fs.openSync(path.join(dir, 'f'), 'r'))
    expect(seenWrites().length).toBe(before)
  })
})

describe('doctor backups over every store', () => {
  it('writes, deletes, renames, creates and locks nothing: no write-family fs call, and every fixture entry unchanged', async () => {
    const discovery = plantEverything()
    const before = snapshot(base)
    installSpies()
    await runDoctorBackups({ discovery, json: true })
    expect(process.exitCode).toBeUndefined()
    expect(seenWrites()).toEqual([])
    expect(snapshot(base)).toEqual(before)
  })

  it('the run did read the stores (a run that lists nothing proves nothing)', async () => {
    const discovery = plantEverything()
    const out: string[] = []
    vi.mocked(console.log).mockImplementation((...a) => void out.push(a.join(' ')))
    await runDoctorBackups({ discovery, json: true })
    const doc = JSON.parse(out.join('\n')) as {
      parked: { copies: unknown[]; leftovers: unknown[]; orphanSidecars: unknown[] }[]
      backups: { areas: { trees: unknown[]; temps: unknown[]; leftovers: unknown[] }[] }[]
      olderMcpBackups: unknown[]
      legacyLeftovers: unknown[]
      index: { rejected: unknown[] }
    }
    expect(doc.parked.flatMap((a) => a.copies).length).toBeGreaterThanOrEqual(2)
    expect(doc.parked.flatMap((a) => a.orphanSidecars).length).toBeGreaterThan(0)
    expect(doc.parked.flatMap((a) => a.leftovers).length).toBeGreaterThan(0)
    expect(doc.backups.flatMap((s) => s.areas).flatMap((a) => a.trees).length).toBe(1)
    expect(doc.backups.flatMap((s) => s.areas).flatMap((a) => a.temps).length).toBe(1)
    expect(doc.olderMcpBackups).toHaveLength(1)
    expect(doc.legacyLeftovers).toHaveLength(1)
    expect(doc.index.rejected).toHaveLength(2)
  })
})

/**
 * @fileoverview `skillsmith doctor backups --prune` end to end (SMI-6531 step
 * 6c-ii-b): real fixtures, the real listing, lock assignment and planner, then
 * the text and JSON the CLI prints. Each selector, `--keep` explicit against
 * default (M-KEEP1), `--include-kept`, `--allow-changed`, a mounted copy that
 * is never offered, unknown protection and unidentified copies shown as
 * excluded, the D10 banner with exit 0, D18's exit 1, selectors without
 * `--prune`, and the words of a dry run.
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runDoctorBackups, type DoctorBackupsOptions } from './doctor.backups.js'
import { hermeticDiscovery } from './doctor.test-helpers.js'
import {
  claudeRoot,
  clientRoot,
  injectMountinfo,
  mkBase,
  mountinfoLine,
  putBackup,
  putBrokenRecord,
  putParked,
  selectedOf,
  stateRootOf,
} from './doctor.backups.prune.test-helpers.js'
import type { PlanDoc } from './doctor.backups.prune.test-helpers.js'

let base = ''
let state = ''
let out: string[] = []
let err: string[] = []

beforeEach(() => {
  base = mkBase()
  state = stateRootOf(base)
  out = []
  err = []
  vi.spyOn(console, 'log').mockImplementation((...a) => void out.push(a.join(' ')))
  vi.spyOn(console, 'error').mockImplementation((...a) => void err.push(a.join(' ')))
  process.exitCode = undefined
})
afterEach(() => {
  vi.restoreAllMocks()
  process.exitCode = undefined
  fs.rmSync(base, { recursive: true, force: true })
})

const run = (o: Partial<DoctorBackupsOptions> = {}): Promise<void> =>
  runDoctorBackups({ discovery: hermeticDiscovery(base, true), ...o })
const root = (): string => claudeRoot(base)

/** A `--prune --json` run, parsed. */
async function plan(o: Partial<DoctorBackupsOptions> = {}): Promise<PlanDoc> {
  out = []
  await run({ prune: true, json: true, ...o })
  return JSON.parse(out.join('\n')) as PlanDoc
}
const reasonOf = (d: PlanDoc, copyPath: string): string | undefined =>
  d.excluded.find((x) => x.copyPath === copyPath)?.reason.code
const DAYS = (n: number): number => n

describe('no selector selects nothing, and --keep is a selector only when given (M-KEEP1)', () => {
  it('--prune alone lists nothing to delete, says why, and exits 0', async () => {
    putBackup({ state, skillsDir: root(), opId: 'op-a', ageDays: DAYS(9) })
    putBackup({ state, skillsDir: root(), opId: 'op-b', ageDays: DAYS(1) })
    const d = await plan()
    expect(d.noSelector).toBe(true)
    expect(selectedOf(d)).toEqual([])
    expect(process.exitCode).toBeUndefined()
    out = []
    await run({ prune: true })
    const text = out.join('\n')
    expect(text).toContain('No selector was given, so nothing is selected.')
    expect(text).toContain('0 trees')
  })

  it('--keep given explicitly guards the newest and selects the older backups of a folder', async () => {
    const newest = putBackup({ state, skillsDir: root(), opId: 'op-new', ageDays: DAYS(1) })
    const mid = putBackup({ state, skillsDir: root(), opId: 'op-mid', ageDays: DAYS(5) })
    const old = putBackup({ state, skillsDir: root(), opId: 'op-old', ageDays: DAYS(9) })
    const d = await plan({ keep: '1' })
    expect(selectedOf(d)).toEqual([mid.copyPath, old.copyPath])
    expect(reasonOf(d, newest.copyPath)).toBe('newest-kept')
  })

  it('--keep 2 keeps the newest two', async () => {
    putBackup({ state, skillsDir: root(), opId: 'op-new', ageDays: DAYS(1) })
    const mid = putBackup({ state, skillsDir: root(), opId: 'op-mid', ageDays: DAYS(5) })
    const old = putBackup({ state, skillsDir: root(), opId: 'op-old', ageDays: DAYS(9) })
    const d = await plan({ keep: '2' })
    expect(selectedOf(d)).toEqual([old.copyPath])
    expect(reasonOf(d, mid.copyPath)).toBe('newest-kept')
  })

  it('--keep with --older-than selects only within the intersection', async () => {
    putBackup({ state, skillsDir: root(), opId: 'op-new', ageDays: DAYS(1) })
    const young = putBackup({ state, skillsDir: root(), opId: 'op-mid', ageDays: DAYS(5) })
    const old = putBackup({ state, skillsDir: root(), opId: 'op-old', ageDays: DAYS(40) })
    const d = await plan({ keep: '1', olderThan: '30' })
    expect(selectedOf(d)).toEqual([old.copyPath])
    expect(selectedOf(d)).not.toContain(young.copyPath)
  })
})

describe('each selector', () => {
  it('--older-than selects only trees at least that old; a tree of unknown age never matches', async () => {
    const old = putBackup({ state, skillsDir: root(), opId: 'op-o', kind: 'undone', ageDays: 40 })
    putBackup({ state, skillsDir: root(), opId: 'op-y', kind: 'undone', ageDays: 10 })
    const odd = putBackup({
      state,
      skillsDir: root(),
      opId: 'op-u',
      kind: 'undone',
      badCreatedAt: true,
    })
    const d = await plan({ olderThan: '30' })
    expect(selectedOf(d)).toEqual([old.copyPath])
    expect(selectedOf(d)).not.toContain(odd.copyPath)
  })

  it('--skill, --op and --client each narrow to their own', async () => {
    const a = putBackup({ state, skillsDir: root(), dirName: 'a', opId: 'op-1', kind: 'undone' })
    const b = putBackup({ state, skillsDir: root(), dirName: 'b', opId: 'op-2', kind: 'undone' })
    const cursorRoot = clientRoot(base, 'cursor')
    const c = putBackup({
      state,
      skillsDir: cursorRoot,
      client: 'cursor',
      dirName: 'c',
      opId: 'op-3',
      kind: 'undone',
    })
    expect(selectedOf(await plan({ skill: 'a' }))).toEqual([a.copyPath])
    expect(selectedOf(await plan({ op: 'op-2' }))).toEqual([b.copyPath])
    expect(selectedOf(await plan({ client: 'cursor' }))).toEqual([c.copyPath])
  })

  it('--root selects what belongs to that skills root only', async () => {
    const a = putBackup({ state, skillsDir: root(), dirName: 'a', opId: 'op-1', kind: 'undone' })
    const cursorRoot = clientRoot(base, 'cursor')
    putBackup({ state, skillsDir: cursorRoot, client: 'cursor', opId: 'op-3', kind: 'undone' })
    expect(selectedOf(await plan({ root: [root()] }))).toEqual([a.copyPath])
  })

  it('--path names an exact tree, also through a symlinked parent (resolved to its native real path)', async () => {
    const a = putBackup({ state, skillsDir: root(), dirName: 'a', opId: 'op-1', kind: 'undone' })
    const b = putBackup({ state, skillsDir: root(), dirName: 'b', opId: 'op-2', kind: 'undone' })
    expect(selectedOf(await plan({ path: [a.copyPath] }))).toEqual([a.copyPath])
    const link = path.join(base, 'via-link')
    fs.symlinkSync(state, link)
    const spelled = path.join(link, path.relative(state, b.copyPath))
    expect(spelled).not.toBe(b.copyPath)
    const d = await plan({ path: [spelled] })
    expect(selectedOf(d)).toEqual([b.copyPath])
    expect(d.unmatchedPaths).toEqual([])
    expect(process.exitCode).toBeUndefined()
  })
})

describe('kinds, classes and tiers', () => {
  it('--include-kept offers a kept kind; without it the tree is shown as excluded', async () => {
    const t = putBackup({ state, skillsDir: root(), opId: 'op-c', kind: 'conflict' })
    const without = await plan({ op: 'op-c' })
    expect(selectedOf(without)).toEqual([])
    expect(reasonOf(without, t.copyPath)).toBe('needs-include-kept')
    const withIt = await plan({ op: 'op-c', includeKept: true })
    expect(selectedOf(withIt)).toEqual([t.copyPath])
  })

  it('a changed copy needs --allow-changed <path>; then it is a per-item confirmation, a clean one a batch', async () => {
    const clean = putBackup({
      state,
      skillsDir: root(),
      dirName: 'a',
      opId: 'op-1',
      kind: 'undone',
    })
    const changed = putBackup({
      state,
      skillsDir: root(),
      dirName: 'b',
      opId: 'op-2',
      kind: 'undone',
    })
    fs.writeFileSync(path.join(changed.copyPath, 'extra.txt'), 'edited after the sidecar')
    const without = await plan({ olderThan: '0' })
    expect(selectedOf(without)).toEqual([clean.copyPath])
    expect(reasonOf(without, changed.copyPath)).toBe('needs-allow-changed')
    const withIt = await plan({ olderThan: '0', allowChanged: [changed.copyPath] })
    const tiers = Object.fromEntries(
      withIt.groups.flatMap((g) => g.items.map((i) => [i.copyPath, [i.class, i.tier]]))
    )
    expect(tiers).toEqual({
      [clean.copyPath]: ['clean', 'batch'],
      [changed.copyPath]: ['changed', 'per-item'],
    })
  })

  it.skipIf(process.platform !== 'linux')(
    'a mounted copy is never offered, even named by --path and --allow-changed',
    async () => {
      const p = putParked({ root: root(), name: 'm', opId: 'op-m', noSidecar: true })
      injectMountinfo(mountinfoLine(path.join(fs.realpathSync(p.copyPath), 'sub')))
      const d = await plan({ path: [p.copyPath], allowChanged: [p.copyPath] })
      expect(selectedOf(d)).toEqual([])
      expect(reasonOf(d, p.copyPath)).toBe('mounted')
      out = []
      await run({ prune: true, path: [p.copyPath], allowChanged: [p.copyPath] })
      expect(out.join('\n')).toContain('mounted: never offered')
    }
  )

  it('a tree whose protection is unknown is shown as excluded, never selected', async () => {
    putBrokenRecord(root(), 'op-broken')
    const unknown = putBackup({ state, skillsDir: root(), opId: 'op-other', kind: 'undone' })
    const d = await plan({ skill: 'foo' })
    expect(selectedOf(d)).toEqual([])
    expect(reasonOf(d, unknown.copyPath)).toBe('protection-unknown')
    out = []
    await run({ prune: true, skill: 'foo' })
    expect(out.join('\n')).toContain('protection unknown, so it is kept')
  })

  it.skipIf(process.platform !== 'linux')(
    'a tree no job can name (it cannot be walked) is excluded as unidentified even when allowed',
    async () => {
      const t = putBackup({
        state,
        skillsDir: root(),
        dirName: 'fifo',
        opId: 'op-f',
        kind: 'undone',
      })
      execFileSync('mkfifo', [path.join(t.copyPath, 'pipe')])
      const d = await plan({ skill: 'fifo', allowChanged: [t.copyPath] })
      expect(selectedOf(d)).toEqual([])
      expect(reasonOf(d, t.copyPath)).toBe('unidentified')
      out = []
      await run({ prune: true, skill: 'fifo', allowChanged: [t.copyPath] })
      expect(out.join('\n')).toContain('no deletion job can name it')
    }
  )
})

describe('when --apply would refuse (D10) and when a path matches nothing (D18)', () => {
  it('prints the --apply refusal first, still plans, and exits 0', async () => {
    const rec = putBrokenRecord(root(), 'op-broken')
    putBackup({ state, skillsDir: root(), opId: 'op-1', kind: 'undone' })
    await run({ prune: true, skill: 'foo' })
    expect(process.exitCode).toBeUndefined()
    const first = out[0] ?? ''
    expect(first.startsWith('--apply would refuse:')).toBe(true)
    expect(first).toContain(rec)
    const d = await plan({ skill: 'foo' })
    expect(d.preconditions.map((p) => p.code)).toContain('unreadable-record')
  })

  it('a --path that names no tree prune lists exits 1 and names the path and why', async () => {
    const t = putBackup({ state, skillsDir: root(), opId: 'op-1', kind: 'undone' })
    const prune = path.join(t.areaPath, '.prune-0123456789abcdef')
    fs.mkdirSync(prune)
    const missing = path.join(t.areaPath, 'op-nope')
    const d = await plan({ path: [prune, missing, t.copyPath] })
    expect(process.exitCode).toBe(1)
    expect(selectedOf(d)).toEqual([t.copyPath])
    expect(d.unmatchedPaths.map((u) => u.path).sort()).toEqual([prune, missing].sort())
    const text = err.join('\n')
    expect(text).toContain(`--path ${prune} matched nothing`)
    expect(text).toContain('.prune-* directory')
    expect(text).toContain(`--path ${missing} matched nothing`)
    expect(text).toContain('not found')
  })

  it('an unusable --root exits 1 and creates nothing there', async () => {
    const missing = path.join(base, 'no-such-root')
    await run({ prune: true, root: [missing], olderThan: '0' })
    expect(process.exitCode).toBe(1)
    expect(err.join('\n')).toContain(`--root ${missing} could not be used`)
    expect(fs.existsSync(missing)).toBe(false)
  })
})

describe('selector options without --prune, and values that are not usable', () => {
  const stray: [string, Partial<DoctorBackupsOptions>][] = [
    ['--older-than', { olderThan: '30' }],
    ['--keep', { keep: '1' }],
    ['--skill', { skill: 'a' }],
    ['--op', { op: 'op-1' }],
    ['--path', { path: ['/x'] }],
    ['--include-kept', { includeKept: true }],
    ['--allow-changed', { allowChanged: ['/x'] }],
  ]
  it.each(stray)('%s without --prune is refused with exit 1 and lists nothing', async (flag, o) => {
    putBackup({ state, skillsDir: root(), opId: 'op-1', kind: 'undone' })
    await run(o)
    expect(process.exitCode).toBe(1)
    expect(err.join('\n')).toContain(`${flag} only works with --prune`)
    expect(out).toEqual([])
  })

  it('--client and --root alone still list (they narrow the listing)', async () => {
    putBackup({ state, skillsDir: root(), opId: 'op-1', kind: 'undone' })
    await run({ client: 'claude-code', root: [root()] })
    expect(process.exitCode).toBeUndefined()
    expect(out.join('\n')).toContain('Kept backups in')
  })

  it.each([
    [{ olderThan: 'abc' }, '--older-than needs a number of days'],
    [{ olderThan: '-3' }, '--older-than needs a number of days'],
    [{ keep: '1.5' }, '--keep needs a whole number'],
    [{ keep: '-1' }, '--keep needs a whole number'],
  ] as [Partial<DoctorBackupsOptions>, string][])(
    '%j is refused with exit 1',
    async (o, message) => {
      await run({ prune: true, ...o })
      expect(process.exitCode).toBe(1)
      expect(err.join('\n')).toContain(message)
      expect(out).toEqual([])
    }
  )
})

describe('the words and the JSON of a dry run', () => {
  it('says "would be deleted under --apply (6c-iii)" and never "deleted" alone; shows lock, kind, class, size and tier', async () => {
    const t = putBackup({ state, skillsDir: root(), opId: 'op-1', kind: 'undone' })
    const p = putParked({ root: root(), name: 'p', opId: 'op-p' })
    await run({ prune: true, olderThan: '0' })
    const text = out.join('\n')
    expect(text).toContain('would be deleted under --apply (6c-iii)')
    expect(text.match(/deleted/g)?.length).toBe(text.match(/would be deleted/g)?.length)
    expect(text).toContain(`lock 1 of the skills root ${root()}`)
    for (const copy of [t.copyPath, p.copyPath]) expect(text).toContain(copy)
    expect(text).toContain('store: backup  kind: undone  class: clean')
    expect(text).toContain('store: parked  kind: uninstall  class: clean')
    expect(text).toMatch(/on disk {2}batch confirmation/)
    expect(text).toContain('2 trees')
  })

  it('--json carries bigint identities as decimal strings and a sidecar as its sha256 only', async () => {
    const t = putBackup({ state, skillsDir: root(), opId: 'op-1', kind: 'undone' })
    out = []
    await run({ prune: true, json: true, olderThan: '0' })
    const raw = out.join('\n')
    const doc = JSON.parse(raw) as {
      dryRun: boolean
      groups: { items: { rootIdentity: Record<string, unknown>; sidecarSha256: string }[] }[]
    }
    const item = doc.groups[0]!.items[0]!
    expect(doc.dryRun).toBe(true)
    for (const v of Object.values(item.rootIdentity)) expect(v).toMatch(/^[0-9]+$/)
    const bytes = fs.readFileSync(t.sidecarPath)
    expect(item.sidecarSha256).toBe(createHash('sha256').update(bytes).digest('hex'))
    expect(raw).not.toContain(bytes.toString('base64'))
    expect(raw).not.toContain('manifestKey')
  })

  it('the space warning goes to stderr before the plan', async () => {
    putBackup({ state, skillsDir: root(), opId: 'op-1', kind: 'undone' })
    await run({
      prune: true,
      olderThan: '0',
      parkedUsage: { statfs: () => ({ bavail: 1e12, bsize: 1 }), capBytes: 1 },
    })
    expect(err.join('\n')).toContain('set-aside folders')
    expect(out.join('\n')).not.toContain('set-aside folders take')
  })
})

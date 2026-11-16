/**
 * @fileoverview `doctor backups` after the /governance review of the dry run
 * (SMI-6531 step 6c-ii-b): an empty or blank value is refused by every
 * string option (the property test in `doctor.backups.prune.blank.test.ts`), `--keep 0` is refused by the CLI before the
 * planner runs, a symlinked copy-root leaf and a symlinked root are named as
 * typed, the output order and exit claims, the text of excluded, per-item and
 * lock 1' rows, a no-match `--allow-changed` notice, and a parked copy's
 * protection in the plain listing and its JSON.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runDoctorBackups, type DoctorBackupsOptions } from './doctor.backups.js'
import { hermeticDiscovery } from './doctor.test-helpers.js'
import {
  claudeRoot,
  clientRoot,
  mkBase,
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
/** Every console line in the order it was printed: `out: ...` or `err: ...`. */
let events: string[] = []

beforeEach(() => {
  base = mkBase('doctor-prune-fix-')
  state = stateRootOf(base)
  out = []
  err = []
  events = []
  vi.spyOn(console, 'log').mockImplementation((...a) => {
    out.push(a.join(' '))
    events.push(`out: ${a.join(' ')}`)
  })
  vi.spyOn(console, 'error').mockImplementation((...a) => {
    err.push(a.join(' '))
    events.push(`err: ${a.join(' ')}`)
  })
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

async function plan(o: Partial<DoctorBackupsOptions> = {}): Promise<PlanDoc> {
  out = []
  await run({ prune: true, json: true, ...o })
  return JSON.parse(out.join('\n')) as PlanDoc
}
const reasonOf = (d: PlanDoc, copyPath: string): string | undefined =>
  d.excluded.find((x) => x.copyPath === copyPath)?.reason.code

describe('--keep 0 is refused by the CLI before the planner runs', () => {
  it.each(['0', '00'])(
    '--keep %s exits 1 with the message and never reaches the planner',
    async (k) => {
      putBackup({ state, skillsDir: root(), opId: 'op-1', kind: 'undone' })
      await run({ prune: true, keep: k })
      expect(process.exitCode).toBe(1)
      const text = err.join('\n')
      expect(text).toContain(
        '--keep needs at least 1; the newest backup of each folder is always kept.'
      )
      expect(text).not.toContain('TypeError')
      expect(text).not.toContain('could not plan')
      expect(out).toEqual([])
    }
  )
})

describe('a symlinked path is named as the user typed it', () => {
  /** Two backups, `b` changed; `link` is a leaf in a's area pointing at b's copy. */
  function plantLink(): { a: string; b: string; link: string } {
    const a = putBackup({ state, skillsDir: root(), dirName: 'a', opId: 'op-1', kind: 'undone' })
    const b = putBackup({ state, skillsDir: root(), dirName: 'b', opId: 'op-2', kind: 'undone' })
    fs.writeFileSync(path.join(b.copyPath, 'extra.txt'), 'edited')
    const link = path.join(a.areaPath, 'op-link')
    fs.symlinkSync(b.copyPath, link)
    return { a: a.copyPath, b: b.copyPath, link }
  }

  it('--path names the symlinked leaf, not its target: the leaf is what the plan reports, the target is untouched', async () => {
    const p = plantLink()
    const d = await plan({ path: [p.link] })
    expect(selectedOf(d)).toEqual([])
    expect(d.unmatchedPaths).toEqual([])
    expect(d.excluded.map((x) => x.copyPath)).toEqual([p.link])
  })

  it('--allow-changed names the symlinked leaf, not its target: the changed target stays excluded', async () => {
    const p = plantLink()
    const d = await plan({ olderThan: '0', allowChanged: [p.link] })
    expect(reasonOf(d, p.b)).toBe('needs-allow-changed')
    expect(selectedOf(d)).not.toContain(p.b)
    expect(err.join('\n')).toContain(`--allow-changed ${p.link} names no tree`)
  })

  it('--root through a symlinked root selects what belongs to its real path', async () => {
    const a = putBackup({ state, skillsDir: root(), dirName: 'a', opId: 'op-1', kind: 'undone' })
    const cursor = clientRoot(base, 'cursor')
    putBackup({ state, skillsDir: cursor, client: 'cursor', opId: 'op-3', kind: 'undone' })
    const link = path.join(base, 'root-link')
    fs.symlinkSync(root(), link)
    const d = await plan({ root: [link] })
    expect(selectedOf(d)).toEqual([a.copyPath])
    expect(process.exitCode).toBeUndefined()
  })
})

describe('what is printed, in what order, and with which exit status', () => {
  it('the space warning is printed before any line of the plan', async () => {
    putBackup({ state, skillsDir: root(), opId: 'op-1', kind: 'undone' })
    await run({
      prune: true,
      olderThan: '0',
      parkedUsage: { statfs: () => ({ bavail: 1e12, bsize: 1 }), capBytes: 1 },
    })
    const warning = events.findIndex((e) => e.startsWith('err:') && e.includes('set-aside folders'))
    const firstPlanLine = events.findIndex((e) => e.startsWith('out:'))
    expect(warning).toBeGreaterThanOrEqual(0)
    expect(firstPlanLine).toBeGreaterThanOrEqual(0)
    expect(warning).toBeLessThan(firstPlanLine)
  })

  it('a planning error exits 1, says it could not plan, and prints no plan', async () => {
    await run({ prune: true, olderThan: '0', discovered: {} as never })
    expect(process.exitCode).toBe(1)
    expect(err.join('\n')).toContain('doctor backups --prune could not plan:')
    expect(out).toEqual([])
  })

  it('every excluded row is printed, under a count that matches', async () => {
    const copies = ['a', 'b', 'c'].map((dirName, i) => {
      const t = putBackup({ state, skillsDir: root(), dirName, opId: `op-${i}`, kind: 'undone' })
      fs.writeFileSync(path.join(t.copyPath, 'extra.txt'), 'edited')
      return t.copyPath
    })
    await run({ prune: true, olderThan: '0' })
    const text = out.join('\n')
    expect(text).toContain('Matched but kept (3):')
    for (const c of copies) expect(text).toContain(`${c}  store: backup  class changed`)
  })

  it('a changed copy says per-item confirmation on its own line, a clean one batch', async () => {
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
    fs.writeFileSync(path.join(changed.copyPath, 'extra.txt'), 'edited')
    await run({ prune: true, olderThan: '0', allowChanged: [changed.copyPath] })
    const line = (p: string): string => out.find((l) => l.includes(`${p}  store:`)) ?? ''
    expect(line(changed.copyPath)).toMatch(/per-item confirmation$/)
    expect(line(clean.copyPath)).toMatch(/batch confirmation$/)
  })

  it("a backup whose skills root is gone is grouped under lock 1' of the set-aside area", async () => {
    const gone = path.join(base, 'gone-root')
    const t = putBackup({ state, skillsDir: gone, opId: 'op-1', kind: 'undone' })
    const d = await plan({ olderThan: '0' })
    expect(selectedOf(d)).toEqual([t.copyPath])
    expect(d.groups[0]?.lock.kind).toBe('lock1prime')
    out = []
    await run({ prune: true, olderThan: '0' })
    const text = out.join('\n')
    expect(text).toContain("lock 1' of the set-aside area ")
    expect(text).not.toContain('lock 1 of the skills root')
  })

  it('the needs-allow-changed text names the copy path to allow', async () => {
    const changed = putBackup({ state, skillsDir: root(), opId: 'op-2', kind: 'undone' })
    fs.writeFileSync(path.join(changed.copyPath, 'extra.txt'), 'edited')
    await run({ prune: true, olderThan: '0' })
    expect(out.join('\n')).toContain(
      `needs --allow-changed ${changed.copyPath}, then a per-item confirmation`
    )
  })
})

describe('a --allow-changed that matches nothing', () => {
  it('prints a notice on stderr for each, and leaves the exit status alone', async () => {
    putBackup({ state, skillsDir: root(), opId: 'op-1', kind: 'undone' })
    const nope = path.join(base, 'nope')
    const nope2 = path.join(base, 'nope-too')
    await run({ prune: true, olderThan: '0', allowChanged: [nope, nope2] })
    const text = err.join('\n')
    expect(text).toContain(`--allow-changed ${nope} names no tree`)
    expect(text).toContain(`--allow-changed ${nope2} names no tree`)
    expect(process.exitCode).toBeUndefined()
    expect(out.join('\n')).toContain('would be deleted under --apply (6c-iii)')
  })

  it('prints none for one that names a tree the plan keeps', async () => {
    const changed = putBackup({ state, skillsDir: root(), opId: 'op-2', kind: 'undone' })
    fs.writeFileSync(path.join(changed.copyPath, 'extra.txt'), 'edited')
    await run({ prune: true, olderThan: '0', allowChanged: [changed.copyPath] })
    expect(err.join('\n')).not.toContain('--allow-changed')
  })
})

describe('a parked copy shows its protection in the plain listing and its JSON', () => {
  it('text: "no update record protects it" next to the copy', async () => {
    const p = putParked({ root: root(), name: 'p', opId: 'op-p' })
    await run()
    const line = out.find((l) => l.includes(p.copyPath)) ?? ''
    expect(line).toContain('no update record protects it')
  })

  it('text: "protection unknown" when an update record could not be read', async () => {
    const p = putParked({ root: root(), name: 'p', opId: 'op-p' })
    putBrokenRecord(root(), 'op-broken')
    await run()
    const line = out.find((l) => l.includes(p.copyPath)) ?? ''
    expect(line).toContain('protection unknown:')
  })

  it('JSON: each parked copy carries its protection as the backups do', async () => {
    const p = putParked({ root: root(), name: 'p', opId: 'op-p' })
    await run({ json: true })
    const doc = JSON.parse(out.join('\n')) as {
      parked: { copies: { path: string; protection: { status: string } }[] }[]
    }
    const copy = doc.parked.flatMap((a) => a.copies).find((c) => c.path === p.copyPath)
    expect(copy?.protection).toEqual({ status: 'unprotected' })
  })
})

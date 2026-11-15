/**
 * @fileoverview `doctor backups --prune` writes nothing (SMI-6531 step
 * 6c-ii-b): full dry runs over a fixture holding both stores, with every
 * selector, every write-family fs member spied in all three forms (callback,
 * sync, promises), and every fixture entry hashed before and after. The
 * instrument is checked first, with a known positive (a write in each form is
 * seen, also one made through a named or namespace ESM import of `node:fs`,
 * which core loads that way) and a known negative (a read is not). Control
 * against the product: a write injected into code the dry run runs must be
 * reported and must fail this test.
 */
import fs, { mkdirSync as namedMkdirSync } from 'node:fs'
import { mkdir as namedPromisesMkdir } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runDoctorBackups, type DoctorBackupsOptions } from './doctor.backups.js'
import { hermeticDiscovery } from './doctor.test-helpers.js'
import {
  claudeRoot,
  clearWriteSpies,
  installWriteSpies,
  mkBase,
  putBackup,
  putBrokenRecord,
  putParked,
  seenWrites,
  snapshot,
  stateRootOf,
} from './doctor.backups.prune.test-helpers.js'
import type { PlanDoc } from './doctor.backups.prune.test-helpers.js'

let base = ''
let out: string[] = []
beforeEach(() => {
  base = mkBase('doctor-prune-ro-')
  out = []
  vi.spyOn(console, 'log').mockImplementation((...a) => void out.push(a.join(' ')))
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  process.exitCode = undefined
})
afterEach(() => {
  vi.restoreAllMocks()
  clearWriteSpies()
  process.exitCode = undefined
  fs.rmSync(base, { recursive: true, force: true })
})

/**
 * Let work the run scheduled but did not await finish before the final
 * snapshot: pending immediates, and timers due within SETTLE_MS of the run's
 * end. A write scheduled later than that is outside what this test sees.
 */
const SETTLE_MS = 25
async function settle(): Promise<void> {
  await new Promise<void>((r) => setImmediate(r))
  await new Promise<void>((r) => setTimeout(r, SETTLE_MS))
  await new Promise<void>((r) => setImmediate(r))
}

/** Both stores, a changed tree, a kept kind, a leftover, an unreadable record, and a symlinked path. */
function plant(broken: boolean): { changed: string; kept: string; paths: string[] } {
  const state = stateRootOf(base)
  const root = claudeRoot(base)
  const a = putBackup({ state, skillsDir: root, dirName: 'a', opId: 'op-1', kind: 'undone' })
  const changed = putBackup({ state, skillsDir: root, dirName: 'b', opId: 'op-2', kind: 'undone' })
  fs.writeFileSync(path.join(changed.copyPath, 'extra.txt'), 'edited')
  const kept = putBackup({ state, skillsDir: root, dirName: 'c', opId: 'op-3', kind: 'conflict' })
  putBackup({ state, skillsDir: root, dirName: 'd', opId: 'op-4', ageDays: 9 })
  putBackup({ state, skillsDir: root, dirName: 'd', opId: 'op-5', ageDays: 1 })
  const p = putParked({ root, name: 'p', opId: 'op-p' })
  fs.mkdirSync(path.join(a.areaPath, '.prune-0123456789abcdef'))
  if (broken) putBrokenRecord(root, 'op-broken')
  fs.symlinkSync(state, path.join(base, 'via-link'))
  return {
    changed: changed.copyPath,
    kept: kept.copyPath,
    paths: [a.copyPath, p.copyPath, path.join(a.areaPath, 'missing'), path.join(base, 'via-link')],
  }
}

/** Every selector in one run, and each alone. */
function runs(p: ReturnType<typeof plant>): Partial<DoctorBackupsOptions>[] {
  return [
    {},
    { olderThan: '0' },
    { keep: '1' },
    { client: 'claude-code' },
    { root: [claudeRoot(base)] },
    { skill: 'a' },
    { op: 'op-1' },
    { path: p.paths },
    { olderThan: '0', includeKept: true, allowChanged: [p.changed, p.kept] },
    {
      olderThan: '0',
      keep: '1',
      client: 'claude-code',
      root: [claudeRoot(base)],
      skill: 'a',
      op: 'op-1',
      path: p.paths,
      includeKept: true,
      allowChanged: [p.changed],
      json: true,
    },
  ]
}

describe('the write spies themselves (known positive and known negative)', () => {
  it('see a write in every form, and do not see a read', async () => {
    installWriteSpies()
    const dir = path.join(base, 'probe')
    fs.mkdirSync(dir)
    fs.mkdir(path.join(dir, 'a'), () => undefined)
    await fs.promises.mkdir(path.join(dir, 'b'))
    fs.writeFileSync(path.join(dir, 'f'), 'x')
    fs.closeSync(fs.openSync(path.join(dir, 'g'), 'w'))
    const seen = seenWrites()
    for (const w of [
      `fs.mkdirSync ${dir}`,
      `fs.mkdir ${path.join(dir, 'a')}`,
      `fs.promises.mkdir ${path.join(dir, 'b')}`,
      `fs.writeFileSync ${path.join(dir, 'f')}`,
      `fs.openSync ${path.join(dir, 'g')}`,
    ]) {
      expect(seen).toContain(w)
    }
    const before = seenWrites().length
    fs.readdirSync(dir)
    fs.readFileSync(path.join(dir, 'f'))
    fs.closeSync(fs.openSync(path.join(dir, 'f'), 'r'))
    expect(seenWrites().length).toBe(before)
  })
})

describe('the write spies reach named ESM imports and the later write families', () => {
  it('see a write made through a named import and through the fs/promises namespace', async () => {
    installWriteSpies()
    const named = path.join(base, 'named')
    const ns = path.join(base, 'ns')
    namedMkdirSync(named)
    await namedPromisesMkdir(ns)
    expect(seenWrites()).toEqual(
      expect.arrayContaining([`fs.mkdirSync ${named}`, `fs.promises.mkdir ${ns}`])
    )
  })

  it('see fchmod, fchown, writev (and lchmod where the platform has it) in every form that exists', async () => {
    const file = path.join(base, 'f')
    fs.writeFileSync(file, 'x')
    const link = path.join(base, 'l')
    fs.symlinkSync(file, link)
    installWriteSpies()
    const fd = fs.openSync(file, 'r+')
    const uid = process.getuid?.() ?? 0
    const gid = process.getgid?.() ?? 0
    fs.fchmodSync(fd, 0o644)
    fs.fchownSync(fd, uid, gid)
    fs.writevSync(fd, [Buffer.from('y')])
    await new Promise<void>((r) => fs.fchmod(fd, 0o644, () => r()))
    await new Promise<void>((r) => fs.fchown(fd, uid, gid, () => r()))
    await new Promise<void>((r) => fs.writev(fd, [Buffer.from('z')], () => r()))
    fs.closeSync(fd)
    const seen = seenWrites().map((w) => w.split(' ')[0])
    for (const label of [
      'fs.fchmodSync',
      'fs.fchownSync',
      'fs.writevSync',
      'fs.fchmod',
      'fs.fchown',
      'fs.writev',
    ]) {
      expect(seen).toContain(label)
    }
    if (typeof fs.lchmodSync === 'function') {
      fs.lchmodSync(link, 0o777)
      expect(seenWrites().map((w) => w.split(' ')[0])).toContain('fs.lchmodSync')
    }
  })
})

describe('control against the product: a write injected into code the dry run runs', () => {
  it('is reported by the spies and changes the fixture, which fails the zero-write assertions', async () => {
    const planted = plant(true)
    const discovery = hermeticDiscovery(base, true)
    const before = snapshot(base)
    const injected = path.join(base, 'injected-by-the-control')
    // The dry run prints its plan with console.log: a write made from there is a write the run makes.
    vi.spyOn(console, 'log').mockImplementation(() => void namedMkdirSync(injected))
    installWriteSpies()
    await runDoctorBackups({ discovery, prune: true, ...runs(planted)[1] })
    expect(seenWrites()).toContain(`fs.mkdirSync ${injected}`)
    expect(snapshot(base)).not.toEqual(before)
  })

  it('a write scheduled to run after the command resolves is also caught', async () => {
    const planted = plant(true)
    const discovery = hermeticDiscovery(base, true)
    const before = snapshot(base)
    const injected = path.join(base, 'injected-after-resolve')
    // Built before the spies: runs() creates fixture roots, which is not the run writing.
    const options = runs(planted)[1]
    vi.spyOn(console, 'log').mockImplementation(
      () => void setTimeout(() => namedMkdirSync(injected, { recursive: true }), 0)
    )
    installWriteSpies()
    await runDoctorBackups({ discovery, prune: true, ...options })
    // Nothing has run yet: the write is still pending when the command resolves.
    expect(seenWrites()).toEqual([])
    await settle()
    expect(seenWrites()).toContain(`fs.mkdirSync ${injected}`)
    expect(snapshot(base)).not.toEqual(before)
  })
})

describe('doctor backups --prune over both stores', () => {
  it('with every selector, no write-family fs call is made and every fixture entry is unchanged', async () => {
    const planted = plant(true)
    const discovery = hermeticDiscovery(base, true)
    const all = runs(planted)
    const before = snapshot(base)
    installWriteSpies()
    for (const o of all) {
      await runDoctorBackups({ discovery, prune: true, ...o })
      expect(seenWrites()).toEqual([])
    }
    await settle()
    expect(seenWrites()).toEqual([])
    expect(snapshot(base)).toEqual(before)
  })

  it('the runs did plan something (a run that selects nothing proves nothing)', async () => {
    const planted = plant(false)
    const discovery = hermeticDiscovery(base, true)
    await runDoctorBackups({
      discovery,
      prune: true,
      json: true,
      olderThan: '0',
      includeKept: true,
    })
    const doc = JSON.parse(out.join('\n')) as PlanDoc
    const items = doc.groups.flatMap((g) => g.items)
    expect(items.length).toBeGreaterThanOrEqual(4)
    expect(new Set(items.map((i) => i.store))).toEqual(new Set(['backup', 'parked']))
    expect(items.map((i) => i.copyPath)).toContain(planted.kept)
    expect(doc.excluded.length).toBeGreaterThan(0)
    expect(doc.preconditions).toEqual([])
    // With an unreadable record, the same run still plans, and says --apply would refuse.
    putBrokenRecord(claudeRoot(base), 'op-broken')
    out = []
    await runDoctorBackups({
      discovery,
      prune: true,
      json: true,
      olderThan: '0',
      includeKept: true,
    })
    expect((JSON.parse(out.join('\n')) as PlanDoc).preconditions.length).toBeGreaterThan(0)
  })
})

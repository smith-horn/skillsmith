/**
 * SMI-6531 (A1 step 6c-ii-a): the governance round-3 reviewer's experiments,
 * kept as tests against the ledger.
 *
 *  (B) an area only the parked index reaches: a readable index lists and warns
 *      for it; an index that cannot be read (EISDIR) or a line that cannot be
 *      parsed still warns, and the ledger names what could not be measured;
 *  (C) a hidden directory holding data in a parked area or an op dir is
 *      measured, so the warning counts its bytes;
 *  (D) `--root` counts the anomaly and the refused area of another root it
 *      hides, and a `--client` narrowing counts an anomaly it hides.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { listBackups } from '../../../src/services/skill-backups.listing.js'
import { makeBackup } from '../../unit/install/prune.list.helpers.js'
import { hermetic, indexLine, mkBase, parkAt } from './skill-backups.helpers.js'

const bases: string[] = []
const base = (): string => {
  const b = mkBase('sbk-r3-')
  bases.push(b)
  return b
}
afterEach(() => {
  vi.restoreAllMocks()
  for (const b of bases.splice(0)) fs.rmSync(b, { recursive: true, force: true })
})

const claude = (b: string): string => path.join(b, 'clients', 'claude-code')
const zeroCap = { statfs: () => ({ bavail: 1e12, bsize: 1 }), capBytes: 0 }
/** Out of reach, so only the "could not be measured" arm can warn. */
const quietCap = { statfs: () => ({ bavail: 1e12, bsize: 1 }), capBytes: 1e12 }

const unmeasuredPaths = (l: Awaited<ReturnType<typeof listBackups>>): string[] =>
  l.accounting.rows.filter((r) => r.disposition.kind === 'unmeasured').map((r) => r.path)

describe('(B) an area only the parked index reaches', () => {
  const plant = (b: string) => {
    const state = path.join(b, '.skillsmith')
    const p = parkAt(path.join(b, 'elsewhere'), 'victim')
    return { state, p, idx: indexLine(state, p.copyPath, 'op-victim') }
  }

  it('control: a readable index lists the copy, and it warns with capBytes 0', async () => {
    const b = base()
    const { state, p } = plant(b)
    const l = await listBackups({ stateRoot: state, discovery: hermetic(b), usage: zeroCap })
    expect(l.parked.flatMap((a) => a.rows).map((r) => r.copy.copyPath)).toEqual([p.copyPath])
    expect(l.warning.warn).toBe(true)
    expect(l.unmeasured).toBe(0)
  })

  it('an index that is a directory (EISDIR) warns, and names the index as unmeasured', async () => {
    const b = base()
    const { state, idx } = plant(b)
    fs.rmSync(idx)
    fs.mkdirSync(idx)
    const l = await listBackups({ stateRoot: state, discovery: hermetic(b), usage: quietCap })
    expect(l.parked.flatMap((a) => a.rows)).toEqual([])
    expect(unmeasuredPaths(l)).toEqual([idx])
    expect(l.warning.warn).toBe(true)
    expect(l.warning.message).toMatch(/1 entry could not be measured/)
  })

  it('a line that cannot be parsed warns, and names the line as unmeasured', async () => {
    const b = base()
    const { state, idx } = plant(b)
    fs.writeFileSync(idx, fs.readFileSync(idx, 'utf8').replace(/"path"/, '"pth"'))
    const l = await listBackups({ stateRoot: state, discovery: hermetic(b), usage: quietCap })
    expect(l.parked.flatMap((a) => a.rows)).toEqual([])
    expect(l.index.facts.rejected).toHaveLength(1)
    expect(unmeasuredPaths(l)).toEqual([`${idx}:1`])
    expect(l.warning.warn).toBe(true)
  })
})

describe('(C) a hidden directory holding data is measured', () => {
  it('1 MB in <area>/.stuff/ warns with capBytes 0 and is in the held bytes', async () => {
    const b = base()
    const area = path.join(claude(b), '.skillsmith-parked')
    fs.mkdirSync(path.join(area, '.stuff'), { recursive: true })
    fs.writeFileSync(path.join(area, '.stuff', 'big'), 'x'.repeat(1_000_000))
    const l = await listBackups({ discovery: hermetic(b), usage: zeroCap })
    expect(l.warning.warn).toBe(true)
    expect(Math.max(...l.warning.perVolume.map((v) => v.heldBytes))).toBeGreaterThanOrEqual(1e6)
    expect(l.warning.message).toContain('.stuff')
  })

  it('1 MB in <area>/op-z/.foo/ warns with capBytes 0 and is in the held bytes', async () => {
    const b = base()
    const op = path.join(claude(b), '.skillsmith-parked', 'op-z')
    fs.mkdirSync(path.join(op, '.foo'), { recursive: true })
    fs.writeFileSync(path.join(op, '.foo', 'big'), 'x'.repeat(1_000_000))
    const l = await listBackups({ discovery: hermetic(b), usage: zeroCap })
    expect(l.warning.warn).toBe(true)
    expect(Math.max(...l.warning.perVolume.map((v) => v.heldBytes))).toBeGreaterThanOrEqual(1e6)
    expect(l.warning.message).toContain('.foo')
  })

  it('control: an empty parked area holds nothing large', async () => {
    const b = base()
    fs.mkdirSync(path.join(claude(b), '.skillsmith-parked'), { recursive: true })
    const l = await listBackups({ discovery: hermetic(b), usage: zeroCap })
    expect(Math.max(...l.warning.perVolume.map((v) => v.heldBytes))).toBeLessThan(1e6)
  })
})

describe('(D) narrowing counts what it hides', () => {
  it('--root claude counts another root anomaly and another root refused area', async () => {
    const b = base()
    const d = hermetic(b)
    parkAt(claude(b), 'mine')
    const cursor = path.join(b, 'clients', 'cursor')
    parkAt(cursor, 'theirs')
    fs.writeFileSync(path.join(cursor, '.skillsmith-parked', '.weird'), 'x')
    const copilotArea = path.join(b, 'clients', 'copilot', '.skillsmith-parked')
    parkAt(path.dirname(copilotArea), 'refused')
    const realL = fs.lstatSync.bind(fs) as (...a: unknown[]) => unknown
    vi.spyOn(fs, 'lstatSync').mockImplementation(((p: unknown, ...rest: unknown[]) => {
      const st = realL(p, ...rest)
      if (p === copilotArea && typeof st === 'object' && st !== null) {
        return Object.defineProperty(Object.create(st), 'uid', { value: 1234n })
      }
      return st
    }) as typeof fs.lstatSync)
    const l = await listBackups({ roots: [claude(b)], discovery: d, usage: zeroCap })
    expect(l.narrowedTo).toEqual([claude(b)])
    // theirs (a copy), and .weird plus the refused copilot area (two other entries).
    expect(l.excludedByRoot).toEqual({
      parkedCopies: 1,
      backupTrees: 0,
      otherEntries: 2,
      olderStores: 0,
    })
    // Computed before narrowing: the refused area still makes the warning say so.
    expect(l.warning.message).toMatch(/1 entry could not be measured/)
  })

  it('--client counts an anomaly in another client backup area', async () => {
    const b = base()
    const state = path.join(b, '.skillsmith')
    makeBackup({ state, skillsDir: claude(b), dirName: 'one', opId: 'op-1' })
    const cur = makeBackup({ state, skillsDir: claude(b), client: 'cursor', opId: 'op-2' })
    fs.writeFileSync(path.join(cur.areaPath, '.hidden'), 'x')
    const l = await listBackups({ stateRoot: state, client: 'claude-code', discovery: hermetic(b) })
    expect(l.excludedByClient).toEqual({ parkedCopies: 0, backupTrees: 1, otherEntries: 1 })
  })
})

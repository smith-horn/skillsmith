/**
 * SMI-6531 (A1 step 6c-ii-a): the ledger's exempt rule, pinned.
 *
 *  - `vanished` needs proof the name is gone: a name that is not valid UTF-8
 *    cannot be addressed as a string, so it is `unmeasured`, never `vanished`;
 *  - an exempt row never covers another path;
 *  - an lstat that fails with EACCES on a stale index-line path is `unmeasured`
 *    and may hide a set-aside copy, so protection reads `unknown`;
 *  - with `--client` and `--root` together, an item both hide is counted once.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { listBackups } from '../../../src/services/skill-backups.listing.js'
import type { BackupsListing } from '../../../src/services/skill-backups.listing.js'
import { makeBackup } from '../../unit/install/prune.list.helpers.js'
import { hermetic, indexLine, mkBase, parkAt } from './skill-backups.helpers.js'

// The legacy scan reads a skills root through `fs/promises` (a namespace import, so not spy-able).
const deny = vi.hoisted(() => ({ dir: null as string | null }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>()
  const readdir = ((p: unknown, ...rest: unknown[]) =>
    p === deny.dir
      ? Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' }))
      : (real.readdir as (...a: unknown[]) => unknown)(p, ...rest)) as typeof real.readdir
  return { ...real, readdir, default: { ...real, readdir } }
})

const bases: string[] = []
afterEach(() => {
  deny.dir = null
  vi.restoreAllMocks()
  for (const b of bases.splice(0)) fs.rmSync(b, { recursive: true, force: true })
})

const base = (prefix: string): string => {
  const b = mkBase(prefix)
  bases.push(b)
  return b
}

const statfs = () => ({ bavail: 1e12, bsize: 1 })
const kindOf = (l: BackupsListing, p: string): string => {
  const r = l.accounting.rows.find((x) => x.path === p)
  if (r === undefined) return 'NO ROW'
  return r.disposition.kind === 'exempt' ? `exempt:${r.disposition.reason}` : r.disposition.kind
}

/** A path as bytes: `dir` + separator + a name that need not be UTF-8. */
const bytesPath = (dir: string, name: Buffer): Buffer =>
  Buffer.concat([Buffer.from(dir + path.sep), name])

const BAD = Buffer.from([...Buffer.from('bad'), 0xff, 0xfe, ...Buffer.from('-0123abcd')])
const GOOD = Buffer.from('bad--0123abcd')
const TWO_MB = Buffer.alloc(2_000_000, 1)

/** A 2 MB tree named `name` directly under `dir` (made through a Buffer path). */
function plantTree(dir: string, name: Buffer): void {
  fs.mkdirSync(dir, { recursive: true })
  const at = bytesPath(dir, name)
  fs.mkdirSync(at)
  fs.writeFileSync(Buffer.concat([at, Buffer.from(path.sep + 'big.bin')]), TWO_MB)
}

type Place = 'parked op dir' | 'backup store level'

async function listWithTree(place: Place, name: Buffer): Promise<BackupsListing> {
  const b = base('sbk-utf8-')
  const h = hermetic(b)
  const claude = path.join(b, 'clients', 'claude-code')
  if (place === 'parked op dir') {
    plantTree(path.join(claude, '.skillsmith-parked', 'op1'), name)
  } else {
    const bk = makeBackup({ state: path.join(b, '.skillsmith'), skillsDir: claude })
    plantTree(bk.updateDir, name)
  }
  // The cap is above the tree's size, so only a row that says "could not look" can make it warn.
  return listBackups({ discovery: h, usage: { capBytes: 10_000_000, statfs } })
}

describe.each<Place>(['parked op dir', 'backup store level'])(
  'a name that is not valid UTF-8, in a %s',
  (place) => {
    it('the ASCII control is measured and the warning stays silent', async () => {
      const l = await listWithTree(place, GOOD)
      expect(l.unmeasured).toBe(0)
      expect(l.warning.warn).toBe(false)
    })

    it('is unmeasured (could not be addressed), never vanished, so the warning fires', async () => {
      const l = await listWithTree(place, BAD)
      const lossy = l.accounting.rows.filter((r) => r.path.includes('�'))
      expect(lossy.length).toBeGreaterThan(0)
      expect(lossy.map((r) => `${r.path} ${kindOf(l, r.path)}`)).toEqual(
        lossy.map((r) => `${r.path} unmeasured`)
      )
      for (const r of lossy) {
        expect(r.disposition.kind === 'unmeasured' && r.disposition.reason).toMatch(
          /not valid UTF-8/
        )
      }
      expect(l.unmeasured).toBeGreaterThan(0)
      expect(l.warning.warn).toBe(true)
    })
  }
)

describe('an exempt row never covers another path', () => {
  it('an unreadable legacy scan of a skills root does not swallow a rejected index line under it', async () => {
    const b = base('sbk-legacy-')
    const h = hermetic(b)
    const root = path.join(b, 'clients', 'claude-code')
    const victim = path.join(root, 'victim')
    fs.mkdirSync(victim, { recursive: true })
    fs.writeFileSync(path.join(victim, 'f'), 'z'.repeat(9000))
    const state = path.join(b, '.skillsmith')
    indexLine(state, victim, 'op')
    // The legacy scan reads the root; make that read fail (the suite may run as root).
    deny.dir = root
    const l = await listBackups({
      stateRoot: state,
      discovery: h,
      usage: { capBytes: 1e9, statfs },
    })
    expect(l.legacy.map((g) => g.unreadable !== null)).toContain(true)
    // The index-named path under that root has a row of its own.
    expect(kindOf(l, victim)).toBe('unmeasured')
    expect(l.warning.warn).toBe(true)
    // The marker is its own row at a synthetic key, not the root's own row.
    expect(kindOf(l, `${root}:legacy-scan`)).toBe('exempt:legacy-leftover')
    expect(kindOf(l, root)).not.toBe('exempt:legacy-leftover')
  })
})

describe('an lstat refused on a stale index-line path', () => {
  async function run(refuse: boolean) {
    const b = base('sbk-stale-')
    const h = hermetic(b)
    const claude = path.join(b, 'clients', 'claude-code')
    const state = path.join(b, '.skillsmith')
    const area = path.dirname(parkAt(claude, 'keep', { opId: 'op-keep' }).opDir)
    makeBackup({ state, skillsDir: claude, opId: 'op-1' })
    const stale = path.join(area, 'op-stale', 'stale-22222222')
    indexLine(state, stale, 'op-stale')
    if (refuse) {
      const real = fs.lstatSync.bind(fs) as (...a: unknown[]) => unknown
      vi.spyOn(fs, 'lstatSync').mockImplementation(((p: unknown, ...rest: unknown[]) => {
        if (p === stale) throw Object.assign(new Error('denied'), { code: 'EACCES' })
        return real(p, ...rest)
      }) as typeof fs.lstatSync)
    }
    const l = await listBackups({ discovery: h, usage: { capBytes: 1e9, statfs } })
    return { l, stale }
  }
  const protections = (l: BackupsListing) =>
    l.backups.flatMap((s) => s.areas.flatMap((a) => a.rows.map((r) => r.protection)))

  it('control: a stale line whose path is gone is absent, and nothing is unknown', async () => {
    const { l, stale } = await run(false)
    expect(kindOf(l, stale)).toBe('exempt:absent')
    expect(protections(l).map((p) => p.status)).toEqual(['unprotected'])
  })

  it('is unmeasured and may hide a set-aside copy, so protection is unknown', async () => {
    const { l, stale } = await run(true)
    const row = l.accounting.rows.find((r) => r.path === stale)
    expect(row?.disposition.kind).toBe('unmeasured')
    expect(row?.mayHideCopies).toBe(true)
    expect(protections(l).map((p) => p.status)).toEqual(['unknown'])
  })
})

describe('--client and --root together', () => {
  it('counts an item both hide once: under --client only', async () => {
    const b = base('sbk-both-')
    const h = hermetic(b)
    const claude = path.join(b, 'clients', 'claude-code')
    const cursor = fs.realpathSync(path.join(b, 'clients', 'cursor'))
    const state = path.join(b, '.skillsmith')
    makeBackup({ state, skillsDir: claude, opId: 'op-shown' })
    makeBackup({ state, skillsDir: cursor, client: 'cursor', opId: 'op-hidden' })
    const l = await listBackups({
      client: 'claude-code',
      roots: [claude],
      discovery: h,
      usage: { capBytes: 1e9, statfs },
    })
    // The cursor tree is hidden by --client (another client) and by --root (another root).
    expect(l.excludedByClient).toEqual({ parkedCopies: 0, backupTrees: 1, otherEntries: 0 })
    expect(l.excludedByRoot).toEqual({
      parkedCopies: 0,
      backupTrees: 0,
      otherEntries: 0,
      olderStores: 0,
    })
  })
})

/**
 * SMI-6531 (A1 step 6c-ii-a): the D-11 classifier over both stores (ADR-166
 * D-11 P2): mounted, held, unverified, changed, clean, first match wins.
 * Rows: T-X14 (a sidecar-less parked copy is held), T-F1's park-sidecar row,
 * T-K1's classification rows, M-M1/M-M2 (the mount table, injected), Q9's
 * fields at the classifier level.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { classifyCopy, rootKeyFor } from '../../../src/install/prune.classify.js'
import { listParkedArea } from '../../../src/install/prune.list.parked.js'
import { listBackupStore } from '../../../src/install/prune.list.backups.js'
import { rootKeyOf } from '../../../src/services/skill-swap.area.js'
import type { ListedCopy } from '../../../src/install/prune.list.types.js'
import { errnoError, park, withFsStub } from './park-tree.helpers.js'
import { makeParent, parkCopy, removeFixture } from './prune.walk.helpers.js'
import type { PruneFixture } from './prune.walk.helpers.js'
import { injectMountinfo, makeBackup, mountinfoLine, tmpRoot } from './prune.list.helpers.js'

const fixtures: PruneFixture[] = []
const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const f of fixtures.splice(0)) removeFixture(f)
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true })
})
const parent = (): PruneFixture => {
  const f = makeParent('prune-cls-')
  fixtures.push(f)
  return f
}
const root = (): string => {
  const r = tmpRoot('prune-cls-')
  roots.push(r)
  return r
}
const onlyParked = (p: string): ListedCopy => {
  const l = listParkedArea(p)
  expect(l.copies).toHaveLength(1)
  return l.copies[0] as ListedCopy
}
const onlyBackup = (updateDir: string): ListedCopy => {
  const l = listBackupStore(updateDir)
  const all = l.areas.flatMap((a) => a.copies)
  expect(all).toHaveLength(1)
  return all[0] as ListedCopy
}
const rewriteSidecar = (p: string, over: Record<string, unknown>): void => {
  const s = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>
  fs.writeFileSync(p, JSON.stringify({ ...s, ...over }))
}

describe('a parked copy', () => {
  it('clean: the tree hashes to what the sidecar recorded, and Q9 fields are carried', () => {
    const f = parent()
    const c = parkCopy(f.parent, 'tree')
    const k = classifyCopy(onlyParked(f.parent), 'parked')
    expect(k.klass).toBe('clean')
    expect(k.reason).toBeNull()
    expect(k.freshHash).toBe(k.recordedHash)
    expect(k.kind).toBe('uninstall')
    expect((k.sidecar as { originPath: string }).originPath).toBe(path.join(f.parent, 'tree'))
    expect(k.rootIdentity).toMatchObject({ fmt: 0o040000n })
    expect(k.sidecarRead?.bytes.equals(fs.readFileSync(c.sidecarPath))).toBe(true)
    expect(k.measured.allocatedBytes).toBeGreaterThan(0)
    expect(k.measured.unmeasured).toBe(0)
  })

  it('changed: a byte added after the park', () => {
    const f = parent()
    const c = parkCopy(f.parent, 'tree')
    fs.writeFileSync(path.join(c.copyPath, 'extra.txt'), 'x')
    const k = classifyCopy(onlyParked(f.parent), 'parked')
    expect(k).toMatchObject({ klass: 'changed', reason: 'hash-differs' })
    expect(k.freshHash).not.toBe(k.recordedHash)
  })

  it('T-X14: a copy with no sidecar is listed and held/sidecar-absent', () => {
    const f = parent()
    const c = parkCopy(f.parent, 'tree')
    fs.unlinkSync(c.sidecarPath)
    const k = classifyCopy(onlyParked(f.parent), 'parked')
    expect(k.klass).toBe('held')
    expect(k.reason).toBe('sidecar-absent')
    expect(k.freshHash).not.toBeNull()
  })

  it('T-F1: ENOSPC after the park rename and before its sidecar leaves the tree whole and held', () => {
    const f = parent()
    fs.mkdirSync(path.join(f.parent, 'tree'))
    fs.writeFileSync(path.join(f.parent, 'tree', 'a.txt'), 'a')
    const r = withFsStub(
      'writeFileSync',
      (orig) =>
        (...args: unknown[]) => {
          if (String(args[0]).endsWith('.json')) throw errnoError('ENOSPC')
          return orig(...args)
        },
      () => park(f.parent, 'tree')
    )
    expect(r.sidecarError).toBe('ENOSPC')
    const k = classifyCopy(onlyParked(f.parent), 'parked')
    expect({ klass: k.klass, reason: k.reason }).toEqual({
      klass: 'held',
      reason: 'sidecar-absent',
    })
  })

  it('a sidecar that says hold:true is held/hold', () => {
    const f = parent()
    const c = parkCopy(f.parent, 'tree')
    rewriteSidecar(c.sidecarPath, { hold: true })
    expect(classifyCopy(onlyParked(f.parent), 'parked')).toMatchObject({
      klass: 'held',
      reason: 'hold',
    })
  })

  it('a sidecar that is not JSON is held/sidecar-unparseable', () => {
    const f = parent()
    const c = parkCopy(f.parent, 'tree')
    fs.writeFileSync(c.sidecarPath, '{not json')
    expect(classifyCopy(onlyParked(f.parent), 'parked')).toMatchObject({
      klass: 'held',
      reason: 'sidecar-unparseable',
    })
  })

  it('a sidecar that fails the schema is unverified/schema-invalid', () => {
    const f = parent()
    const c = parkCopy(f.parent, 'tree')
    fs.writeFileSync(c.sidecarPath, JSON.stringify({ opId: 'x' }))
    expect(classifyCopy(onlyParked(f.parent), 'parked')).toMatchObject({
      klass: 'unverified',
      reason: 'schema-invalid',
    })
  })

  it('a parked kind prune has no policy for is unverified/kind-unknown', () => {
    const f = parent()
    const c = parkCopy(f.parent, 'tree')
    rewriteSidecar(c.sidecarPath, { kind: 'pre-rename' })
    expect(classifyCopy(onlyParked(f.parent), 'parked')).toMatchObject({
      klass: 'unverified',
      reason: 'kind-unknown',
    })
  })

  it('a copy parked without a guard hash is unverified/treehash-null', () => {
    const f = parent()
    fs.mkdirSync(path.join(f.parent, 'tree'))
    fs.writeFileSync(path.join(f.parent, 'tree', 'a.txt'), 'a')
    expect(park(f.parent, 'tree').status).toBe('parked')
    expect(classifyCopy(onlyParked(f.parent), 'parked')).toMatchObject({
      klass: 'unverified',
      reason: 'treehash-null',
    })
  })

  it('a staged copy whose delete stopped is held/interrupted-delete', () => {
    const f = parent()
    parkCopy(f.parent, 'tree')
    const copy = { ...onlyParked(f.parent), interruptedDelete: true }
    expect(classifyCopy(copy, 'parked')).toMatchObject({
      klass: 'held',
      reason: 'interrupted-delete',
    })
  })

  it('a copy that is gone is unverified/tree-unreadable, and the call does not throw', () => {
    const f = parent()
    const c = parkCopy(f.parent, 'tree')
    const copy = onlyParked(f.parent)
    fs.rmSync(c.copyPath, { recursive: true })
    const k = classifyCopy(copy, 'parked')
    expect(k).toMatchObject({ klass: 'unverified', reason: 'tree-unreadable' })
    expect(k.measured.unmeasured).toBe(1)
  })
})

describe('the mount table (M-M1, M-M2)', () => {
  it('control: with the real table, a clean copy is clean', () => {
    const f = parent()
    parkCopy(f.parent, 'tree')
    expect(classifyCopy(onlyParked(f.parent), 'parked').klass).toBe('clean')
  })

  it('M-M2: an unreadable mount table is mounted/mountinfo-unreadable, never clean', () => {
    const f = parent()
    parkCopy(f.parent, 'tree')
    const copy = onlyParked(f.parent)
    injectMountinfo({ throws: 'EACCES' })
    const k = classifyCopy(copy, 'parked')
    expect(k.klass).toBe('mounted')
    expect(k.reason).toBe('mountinfo-unreadable')
    expect(k.detail).toContain('EACCES')
  })

  it('M-M1: a mount point under the copy is mounted, ahead of held (the copy has no sidecar)', () => {
    const f = parent()
    const c = parkCopy(f.parent, 'tree')
    fs.unlinkSync(c.sidecarPath)
    const copy = onlyParked(f.parent)
    injectMountinfo(mountinfoLine(path.join(fs.realpathSync(c.copyPath), 'sub')))
    const k = classifyCopy(copy, 'parked')
    expect(k).toMatchObject({ klass: 'mounted', reason: 'mount-point' })
    expect(k.rootIdentity).not.toBeNull()
  })

  it('the same holds for a backup-area tree', () => {
    const state = root()
    const b = makeBackup({ state, skillsDir: '/skills/a' })
    injectMountinfo(mountinfoLine(b.copyPath))
    expect(classifyCopy(onlyBackup(b.updateDir), 'backup').klass).toBe('mounted')
  })
})

describe('a backup-area tree', () => {
  it('clean, with the sidecar recorded hash', () => {
    const state = root()
    const b = makeBackup({ state, skillsDir: '/skills/a' })
    const k = classifyCopy(onlyBackup(b.updateDir), 'backup')
    expect(k).toMatchObject({ klass: 'clean', reason: null, kind: 'backup' })
    expect(k.recordedHash).toBe(b.sidecar?.treeHash)
  })

  it('changed: a file edited after the backup', () => {
    const state = root()
    const b = makeBackup({ state, skillsDir: '/skills/a' })
    fs.writeFileSync(path.join(b.copyPath, 'SKILL.md'), 'edited')
    expect(classifyCopy(onlyBackup(b.updateDir), 'backup')).toMatchObject({
      klass: 'changed',
      reason: 'hash-differs',
    })
  })

  it('no sidecar is held/sidecar-absent', () => {
    const state = root()
    const b = makeBackup({ state, skillsDir: '/skills/a', noSidecar: true })
    expect(classifyCopy(onlyBackup(b.updateDir), 'backup')).toMatchObject({
      klass: 'held',
      reason: 'sidecar-absent',
    })
  })

  it('T-K1: a planted pre-rename sidecar is unverified (the strict parser is closed to it)', () => {
    const state = root()
    const b = makeBackup({ state, skillsDir: '/skills/a', kind: 'pre-rename' })
    const k = classifyCopy(onlyBackup(b.updateDir), 'backup')
    expect(k.klass).toBe('unverified')
    expect(k.reason).toBe('schema-invalid')
    expect(k.detail).toContain('pre-rename')
  })

  it('T-K1: a cursor sidecar inside the claude-code area is unverified/area-mismatch', () => {
    const state = root()
    const b = makeBackup({
      state,
      skillsDir: '/skills/a',
      client: 'cursor',
      areaClient: 'claude-code',
      areaRootKey: rootKeyFor('/skills/a'),
    })
    const k = classifyCopy(onlyBackup(b.updateDir), 'backup')
    expect(k.klass).toBe('unverified')
    expect(k.reason).toBe('area-mismatch')
    expect(k.detail).toContain('"cursor"')
  })

  it('a sidecar whose skills root is not the area root key is unverified/area-mismatch', () => {
    const state = root()
    const b = makeBackup({
      state,
      skillsDir: '/skills/a',
      areaRootKey: rootKeyFor('/skills/other'),
    })
    expect(classifyCopy(onlyBackup(b.updateDir), 'backup')).toMatchObject({
      klass: 'unverified',
      reason: 'area-mismatch',
    })
  })

  it('a kept tree that could not be hashed is unverified/treehash-null (UD68)', () => {
    const state = root()
    const b = makeBackup({
      state,
      skillsDir: '/skills/a',
      kind: 'failed-build',
      sidecar: { treeHash: null, treeHashError: 'guard-unreadable at x' },
    })
    expect(classifyCopy(onlyBackup(b.updateDir), 'backup')).toMatchObject({
      klass: 'unverified',
      reason: 'treehash-null',
    })
  })

  it('two clients sit in separate areas, each restore root carried by its sidecar', () => {
    const state = root()
    const a = makeBackup({ state, skillsDir: '/skills/a', client: 'claude-code', opId: 'op-a' })
    const c = makeBackup({ state, skillsDir: '/skills/c', client: 'cursor', opId: 'op-c' })
    expect(path.dirname(a.areaPath)).not.toBe(path.dirname(c.areaPath))
    const l = listBackupStore(a.updateDir)
    const got = l.areas.map((area) => {
      const k = classifyCopy(area.copies[0] as ListedCopy, 'backup')
      return [area.client, k.klass, (k.sidecar as { skillsDir: string }).skillsDir]
    })
    expect(got.sort()).toEqual([
      ['claude-code', 'clean', '/skills/a'],
      ['cursor', 'clean', '/skills/c'],
    ])
  })
})

describe('the root key', () => {
  it('rootKeyFor equals the services rootKeyOf, which names the area', () => {
    for (const r of ['/a', '/Users/x/.claude/skills', '/tmp/s p/ace']) {
      expect(rootKeyFor(r)).toBe(rootKeyOf(r))
    }
  })
})

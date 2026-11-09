/**
 * SMI-6531 (A1 step 6c-i): the stable read and the strict sidecar schema
 * (ADR-166 D-10 item 4: a sidecar that fails a strict schema check counts as
 * unverified, never clean), for both stores prune deletes from: a parked copy
 * (`park-tree.postmove.ts`, recorded hash `postMoveTreeHash`) and a backup-area
 * tree (`skill-swap.sidecar.ts`, recorded hash `treeHash`). Ported from the
 * SMI-6676 spike's `harness/test-w5-sidecar.mjs`, with the backup store added.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parkTree, computePathTreeHash } from '../../../src/install/park-tree.js'
import { parseSidecarStrict, readStable } from '../../../src/install/prune.sidecar.js'
import type { Sidecar } from '../../../src/services/skill-swap.sidecar.js'
import { CALLER, CLIENT, KIND, populate } from './park-tree.helpers.js'
import { makeParent, parkCopy, removeFixture } from './prune.walk.helpers.js'
import type { PruneFixture } from './prune.walk.helpers.js'

let f: PruneFixture | null = null
afterEach(() => {
  if (f !== null) removeFixture(f)
  f = null
})

const H1 = 'a'.repeat(64)
const H2 = 'b'.repeat(64)

describe('readStable', () => {
  it('returns the bytes and the inode it read them from', () => {
    f = makeParent('prune-rs-')
    const p = path.join(f.root, 'x')
    fs.writeFileSync(p, 'hello')
    const r = readStable(p)
    expect(r.ok && r.bytes.toString()).toBe('hello')
    expect(r.ok && r.ino).toBe(fs.lstatSync(p, { bigint: true }).ino)
  })

  it('a write during the read is reported, never returned as data', () => {
    f = makeParent('prune-rs-')
    const p = path.join(f.root, 'x')
    fs.writeFileSync(p, 'hello')
    const grown = readStable(p, { afterRead: () => fs.appendFileSync(p, '!') })
    expect(grown).toEqual({ ok: false, reason: 'changed-while-reading', errno: null })
  })

  it('a same-size change is seen by its timestamps', () => {
    // A same-size write inside one timestamp tick is invisible (ADR-166 D-11's
    // open-descriptor residual), so the change here moves mtime explicitly.
    f = makeParent('prune-rs-')
    const p = path.join(f.root, 'x')
    fs.writeFileSync(p, 'hello')
    const r = readStable(p, {
      afterRead: () => {
        fs.writeFileSync(p, 'HELLO')
        fs.utimesSync(p, new Date(0), new Date(0))
      },
    })
    expect(r).toEqual({ ok: false, reason: 'changed-while-reading', errno: null })
  })

  it('a symlink is not read through, and a missing file is unreadable', () => {
    f = makeParent('prune-rs-')
    fs.writeFileSync(path.join(f.root, 'target'), 'secret')
    fs.symlinkSync(path.join(f.root, 'target'), path.join(f.root, 'link'))
    expect(readStable(path.join(f.root, 'link'))).toEqual({
      ok: false,
      reason: 'not-a-file',
      errno: null,
    })
    expect(readStable(path.join(f.root, 'gone'))).toMatchObject({ ok: false, reason: 'unreadable' })
  })
})

describe('parked store: the shapes the real park writes', () => {
  const parse = (bytes: Buffer, copyPath: string) =>
    parseSidecarStrict(bytes, {
      copyPath,
      parentName: path.basename(path.dirname(copyPath)),
      store: 'parked',
    })

  it('Q (guarded, verified after the move) parses, recording postMoveTreeHash', () => {
    f = makeParent('prune-sc-')
    const c = parkCopy(f.parent, 'tree')
    const r = parse(fs.readFileSync(c.sidecarPath), c.copyPath)
    expect(r.ok && [r.store, r.shape]).toEqual(['parked', 'Q'])
    const s = JSON.parse(fs.readFileSync(c.sidecarPath, 'utf8')) as Record<string, unknown>
    expect(r.ok && r.recordedHash).toBe(s.postMoveTreeHash)
  })

  it('U (parked without a guard hash) parses with no recorded hash', () => {
    f = makeParent('prune-sc-')
    populate(path.join(f.parent, 'tree'))
    const p = parkTree(f.parent, 'tree', { client: CLIENT, caller: CALLER, kind: KIND })
    expect(p.status).toBe('parked')
    const r = parse(fs.readFileSync(String(p.sidecarPath)), String(p.path))
    expect(r.ok && [r.shape, r.recordedHash]).toEqual(['U', null])
  })

  it('H (held) parses, and a held sidecar with an unknown reason does not', () => {
    f = makeParent('prune-sc-')
    const c = parkCopy(f.parent, 'tree')
    const s = JSON.parse(fs.readFileSync(c.sidecarPath, 'utf8')) as Record<string, unknown>
    const { postMoveVerified: _v, ...rest } = s
    void _v
    const held = {
      ...rest,
      hold: true,
      reason: 'changed-during-move',
      heldPath: c.copyPath,
      guardHash: s.treeHash,
      postMoveTreeHash: null,
    }
    const r = parse(Buffer.from(JSON.stringify(held)), c.copyPath)
    expect(r.ok && [r.shape, r.recordedHash]).toEqual(['H', null])
    const bad = parse(Buffer.from(JSON.stringify({ ...held, reason: 'whim' })), c.copyPath)
    expect(bad).toMatchObject({ ok: false, reason: 'schema-invalid' })
  })

  it('bytes null with bytesError (an uncountable tree) parses; bytesError beside a count does not', () => {
    f = makeParent('prune-sc-')
    const c = parkCopy(f.parent, 'tree')
    const s = JSON.parse(fs.readFileSync(c.sidecarPath, 'utf8')) as Record<string, unknown>
    const ok = parse(
      Buffer.from(JSON.stringify({ ...s, bytes: null, bytesError: 'EACCES' })),
      c.copyPath
    )
    expect(ok.ok && ok.shape).toBe('Q')
    const no = parse(Buffer.from(JSON.stringify({ ...s, bytesError: 'EACCES' })), c.copyPath)
    expect(no).toMatchObject({ ok: false, reason: 'schema-invalid' })
  })

  for (const [label, edit] of [
    ['an extra key', (s: Record<string, unknown>) => ({ ...s, extra: 1 })],
    ['a missing createdAt', ({ createdAt: _c, ...s }: Record<string, unknown>) => s],
    ['another opId', (s: Record<string, unknown>) => ({ ...s, opId: 'op-other' })],
    ['negative bytes', (s: Record<string, unknown>) => ({ ...s, bytes: -1 })],
    [
      'a postMoveTreeHash differing from treeHash',
      (s: Record<string, unknown>) => ({ ...s, postMoveTreeHash: H2 }),
    ],
    ['a relative originPath', (s: Record<string, unknown>) => ({ ...s, originPath: 'tree' })],
    [
      'an originPath naming another tree',
      (s: Record<string, unknown>) => ({ ...s, originPath: '/x/other' }),
    ],
    [
      'a non-round-tripping createdAt',
      (s: Record<string, unknown>) => ({ ...s, createdAt: '2026-11-04' }),
    ],
  ] as const) {
    it(`schema-invalid: ${label}`, () => {
      f = makeParent('prune-sc-')
      const c = parkCopy(f.parent, 'tree')
      const s = JSON.parse(fs.readFileSync(c.sidecarPath, 'utf8')) as Record<string, unknown>
      expect(parse(fs.readFileSync(c.sidecarPath), c.copyPath).ok).toBe(true)
      const r = parse(Buffer.from(JSON.stringify(edit(s))), c.copyPath)
      expect(r).toMatchObject({ ok: false, reason: 'schema-invalid' })
    })
  }

  it('not JSON is unparseable; a backup sidecar in a parked area is schema-invalid', () => {
    expect(
      parseSidecarStrict(Buffer.from('{'), {
        copyPath: '/a/b-00000000',
        parentName: 'b',
        store: 'parked',
      })
    ).toMatchObject({ ok: false, reason: 'unparseable' })
    const r = parseSidecarStrict(Buffer.from(JSON.stringify(backup())), {
      copyPath: '/area/foo/op1',
      parentName: 'op1',
      store: 'parked',
    })
    expect(r).toMatchObject({ ok: false, reason: 'schema-invalid' })
  })

  it('premise: the hash the park recorded is the tree hash of the parked copy', () => {
    f = makeParent('prune-sc-')
    const c = parkCopy(f.parent, 'tree')
    const r = parse(fs.readFileSync(c.sidecarPath), c.copyPath)
    const h = computePathTreeHash(c.copyPath)
    expect(h.ok && r.ok && h.treeHash === r.recordedHash).toBe(true)
  })
})

/** A backup-area sidecar, typed by the store's own `Sidecar`. */
function backup(over: Partial<Sidecar> = {}): Sidecar {
  return {
    opId: 'op1',
    kind: 'backup',
    dirName: 'foo',
    createdAt: '2026-11-04T01:02:03.004Z',
    treeHash: H1,
    identity: { dev: '1', ino: '2', birthtimeNs: '3', fmt: '16384' },
    client: 'claude-code',
    skillsDir: '/home/u/.claude/skills',
    scope: 'global',
    manifestKey: 'foo',
    ...over,
  }
}

describe('backup store: the Sidecar the update writes', () => {
  const parse = (s: unknown, name = 'op1', parentName = 'foo') =>
    parseSidecarStrict(Buffer.from(JSON.stringify(s)), {
      copyPath: path.join('/state/backups/update/claude-code/rk', parentName, name),
      parentName,
      store: 'backup',
    })

  it('a backup parses, recording treeHash', () => {
    const r = parse(backup())
    expect(r.ok && [r.store, r.shape, r.recordedHash]).toEqual(['backup', 'B', H1])
  })

  it('a kept kind is named <opId>.<kind>[.<k>]', () => {
    expect(parse(backup({ kind: 'undone' }), 'op1.undone').ok).toBe(true)
    expect(parse(backup({ kind: 'undone' }), 'op1.undone.2').ok).toBe(true)
    expect(parse(backup({ kind: 'undone' }), 'op1').ok).toBe(false)
    expect(parse(backup({ kind: 'undone' }), 'op1.conflict').ok).toBe(false)
    expect(parse(backup(), 'op1.backup').ok).toBe(false)
  })

  it('a partial-copy with sourceUnchanged and partialCause parses; elsewhere they are refused', () => {
    const pc = backup({ kind: 'partial-copy', sourceUnchanged: true, partialCause: 'enospc' })
    expect(parse(pc, 'op1.partial-copy').ok).toBe(true)
    expect(parse(backup({ sourceUnchanged: true })).ok).toBe(false)
    expect(parse({ ...pc, partialCause: 'gremlins' }, 'op1.partial-copy').ok).toBe(false)
  })

  it('an unhashable tree records treeHash null (no recorded hash) with treeHashError', () => {
    const r = parse(
      backup({ kind: 'failed-build', treeHash: null, treeHashError: 'x at y' }),
      'op1.failed-build'
    )
    expect(r.ok && r.recordedHash).toBeNull()
    expect(parse(backup({ treeHashError: 'x' })).ok).toBe(false)
  })

  it('opDirIdentity only on an abandoned-* tree', () => {
    const id = { dev: '1', ino: '2', birthtimeNs: '3', fmt: '16384' }
    expect(
      parse(backup({ kind: 'abandoned-old', opDirIdentity: id }), 'op1.abandoned-old').ok
    ).toBe(true)
    expect(parse(backup({ opDirIdentity: id })).ok).toBe(false)
  })

  for (const [label, s] of [
    ['an unknown kind', { ...backup(), kind: 'mystery' }],
    ['an extra key', { ...backup(), extra: true }],
    ['a missing identity', (({ identity: _i, ...s }) => s)(backup())],
    [
      'a malformed identity',
      { ...backup(), identity: { dev: '1', ino: 'x', birthtimeNs: '3', fmt: '4' } },
    ],
    ['another dirName', { ...backup(), dirName: 'bar' }],
    ['a relative skillsDir', { ...backup(), skillsDir: 'skills' }],
    ['a malformed treeHash', { ...backup(), treeHash: 'abc' }],
    ['an opId with a leading dot', { ...backup(), opId: '.prune-0000000000000000' }],
  ] as const) {
    it(`schema-invalid: ${label}`, () => {
      const name = (s as { opId?: string }).opId ?? 'op1'
      expect(parse(s, typeof name === 'string' ? name : 'op1')).toMatchObject({
        ok: false,
        reason: 'schema-invalid',
      })
    })
  }

  it('a parked sidecar in the backup area is schema-invalid', () => {
    f = makeParent('prune-sc-')
    const c = parkCopy(f.parent, 'tree')
    const r = parseSidecarStrict(fs.readFileSync(c.sidecarPath), {
      copyPath: c.copyPath,
      parentName: path.basename(c.opDir),
      store: 'backup',
    })
    expect(r).toMatchObject({ ok: false, reason: 'schema-invalid' })
  })
})

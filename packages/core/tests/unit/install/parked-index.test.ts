/**
 * SMI-6531: the parked index (A1 plan §3.5), ported from the index cases of
 * the SMI-6676 spike's `harness/test-w5-index.mjs`. Its Q8a (`index: missing`
 * in a listing), Q9 (the trash report) and Q10 (the .gitignore suggestion)
 * exercise prune and listing code that is not part of this port.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  appendParkedIndex,
  compactParkedIndex,
  readParkedIndex,
} from '../../../src/install/parked-index.js'
import { CLIENT, cleanup, guardOf, park, simpleFixture, withFsStub } from './park-tree.helpers.js'

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) cleanup(r)
})
const fixture = () => {
  const f = simpleFixture('park-idx-')
  roots.push(f.root)
  return f
}
const addTree = (parent: string, name: string) => {
  fs.mkdirSync(path.join(parent, name), { recursive: true })
  fs.writeFileSync(path.join(parent, name, 'f.txt'), name)
}

describe('the park appends one index line', () => {
  it('one park, one line, naming the parked path, the opId, the caller and the kind', () => {
    const f = fixture()
    const indexPath = path.join(f.root, 'parked-index.jsonl')
    const r = park(f.parent, 'tree', { indexPath, kind: 'uninstall', guardHash: guardOf(f.origin) })
    const idx = readParkedIndex(indexPath)
    expect(idx.present).toBe(true)
    expect(idx.entries).toHaveLength(1)
    expect(idx.entries[0]?.path).toBe(r.path)
    expect(idx.entries[0]?.opId).toBe(r.opId)
    expect(idx.entries[0]?.client).toBe(CLIENT)
    expect(idx.entries[0]?.kind).toBe('uninstall')
    expect(idx.entries[0]?.bytes).toBe(9)
  })

  it('an unwritable index leaves the status parked and is reported as indexError', () => {
    const f = fixture()
    const r = park(f.parent, 'tree', {
      guardHash: guardOf(f.origin),
      indexPath: path.join(f.root, 'no-such-dir', 'idx.jsonl'),
    })
    expect(r.status).toBe('parked')
    expect(r.indexError).toBe('ENOENT')
  })

  it('no indexPath, no index line and no indexError key', () => {
    const f = fixture()
    const r = park(f.parent, 'tree')
    expect(r.status).toBe('parked')
    expect('indexError' in r).toBe(false)
  })
})

describe('reading and compacting the index (spike Q8b)', () => {
  it('a stale line is not an error, and compaction drops it and keeps the rest', () => {
    const f = fixture()
    const indexPath = path.join(f.root, 'parked-index.jsonl')
    addTree(f.parent, 'a')
    addTree(f.parent, 'b')
    const a = park(f.parent, 'a', { indexPath })
    const b = park(f.parent, 'b', { indexPath })
    fs.rmSync(String(b.path), { recursive: true })
    const before = readParkedIndex(indexPath)
    expect(before.entries).toHaveLength(2)
    expect(before.errors).toEqual([])
    expect(compactParkedIndex(indexPath)).toEqual({ kept: 1, dropped: 1 })
    const after = readParkedIndex(indexPath)
    expect(after.entries.map((e) => e.path)).toEqual([a.path])
    appendParkedIndex(indexPath, { opId: 'op-x', path: '/abs/x', client: 'c', kind: 'k', bytes: 1 })
    expect(readParkedIndex(indexPath).entries).toHaveLength(2)
  })

  it('an absent index is not an error; a malformed line is reported by number, not thrown', () => {
    const f = fixture()
    const indexPath = path.join(f.root, 'parked-index.jsonl')
    expect(readParkedIndex(indexPath)).toEqual({ present: false, entries: [], errors: [] })
    expect(compactParkedIndex(indexPath)).toEqual({ kept: 0, dropped: 0 })
    fs.writeFileSync(indexPath, '{"path":"/abs/ok"}\nnot json\n{"nopath":1}\n')
    const idx = readParkedIndex(indexPath)
    expect(idx.entries.map((e) => e.path)).toEqual(['/abs/ok'])
    expect(idx.errors.map((e) => e.line)).toEqual([2, 3])
  })

  it('a relative path is refused before anything is written', () => {
    const f = fixture()
    const indexPath = path.join(f.root, 'parked-index.jsonl')
    expect(() => appendParkedIndex(indexPath, { path: 'relative/x' })).toThrow(TypeError)
    expect(fs.existsSync(indexPath)).toBe(false)
  })

  it('a short write throws and still closes the descriptor it opened', () => {
    const f = fixture()
    const indexPath = path.join(f.root, 'parked-index.jsonl')
    const opened: number[] = []
    const closed: number[] = []
    expect(() =>
      withFsStub(
        'openSync',
        (orig) =>
          (...args: unknown[]) => {
            const fd = orig(...args) as number
            opened.push(fd)
            return fd
          },
        () =>
          withFsStub(
            'closeSync',
            (orig) =>
              (...args: unknown[]) => {
                closed.push(args[0] as number)
                return orig(...args)
              },
            () =>
              withFsStub(
                'writeSync',
                () => () => 1,
                () => appendParkedIndex(indexPath, { path: '/abs/x' })
              )
          )
      )
    ).toThrow(/short write/)
    expect(opened).toHaveLength(1)
    expect(closed).toEqual(opened)
  })
})

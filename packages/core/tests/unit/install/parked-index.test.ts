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
import {
  CLIENT,
  cleanup,
  errnoError,
  guardOf,
  parkIndexed,
  simpleFixture,
  withFsStub,
} from './park-tree.helpers.js'

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) cleanup(r)
})
const fixture = () => {
  const f = simpleFixture('park-idx-')
  roots.push(f.root)
  return f
}
/** readParkedIndex, asserting the read succeeded. */
const readOk = (indexPath: string) => {
  const r = readParkedIndex(indexPath)
  if (!r.ok) throw new Error(`index read failed: ${r.errno}`)
  return r
}
const addTree = (parent: string, name: string) => {
  fs.mkdirSync(path.join(parent, name), { recursive: true })
  fs.writeFileSync(path.join(parent, name, 'f.txt'), name)
}

describe('the park appends one index line', () => {
  it('one park, one line, naming the parked path, the opId, the caller and the kind', async () => {
    const f = fixture()
    const indexPath = path.join(f.root, 'parked-index.jsonl')
    const r = await parkIndexed(f.parent, 'tree', {
      indexPath,
      kind: 'uninstall',
      guardHash: guardOf(f.origin),
    })
    const idx = readOk(indexPath)
    expect(idx.present).toBe(true)
    expect(idx.entries).toHaveLength(1)
    expect(idx.entries[0]?.path).toBe(r.path)
    expect(idx.entries[0]?.opId).toBe(r.opId)
    expect(idx.entries[0]?.client).toBe(CLIENT)
    expect(idx.entries[0]?.kind).toBe('uninstall')
    expect(idx.entries[0]?.bytes).toBe(9)
  })

  it('an unwritable index leaves the status parked and is reported as indexError', async () => {
    const f = fixture()
    const r = await parkIndexed(f.parent, 'tree', {
      guardHash: guardOf(f.origin),
      indexPath: path.join(f.root, 'no-such-dir', 'idx.jsonl'),
    })
    expect(r.status).toBe('parked')
    expect(r.indexError).toBe('ENOENT')
  })

  it('no indexPath, no index line and no indexError key', async () => {
    const f = fixture()
    const r = await parkIndexed(f.parent, 'tree')
    expect(r.status).toBe('parked')
    expect('indexError' in r).toBe(false)
  })
})

describe('reading and compacting the index (spike Q8b)', () => {
  it('a stale line is not an error, and compaction drops it and keeps the rest', async () => {
    const f = fixture()
    const indexPath = path.join(f.root, 'parked-index.jsonl')
    addTree(f.parent, 'a')
    addTree(f.parent, 'b')
    const a = await parkIndexed(f.parent, 'a', { indexPath })
    const b = await parkIndexed(f.parent, 'b', { indexPath })
    fs.rmSync(String(b.path), { recursive: true })
    const before = readOk(indexPath)
    expect(before.entries).toHaveLength(2)
    expect(before.errors).toEqual([])
    expect(compactParkedIndex(indexPath)).toEqual({
      ok: true,
      kept: 1,
      dropped: 1,
      keptMalformed: 0,
    })
    const after = readOk(indexPath)
    expect(after.entries.map((e) => e.path)).toEqual([a.path])
    appendParkedIndex(indexPath, { opId: 'op-x', path: '/abs/x', client: 'c', kind: 'k', bytes: 1 })
    expect(readOk(indexPath).entries).toHaveLength(2)
  })

  it('an absent index is not an error; a malformed line is reported by number, not thrown', () => {
    const f = fixture()
    const indexPath = path.join(f.root, 'parked-index.jsonl')
    expect(readParkedIndex(indexPath)).toEqual({
      ok: true,
      present: false,
      entries: [],
      lines: [],
      errors: [],
    })
    expect(compactParkedIndex(indexPath)).toEqual({
      ok: true,
      kept: 0,
      dropped: 0,
      keptMalformed: 0,
    })
    fs.writeFileSync(indexPath, '{"path":"/abs/ok"}\nnot json\n{"nopath":1}\n')
    const idx = readOk(indexPath)
    expect(idx.entries.map((e) => e.path)).toEqual(['/abs/ok'])
    expect(idx.errors.map((e) => e.line)).toEqual([2, 3])
  })

  it('a read failure other than ENOENT is reported, and compaction leaves the index bytes unchanged', async () => {
    const f = fixture()
    const indexPath = path.join(f.root, 'parked-index.jsonl')
    addTree(f.parent, 'a')
    addTree(f.parent, 'b')
    await parkIndexed(f.parent, 'a', { indexPath })
    await parkIndexed(f.parent, 'b', { indexPath })
    const before = fs.readFileSync(indexPath)
    const emfile =
      (orig: (...a: unknown[]) => unknown) =>
      (...args: unknown[]) => {
        if (args[0] === indexPath) throw errnoError('EMFILE')
        return orig(...args)
      }
    expect(withFsStub('readFileSync', emfile, () => readParkedIndex(indexPath))).toEqual({
      ok: false,
      present: true,
      errno: 'EMFILE',
    })
    expect(withFsStub('readFileSync', emfile, () => compactParkedIndex(indexPath))).toEqual({
      ok: false,
      errno: 'EMFILE',
    })
    expect(fs.readFileSync(indexPath).equals(before)).toBe(true)
    expect(readOk(indexPath).entries).toHaveLength(2)
  })

  it('compaction keeps malformed and invalid lines verbatim and counts them', () => {
    const f = fixture()
    const indexPath = path.join(f.root, 'parked-index.jsonl')
    const stale = JSON.stringify({ path: path.join(f.root, 'gone') })
    fs.writeFileSync(indexPath, `not json\n${stale}\n[1,2]\n{"path":"rel/x"}\n`)
    expect(compactParkedIndex(indexPath)).toEqual({
      ok: true,
      kept: 0,
      dropped: 1,
      keptMalformed: 3,
    })
    expect(fs.readFileSync(indexPath, 'utf8')).toBe('not json\n[1,2]\n{"path":"rel/x"}\n')
  })

  it('an interior empty line is kept verbatim as malformed; only the final newline is not a line', () => {
    const f = fixture()
    const indexPath = path.join(f.root, 'parked-index.jsonl')
    const text = `${JSON.stringify({ path: f.root })}\n\nnot json\n`
    fs.writeFileSync(indexPath, text)
    const idx = readOk(indexPath)
    expect(idx.errors.map((e) => e.line)).toEqual([2, 3])
    expect(compactParkedIndex(indexPath)).toEqual({
      ok: true,
      kept: 1,
      dropped: 0,
      keptMalformed: 2,
    })
    expect(fs.readFileSync(indexPath, 'utf8')).toBe(text)
  })

  it('an lstat error other than ENOENT/ENOTDIR keeps the entry', async () => {
    const f = fixture()
    const indexPath = path.join(f.root, 'parked-index.jsonl')
    const r = await parkIndexed(f.parent, 'tree', { indexPath })
    const before = fs.readFileSync(indexPath, 'utf8')
    const result = withFsStub(
      'lstatSync',
      (orig) =>
        (...args: unknown[]) => {
          if (args[0] === r.path) throw errnoError('EACCES')
          return orig(...args)
        },
      () => compactParkedIndex(indexPath)
    )
    expect(result).toEqual({ ok: true, kept: 1, dropped: 0, keptMalformed: 0 })
    expect(fs.readFileSync(indexPath, 'utf8')).toBe(before)
  })

  it('an entry with a relative path is kept and never lstat-ed (it would resolve against the cwd)', () => {
    const f = fixture()
    const indexPath = path.join(f.root, 'parked-index.jsonl')
    fs.writeFileSync(indexPath, '{"path":"rel/x"}\n')
    const lstats: string[] = []
    const result = withFsStub(
      'lstatSync',
      (orig) =>
        (...args: unknown[]) => {
          lstats.push(String(args[0]))
          return orig(...args)
        },
      () => compactParkedIndex(indexPath)
    )
    expect(lstats.filter((p) => p.includes('rel/x'))).toEqual([])
    expect(result).toEqual({ ok: true, kept: 0, dropped: 0, keptMalformed: 1 })
    expect(fs.readFileSync(indexPath, 'utf8')).toBe('{"path":"rel/x"}\n')
  })

  it('a line with an absolute path but a non-string opId is invalid and kept verbatim', () => {
    const f = fixture()
    const indexPath = path.join(f.root, 'parked-index.jsonl')
    const bad = JSON.stringify({ path: path.join(f.root, 'gone'), opId: 7 })
    fs.writeFileSync(indexPath, `${bad}\n`)
    const idx = readOk(indexPath)
    expect(idx.entries).toEqual([])
    expect(idx.errors).toEqual([{ line: 1, error: 'opId is not a string or null' }])
    expect(compactParkedIndex(indexPath)).toEqual({
      ok: true,
      kept: 0,
      dropped: 0,
      keptMalformed: 1,
    })
    expect(fs.readFileSync(indexPath, 'utf8')).toBe(`${bad}\n`)
  })

  for (const [label, bytesJson] of [
    ['a string', '"12"'],
    ['a non-finite number', '1e999'],
  ] as const) {
    it(`a line whose bytes is ${label} is invalid and kept verbatim`, () => {
      const f = fixture()
      const indexPath = path.join(f.root, 'parked-index.jsonl')
      const line = `{"path":${JSON.stringify(f.origin)},"bytes":${bytesJson}}`
      fs.writeFileSync(indexPath, `${line}\n`)
      const idx = readOk(indexPath)
      expect(idx.entries).toEqual([])
      expect(idx.errors).toEqual([{ line: 1, error: 'bytes is not a finite number or null' }])
      expect(compactParkedIndex(indexPath)).toEqual({
        ok: true,
        kept: 0,
        dropped: 0,
        keptMalformed: 1,
      })
      expect(fs.readFileSync(indexPath, 'utf8')).toBe(`${line}\n`)
    })
  }

  it('an entry under a regular file (lstat ENOTDIR) is dropped as gone', () => {
    const f = fixture()
    const indexPath = path.join(f.root, 'parked-index.jsonl')
    const file = path.join(f.root, 'a-file')
    fs.writeFileSync(file, 'x')
    const keepLine = JSON.stringify({ path: f.origin })
    fs.writeFileSync(
      indexPath,
      `${JSON.stringify({ path: path.join(file, 'child') })}\n${keepLine}\n`
    )
    expect(compactParkedIndex(indexPath)).toEqual({
      ok: true,
      kept: 1,
      dropped: 1,
      keptMalformed: 0,
    })
    expect(fs.readFileSync(indexPath, 'utf8')).toBe(`${keepLine}\n`)
  })

  it('a failed temp write (ENOSPC) returns the error with the temp path, and the index is unchanged', async () => {
    const f = fixture()
    const indexPath = path.join(f.root, 'parked-index.jsonl')
    await parkIndexed(f.parent, 'tree', { indexPath })
    const before = fs.readFileSync(indexPath)
    const r = withFsStub(
      'writeFileSync',
      (orig) =>
        (...args: unknown[]) => {
          if (String(args[0]).startsWith(`${indexPath}.tmp-`)) throw errnoError('ENOSPC')
          return orig(...args)
        },
      () => compactParkedIndex(indexPath)
    )
    expect(r.ok).toBe(false)
    expect(r.ok ? null : r.errno).toBe('ENOSPC')
    expect(r.ok ? null : r.tmpPath?.startsWith(`${indexPath}.tmp-`)).toBe(true)
    expect(fs.readFileSync(indexPath).equals(before)).toBe(true)
  })

  it('a temp name already taken (EEXIST) returns the error with no temp path: nothing of ours is there', async () => {
    const f = fixture()
    const indexPath = path.join(f.root, 'parked-index.jsonl')
    await parkIndexed(f.parent, 'tree', { indexPath })
    const before = fs.readFileSync(indexPath)
    const r = withFsStub(
      'writeFileSync',
      (orig) =>
        (...args: unknown[]) => {
          if (String(args[0]).startsWith(`${indexPath}.tmp-`)) throw errnoError('EEXIST')
          return orig(...args)
        },
      () => compactParkedIndex(indexPath)
    )
    expect(r).toEqual({ ok: false, errno: 'EEXIST' })
    expect(fs.readFileSync(indexPath).equals(before)).toBe(true)
  })

  for (const code of ['EXDEV', 'EACCES']) {
    it(`a failed rename (${code}) returns the error and the temp path left, and the index is unchanged`, async () => {
      const f = fixture()
      const indexPath = path.join(f.root, 'parked-index.jsonl')
      await parkIndexed(f.parent, 'tree', { indexPath })
      const before = fs.readFileSync(indexPath)
      const r = withFsStub(
        'renameSync',
        (orig) =>
          (...args: unknown[]) => {
            if (args[1] === indexPath) throw errnoError(code)
            return orig(...args)
          },
        () => compactParkedIndex(indexPath)
      )
      expect(r.ok).toBe(false)
      expect(r.ok ? null : r.errno).toBe(code)
      const tmp = r.ok ? '' : String(r.tmpPath)
      expect(tmp.startsWith(`${indexPath}.tmp-`)).toBe(true)
      expect(fs.existsSync(tmp)).toBe(true)
      expect(fs.readFileSync(indexPath).equals(before)).toBe(true)
    })
  }

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

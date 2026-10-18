/**
 * SMI-6531: the guard behaves as a guard, the tree hash is one function, the
 * sidecar records what was verified, and every root type parks the same way
 * (UD30). The guard cases are the park half of the SMI-6676 spike's
 * `harness/test-guard-hash-parity.mjs` (T1, T2, T4, T4b); its native-vs-path
 * comparison (T3) has no product counterpart.
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { computePathTreeHash } from '../../../src/install/park-tree.js'
import {
  CLIENT,
  PARKED,
  cleanup,
  errnoError,
  exists,
  field,
  guardOf,
  park,
  parkIndexed,
  parkedEntries,
  readJson,
  readText,
  simpleFixture,
  withFsStub,
} from './park-tree.helpers.js'

/** packages/core/package.json's version, read here independently of the port. */
const PKG_VERSION = (
  JSON.parse(
    fs.readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../package.json'),
      'utf8'
    )
  ) as { version: string }
).version
const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) cleanup(r)
})
/** Sum of file and symlink lstat sizes under `p`, computed independently of treeBytes. */
const sumSizes = (p: string): number => {
  const st = fs.lstatSync(p)
  if (!st.isDirectory()) return st.size
  return fs.readdirSync(p).reduce((n, c) => n + sumSizes(path.join(p, c)), 0)
}
const fixture = (prefix = 'park-gh-') => {
  const f = simpleFixture(prefix)
  fs.mkdirSync(path.join(f.origin, 'd', 'e'), { recursive: true })
  fs.writeFileSync(path.join(f.origin, 'd', 'e', 'deep.txt'), 'deep')
  roots.push(f.root)
  return f
}

describe('the guard (spike T1, T2, T4, T4b)', () => {
  it('T1: a wrong guardHash leaves the tree in place', () => {
    const f = fixture()
    const r = park(f.parent, 'tree', { guardHash: 'DELIBERATELY-WRONG-HASH' })
    expect(r.status).toBe('kept')
    expect(r.reason).toBe('identity-changed')
    expect(readText(path.join(f.origin, 'd', 'e', 'deep.txt'))).toBe('deep')
  })

  it('T2/T4: a correct guardHash parks, and the sidecar records the hash it verified', () => {
    const f = fixture()
    const guardHash = guardOf(f.origin)
    const r = park(f.parent, 'tree', { guardHash })
    expect(r.status).toBe('parked')
    expect(exists(f.origin)).toBe(false)
    expect(field(readJson(r.sidecarPath), 'treeHash')).toBe(guardHash)
  })

  it('T4b: with no guardHash the sidecar records null, not a value it never checked', () => {
    const f = fixture()
    const r = park(f.parent, 'tree')
    expect(r.status).toBe('parked')
    expect(field(readJson(r.sidecarPath), 'treeHash')).toBe(null)
  })
})

describe('what a park does to the bytes and where it puts them', () => {
  it('the origin is absent and the parked bytes equal the original bytes', () => {
    const f = fixture()
    const before = readText(path.join(f.origin, 'd', 'e', 'deep.txt'))
    const beforeHash = guardOf(f.origin)
    const r = park(f.parent, 'tree', { guardHash: beforeHash })
    expect(exists(f.origin)).toBe(false)
    expect(readText(path.join(String(r.path), 'd', 'e', 'deep.txt'))).toBe(before)
    // The hash keys entries relative to the root, so it survives the move.
    expect(guardOf(String(r.path))).toBe(beforeHash)
  })

  it('two parks of the same name under one opId get different random suffixes', () => {
    const f = fixture()
    const first = park(f.parent, 'tree', { opId: 'op-twice' })
    fs.mkdirSync(path.join(f.origin, 'sub'), { recursive: true })
    fs.writeFileSync(path.join(f.origin, 'sub', 'f.txt'), 'second')
    const second = park(f.parent, 'tree', { opId: 'op-twice' })
    expect(first.status).toBe('parked')
    expect(second.status).toBe('parked')
    expect(path.dirname(String(first.path))).toBe(path.dirname(String(second.path)))
    expect(first.path).not.toBe(second.path)
    expect(parkedEntries(path.join(f.parent, PARKED, 'op-twice'))).toHaveLength(2)
  })

  it('two parks without an opId get different generated opIds', () => {
    const a = fixture('park-gh-a-')
    const b = fixture('park-gh-b-')
    const ra = park(a.parent, 'tree')
    const rb = park(b.parent, 'tree')
    expect(typeof ra.opId).toBe('string')
    expect(ra.opId).not.toBe(rb.opId)
  })

  it('the sidecar names the caller, the kind, the origin and the real Skillsmith version', () => {
    const f = fixture()
    const r = park(f.parent, 'tree', { kind: 'uninstall', rootKey: 'rk-1' })
    const s = readJson(r.sidecarPath)
    expect(field(s, 'client')).toBe(CLIENT)
    expect(field(s, 'kind')).toBe('uninstall')
    expect(field(s, 'rootKey')).toBe('rk-1')
    expect(field(s, 'originPath')).toBe(f.origin)
    expect(field(s, 'opId')).toBe(r.opId)
    expect(field(s, 'skillsmithVersion')).toBe(PKG_VERSION)
    expect(field(s, 'bytes')).toBe(sumSizes(String(r.path)))
  })
})

describe('a byte count that fails never suppresses the sidecar (ADR-166 D-1)', () => {
  it('an unreadable subdirectory: the sidecar is written with bytes null and bytesError; the index line has bytes null', async () => {
    const f = fixture()
    const indexPath = path.join(f.root, 'parked-index.jsonl')
    // A stub, since the container runs as root: the parked copy's subdirectory
    // cannot be listed, so treeBytes fails after the rename. The stub is
    // synchronous; it still covers the whole park, which runs before
    // parkTreeIndexed's first await (only the index append comes after it).
    const r = await withFsStub(
      'readdirSync',
      (orig) =>
        (...args: unknown[]) => {
          if (String(args[0]).includes(`${path.sep}${PARKED}${path.sep}`)) {
            throw errnoError('EACCES')
          }
          return orig(...args)
        },
      () => parkIndexed(f.parent, 'tree', { kind: 'uninstall', indexPath })
    )
    expect(r.status).toBe('parked')
    expect('sidecarError' in r).toBe(false)
    const s2 = readJson(r.sidecarPath)
    expect(field(s2, 'originPath')).toBe(f.origin)
    expect(field(s2, 'opId')).toBe(r.opId)
    expect(field(s2, 'kind')).toBe('uninstall')
    expect(field(s2, 'bytes')).toBe(null)
    expect(field(s2, 'bytesError')).toBe('EACCES')
    const line = JSON.parse(fs.readFileSync(indexPath, 'utf8').trim()) as { bytes: unknown }
    expect(line.bytes).toBe(null)
  })
})

describe('one tree-hash function (A1 plan §3.4)', () => {
  const hash = (p: string) => {
    const h = computePathTreeHash(p)
    if (!h.ok) throw new Error(JSON.stringify(h))
    return h.treeHash
  }
  it('identical trees hash equal; content, mode, link text and an added entry each change it', () => {
    const base = fixture('park-th-')
    const make = (name: string) => {
      const d = path.join(base.root, name)
      fs.mkdirSync(path.join(d, 'sub'), { recursive: true })
      fs.writeFileSync(path.join(d, 'sub', 'f.txt'), 'same')
      fs.symlinkSync('sub/f.txt', path.join(d, 'link'))
      return d
    }
    const a = make('a')
    const b = make('b')
    expect(hash(a)).toBe(hash(b))
    const c = make('c')
    fs.writeFileSync(path.join(c, 'sub', 'f.txt'), 'diff')
    const m = make('m')
    fs.chmodSync(path.join(m, 'sub', 'f.txt'), 0o600)
    fs.chmodSync(path.join(a, 'sub', 'f.txt'), 0o644)
    fs.chmodSync(path.join(b, 'sub', 'f.txt'), 0o644)
    const l = make('l')
    fs.unlinkSync(path.join(l, 'link'))
    fs.symlinkSync('elsewhere', path.join(l, 'link'))
    const x = make('x')
    fs.mkdirSync(path.join(x, 'empty'))
    const hashes = new Set([hash(a), hash(c), hash(m), hash(l), hash(x)])
    expect(hashes.size).toBe(5)
  })

  it('a FIFO in the tree makes the walk stop guard-unsupported-type', () => {
    const f = fixture('park-thf-')
    const fifo = path.join(f.origin, 'pipe')
    const mk = spawnSync('mkfifo', [fifo])
    if (mk.status !== 0) throw new Error(`mkfifo failed: ${String(mk.stderr)}`)
    const h = computePathTreeHash(f.origin)
    expect(h.ok).toBe(false)
    expect(h.ok ? null : h.reason).toBe('guard-unsupported-type')
  })
})

describe('every root type parks the same way (UD30)', () => {
  /** A parent plus one root entry of the given kind, and an outside target. */
  function rootOf(kind: 'file' | 'link-dir' | 'link-file' | 'dangling') {
    const f = simpleFixture(`park-ud30-${kind}-`)
    roots.push(f.root)
    const outsideDir = path.join(f.root, 'outside-dir')
    fs.mkdirSync(outsideDir)
    fs.writeFileSync(path.join(outsideDir, 'inner.txt'), 'DIR-TARGET-BYTES')
    const outsideFile = path.join(f.root, 'outside-file.txt')
    fs.writeFileSync(outsideFile, 'FILE-TARGET-BYTES')
    const p = path.join(f.parent, 'entry')
    if (kind === 'file') fs.writeFileSync(p, 'REGULAR-ROOT-BYTES')
    if (kind === 'link-dir') fs.symlinkSync(outsideDir, p)
    if (kind === 'link-file') fs.symlinkSync(outsideFile, p)
    if (kind === 'dangling') fs.symlinkSync(path.join(f.root, 'no-such-target'), p)
    return { f, p, outsideDir, outsideFile }
  }
  for (const kind of ['file', 'link-dir', 'link-file', 'dangling'] as const) {
    for (const guarded of [false, true]) {
      it(`${kind}, ${guarded ? 'guarded' : 'unguarded'}: parked with its bytes or link text, the target byte-identical`, () => {
        const { f, p, outsideDir, outsideFile } = rootOf(kind)
        const linkText = kind === 'file' ? null : fs.readlinkSync(p)
        const r = park(f.parent, 'entry', guarded ? { guardHash: guardOf(p) } : {})
        expect(r.status).toBe('parked')
        expect(exists(p)).toBe(false)
        const parked = String(r.path)
        if (kind === 'file') {
          expect(fs.lstatSync(parked).isFile()).toBe(true)
          expect(readText(parked)).toBe('REGULAR-ROOT-BYTES')
        } else {
          expect(fs.lstatSync(parked).isSymbolicLink()).toBe(true)
          expect(fs.readlinkSync(parked)).toBe(linkText)
        }
        expect(readText(path.join(outsideDir, 'inner.txt'))).toBe('DIR-TARGET-BYTES')
        expect(readText(outsideFile)).toBe('FILE-TARGET-BYTES')
        if (guarded) expect(field(readJson(r.sidecarPath), 'postMoveVerified')).toBe(true)
      })
    }
  }

  for (const guarded of [false, true]) {
    it(`a FIFO root is refused before anything moves (${guarded ? 'guarded' : 'unguarded'})`, () => {
      const f = simpleFixture('park-ud30-fifo-')
      roots.push(f.root)
      const fifo = path.join(f.parent, 'pipe')
      const mk = spawnSync('mkfifo', [fifo])
      if (mk.status !== 0) throw new Error(`mkfifo failed: ${String(mk.stderr)}`)
      const r = park(f.parent, 'pipe', guarded ? { guardHash: 'a'.repeat(64) } : {})
      expect(r.status).toBe('stopped')
      expect(r.reason).toBe('guard-unsupported-type')
      expect(fs.lstatSync(fifo).isFIFO()).toBe(true)
      expect(exists(path.join(f.parent, PARKED))).toBe(false)
    })
  }
})

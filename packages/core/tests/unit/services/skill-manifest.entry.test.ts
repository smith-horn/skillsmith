/**
 * SMI-6531 (A1 step 7a): the manifest entry model. T-C3 (protected fields and
 * the exact writable set), T-C4 (the raw canonical form), `rawEntryAt`'s
 * prototype safety, `classifyEntry`, `buildPostEntry` and `readEntryState`.
 *
 * Each absence assertion sits beside a presence assertion from the same run.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { canonicalJson } from '../../../src/services/skill-manifest.canonical.js'
import type { JsonObject } from '../../../src/services/skill-manifest.canonical.js'
import {
  buildPostEntry,
  classifyEntry,
  ENTRY_WRITABLE_FIELDS,
  rawEntryAt,
  readEntryState,
} from '../../../src/services/skill-manifest.entry.js'
import type { EntryWritable } from '../../../src/services/skill-manifest.entry.js'

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true })
})
const tmpManifest = (text?: string): string => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mentry-')))
  roots.push(root)
  const p = path.join(root, 'manifest.json')
  if (text !== undefined) fs.writeFileSync(p, text)
  return p
}
const doc = (entries: Record<string, unknown>) => ({ version: '1.0.0', installedSkills: entries })

const WRITABLE: Required<EntryWritable> = {
  version: '2.0.0',
  lastUpdated: '2026-10-25T00:00:00.000Z',
  originalContentHash: 'o'.repeat(64),
  upstreamContentHash: 'u'.repeat(64),
  fileHashes: { 'a/b.txt': 'h'.repeat(64) },
}

describe('T-C3: protected fields', () => {
  const PROTECTED = {
    provenance: 'registry',
    verifiedAt: '2026-01-01T00:00:00.000Z',
    pinnedVersion: 'abcd1234',
    updatePolicy: 'manual',
    installedAt: '2026-01-01T00:00:00.000Z',
    contentHash: 'c'.repeat(64),
    unknownField: { keep: [1, { me: null }] },
  }
  const raw: JsonObject = {
    id: 'a/b',
    name: 'b',
    version: '1.0.0',
    source: 'github:a/b',
    installPath: '/x',
    lastUpdated: '2026-01-01T00:00:00.000Z',
    originalContentHash: 'old',
    ...PROTECTED,
  } as JsonObject

  it('every protected field, and the unknown one, is byte-identical in canonical form', () => {
    const post = buildPostEntry(raw, WRITABLE)
    for (const [k, v] of Object.entries(PROTECTED)) {
      expect(Object.hasOwn(post, k), k).toBe(true)
      expect(canonicalJson(post[k]), k).toBe(canonicalJson(v))
    }
    // The control: the five writable fields did change.
    expect(post.version).toBe('2.0.0')
    expect(post.fileHashes).toEqual(WRITABLE.fileHashes)
    expect(post.upstreamContentHash).toBe(WRITABLE.upstreamContentHash)
  })

  it('verifiedAt is never added to an entry that lacks it, and is kept on one that has it', () => {
    const { verifiedAt: _dropped, ...without } = raw
    const post = buildPostEntry(without as JsonObject, WRITABLE)
    expect(Object.hasOwn(post, 'verifiedAt')).toBe(false)
    expect(Object.hasOwn(buildPostEntry(raw, WRITABLE), 'verifiedAt')).toBe(true)
  })

  it('ENTRY_WRITABLE_FIELDS is exactly the five fields, compared as a sorted array', () => {
    expect([...ENTRY_WRITABLE_FIELDS].sort()).toEqual(
      ['fileHashes', 'lastUpdated', 'originalContentHash', 'upstreamContentHash', 'version'].sort()
    )
  })

  it('a field outside the set throws (contentHash and verifiedAt included); each allowed field is accepted', () => {
    for (const f of ['contentHash', 'verifiedAt', 'provenance', 'pinnedVersion', 'id', 'unknown']) {
      expect(() => buildPostEntry(raw, { [f]: 'x' } as EntryWritable), f).toThrow(/not writable/)
    }
    for (const f of ENTRY_WRITABLE_FIELDS) {
      expect(() => buildPostEntry(raw, { [f]: WRITABLE[f] } as EntryWritable), f).not.toThrow()
    }
  })

  it('an undefined field is left out, so absent stays absent and a present value is kept', () => {
    const post = buildPostEntry({ id: 'x', version: '1.0.0' }, { version: undefined })
    expect(post).toEqual({ id: 'x', version: '1.0.0' })
    expect(Object.hasOwn(post, 'fileHashes')).toBe(false)
    expect(buildPostEntry({ id: 'x' }, { version: '3' }).version).toBe('3')
  })

  it('a wrong-typed writable value throws', () => {
    expect(() => buildPostEntry(raw, { version: 2 } as unknown as EntryWritable)).toThrow(TypeError)
    expect(() => buildPostEntry(raw, { fileHashes: { a: 1 } } as unknown as EntryWritable)).toThrow(
      TypeError
    )
  })
})

describe('buildPostEntry: fileHashes merge', () => {
  it('merges over the existing map; the new value wins; untouched baselines survive', () => {
    const post = buildPostEntry(
      { fileHashes: { keep: 'k', both: 'old' } },
      { fileHashes: { both: 'new', added: 'a' } }
    )
    expect(post.fileHashes).toEqual({ keep: 'k', both: 'new', added: 'a' })
  })

  it('a malformed existing map counts as no baseline and is replaced', () => {
    for (const bad of ['text', ['a'], { a: 1 }, null]) {
      const post = buildPostEntry({ fileHashes: bad } as JsonObject, { fileHashes: { n: 'h' } })
      expect(post.fileHashes, JSON.stringify(bad)).toEqual({ n: 'h' })
    }
  })

  it('a path named __proto__ stays an own key', () => {
    const post = buildPostEntry(
      {},
      {
        fileHashes: JSON.parse('{"__proto__":"h"}') as Record<string, string>,
      }
    )
    expect(Object.hasOwn(post.fileHashes as object, '__proto__')).toBe(true)
  })
})

describe('T-C4: the raw canonical form', () => {
  const nested = { x: { y: [1, { z: null, b: 2 }], a: true } }
  const pre = { id: 'a', pinnedVersion: null, ...nested }
  const post = { id: 'a', pinnedVersion: null, version: '2', ...nested }
  const at = (entry: unknown) => classifyEntry(doc({ k: entry }), 'k', pre, post)

  it('the entry as written (pre) is pre, and as updated (post) is post', () => {
    expect(at(pre)).toBe('pre')
    expect(at(post)).toBe('post')
  })

  it('changing null to absent fails the CAS, at the top level and at a nested key', () => {
    expect(at({ id: 'a', ...nested })).toBe('other')
    expect(at({ id: 'a', pinnedVersion: null, x: { y: [1, { b: 2 }], a: true } })).toBe('other')
  })

  it('a record written in a different key order, at every depth, still matches', () => {
    const reordered = { x: { a: true, y: [1, { b: 2, z: null }] }, pinnedVersion: null, id: 'a' }
    expect(at(reordered)).toBe('pre')
    expect(canonicalJson(reordered)).toBe(canonicalJson(pre))
  })

  it('two inputs differing only in array order give different canonicalJson, and fail the CAS', () => {
    const swapped = { id: 'a', pinnedVersion: null, x: { y: [{ z: null, b: 2 }, 1], a: true } }
    expect(canonicalJson(swapped)).not.toBe(canonicalJson(pre))
    expect(at(swapped)).toBe('other')
  })

  it('the nested unknown value is deep-equal after buildPostEntry', () => {
    const built = buildPostEntry(pre as JsonObject, { version: '2' })
    expect(built.x).toEqual(nested.x)
    expect(canonicalJson(built)).toBe(canonicalJson(post))
  })
})

describe('rawEntryAt: prototype safety', () => {
  const inherited = ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']

  it('an inherited member is not an entry; the same key as an own entry is', () => {
    for (const key of inherited) {
      expect(rawEntryAt(doc({}), key), key).toBeNull()
      const own = JSON.parse(`{"version":"1.0.0","installedSkills":{"${key}":{"id":"own"}}}`)
      expect(rawEntryAt(own, key), key).toEqual({ id: 'own' })
    }
  })

  it('classify treats an inherited key as no entry (pre = null), not as an unknown entry', () => {
    for (const key of inherited)
      expect(classifyEntry(doc({}), key, null, { id: 'p' }), key).toBe('pre')
  })

  it('a missing, null or non-object installedSkills holds no entry; a real one holds it', () => {
    for (const m of [null, 'x', [], {}, { installedSkills: null }, { installedSkills: [] }]) {
      expect(rawEntryAt(m, 'k')).toBeNull()
    }
    expect(rawEntryAt(doc({ k: { id: 1 } }), 'k')).toEqual({ id: 1 })
  })
})

describe('classifyEntry', () => {
  it('pre wins when pre and post are canonically equal; otherwise by equality', () => {
    expect(classifyEntry(doc({ k: { a: 1 } }), 'k', { a: 1 }, { a: 1 })).toBe('pre')
    expect(classifyEntry(doc({ k: { a: 2 } }), 'k', { a: 1 }, { a: 2 })).toBe('post')
    expect(classifyEntry(doc({ k: { a: 3 } }), 'k', { a: 1 }, { a: 2 })).toBe('other')
    expect(classifyEntry(doc({}), 'k', { a: 1 }, { a: 2 })).toBe('other')
    expect(classifyEntry(doc({}), 'k', null, { a: 2 })).toBe('pre')
  })
})

describe('readEntryState', () => {
  it('classifies a readable manifest, and a missing one as no entry', async () => {
    const p = tmpManifest(JSON.stringify(doc({ k: { a: 1 } })))
    expect(await readEntryState(p, 'k', { a: 1 }, { a: 2 })).toEqual({ ok: true, state: 'pre' })
    expect(await readEntryState(p, 'k', { a: 0 }, { a: 1 })).toEqual({ ok: true, state: 'post' })
    expect(await readEntryState(p, 'k', { a: 0 }, { a: 2 })).toEqual({ ok: true, state: 'other' })
    const missing = tmpManifest()
    expect(await readEntryState(missing, 'k', null, { a: 2 })).toEqual({ ok: true, state: 'pre' })
    expect(await readEntryState(missing, 'k', { a: 1 }, { a: 2 })).toEqual({
      ok: true,
      state: 'other',
    })
  })

  it('refuses a corrupt, an unreadable and a newer-major manifest without touching it', async () => {
    const cases: Array<[string, string]> = [
      ['{ not json', 'corrupt'],
      [JSON.stringify({ version: '1.0.0', installedSkills: [] }), 'corrupt'],
      [JSON.stringify({ version: '9.0.0', installedSkills: {} }), 'version_unsupported'],
    ]
    for (const [text, state] of cases) {
      const p = tmpManifest(text)
      const r = await readEntryState(p, 'k', null, { a: 1 })
      expect(r.ok, text).toBe(false)
      if (!r.ok) expect(r.refusal.state).toBe(state)
      expect(fs.readFileSync(p, 'utf8')).toBe(text)
    }
    const dirAsManifest = tmpManifest()
    fs.mkdirSync(dirAsManifest)
    const r = await readEntryState(dirAsManifest, 'k', null, { a: 1 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.refusal.state).toBe('unreadable')
  })
})

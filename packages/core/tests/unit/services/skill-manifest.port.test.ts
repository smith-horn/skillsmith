/**
 * SMI-6531 (A1 step 7a): `createManifestPort`, on a real manifest file.
 *
 * Refusals at construction, classify/CAS, `write()`'s CAS throw, the one-key
 * replace, `installedSkills` absent or null, a missing manifest, `__proto__` and
 * `constructor` keys, a strict-load refusal, and the lock-loss retry. Each
 * absence assertion (a file left unchanged, a key not written) sits beside the
 * presence assertion from a control that does write.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ManifestEntryChanged } from '../../../src/services/skill-manifest.entry.js'
import { ManifestLockLost } from '../../../src/services/skill-manifest.lock.js'
import { createManifestPort } from '../../../src/services/skill-manifest.port.js'
import { ManifestUnwritableError } from '../../../src/services/skill-manifest.read-state.js'

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true })
})
const PRE = { id: 'a/b', version: '1.0.0', pinnedVersion: null, nested: { b: 1, a: [2, 1] } }
const POST = { ...PRE, version: '2.0.0', fileHashes: { 'f.txt': 'h' } }
const KEY = 'my-skill'

function setup(manifest?: unknown) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mport-')))
  roots.push(root)
  const manifestPath = path.join(root, 'manifest.json')
  if (manifest !== undefined) {
    fs.writeFileSync(
      manifestPath,
      typeof manifest === 'string' ? manifest : JSON.stringify(manifest, null, 2)
    )
  }
  return { root, manifestPath, lockPath: `${manifestPath}.lock` }
}
const readDoc = (p: string) => JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>
const target = (manifestPath: string, over: Record<string, unknown> = {}) => ({
  manifestPath,
  manifestKey: KEY,
  preEntry: PRE,
  postEntry: POST,
  ...over,
})
const backdate = (p: string, seconds: number) => {
  const t = Date.now() / 1000 - seconds
  fs.utimesSync(p, t, t)
}

describe('createManifestPort: refusals at construction', () => {
  it('refuses a bad postEntry, a bad preEntry and an equal pair; accepts a valid pair and a null pre', () => {
    const { manifestPath } = setup()
    for (const post of [null, undefined, [], 'x', 1, new Date()]) {
      expect(
        () => createManifestPort(target(manifestPath, { postEntry: post })),
        String(post)
      ).toThrow(TypeError)
    }
    for (const pre of [undefined, [], 'x', 1, new Date()]) {
      expect(
        () => createManifestPort(target(manifestPath, { preEntry: pre })),
        String(pre)
      ).toThrow(TypeError)
    }
    // Equal after canonicalization: a different key order is still the same entry.
    expect(() =>
      createManifestPort(
        target(manifestPath, { preEntry: { a: 1, b: 2 }, postEntry: { b: 2, a: 1 } })
      )
    ).toThrow(/must differ/)
    expect(() => createManifestPort(target(manifestPath))).not.toThrow()
    expect(() => createManifestPort(target(manifestPath, { preEntry: null }))).not.toThrow()
  })
})

describe('the handle: classify and casMatches', () => {
  it('reports pre, post and other, and casMatches is true only for pre', async () => {
    const seen: string[] = []
    for (const entry of [PRE, POST, { ...PRE, version: '9' }]) {
      const { manifestPath } = setup({ version: '1.0.0', installedSkills: { [KEY]: entry } })
      await createManifestPort(target(manifestPath)).withManifestLock(async (m) => {
        seen.push(await m.classify(), String(await m.casMatches()))
      })
    }
    expect(seen).toEqual(['pre', 'true', 'post', 'false', 'other', 'false'])
  })

  it('does not write: the file is unchanged and the lock is released', async () => {
    const { manifestPath, lockPath } = setup({ version: '1.0.0', installedSkills: { [KEY]: PRE } })
    const before = fs.readFileSync(manifestPath)
    await createManifestPort(target(manifestPath)).withManifestLock((m) => m.casMatches())
    expect(fs.readFileSync(manifestPath).equals(before)).toBe(true)
    expect(fs.existsSync(lockPath)).toBe(false)
  })
})

describe('write(): the CAS throw', () => {
  it('writes when the entry is pre', async () => {
    const { manifestPath } = setup({ version: '1.0.0', installedSkills: { [KEY]: PRE } })
    await createManifestPort(target(manifestPath)).withManifestLock((m) => m.write())
    expect((readDoc(manifestPath).installedSkills as Record<string, unknown>)[KEY]).toEqual(POST)
  })

  it('throws ManifestEntryChanged, naming what it found, and leaves the file byte-identical, for other and for post', async () => {
    const found: string[] = []
    for (const entry of [{ ...PRE, pinnedVersion: 'abc' }, POST]) {
      const { manifestPath } = setup({ version: '1.0.0', installedSkills: { [KEY]: entry } })
      const before = fs.readFileSync(manifestPath)
      const err = await createManifestPort(target(manifestPath))
        .withManifestLock((m) => m.write())
        .catch((e: unknown) => e)
      expect(err).toBeInstanceOf(ManifestEntryChanged)
      expect((err as ManifestEntryChanged).manifestKey).toBe(KEY)
      found.push((err as ManifestEntryChanged).found)
      expect(fs.readFileSync(manifestPath).equals(before)).toBe(true)
      expect(fs.readdirSync(path.dirname(manifestPath)).filter((f) => f.includes('.tmp.'))).toEqual(
        []
      )
    }
    expect(found).toEqual(['other', 'post'])
  })

  it('a change between casMatches and write is caught by write() itself', async () => {
    const { manifestPath } = setup({ version: '1.0.0', installedSkills: { [KEY]: PRE } })
    const changed = { version: '1.0.0', installedSkills: { [KEY]: { ...PRE, pinnedVersion: 'z' } } }
    const err = await createManifestPort(target(manifestPath))
      .withManifestLock(async (m) => {
        expect(await m.casMatches()).toBe(true)
        fs.writeFileSync(manifestPath, JSON.stringify(changed))
        await m.write()
      })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ManifestEntryChanged)
    expect(readDoc(manifestPath)).toEqual(changed)
  })
})

describe('write(): replaces only that key', () => {
  it('every other entry and top-level field is byte-identical in order and content', async () => {
    const other1 = { id: 'o1', odd: { z: 1, a: [3, 2, 1] }, n: null }
    const other2 = { id: 'o2', unknown: true }
    const doc = {
      version: '1.0.0',
      telemetry: { enabled: false, extra: { k: 1 } },
      installedSkills: { first: other1, [KEY]: PRE, last: other2 },
      topUnknown: [1, { b: 1, a: 2 }],
    }
    const { manifestPath } = setup(doc)
    await createManifestPort(target(manifestPath)).withManifestLock((m) => m.write())
    const out = readDoc(manifestPath)
    const skills = out.installedSkills as Record<string, unknown>
    expect(Object.keys(skills)).toEqual(['first', KEY, 'last'])
    expect(JSON.stringify(skills.first)).toBe(JSON.stringify(other1))
    expect(JSON.stringify(skills.last)).toBe(JSON.stringify(other2))
    expect(JSON.stringify(out.telemetry)).toBe(JSON.stringify(doc.telemetry))
    expect(JSON.stringify(out.topUnknown)).toBe(JSON.stringify(doc.topUnknown))
    expect(Object.keys(out)).toEqual(Object.keys(doc))
    // The control: the target key did change.
    expect(skills[KEY]).toEqual(POST)
    expect(skills[KEY]).not.toEqual(PRE)
  })

  it('a new key is appended after the others', async () => {
    const { manifestPath } = setup({ version: '1.0.0', installedSkills: { a: { id: 'a' } } })
    await createManifestPort(target(manifestPath, { preEntry: null })).withManifestLock((m) =>
      m.write()
    )
    const skills = readDoc(manifestPath).installedSkills as Record<string, unknown>
    expect(Object.keys(skills)).toEqual(['a', KEY])
    expect(skills[KEY]).toEqual(POST)
  })
})

describe('installedSkills absent or null, and a missing manifest', () => {
  for (const [label, doc] of [
    ['absent', { version: '1.0.0', other: 1 }],
    ['null', { version: '1.0.0', installedSkills: null, other: 1 }],
  ] as const) {
    it(`installedSkills ${label}: pre = null classifies pre and write creates the map, keeping other fields`, async () => {
      const { manifestPath } = setup(doc)
      await createManifestPort(target(manifestPath, { preEntry: null })).withManifestLock(
        async (m) => {
          expect(await m.classify()).toBe('pre')
          await m.write()
        }
      )
      const out = readDoc(manifestPath)
      expect(out.installedSkills).toEqual({ [KEY]: POST })
      expect(out.other).toBe(1)
    })

    it(`installedSkills ${label}: a non-null pre classifies other and write throws`, async () => {
      const { manifestPath } = setup(doc)
      const before = fs.readFileSync(manifestPath)
      const err = await createManifestPort(target(manifestPath))
        .withManifestLock((m) => m.write())
        .catch((e: unknown) => e)
      expect(err).toBeInstanceOf(ManifestEntryChanged)
      expect((err as ManifestEntryChanged).found).toBe('other')
      expect(fs.readFileSync(manifestPath).equals(before)).toBe(true)
    })
  }

  it('a missing manifest holds no entry: pre = null writes a new file; a non-null pre is other and writes nothing', async () => {
    const created = setup()
    await createManifestPort(target(created.manifestPath, { preEntry: null })).withManifestLock(
      async (m) => {
        expect(await m.classify()).toBe('pre')
        await m.write()
      }
    )
    expect(readDoc(created.manifestPath)).toEqual({
      version: '1.0.0',
      installedSkills: { [KEY]: POST },
    })

    const absent = setup()
    const err = await createManifestPort(target(absent.manifestPath))
      .withManifestLock((m) => m.write())
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ManifestEntryChanged)
    expect(fs.existsSync(absent.manifestPath)).toBe(false)
  })
})

describe('keys named like prototype members', () => {
  for (const key of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    it(`${key}: absent reads as no entry, write creates an own key, and a second port finds it as post`, async () => {
      const { manifestPath } = setup({ version: '1.0.0', installedSkills: { other: { id: 'o' } } })
      const t = target(manifestPath, { manifestKey: key, preEntry: null })
      await createManifestPort(t).withManifestLock(async (m) => {
        expect(await m.classify()).toBe('pre')
        await m.write()
      })
      const skills = readDoc(manifestPath).installedSkills as object
      expect(Object.hasOwn(skills, key)).toBe(true)
      expect(Object.getPrototypeOf(skills)).toBe(Object.prototype)
      expect((skills as Record<string, unknown>).other).toEqual({ id: 'o' })
      await createManifestPort(t).withManifestLock(async (m) => {
        expect(await m.classify()).toBe('post')
      })
    })
  }
})

describe('a strict load refuses an unwritable manifest', () => {
  const bad: Array<[string, string]> = [
    ['corrupt JSON', '{ not json'],
    ['a list for installedSkills', JSON.stringify({ version: '1.0.0', installedSkills: [] })],
    ['a newer major', JSON.stringify({ version: '9.0.0', installedSkills: {} })],
  ]
  for (const [label, text] of bad) {
    it(`${label}: classify and write throw ManifestUnwritableError and the file is unchanged`, async () => {
      const { manifestPath } = setup(text)
      const port = createManifestPort(target(manifestPath, { preEntry: null }))
      for (const call of ['classify', 'write'] as const) {
        const err = await port
          .withManifestLock(async (m) => {
            await m[call]()
          })
          .catch((e: unknown) => e)
        expect(err, call).toBeInstanceOf(ManifestUnwritableError)
      }
      expect(fs.readFileSync(manifestPath, 'utf8')).toBe(text)
    })
  }
})

describe('the lock-loss retry', () => {
  const doc = { version: '1.0.0', installedSkills: { [KEY]: PRE } }

  it('a lock lost before the rename retries once from a fresh acquisition, and the retry commits', async () => {
    const { manifestPath, lockPath } = setup(doc)
    let attempts = 0
    const states: string[] = []
    await createManifestPort(target(manifestPath)).withManifestLock(async (m) => {
      attempts += 1
      states.push(await m.classify())
      if (attempts === 1) backdate(lockPath, 26)
      await m.write()
    })
    expect(attempts).toBe(2)
    // The first attempt saved nothing, so the retry's CAS still saw pre.
    expect(states).toEqual(['pre', 'pre'])
    expect((readDoc(manifestPath).installedSkills as Record<string, unknown>)[KEY]).toEqual(POST)
    expect(fs.existsSync(lockPath)).toBe(false)
  })

  it('a second loss throws ManifestLockLost after two attempts, saves nothing and leaves no temp file', async () => {
    const { manifestPath, lockPath } = setup(doc)
    const before = fs.readFileSync(manifestPath)
    let attempts = 0
    const err = await createManifestPort(target(manifestPath))
      .withManifestLock(async (m) => {
        attempts += 1
        backdate(lockPath, 26)
        await m.write()
      })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ManifestLockLost)
    expect(attempts).toBe(2)
    expect(fs.readFileSync(manifestPath).equals(before)).toBe(true)
    expect(fs.readdirSync(path.dirname(manifestPath)).filter((f) => f.includes('.tmp.'))).toEqual(
      []
    )
    expect(fs.existsSync(lockPath)).toBe(false)
  })

  it('a ManifestEntryChanged is not retried', async () => {
    const { manifestPath } = setup({ version: '1.0.0', installedSkills: { [KEY]: POST } })
    let attempts = 0
    const err = await createManifestPort(target(manifestPath))
      .withManifestLock(async (m) => {
        attempts += 1
        await m.write()
      })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ManifestEntryChanged)
    expect(attempts).toBe(1)
  })
})

describe('T-C4 end to end: a record written in another key order still passes the CAS', () => {
  it('the on-disk entry and the record differ only in key order at every depth: casMatches is true and write commits', async () => {
    const onDisk = { nested: { a: [2, 1], b: 1 }, pinnedVersion: null, version: '1.0.0', id: 'a/b' }
    const { manifestPath } = setup({ version: '1.0.0', installedSkills: { [KEY]: onDisk } })
    await createManifestPort(target(manifestPath)).withManifestLock(async (m) => {
      expect(await m.casMatches()).toBe(true)
      await m.write()
    })
    const written = (readDoc(manifestPath).installedSkills as Record<string, unknown>)[KEY]
    expect(written).toEqual(POST)
    // The control: a reordered array is a different entry.
    const swapped = { ...onDisk, nested: { a: [1, 2], b: 1 } }
    const other = setup({ version: '1.0.0', installedSkills: { [KEY]: swapped } })
    await createManifestPort(target(other.manifestPath)).withManifestLock(async (m) => {
      expect(await m.casMatches()).toBe(false)
    })
  })
})

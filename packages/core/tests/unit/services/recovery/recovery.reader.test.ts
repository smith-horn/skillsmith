/**
 * SMI-6531 (A1 step 6a-i): one reader, one digest (design § 2).
 *
 * Two properties make the re-plan digest cover everything the classifier read:
 * the classifier modules cannot touch the filesystem except through the reader
 * (the import test), and everything the reader reads is in the transcript
 * (the digest tests). Each negative has a positive control run through the
 * same instrument: the walker that finds no `fs` in the classifier is shown to
 * find it in the reader and in a planted module, so a walker that found
 * nothing anywhere cannot pass.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { digestOf } from '../../../../src/services/skill-recovery.digest.js'
import { reportOp } from '../../../../src/services/skill-recovery.listing.js'
import { ClassifierReader } from '../../../../src/services/skill-recovery.reader.js'
import { areaOf, makeFixture, tmp, useTmpCleanup } from '../skill-swap.helpers.js'
import { opIdN, otherSkill } from '../skill-swap.scan.helpers.js'
import {
  destOf,
  journalOf,
  keepTree,
  opReport,
  s2,
  setEntry,
  writeJournalLine,
} from './recovery.helpers.js'
import type { State } from './recovery.helpers.js'

useTmpCleanup()

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../src/services')

const FS_MODULES = new Set(['node:fs', 'fs', 'node:fs/promises', 'fs/promises'])

/**
 * The module specifiers a source file imports at run time: `import ... from`,
 * `export ... from`, side-effect imports, dynamic `import()` and `require()`.
 * `import type` and `export type` are erased and do not count.
 */
export function importsOf(source: string): string[] {
  const found: string[] = []
  const patterns = [
    /(?:^|\n)\s*(?:import|export)\s+(?!type\b)[^;'"]*?\sfrom\s+['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const re of patterns) for (const m of source.matchAll(re)) found.push(m[1]!)
  return found
}

interface Walk {
  /** `<module> -> <specifier>` for every filesystem import reached. */
  fsImports: string[]
  visited: string[]
}

/** Walks relative imports from `entries` under `dir`; stops at (and does not enter) `stop`. */
export function walkImports(dir: string, entries: string[], stop: readonly string[]): Walk {
  const visited = new Set<string>()
  const fsImports: string[] = []
  const queue = [...entries]
  while (queue.length > 0) {
    const mod = queue.shift()!
    if (visited.has(mod) || stop.includes(mod)) continue
    visited.add(mod)
    const file = path.join(dir, mod)
    if (!fs.existsSync(file)) throw new Error(`cannot walk into ${mod}: no such file under ${dir}`)
    for (const spec of importsOf(fs.readFileSync(file, 'utf8'))) {
      if (FS_MODULES.has(spec)) fsImports.push(`${mod} -> ${spec}`)
      else if (spec.startsWith('.'))
        queue.push(path.normalize(path.join(path.dirname(mod), spec)).replace(/\.js$/, '.ts'))
    }
  }
  return { fsImports, visited: [...visited].sort() }
}

/** Bare calls of the fs functions, and any `fs.` member access: what the classifier must not make. */
export function directCalls(source: string): string[] {
  const found: string[] = []
  const bare =
    /(?<![.\w])(readFileSync|readFile|readdirSync|readdir|lstatSync|lstat|statSync|stat|openSync|open|opendirSync|opendir|realpathSync|realpath|createReadStream|existsSync|access|accessSync)\s*\(|\bfs\s*\./g
  for (const m of source.matchAll(bare)) found.push(m[0].replace(/\s+/g, ''))
  return found
}

const CLASSIFIER = [
  'skill-recovery.opdir.ts',
  'skill-recovery.trees.ts',
  'skill-recovery.pstate.ts',
  'skill-recovery.classify.ts',
  'skill-recovery.plan.ts',
  // 6a-iii (bf-zyg F1): the already-parked check, digested like the classifier.
  'skill-recovery.parked-check.ts',
]
const READER = 'skill-recovery.reader.ts'

describe('the classifier has no filesystem access except through the reader', () => {
  it('no classifier module imports node:fs, directly or transitively, except via the reader', () => {
    const walk = walkImports(SRC, CLASSIFIER, [READER])
    expect(walk.fsImports).toEqual([])
    // The denominator: the walk went through the classifier's real dependencies.
    for (const expected of [
      ...CLASSIFIER,
      'skill-swap.record-schema.ts',
      'skill-swap.area.ts',
      'skill-recovery.digest.ts',
      'skill-swap.types.ts',
    ]) {
      expect(walk.visited).toContain(expected)
    }
    expect(walk.visited).not.toContain(READER)
  })

  it('control: the same walk, started at the reader, finds fs (the instrument can see it)', () => {
    const walk = walkImports(SRC, [READER], [])
    expect(walk.fsImports.some((l) => l.endsWith('node:fs'))).toBe(true)
    expect(walk.visited.length).toBeGreaterThan(5)
  })

  it('control: a planted classifier that reads with fs, or imports a module that does, is caught', () => {
    const dir = tmp('recovery-walk-')
    fs.writeFileSync(path.join(dir, 'leaf.ts'), "import fs from 'node:fs'\nexport const x = fs\n")
    fs.writeFileSync(
      path.join(dir, 'mid.ts'),
      "import { x } from './leaf.js'\nexport const y = x\n"
    )
    fs.writeFileSync(
      path.join(dir, 'direct.ts'),
      "import { readFileSync } from 'fs'\nexport const z = readFileSync\n"
    )
    fs.writeFileSync(
      path.join(dir, 'typeonly.ts'),
      "import type { Stats } from 'node:fs'\nexport type S = Stats\n"
    )
    fs.writeFileSync(
      path.join(dir, 'dyn.ts'),
      "export const f = () => import('node:fs/promises')\n"
    )
    expect(walkImports(dir, ['mid.ts'], []).fsImports).toEqual(['leaf.ts -> node:fs'])
    expect(walkImports(dir, ['direct.ts'], []).fsImports).toEqual(['direct.ts -> fs'])
    expect(walkImports(dir, ['dyn.ts'], []).fsImports).toEqual(['dyn.ts -> node:fs/promises'])
    // A type-only import is erased: it reads nothing.
    expect(walkImports(dir, ['typeonly.ts'], []).fsImports).toEqual([])
  })

  it('the classifier modules read no file other than through the reader (no direct fs-like calls)', () => {
    for (const m of CLASSIFIER) {
      const text = fs.readFileSync(path.join(SRC, m), 'utf8')
      expect(directCalls(text), m).toEqual([])
    }
  })

  it("control: the direct-call check sees a bare call and an fs member call, and not the reader's own methods", () => {
    const planted = [
      'const a = readFileSync(p)',
      'const b = readdir(p)',
      'const c = opendir(p)',
      'const d = realpath(p)',
      'const e = createReadStream(p)',
      'const f = fs.promises.readFile(p)',
      'const g = lstatSync(p)',
    ].join('\n')
    expect(directCalls(planted)).toEqual([
      'readFileSync(',
      'readdir(',
      'opendir(',
      'realpath(',
      'createReadStream(',
      'fs.',
      'lstatSync(',
    ])
    const viaReader = 'const x = r.readFile(p, 10); r.list(d, rule); r.stat(p); r.realpath(p)'
    expect(directCalls(viaReader)).toEqual([])
  })
})

/** The transcript digest of one op, plus the plan of its class. */
async function digestOfOp(st: State, over: Parameters<typeof reportOp>[2] = {}): Promise<string> {
  const ctx = {
    root: fs.realpathSync(st.fx.skillsDir),
    stagingDir: path.join(fs.realpathSync(st.fx.skillsDir), '.skillsmith-staging'),
    euid: process.geteuid?.() ?? 0,
    journalFile: journalOf(st.fx),
  }
  return (await reportOp(ctx, st.opId, over)).digest
}

describe('the digest covers everything the classifier read', () => {
  it('is stable across two runs over an unchanged state', async () => {
    const st = await s2(makeFixture({ 'SKILL.md': '# v1\n' }))
    expect(await digestOfOp(st)).toBe(await digestOfOp(st))
  })

  it('a corrupted record changes the digest (and the class); restoring its bytes restores it; an unparsed file does not matter', async () => {
    const st = await s2(makeFixture({ 'SKILL.md': '# v1\n' }))
    const before = await digestOfOp(st)
    const owner = path.join(st.opDir, 'owner.json')
    // owner.json is not parsed for a recorded op; record.json is.
    const rec = path.join(st.opDir, 'record.json')
    const bytes = fs.readFileSync(rec)
    const ino = fs.statSync(rec).ino
    const flipped = Buffer.from(bytes)
    const at = flipped.indexOf(Buffer.from('"pid"'))
    flipped[at + 1] = flipped[at + 1] === 0x50 ? 0x51 : 0x50 // change one byte of a key, same length
    fs.writeFileSync(rec, flipped)
    expect(fs.statSync(rec).ino).toBe(ino)
    expect(fs.readFileSync(rec).length).toBe(bytes.length)
    expect(await digestOfOp(st)).not.toBe(before)
    fs.writeFileSync(rec, bytes)
    expect(await digestOfOp(st)).toBe(before)
    // The control: bytes of a file nothing reads do not matter (another op's
    // entry in the backup area, which the `areaForOp` rule never lists).
    const other = path.join(areaOf(st.fx), `${'b'.repeat(32)}.json`)
    fs.mkdirSync(path.dirname(other), { recursive: true })
    fs.writeFileSync(other, 'another operation, never read for this one\n')
    const withOther = await digestOfOp(st)
    fs.writeFileSync(other, 'changed, and still never read\n')
    expect(await digestOfOp(st)).toBe(withOther)
    // 6a-ii: owner.json IS read for a recorded op (doctor adopts it by identity
    // and bytes before unlinking it), so its bytes are in the digest.
    expect(fs.existsSync(owner)).toBe(true)
    fs.writeFileSync(owner, 'changed in place\n')
    expect(await digestOfOp(st)).not.toBe(withOther)
  })

  it('byte hash alone: same inode, same length, other bytes, the plan held constant, the digest differs', () => {
    const dir = tmp('recovery-bytehash-')
    const f = path.join(dir, 'parsed.json')
    fs.writeFileSync(f, '{"a":"xxxx"}')
    const ino = fs.statSync(f).ino
    const digest = (): string => {
      const r = new ClassifierReader()
      r.readFile(f, 1024)
      return digestOf(r.transcript(), 'one constant plan')
    }
    const before = digest()
    fs.writeFileSync(f, '{"a":"xxxy"}')
    expect(fs.statSync(f).ino).toBe(ino)
    expect(fs.statSync(f).size).toBe(12)
    expect(digest()).not.toBe(before)
    fs.writeFileSync(f, '{"a":"xxxx"}')
    expect(digest()).toBe(before)
  })

  it('a record with two members swapped is the same class and plans, and only the digest differs', async () => {
    const st = await s2(makeFixture({ 'SKILL.md': '# v1\n' }))
    const before = await opReport(st)
    const rec = path.join(st.opDir, 'record.json')
    const bytes = fs.readFileSync(rec)
    const ino = fs.statSync(rec).ino
    const obj = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>
    const keys = Object.keys(obj)
    const at = keys.indexOf('pid')
    const swap = keys.indexOf('host')
    ;[keys[at], keys[swap]] = [keys[swap]!, keys[at]!]
    const reordered = Buffer.from(
      JSON.stringify(Object.fromEntries(keys.map((k) => [k, obj[k]])), null, 2) + '\n'
    )
    expect(reordered.length).toBe(bytes.length)
    expect(reordered.equals(bytes)).toBe(false)
    fs.writeFileSync(rec, reordered)
    expect(fs.statSync(rec).ino).toBe(ino)
    const after = await opReport(st)
    expect(after.cls).toEqual(before.cls)
    expect(after.plans).toEqual(before.plans)
    expect(after.digest).not.toBe(before.digest)
  })

  it('a tree hash is in the digest: an edit inside T changes it', async () => {
    const fx = makeFixture({ 'SKILL.md': '# v1\n' })
    const st = await s2(fx)
    const before = await digestOfOp(st)
    fs.writeFileSync(path.join(fx.realDir, 'SKILL.md'), '# a later edit\n')
    expect(await digestOfOp(st)).not.toBe(before)
  })

  it("a keep this op made is in the digest; another op's backup in the same area is not", async () => {
    const fx = makeFixture({ 'SKILL.md': '# v1\n' })
    const st = await s2(fx)
    const area = path.dirname(destOf(st, 'backup'))
    fs.mkdirSync(area, { recursive: true })
    const before = await digestOfOp(st)
    // Another operation's backup and sidecar: never listed by this op's rule.
    fs.mkdirSync(path.join(area, opIdN('f')))
    fs.writeFileSync(path.join(area, `${opIdN('f')}.json`), '{}')
    expect(await digestOfOp(st)).toBe(before)
    // This op's own keep changes what its classification read.
    keepTree(st, 'old', 'backup', { move: false })
    expect(await digestOfOp(st)).not.toBe(before)
  })

  it("shared reads hold the derived fact: an unrelated manifest entry or journal line changes nothing, this op's does", async () => {
    const fx = makeFixture({ 'SKILL.md': '# v1\n' })
    const st = await s2(fx)
    const before = await digestOfOp(st)
    setEntry(fx, 'some-other-skill', { version: '7.7.7', anything: [1, 2, 3] })
    writeJournalLine(fx, opIdN('f'), 'update')
    expect(await digestOfOp(st)).toBe(before)
    // The entry for this skill moving from pre to something else is a change the classifier reads.
    setEntry(fx, fx.dirName, { version: '9.9.9' })
    const moved = await digestOfOp(st)
    expect(moved).not.toBe(before)
    setEntry(fx, fx.dirName, st.p.manifest.entry)
    // This op's own audit line is a fact the classifier reads.
    writeJournalLine(fx, st.opId, 'update')
    expect(await digestOfOp(st)).not.toBe(before)
  })

  it("an edit to another skill in the same root does not change this op's digest", async () => {
    const fx = makeFixture({ 'SKILL.md': '# v1\n' })
    const other = otherSkill(fx, 'other-skill', { 'SKILL.md': '# other\n' })
    const st = await s2(fx)
    const before = await digestOfOp(st)
    fs.writeFileSync(path.join(other.realDir, 'SKILL.md'), '# edited\n')
    expect(await digestOfOp(st)).toBe(before)
  })

  it("a fixture classifier that parses one more file shows that file's bytes change the digest", () => {
    const dir = tmp('recovery-digest-')
    const extra = path.join(dir, 'extra.json')
    fs.writeFileSync(extra, '{"a":1}')
    const run = (): string => {
      const r = new ClassifierReader()
      const read = r.readFile(extra, 1024)
      expect(read.bytes).not.toBeNull() // "parsed"
      return digestOf(r.transcript(), 'plan')
    }
    const one = run()
    expect(run()).toBe(one)
    fs.writeFileSync(extra, '{"a":2}')
    expect(run()).not.toBe(one)
    // The same bytes, a different plan: the plan is in the digest too.
    const r = new ClassifierReader()
    r.readFile(extra, 1024)
    expect(digestOf(r.transcript(), 'plan')).not.toBe(digestOf(r.transcript(), 'another plan'))
  })
})

describe("the journal fact is read like the reader's other files", () => {
  const journal = (dir: string, text: string): string => {
    const f = path.join(dir, 'journal.jsonl')
    fs.writeFileSync(f, text)
    return f
  }
  const line = (o: unknown): string => `${JSON.stringify(o)}\n`

  it('a line that is valid JSON but not an object does not throw, and is not torn', () => {
    const dir = tmp('recovery-journal-')
    const update = { tool: 'update', suggestion_id: 'op' }
    const f = journal(dir, `null\n42\n"s"\n[1]\n${JSON.stringify(update)}\nnull`)
    expect(new ClassifierReader().journalHasUpdate('op', f)).toMatchObject({
      ok: true,
      present: true,
      torn: false,
    })
    // Control: the same lines without the update line hold none, and a half line is torn.
    const g = journal(dir, `null\n42\n${line({ tool: 'apply', suggestion_id: 'op' })}{"tool":"upd`)
    expect(new ClassifierReader().journalHasUpdate('op', g)).toMatchObject({
      ok: true,
      present: false,
      torn: true,
    })
  })

  it('a journal over the cap is unknown, never absent; a link or a directory is not read', () => {
    const dir = tmp('recovery-journal-')
    const f = journal(dir, line({ tool: 'update', suggestion_id: 'op' }))
    expect(new ClassifierReader({ journalCap: 8 }).journalHasUpdate('op', f)).toMatchObject({
      ok: false,
      errno: 'TOO_LARGE',
    })
    expect(new ClassifierReader().journalHasUpdate('op', f)).toMatchObject({
      ok: true,
      present: true,
    })
    fs.symlinkSync(f, path.join(dir, 'link.jsonl'))
    expect(
      new ClassifierReader().journalHasUpdate('op', path.join(dir, 'link.jsonl'))
    ).toMatchObject({ ok: false, errno: 'ELOOP' })
    fs.mkdirSync(path.join(dir, 'a-dir'))
    expect(new ClassifierReader().journalHasUpdate('op', path.join(dir, 'a-dir'))).toMatchObject({
      ok: false,
      errno: 'NOT_A_FILE',
    })
    expect(new ClassifierReader().journalHasUpdate('op', path.join(dir, 'missing'))).toMatchObject({
      ok: true,
      present: false,
    })
  })
})

describe("the reader's own facts", () => {
  it('stat reports a missing path by errno and a link as a link, never following it', () => {
    const dir = tmp('recovery-reader-')
    fs.writeFileSync(path.join(dir, 'f'), 'x')
    fs.symlinkSync(path.join(dir, 'f'), path.join(dir, 'link'))
    const r = new ClassifierReader()
    expect(r.stat(path.join(dir, 'nope'))).toEqual({ ok: false, errno: 'ENOENT' })
    expect(r.stat(path.join(dir, 'link'))).toMatchObject({ ok: true, type: 'symlink' })
    expect(r.stat(path.join(dir, 'f'))).toMatchObject({ ok: true, type: 'file', nlink: 1 })
    expect(r.stat(dir)).toMatchObject({ ok: true, type: 'dir' })
  })

  it('readFile never follows a link, never reads a directory, and bounds the read', () => {
    const dir = tmp('recovery-reader-')
    fs.writeFileSync(path.join(dir, 'f'), 'abcdefgh')
    fs.symlinkSync(path.join(dir, 'f'), path.join(dir, 'link'))
    fs.mkdirSync(path.join(dir, 'd'))
    const r = new ClassifierReader()
    expect(r.readFile(path.join(dir, 'link'), 100).fact).toMatchObject({
      ok: false,
      errno: 'ELOOP',
    })
    expect(r.readFile(path.join(dir, 'd'), 100).fact).toMatchObject({
      ok: false,
      errno: 'NOT_A_FILE',
      type: 'dir',
    })
    const bounded = r.readFile(path.join(dir, 'f'), 4)
    expect(bounded.bytes?.toString()).toBe('abcd')
    expect(bounded.fact).toMatchObject({ ok: true, size: 4, truncated: true })
    const whole = r.readFile(path.join(dir, 'f'), 100)
    expect(whole.bytes?.toString()).toBe('abcdefgh')
    expect(whole.fact).toMatchObject({ ok: true, size: 8, truncated: false })
  })

  it("list keeps only what its rule keeps, sorted, and records the rule's name", () => {
    const dir = tmp('recovery-reader-')
    for (const n of ['b-op', 'a-op', '.hidden', '.skillsmith-parked', '.skillsmith-probe-x-1']) {
      fs.mkdirSync(path.join(dir, n))
    }
    const r = new ClassifierReader()
    expect(r.list(dir, { name: 'stagingEntries' })).toMatchObject({
      ok: true,
      rule: 'stagingEntries',
      names: ['.skillsmith-probe-x-1', 'a-op', 'b-op'],
    })
    expect(r.list(dir, { name: 'all' })).toMatchObject({
      ok: true,
      names: expect.arrayContaining(['.hidden']),
    })
    expect(r.list(path.join(dir, 'a-op', 'nope'), { name: 'all' })).toMatchObject({ ok: false })
    const area = tmp('recovery-reader-')
    const id = opIdN('a')
    for (const n of [
      id,
      `${id}.json`,
      `.tmp-${id}`,
      `${id}.json.tmp`,
      `${id}.unused-new`,
      opIdN('b'),
      `${id}x`,
      'unrelated',
    ]) {
      fs.mkdirSync(path.join(area, n))
    }
    const mine = r.list(area, { name: 'areaForOp', opId: id })
    expect(mine).toMatchObject({ ok: true })
    expect(mine.ok ? mine.names : []).toEqual(
      [id, `${id}.json`, `${id}.json.tmp`, `${id}.unused-new`, `.tmp-${id}`].sort()
    )
  })

  it('every call is recorded with its method and key, and a shared read is marked derived', async () => {
    const dir = tmp('recovery-reader-')
    fs.writeFileSync(path.join(dir, 'f'), 'x')
    const r = new ClassifierReader()
    r.stat(path.join(dir, 'f'))
    r.readFile(path.join(dir, 'f'), 10)
    r.journalHasUpdate('op', path.join(dir, 'missing.jsonl'))
    await r.manifestEntry(path.join(dir, 'manifest.json'), 'k', { a: 1 }, { a: 2 })
    expect(r.transcript().map((e) => [e.method, e.derived])).toEqual([
      ['stat', false],
      ['readFile', false],
      ['journalHasUpdate', true],
      ['manifestEntry', true],
    ])
  })
})

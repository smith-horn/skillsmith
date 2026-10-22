/**
 * SMI-6531 (A1 step 4b): abort cleanup keeps a changed or partial tree and
 * parks one that only serializes like it (A1 plan §3.3 abort steps 4-5,
 * UD17, UD28). T-X13's edited, unreadable, failed-build, identical-
 * serialization and open-file rows.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ALL_DELETES,
  contentOf,
  isFs,
  parkedCopy,
  refusedOf,
  runSpied,
  treeDeletes,
} from './skill-swap.abort.helpers.js'
import { abortAt } from './skill-swap.abort.triggers.js'
import {
  areaOf,
  create,
  hashOf,
  makeFixture,
  modify,
  OP_ID,
  plan,
  useTmpCleanup,
} from './skill-swap.helpers.js'
import type { Fixture } from './skill-swap.helpers.js'

useTmpCleanup()

const FILES = { 'SKILL.md': '# v1\n', 'a.txt': 'a\n', 'sub/b.txt': 'b\n' }
const WRITES = [modify('SKILL.md', '# v2\n'), modify('sub/b.txt', 'b2\n')]
const N = (fx: Fixture) => path.join(fx.opDir, 'new')

/** Step-4 abort with `afterBuild` running `edit` on N first. */
async function editedAbort(edit: (fx: Fixture) => void, extra = {}) {
  const fx = makeFixture(FILES)
  const p = plan(fx, WRITES)
  const t = abortAt(fx, 'step4', { afterBuild: () => edit(fx) })
  const r = await runSpied(p, ALL_DELETES, { ...t.options, ...extra })
  return { fx, p, built: t.built, ...r }
}

describe('T-X13: a changed completed build is kept, never parked or removed', () => {
  const cases: Array<[string, (fx: Fixture) => void, Record<string, string>]> = [
    [
      'a file in N changed',
      (fx) => fs.appendFileSync(path.join(N(fx), 'a.txt'), 'edit\n'),
      { 'a.txt': 'a\nedit\n' },
    ],
    [
      'a file rewritten to a prefix of its bytes',
      (fx) => fs.writeFileSync(path.join(N(fx), 'SKILL.md'), '# v'),
      { 'SKILL.md': '# v' },
    ],
  ]
  for (const [label, edit, expected] of cases) {
    it(`${label}: kept as edited-new with the change; OP removed only by rmdir once empty`, async () => {
      const run = await editedAbort(edit)
      const r = refusedOf(run.result)
      const kept = path.join(areaOf(run.fx), `${OP_ID}.edited-new`)
      expect(r).toMatchObject({ staged: 'kept', keptAs: { kind: 'edited-new', path: kept } })
      expect(r.warnings.filter((w) => w.code === 'removal-not-done')).toEqual([])
      expect(contentOf(kept)).toMatchObject(expected)
      expect(JSON.parse(fs.readFileSync(`${kept}.json`, 'utf8'))).toMatchObject({
        opId: OP_ID,
        kind: 'edited-new',
        treeHash: hashOf(kept),
      })
      expect(fs.existsSync(run.fx.opDir)).toBe(false)
      expect(fs.existsSync(path.join(run.fx.staging, '.skillsmith-parked'))).toBe(false)
      expect(treeDeletes(run.fx, run.events)).toEqual([])
    })
  }

  it('unreadable (a FIFO in N, so it cannot be hashed): kept as unrecorded-new, treeHash null', async () => {
    const run = await editedAbort((fx) => execFileSync('mkfifo', [path.join(N(fx), 'pipe')]))
    const r = refusedOf(run.result)
    const kept = path.join(areaOf(run.fx), `${OP_ID}.unrecorded-new`)
    expect(r).toMatchObject({ staged: 'kept', keptAs: { kind: 'unrecorded-new', path: kept } })
    expect(fs.lstatSync(path.join(kept, 'pipe')).isFIFO()).toBe(true)
    const sidecar = JSON.parse(fs.readFileSync(`${kept}.json`, 'utf8'))
    expect(sidecar).toMatchObject({ kind: 'unrecorded-new', treeHash: null })
    expect(sidecar.treeHashError).toMatch(/^unsupported-entry at /)
    expect(fs.existsSync(run.fx.opDir)).toBe(false)
    expect(treeDeletes(run.fx, run.events)).toEqual([])
  })

  it('N replaced by a copy of itself (same bytes, another identity): OP left for doctor, nothing moved or unlinked', async () => {
    const run = await editedAbort((fx) => {
      const copy = path.join(fx.opDir, 'new-copy')
      fs.cpSync(N(fx), copy, { recursive: true, verbatimSymlinks: true })
      fs.renameSync(N(fx), path.join(fx.base, 'new-aside'))
      fs.renameSync(copy, N(fx))
    })
    const r = refusedOf(run.result)
    expect(r).toMatchObject({ staged: 'left', opDir: run.fx.opDir })
    expect(r.warnings).toContainEqual(
      expect.objectContaining({
        code: 'removal-not-done',
        status: 'kept',
        reason: 'identity-changed',
      })
    )
    expect(fs.readdirSync(run.fx.opDir).sort()).toEqual(['new', 'owner.json'])
    expect(hashOf(N(run.fx))).toBe(run.built.hash)
    expect(fs.existsSync(path.join(run.fx.staging, '.skillsmith-parked'))).toBe(false)
    expect(fs.existsSync(areaOf(run.fx))).toBe(false)
    expect(treeDeletes(run.fx, run.events)).toEqual([])
  })
})

/**
 * A step-1 failure mid-file: the third write-set file's write gets half its
 * bytes, then `ENOSPC`. `before` runs just before that failure.
 */
async function failedBuild(before: (fx: Fixture) => void) {
  const fx = makeFixture(FILES)
  const p = plan(fx, [...WRITES, create('c.txt', 'c'.repeat(64))])
  const target = path.join(fx.opDir, 'new', 'c.txt')
  const promises = fs.promises as unknown as Record<string, unknown>
  const orig = fs.promises.open
  promises.open = async (...args: unknown[]) => {
    const fh = await (orig as (...a: unknown[]) => Promise<fs.promises.FileHandle>)(...args)
    if (args[0] !== target) return fh
    let calls = 0
    return new Proxy(fh, {
      get(t, prop) {
        if (prop === 'write') {
          return async (buf: Buffer, off: number, len: number, pos: number | null) => {
            if (calls++ === 0) return t.write(buf, off, Math.floor(len / 2), pos)
            before(fx)
            const e = new Error('ENOSPC: no space left on device') as NodeJS.ErrnoException
            e.code = 'ENOSPC'
            throw e
          }
        }
        const v = Reflect.get(t, prop) as unknown
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v
      },
    })
  }
  try {
    const r = await runSpied(p, ALL_DELETES)
    return { fx, p, ...r }
  } finally {
    promises.open = orig
  }
}

describe('T-X13: a failed build is kept whole as failed-build, nothing compared', () => {
  const inode = (p: string) => fs.lstatSync(p, { bigint: true }).ino

  it('with no change: the partial tree, the half-written file included', async () => {
    const run = await failedBuild(() => undefined)
    const r = refusedOf(run.result)
    const kept = path.join(areaOf(run.fx), `${OP_ID}.failed-build`)
    expect(r).toMatchObject({
      reason: 'write-failed',
      staged: 'kept',
      keptAs: { kind: 'failed-build', path: kept },
    })
    expect(contentOf(kept)).toEqual({
      'SKILL.md': '# v2\n',
      'a.txt': 'a\n',
      'sub/': 'dir',
      'sub/b.txt': 'b2\n',
      'c.txt': 'c'.repeat(32),
    })
    expect(run.events.filter((e) => !isFs(e) && e.op === 'compare')).toEqual([])
    expect(fs.existsSync(run.fx.opDir)).toBe(false)
    expect(treeDeletes(run.fx, run.events)).toEqual([])
  })

  it('with an edited file: the edit is in the kept tree', async () => {
    const run = await failedBuild((fx) => fs.appendFileSync(path.join(N(fx), 'a.txt'), 'edit\n'))
    const kept = path.join(areaOf(run.fx), `${OP_ID}.failed-build`)
    expect(refusedOf(run.result)).toMatchObject({
      staged: 'kept',
      keptAs: { kind: 'failed-build' },
    })
    expect(fs.readFileSync(path.join(kept, 'a.txt'), 'utf8')).toBe('a\nedit\n')
    expect(treeDeletes(run.fx, run.events)).toEqual([])
  })

  it("round 8's substitution (new files at intended paths holding valid prefixes): every one kept, by inode", async () => {
    const subs: Record<string, bigint> = {}
    const run = await failedBuild((fx) => {
      for (const [rel, text] of [
        ['SKILL.md', '# v'],
        ['sub/b.txt', 'b'],
      ] as const) {
        const p = path.join(N(fx), rel)
        fs.unlinkSync(p)
        fs.writeFileSync(p, text)
        subs[rel] = inode(p)
      }
    })
    const kept = path.join(areaOf(run.fx), `${OP_ID}.failed-build`)
    expect(refusedOf(run.result)).toMatchObject({
      staged: 'kept',
      keptAs: { kind: 'failed-build' },
    })
    expect(inode(path.join(kept, 'SKILL.md'))).toBe(subs['SKILL.md'])
    expect(inode(path.join(kept, 'sub/b.txt'))).toBe(subs['sub/b.txt'])
    expect(fs.readFileSync(path.join(kept, 'SKILL.md'), 'utf8')).toBe('# v')
    expect(fs.readFileSync(path.join(kept, 'sub/b.txt'), 'utf8')).toBe('b')
    expect(run.events.filter((e) => !isFs(e) && e.op === 'compare')).toEqual([])
    // The test's own substitution unlinks are the only deletes inside N.
    expect(
      treeDeletes(run.fx, run.events)
        .map((e) => e.path)
        .sort()
    ).toEqual([path.join(N(run.fx), 'SKILL.md'), path.join(N(run.fx), 'sub/b.txt')].sort())
  })
})

describe("T-X13: identical serialization (UD18's seven substitutions) is parked whole, never deleted", () => {
  /** The live folder also holds a link to an outside file and one to an outside directory. */
  function withLinks() {
    const fx = makeFixture(FILES)
    fs.mkdirSync(path.join(fx.outside, 'dir'))
    fs.writeFileSync(path.join(fx.outside, 'dir', 'inner.txt'), 'outside dir bytes\n')
    fs.symlinkSync(path.join(fx.outside, 'secret.txt'), path.join(fx.realDir, 'link-f'))
    fs.symlinkSync(path.join(fx.outside, 'dir'), path.join(fx.realDir, 'link-d'))
    return fx
  }
  const like = (src: string, dest: string) => fs.chmodSync(dest, fs.lstatSync(src).mode & 0o7777)
  /** A user file outside staging with `text`, the same mode as `twin`. */
  const outsideFile = (fx: Fixture, name: string, text: string, twin: string) => {
    const p = path.join(fx.outside, name)
    fs.writeFileSync(p, text)
    like(twin, p)
    return p
  }
  /** Replaces N/sub with a new directory holding b.txt, made by `fill`. */
  const newSub = (fx: Fixture, fill: (dir: string) => void) => {
    const sub = path.join(N(fx), 'sub')
    const mode = fs.lstatSync(sub).mode & 0o7777
    fs.renameSync(sub, path.join(fx.base, `sub-aside-${Math.random()}`))
    fs.mkdirSync(sub)
    fill(sub)
    fs.chmodSync(sub, mode)
  }
  const subs: Array<[string, (fx: Fixture) => string[]]> = [
    [
      'a byte-identical replacement file',
      (fx) => {
        const a = path.join(N(fx), 'a.txt')
        const mode = fs.lstatSync(a).mode & 0o7777
        fs.unlinkSync(a)
        fs.writeFileSync(a, 'a\n')
        fs.chmodSync(a, mode)
        return ['a.txt']
      },
    ],
    [
      'a replacement directory with identical contents',
      (fx) => {
        const twin = path.join(N(fx), 'sub', 'b.txt')
        const mode = fs.lstatSync(twin).mode & 0o7777
        newSub(fx, (d) => {
          fs.writeFileSync(path.join(d, 'b.txt'), 'b2\n')
          fs.chmodSync(path.join(d, 'b.txt'), mode)
        })
        return ['sub', 'sub/b.txt']
      },
    ],
    [
      'a same-text symlink to an outside file',
      (fx) => {
        fs.unlinkSync(path.join(N(fx), 'link-f'))
        fs.symlinkSync(path.join(fx.outside, 'secret.txt'), path.join(N(fx), 'link-f'))
        return ['link-f']
      },
    ],
    [
      'a same-text symlink to an outside directory',
      (fx) => {
        fs.unlinkSync(path.join(N(fx), 'link-d'))
        fs.symlinkSync(path.join(fx.outside, 'dir'), path.join(N(fx), 'link-d'))
        return ['link-d']
      },
    ],
    [
      'a staged file replaced by a hard link to an outside user file',
      (fx) => {
        const a = path.join(N(fx), 'a.txt')
        const out = outsideFile(fx, 'a-copy.txt', 'a\n', a)
        fs.unlinkSync(a)
        fs.linkSync(out, a)
        return ['a.txt']
      },
    ],
    [
      'an outside hard link made to a staged file (topology only)',
      (fx) => {
        fs.linkSync(path.join(N(fx), 'a.txt'), path.join(fx.outside, 'hl.txt'))
        return ['a.txt']
      },
    ],
    [
      'a replacement directory holding a hard link to an outside user file',
      (fx) => {
        const out = outsideFile(fx, 'b-copy.txt', 'b2\n', path.join(N(fx), 'sub', 'b.txt'))
        newSub(fx, (d) => fs.linkSync(out, path.join(d, 'b.txt')))
        return ['sub', 'sub/b.txt']
      },
    ],
  ]

  for (const [label, substitute] of subs) {
    it(`${label}: parked, the substituted entries in the parked copy by inode, every outside file unchanged`, async () => {
      const fx = withLinks()
      const p = plan(fx, WRITES)
      let rels: string[] = []
      const inodes: Record<string, bigint> = {}
      const outsideBefore: Record<string, { text: string; ino: bigint; nlink: bigint }> = {}
      const snapOutside = () => {
        const out: typeof outsideBefore = {}
        for (const rel of Object.keys(contentOf(fx.outside))) {
          const abs = path.join(fx.outside, rel)
          const s = fs.lstatSync(abs, { bigint: true })
          if (s.isFile())
            out[rel] = { text: fs.readFileSync(abs, 'utf8'), ino: s.ino, nlink: s.nlink }
        }
        return out
      }
      const t = abortAt(fx, 'step4', {
        afterBuild: () => {
          const before = hashOf(N(fx))
          rels = substitute(fx)
          for (const rel of rels)
            inodes[rel] = fs.lstatSync(path.join(N(fx), rel), { bigint: true }).ino
          expect(hashOf(N(fx))).toBe(before) // it really serializes identically
          Object.assign(outsideBefore, snapOutside())
        },
      })
      const run = await runSpied(p, ALL_DELETES, t.options)
      const r = refusedOf(run.result)
      expect(r.staged).toBe('parked')
      const copy = parkedCopy(fx)
      for (const rel of rels) {
        expect(fs.lstatSync(path.join(copy, 'new', rel), { bigint: true }).ino).toBe(inodes[rel])
      }
      expect(snapOutside()).toEqual(outsideBefore)
      expect(fs.readFileSync(path.join(fx.outside, 'secret.txt'), 'utf8')).toBe('outside bytes\n')
      expect(fs.readFileSync(path.join(fx.outside, 'dir', 'inner.txt'), 'utf8')).toBe(
        'outside dir bytes\n'
      )
      expect(treeDeletes(fx, run.events).filter((e) => !e.path.startsWith(N(fx)))).toEqual([])
    })
  }
})

describe('T-X13: a write through a file opened inside N lands in the parked copy', () => {
  it('opened after the comparison, written after the park returned: parked, the write in the parked copy', async () => {
    let fd: number | null = null
    const fx = makeFixture(FILES)
    const p = plan(fx, WRITES)
    const t = abortAt(fx, 'step4', {
      abortAfterCompare: () => {
        fd = fs.openSync(path.join(N(fx), 'a.txt'), 'a')
      },
      afterPark: () => {
        fs.writeSync(fd!, 'through the fd\n')
        fs.closeSync(fd!)
      },
    })
    const run = await runSpied(p, ALL_DELETES, t.options)
    expect(refusedOf(run.result).staged).toBe('parked')
    const copy = parkedCopy(fx)
    expect(fs.readFileSync(path.join(copy, 'new', 'a.txt'), 'utf8')).toBe('a\nthrough the fd\n')
    expect(treeDeletes(fx, run.events)).toEqual([])
  })

  it("written right after the park's rename: held, the write in the parked copy, no restore line", async () => {
    let fd: number | null = null
    const fx = makeFixture(FILES)
    const p = plan(fx, WRITES)
    const lines: string[] = []
    const t = abortAt(fx, 'step4', {
      abortAfterCompare: () => {
        fd = fs.openSync(path.join(N(fx), 'a.txt'), 'a')
      },
    })
    const table = fs as unknown as Record<string, (...a: unknown[]) => unknown>
    const orig = table.renameSync!
    table.renameSync = (...args: unknown[]) => {
      const out = orig(...args)
      if (args[0] === fx.opDir) fs.writeSync(fd!, 'through the fd\n')
      return out
    }
    let run
    try {
      run = await runSpied(p, ALL_DELETES, { ...t.options, stderr: (l) => lines.push(l) })
    } finally {
      table.renameSync = orig
      fs.closeSync(fd!)
    }
    const r = refusedOf(run.result)
    const copy = parkedCopy(fx)
    expect(r).toMatchObject({ staged: 'held', parkedPath: copy, opDir: null })
    expect(fs.readFileSync(path.join(copy, 'new', 'a.txt'), 'utf8')).toBe('a\nthrough the fd\n')
    const notDone = r.warnings.find((w) => w.code === 'removal-not-done')
    expect(notDone).toMatchObject({ status: 'held', path: fx.opDir, parkedPath: copy })
    expect(JSON.stringify(r)).not.toContain('skillsmith restore')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain(copy)
    expect(lines[0]).not.toContain('skillsmith restore')
    expect(treeDeletes(fx, run.events)).toEqual([])
  })
})

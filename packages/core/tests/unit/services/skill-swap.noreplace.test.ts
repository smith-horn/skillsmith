/**
 * SMI-6531 (A1 step 4a, cross-family review round): metadata is never
 * published over an existing entry, nothing is unlinked that this run did not
 * write, and the undo's recreate of a non-directory O re-checks the bound paths.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  areaOf,
  hashOf,
  makeFixture,
  modify,
  OP_ID,
  plan,
  readRecord,
  run,
  useTmpCleanup,
} from './skill-swap.helpers.js'
import type { Fixture } from './skill-swap.helpers.js'

useTmpCleanup()

const FILES = { 'SKILL.md': '# v1\n' }

/** Unlink `p` and put a different file at its path. */
function replaceFile(p: string, text: string): void {
  fs.unlinkSync(p)
  fs.writeFileSync(p, text)
}

describe('owner.json and record.json are linked into place, never renamed over an entry', () => {
  for (const file of ['owner.json', 'record.json'] as const) {
    it(`a file planted at ${file} before its link: refused staging-unsafe, the planted file untouched`, async () => {
      const fx = makeFixture(FILES)
      const p = plan(fx, [modify('SKILL.md', '# v2\n')])
      const final = path.join(fx.opDir, file)
      const { result, trace } = await run(p, {
        trace: (t) => {
          if (t.op === 'create' && t.path === `${final}.tmp`) fs.writeFileSync(final, 'planted\n')
        },
      })
      expect(fs.readFileSync(final, 'utf8')).toBe('planted\n')
      expect(result).toMatchObject({ status: 'refused', reason: 'staging-unsafe', staged: 'left' })
      expect(trace.filter((t) => t.op === 'rename' && t.path === fx.realDir)).toEqual([])
      expect(hashOf(fx.realDir)).toBe(p.input.preTree)
    })
  }
})

describe('only files this run wrote are unlinked', () => {
  it('record.json replaced before step 13: incomplete cleanup, the replacement untouched, owner.json and the backup kept', async () => {
    const fx = makeFixture(FILES)
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    const record = path.join(fx.opDir, 'record.json')
    const { result } = await run(p, {
      hooks: { afterCommit: () => replaceFile(record, 'planted record\n') },
    })
    expect(fs.readFileSync(record, 'utf8')).toBe('planted record\n')
    expect(result).toMatchObject({
      status: 'committed',
      incomplete: { step: 'cleanup', reason: 'staging-unsafe' },
      recordPath: record,
    })
    expect(fs.existsSync(path.join(fx.opDir, 'owner.json'))).toBe(true)
    expect(hashOf(path.join(areaOf(fx), OP_ID))).toBe(p.input.preTree)
  })

  it('owner.json replaced after the record unlink: incomplete cleanup, the replacement untouched, OP kept', async () => {
    const fx = makeFixture(FILES)
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    const owner = path.join(fx.opDir, 'owner.json')
    const { result } = await run(p, {
      trace: (t) => {
        if (t.op === 'unlink' && t.path === path.join(fx.opDir, 'record.json')) {
          replaceFile(owner, 'planted owner\n')
        }
      },
    })
    expect(fs.readFileSync(owner, 'utf8')).toBe('planted owner\n')
    expect(result).toMatchObject({
      status: 'committed',
      incomplete: { step: 'cleanup', reason: 'staging-unsafe' },
    })
    expect(fs.readdirSync(fx.opDir)).toEqual(['owner.json'])
    expect(hashOf(path.join(areaOf(fx), OP_ID))).toBe(p.input.preTree)
  })

  it('the sidecar temp replaced after its link: incomplete publish, the replacement untouched, record and old folder kept', async () => {
    const fx = makeFixture(FILES)
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    const tmp = path.join(areaOf(fx), `${OP_ID}.json.tmp`)
    const { result } = await run(p, {
      trace: (t) => {
        if (t.op === 'link' && t.path === tmp) replaceFile(tmp, 'planted temp\n')
      },
    })
    expect(fs.readFileSync(tmp, 'utf8')).toBe('planted temp\n')
    expect(result).toMatchObject({
      status: 'committed',
      incomplete: { step: 'publish', reason: 'backup-unsafe' },
      recordPath: path.join(fx.opDir, 'record.json'),
    })
    readRecord(path.join(fx.opDir, 'record.json'))
    expect(hashOf(path.join(fx.opDir, 'old'))).toBe(p.input.preTree)
  })
})

describe('the undo recreate of a non-directory O re-checks the bound paths', () => {
  /** At beforeRename1 the folder becomes a symlink, so O is a symlink and the undo recreates it. */
  function swapForLink(fx: Fixture): void {
    fs.renameSync(fx.realDir, path.join(fx.base, 'original'))
    fs.symlinkSync(fx.outside, fx.realDir)
  }
  /** OP replaced by a copy of itself: same contents, another identity. */
  function replaceOpWithCopy(fx: Fixture): string {
    const orig = path.join(fx.base, 'op-orig')
    const copy = path.join(fx.base, 'op-copy')
    fs.cpSync(fx.opDir, copy, { recursive: true, verbatimSymlinks: true })
    fs.renameSync(fx.opDir, orig)
    fs.renameSync(copy, fx.opDir)
    return orig
  }

  it('a directory O, OP swapped for a copy at beforeRestore: stopped staging-unsafe before the claim, nothing made at the path', async () => {
    const fx = makeFixture(FILES)
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    p.manifest.failCasOnCall = 2 // force the undo; O is the real old folder
    let orig: string | null = null
    const { result } = await run(p, {
      hooks: {
        beforeRestore: () => {
          orig = replaceOpWithCopy(fx)
        },
      },
    })
    expect(fs.lstatSync(fx.realDir, { throwIfNoEntry: false })).toBeUndefined()
    expect(result).toMatchObject({ status: 'stopped', reason: 'staging-unsafe' })
    expect(hashOf(path.join(orig!, 'old'))).toBe(p.input.preTree)
    readRecord(path.join(orig!, 'record.json'))
  })

  for (const point of ['beforeRestore', 'beforeRecreate'] as const) {
    it(`OP swapped for a copy at ${point}: stopped staging-unsafe, nothing recreated, old and record.json kept`, async () => {
      const fx = makeFixture(FILES)
      const p = plan(fx, [modify('SKILL.md', '# v2\n')])
      p.manifest.failCasOnCall = 2 // force the undo
      let orig: string | null = null
      const { result } = await run(p, {
        hooks: {
          beforeRename1: () => swapForLink(fx),
          [point]: () => {
            orig = replaceOpWithCopy(fx)
          },
        },
      })
      // Nothing was created at the path through the replaced binding.
      expect(fs.lstatSync(fx.realDir, { throwIfNoEntry: false })).toBeUndefined()
      expect(result).toMatchObject({ status: 'stopped', reason: 'staging-unsafe' })
      expect(fs.lstatSync(path.join(orig!, 'old')).isSymbolicLink()).toBe(true)
      readRecord(path.join(orig!, 'record.json'))
      expect(p.manifest.writes).toBe(0)
    })
  }
})

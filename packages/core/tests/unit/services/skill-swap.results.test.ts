/**
 * SMI-6531 (A1 step 4a, governance round): what a result says and does not
 * say. Lock-order bugs propagate; the staging `.gitignore` hint survives; the
 * record, the journal and the result name the backup's real path; an undo
 * carries no warning about a backup it never made; the sidecar never replaces
 * a file; and no result names a record step 13 already removed.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { LockOrderError } from '../../../src/config/lock-tracker.js'
import { STAGING_GITIGNORE_HINT } from '../../../src/services/skill-write-lock.gitignore.js'
import type { ManifestCommitHandle } from '../../../src/services/skill-swap.js'
import {
  areaOf,
  FakeManifest,
  hashOf,
  makeFixture,
  modify,
  OP_ID,
  parseRecord,
  plan,
  readRecord,
  run,
  useTmpCleanup,
} from './skill-swap.helpers.js'

useTmpCleanup()

/** A port whose handle throws a `LockOrderError` from one method. */
class LockOrderPort extends FakeManifest {
  constructor(readonly throwFrom: 'casMatches' | 'preCommitCheck') {
    super({ version: '1.0.0' }, { version: '2.0.0' })
  }
  override async withManifestLock<T>(fn: (m: ManifestCommitHandle) => Promise<T>): Promise<T> {
    return super.withManifestLock((m) =>
      fn({
        ...m,
        [this.throwFrom]: async () => {
          throw new LockOrderError('inversion', 'probe: lock 3 taken in the wrong order')
        },
      })
    )
  }
}

describe('a LockOrderError is a bug, not an outcome', () => {
  for (const from of ['casMatches', 'preCommitCheck'] as const) {
    it(`thrown from the port's ${from}: swapInPlace rejects with it`, async () => {
      const fx = makeFixture({ 'SKILL.md': '# v1\n' })
      const p = plan(fx, [modify('SKILL.md', '# v2\n')])
      p.input = { ...p.input, manifest: new LockOrderPort(from) }
      await expect(run(p)).rejects.toBeInstanceOf(LockOrderError)
    })
  }

  it('thrown from the journal append: swapInPlace rejects with it', async () => {
    const fx = makeFixture({ 'SKILL.md': '# v1\n' })
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    await expect(
      run(p, {
        appendJournal: async () => {
          throw new LockOrderError('under-leaf', 'probe: journal under a leaf')
        },
      })
    ).rejects.toBeInstanceOf(LockOrderError)
  })
})

describe('the staging .gitignore hint', () => {
  function inRepo(files: Record<string, string>) {
    const fx = makeFixture(files)
    execFileSync('git', ['init', '-q', fx.base])
    return fx
  }

  it('a run whose swap created ST in a git work tree carries the hint', async () => {
    const fx = inRepo({ 'SKILL.md': '# v1\n' })
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    const { result } = await run(p)
    expect(result.status).toBe('committed')
    expect(result.gitignoreHint).toBe(STAGING_GITIGNORE_HINT)
  })

  it('a run refused before lock 1 carries it too', async () => {
    const fx = inRepo({ 'SKILL.md': '# v1\n', 'z.txt': 'z\n' })
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    const { result } = await run(p, {
      duringCopy: (rel) => {
        if (rel === 'SKILL.md') fs.writeFileSync(path.join(fx.realDir, 'z.txt'), 'mid-copy\n')
      },
    })
    expect(result).toMatchObject({ status: 'refused', reason: 'changed-since-plan' })
    expect(result.gitignoreHint).toBe(STAGING_GITIGNORE_HINT)
  })
})

describe('the backup has one fixed name (owner decision 2026-10-22)', () => {
  it('taken at plan time: refused backup-unsafe, nothing moved, the planted entry untouched', async () => {
    const fx = makeFixture({ 'SKILL.md': '# v1\n' })
    const area = areaOf(fx)
    fs.mkdirSync(path.join(area, OP_ID), { recursive: true })
    fs.writeFileSync(path.join(area, OP_ID, 'planted.txt'), 'planted')
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])

    const { result, trace, journal } = await run(p)

    expect(result).toMatchObject({ status: 'refused', reason: 'backup-unsafe', staged: 'left' })
    expect(fs.readdirSync(path.join(area, OP_ID))).toEqual(['planted.txt'])
    expect(fs.readFileSync(path.join(area, OP_ID, 'planted.txt'), 'utf8')).toBe('planted')
    expect(trace.filter((t) => t.op === 'rename' && t.path === fx.realDir)).toEqual([])
    expect(fs.existsSync(path.join(fx.opDir, 'record.json'))).toBe(false)
    expect(journal).toEqual([])
    expect(p.manifest.writes).toBe(0)
  })

  it('taken after the record, before rename 1: refused backup-unsafe, nothing moved', async () => {
    const fx = makeFixture({ 'SKILL.md': '# v1\n' })
    const area = areaOf(fx)
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    const { result, trace } = await run(p, {
      hooks: {
        afterRecord: () => {
          fs.mkdirSync(area, { recursive: true })
          fs.writeFileSync(path.join(area, `${OP_ID}.json`), 'late sidecar')
        },
      },
    })
    expect(result).toMatchObject({ status: 'refused', reason: 'backup-unsafe', staged: 'left' })
    expect(trace.filter((t) => t.op === 'rename' && t.path === fx.realDir)).toEqual([])
    expect(fs.readFileSync(path.join(area, `${OP_ID}.json`), 'utf8')).toBe('late sidecar')
    expect(hashOf(fx.realDir)).toBe(p.input.preTree)
  })

  it('a leftover <opId>.json.tmp at plan time: refused backup-unsafe, nothing moved, the temp untouched', async () => {
    const fx = makeFixture({ 'SKILL.md': '# v1\n' })
    const area = areaOf(fx)
    fs.mkdirSync(area, { recursive: true })
    const tmp = path.join(area, `${OP_ID}.json.tmp`)
    fs.writeFileSync(tmp, 'leftover temp')
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])

    const { result, trace } = await run(p)

    expect(result).toMatchObject({ status: 'refused', reason: 'backup-unsafe', staged: 'left' })
    expect(fs.readFileSync(tmp, 'utf8')).toBe('leftover temp')
    expect(trace.filter((t) => t.op === 'rename' && t.path === fx.realDir)).toEqual([])
    expect(fs.existsSync(path.join(fx.opDir, 'record.json'))).toBe(false)
    expect(hashOf(fx.realDir)).toBe(p.input.preTree)
  })

  it('a <opId>.json.tmp planted at publish time: incomplete publish backup-unsafe, the temp untouched', async () => {
    const fx = makeFixture({ 'SKILL.md': '# v1\n' })
    const area = areaOf(fx)
    const tmp = path.join(area, `${OP_ID}.json.tmp`)
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    const { result } = await run(p, {
      hooks: { beforePublish: () => fs.writeFileSync(tmp, 'late temp') },
    })
    expect(result).toMatchObject({
      status: 'committed',
      incomplete: { step: 'publish', reason: 'backup-unsafe' },
    })
    expect(fs.readFileSync(tmp, 'utf8')).toBe('late temp')
    expect(hashOf(path.join(fx.opDir, 'old'))).toBe(p.input.preTree)
  })

  it('taken at publish time: committed, incomplete publish backup-unsafe; the entry untouched, the old folder in OP', async () => {
    const fx = makeFixture({ 'SKILL.md': '# v1\n' })
    const area = areaOf(fx)
    const name = path.join(area, OP_ID)
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    let recordText: string | null = null
    const { result, journal } = await run(p, {
      hooks: {
        afterRecord: () => {
          recordText = fs.readFileSync(path.join(fx.opDir, 'record.json'), 'utf8')
        },
        beforePublish: () => {
          fs.mkdirSync(name)
          fs.writeFileSync(path.join(name, 'late.txt'), 'late')
        },
      },
    })
    expect(result).toMatchObject({
      status: 'committed',
      backupDest: name,
      incomplete: { step: 'publish', reason: 'backup-unsafe' },
      recordPath: path.join(fx.opDir, 'record.json'),
    })
    expect(fs.readdirSync(name)).toEqual(['late.txt'])
    expect(fs.readFileSync(path.join(name, 'late.txt'), 'utf8')).toBe('late')
    expect(hashOf(path.join(fx.opDir, 'old'))).toBe(p.input.preTree)
    const rec = parseRecord(recordText!)
    expect(rec.backupDest).toBe(name)
    expect(journal[0]!.backup_ref).toBe(rec.backupDest)
    readRecord(path.join(fx.opDir, 'record.json'))
  })
})

describe('an undo does not report a backup it never made', () => {
  it('a foreign edit before rename 1, then a CAS failure at commit: undone, no backup-holds-foreign-change', async () => {
    const fx = makeFixture({ 'SKILL.md': '# v1\n', 'a.txt': 'a\n' })
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    p.manifest.failCasOnCall = 2
    const { result } = await run(p, {
      hooks: { beforeRename1: () => fs.appendFileSync(path.join(fx.realDir, 'a.txt'), 'late\n') },
    })
    expect(result).toMatchObject({ status: 'undone', reason: 'changed-since-plan' })
    expect(result.warnings.filter((w) => w.code === 'backup-holds-foreign-change')).toEqual([])
    // The edit went back to the path with the old folder.
    expect(fs.readFileSync(path.join(fx.realDir, 'a.txt'), 'utf8')).toBe('a\nlate\n')
  })
})

describe('the sidecar never replaces a file', () => {
  it('a file planted at <dest>.json after the name was chosen is left byte-identical; the record is kept', async () => {
    const fx = makeFixture({ 'SKILL.md': '# v1\n' })
    const sidecar = path.join(areaOf(fx), `${OP_ID}.json`)
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    const { result } = await run(p, {
      hooks: { beforeSidecar: () => fs.writeFileSync(sidecar, 'planted sidecar\n') },
    })
    expect(fs.readFileSync(sidecar, 'utf8')).toBe('planted sidecar\n')
    expect(result).toMatchObject({
      status: 'committed',
      incomplete: { step: 'publish', reason: 'backup-unsafe' },
      recordPath: path.join(fx.opDir, 'record.json'),
    })
    readRecord(path.join(fx.opDir, 'record.json'))
    expect(hashOf(path.join(fx.opDir, 'old'))).toBe(p.input.preTree)
  })
})

describe('no result names a removed record', () => {
  it('step 13 stopping after record.json was unlinked: incomplete cleanup, no recordPath', async () => {
    const fx = makeFixture({ 'SKILL.md': '# v1\n' })
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    const record = path.join(fx.opDir, 'record.json')
    const { result } = await run(p, {
      // The trace runs right after each mutation: a file appears in OP just
      // after the record is unlinked, so step 13's second look finds it.
      trace: (t) => {
        if (t.op === 'unlink' && t.path === record) {
          fs.writeFileSync(path.join(fx.opDir, 'late.txt'), 'late')
        }
      },
    })
    expect(fs.existsSync(record)).toBe(false)
    expect(result).toMatchObject({
      status: 'committed',
      incomplete: { step: 'cleanup', reason: 'op-not-empty' },
    })
    expect(result).not.toHaveProperty('recordPath')
  })
})

describe('stopped carries a plan word', () => {
  it('rename 2 failing (new/ gone) is stopped write-failed, with the record kept', async () => {
    const fx = makeFixture({ 'SKILL.md': '# v1\n' })
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    const { result } = await run(p, {
      hooks: {
        afterRename1Syncs: () =>
          fs.renameSync(path.join(fx.opDir, 'new'), path.join(fx.base, 'new-aside')),
      },
    })
    expect(result).toMatchObject({
      status: 'stopped',
      reason: 'write-failed',
      recordPath: path.join(fx.opDir, 'record.json'),
    })
    readRecord(path.join(fx.opDir, 'record.json'))
    expect(hashOf(path.join(fx.opDir, 'old'))).toBe(p.input.preTree)
  })
})

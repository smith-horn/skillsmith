/**
 * SMI-6531 (A1 step 6a-ii): doctor `--apply` / `--undo` for each row on one
 * device (T-J1, T-J2, T-J3, T-J4, T-J10's `--apply`, T-X2's doctor half, T-R1's
 * doctor half). Every state is a real `swapInPlace` crash (`recovery.helpers.ts`).
 * Each absence assertion is paired with a presence one from the same run.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { areaOf, hashOf, makeFixture, useTmpCleanup } from '../skill-swap.helpers.js'
import { POST, PRE, s0, s1, s2, s3, un1, un2, writeJournalLine } from './recovery.helpers.js'
import {
  act,
  auditLines,
  done,
  entryOf,
  keptTrees,
  onlyMetadataRemoved,
} from './recovery.act.helpers.js'

useTmpCleanup()

const file = () => makeFixture({ 'SKILL.md': '# v1\n', 'docs/a.md': 'a\n' })

describe('T-J1: S0 keeps the staged tree', () => {
  for (const action of ['apply', 'undo'] as const) {
    it(`--${action}: the skill unchanged, N kept as unused-new, the op dir gone`, async () => {
      const fx = file()
      const st = await s0(fx)
      const before = hashOf(fx.realDir)
      const nHash = hashOf(path.join(st.opDir, 'new'))
      const a = await done(st, action)
      expect(hashOf(fx.realDir)).toBe(before)
      expect(entryOf(fx)).toEqual(PRE)
      expect(a.result.kept).toEqual([
        { tree: 'N', kind: 'unused-new', path: path.join(areaOf(fx), `${st.opId}.unused-new`) },
      ])
      expect(keptTrees(fx)[`${st.opId}.unused-new`]).toBe(nHash)
      expect(fs.existsSync(`${path.join(areaOf(fx), st.opId)}.unused-new.json`)).toBe(true)
      expect(fs.existsSync(st.opDir)).toBe(false)
      onlyMetadataRemoved(a.trace, fx)
    })
  }

  it('an edited N is kept as edited-new holding the edit, for both actions', async () => {
    for (const action of ['apply', 'undo'] as const) {
      const fx = file()
      const st = await s0(fx)
      fs.writeFileSync(path.join(st.opDir, 'new', 'SKILL.md'), '# edited in N\n')
      const a = await done(st, action)
      expect(a.result.kept.map((k) => k.kind)).toEqual(['edited-new'])
      const kept = path.join(areaOf(fx), `${st.opId}.edited-new`)
      expect(fs.readFileSync(path.join(kept, 'SKILL.md'), 'utf8')).toBe('# edited in N\n')
      expect(fs.existsSync(path.join(areaOf(fx), `${st.opId}.unused-new`))).toBe(false)
    }
  })
})

describe('T-J2: S2', () => {
  it('--apply commits the manifest to postEntry and publishes the backup', async () => {
    const fx = file()
    const st = await s2(fx)
    const oldHash = hashOf(path.join(st.opDir, 'old'))
    const a = await done(st, 'apply')
    expect(entryOf(fx)).toEqual(POST)
    expect(a.result.manifest).toBe('committed')
    expect(keptTrees(fx)[st.opId]).toBe(oldHash)
    expect(fs.existsSync(st.opDir)).toBe(false)
    expect(auditLines(fx, st.opId)).toBe(1)
    onlyMetadataRemoved(a.trace, fx)
  })

  it('a commit that drops nothing: other entries and unknown fields survive canonically', async () => {
    const fx = file()
    const st = await s2(fx)
    const file2 = path.join(fx.stateRoot, 'manifest.json')
    const m = JSON.parse(fs.readFileSync(file2, 'utf8')) as Record<string, unknown>
    const other = { version: '3.0.0', extra: { nested: [1, { z: 1, a: 2 }] } }
    m.topLevelUnknown = { keep: true }
    ;(m.installedSkills as Record<string, unknown>)['other-skill'] = other
    fs.writeFileSync(file2, JSON.stringify(m))
    await done(st, 'apply')
    const after = JSON.parse(fs.readFileSync(file2, 'utf8')) as Record<string, unknown>
    expect(after.topLevelUnknown).toEqual({ keep: true })
    expect((after.installedSkills as Record<string, unknown>)['other-skill']).toEqual(other)
    expect((after.installedSkills as Record<string, unknown>)[fx.dirName]).toEqual(POST)
  })

  it('--undo puts the old folder back, keeps the new one as undone, manifest pre', async () => {
    const fx = file()
    const st = await s2(fx)
    const oldHash = hashOf(path.join(st.opDir, 'old'))
    const newHash = hashOf(fx.realDir)
    const a = await done(st, 'undo')
    expect(hashOf(fx.realDir)).toBe(oldHash)
    expect(entryOf(fx)).toEqual(PRE)
    expect(a.result.kept).toEqual([
      { tree: 'T', kind: 'undone', path: path.join(areaOf(fx), `${st.opId}.undone`) },
    ])
    expect(keptTrees(fx)[`${st.opId}.undone`]).toBe(newHash)
    expect(fs.existsSync(st.opDir)).toBe(false)
  })
})

describe('T-J3: S3', () => {
  it('--apply publishes the backup and appends the audit record once', async () => {
    const fx = file()
    const st = await s3(fx)
    expect(auditLines(fx, st.opId)).toBe(0)
    const a = await done(st, 'apply')
    expect(a.result.audit.kind).toBe('appended')
    expect(auditLines(fx, st.opId)).toBe(1)
    expect(keptTrees(fx)[st.opId]).toBeDefined()
    expect(fs.existsSync(st.opDir)).toBe(false)
  })

  it('a record already carrying the opId is not appended again, past a mid-chain break', async () => {
    const fx = file()
    const st = await s3(fx)
    writeJournalLine(fx, st.opId)
    fs.appendFileSync(path.join(fx.base, 'journal', 'journal.jsonl'), '{ broken mid-chain\n')
    writeJournalLine(fx, 'b'.repeat(32), 'apply')
    const a = await done(st, 'apply')
    expect(a.result.audit.kind).toBe('present')
    expect(auditLines(fx, st.opId)).toBe(1)
  })

  it('a non-update line with the same suggestion_id does not count: doctor still appends', async () => {
    const fx = file()
    const st = await s3(fx)
    const j = path.join(fx.base, 'journal', 'journal.jsonl')
    fs.mkdirSync(path.dirname(j), { recursive: true })
    fs.writeFileSync(
      j,
      JSON.stringify({ tool: 'apply', suggestion_id: st.opId, record_hash: 'f'.repeat(64) }) + '\n'
    )
    const a = await done(st, 'apply')
    expect(a.result.audit.kind).toBe('appended')
    expect(auditLines(fx, st.opId)).toBe(1)
  })

  it('a torn tail does not block: finished, audit-not-recorded naming the journal', async () => {
    const fx = file()
    const st = await s3(fx)
    writeJournalLine(fx, 'c'.repeat(32), 'update', true)
    const a = await done(st, 'apply')
    expect(a.result.audit).toMatchObject({ kind: 'not-recorded' })
    if (a.result.audit.kind === 'not-recorded') {
      expect(a.result.audit.detail).toContain('audit-not-recorded')
      expect(a.result.audit.detail).toContain('journal.jsonl')
    }
    expect(auditLines(fx, st.opId)).toBe(0)
    expect(keptTrees(fx)[st.opId]).toBeDefined()
    expect(fs.existsSync(st.opDir)).toBe(false)
  })

  it('a last line that names no chain head: audit-not-recorded says so', async () => {
    const fx = file()
    const st = await s3(fx)
    writeJournalLine(fx, 'c'.repeat(32), 'update')
    const a = await done(st, 'apply')
    expect(a.result.audit).toMatchObject({ kind: 'not-recorded' })
    if (a.result.audit.kind === 'not-recorded') {
      expect(a.result.audit.detail).toContain('names no chain head')
    }
    expect(a.trace.some((t) => t.op === 'journal-append')).toBe(false)
    expect(keptTrees(fx)[st.opId]).toBeDefined()
  })

  it('a record already present is not traced as a journal append', async () => {
    const fx = file()
    const st = await s3(fx)
    writeJournalLine(fx, st.opId)
    const a = await done(st, 'apply')
    expect(a.result.audit.kind).toBe('present')
    expect(a.trace.some((t) => t.op === 'journal-append')).toBe(false)
  })

  it('--undo is not offered: the update is complete', async () => {
    const fx = file()
    const st = await s3(fx)
    const a = await act(st, 'undo')
    expect(a.result).toMatchObject({ status: 'refused', reason: 'recovery-not-offered' })
    expect(fs.existsSync(path.join(st.opDir, 'record.json'))).toBe(true)
  })
})

describe('T-X2 doctor half: S1 between the renames', () => {
  it('--apply installs N, commits and keeps the backup', async () => {
    const fx = file()
    const st = await s1(fx)
    const newHash = hashOf(path.join(st.opDir, 'new'))
    const a = await done(st, 'apply')
    expect(hashOf(fx.realDir)).toBe(newHash)
    expect(entryOf(fx)).toEqual(POST)
    expect(a.result.installed).toBe('N')
    expect(keptTrees(fx)[st.opId]).toBeDefined()
    expect(fs.existsSync(st.opDir)).toBe(false)
  })

  it('--undo puts O back byte-identical and keeps N as unused-new', async () => {
    const fx = file()
    const st = await s1(fx)
    const oldHash = hashOf(path.join(st.opDir, 'old'))
    const a = await done(st, 'undo')
    expect(hashOf(fx.realDir)).toBe(oldHash)
    expect(entryOf(fx)).toEqual(PRE)
    expect(a.result.kept.map((k) => k.kind)).toEqual(['unused-new'])
  })

  it('a rename that fails after the claim leaves the claim as a row, and the rerun finishes', async () => {
    const fx = file()
    const st = await s1(fx)
    const first = await act(
      st,
      'apply',
      {},
      {
        swap: {
          hooks: {
            afterClaim: () => {
              throw new Error('rename(N, T) failed after the claim')
            },
          },
        },
      }
    )
    expect(first.result.status).toBe('stopped')
    expect(fs.readdirSync(fx.realDir)).toEqual([])
    const claimIno = fs.lstatSync(fx.realDir).ino
    expect(fs.existsSync(path.join(st.opDir, 'new'))).toBe(true)
    const again = await done(st, 'apply')
    expect(again.result.from).toContain('S1')
    expect(fs.lstatSync(fx.realDir).ino).not.toBe(claimIno)
    expect(entryOf(fx)).toEqual(POST)
  })
})

describe('T-J10: UN1 and UN2 --apply finish the undo', () => {
  it('UN1: O installed, U kept as undone', async () => {
    const fx = file()
    const st = await un1(fx)
    const oldHash = hashOf(path.join(st.opDir, 'old'))
    const a = await done(st, 'apply')
    expect(hashOf(fx.realDir)).toBe(oldHash)
    expect(a.result.kept.map((k) => k.kind)).toEqual(['undone'])
    expect(fs.existsSync(st.opDir)).toBe(false)
  })

  it('UN1 with an empty claim at T: renamed over the bound claim', async () => {
    const fx = file()
    const st = await un1(fx)
    fs.mkdirSync(fx.realDir)
    const a = await done(st, 'apply')
    expect(a.result.installed).toBe('O')
    expect(fs.readFileSync(path.join(fx.realDir, 'SKILL.md'), 'utf8')).toBe('# v1\n')
  })

  it('a U edited after the restore is kept as conflict, not undone', async () => {
    const fx = file()
    const st = await un2(fx)
    fs.writeFileSync(path.join(st.opDir, 'undone', 'SKILL.md'), '# edited in U\n')
    const a = await done(st, 'apply')
    expect(a.result.kept.map((k) => k.kind)).toEqual(['conflict'])
    expect(a.result.warnings.some((w) => w.code === 'conflict-kept')).toBe(true)
    const kept = path.join(areaOf(fx), `${st.opId}.conflict`)
    expect(fs.readFileSync(path.join(kept, 'SKILL.md'), 'utf8')).toBe('# edited in U\n')
  })
})

describe('T-J4: doctor never overwrites or deletes a later edit', () => {
  it('an edit in the live new folder before the commit: committed with live-folder-changed', async () => {
    const fx = file()
    const st = await s2(fx)
    fs.writeFileSync(path.join(fx.realDir, 'SKILL.md'), '# live edit\n')
    const a = await done(st, 'apply')
    expect(a.result.warnings.some((w) => w.code === 'live-folder-changed')).toBe(true)
    expect(fs.readFileSync(path.join(fx.realDir, 'SKILL.md'), 'utf8')).toBe('# live edit\n')
    expect(entryOf(fx)).toEqual(POST)
  })

  it('the same edit, --undo: the old folder back, the edit kept in <opId>.conflict', async () => {
    const fx = file()
    const st = await s2(fx)
    fs.writeFileSync(path.join(fx.realDir, 'SKILL.md'), '# live edit\n')
    const a = await done(st, 'undo')
    expect(a.result.kept.map((k) => k.kind)).toEqual(['conflict'])
    const kept = path.join(areaOf(fx), `${st.opId}.conflict`)
    expect(fs.readFileSync(path.join(kept, 'SKILL.md'), 'utf8')).toBe('# live edit\n')
    expect(fs.readFileSync(path.join(fx.realDir, 'SKILL.md'), 'utf8')).toBe('# v1\n')
  })

  it('an edit in O after rename 1: --apply finishes with the edit in the backup', async () => {
    const fx = file()
    const st = await s1(fx)
    fs.writeFileSync(path.join(st.opDir, 'old', 'SKILL.md'), '# edit in O\n')
    await done(st, 'apply')
    expect(fs.readFileSync(path.join(areaOf(fx), st.opId, 'SKILL.md'), 'utf8')).toBe(
      '# edit in O\n'
    )
  })

  it('an edit in N after rename 1: --apply refuses with zero mutation; --undo keeps it edited-new', async () => {
    const fx = file()
    const st = await s1(fx)
    fs.writeFileSync(path.join(st.opDir, 'new', 'SKILL.md'), '# edit in N\n')
    const refused = await act(st, 'apply')
    expect(refused.result).toMatchObject({ status: 'refused', reason: 'recovery-conflict' })
    expect(fs.existsSync(fx.realDir)).toBe(false)
    expect(fs.existsSync(path.join(st.opDir, 'record.json'))).toBe(true)
    const a = await done(st, 'undo')
    expect(a.result.kept.map((k) => k.kind)).toEqual(['edited-new'])
    const kept = path.join(areaOf(fx), `${st.opId}.edited-new`)
    expect(fs.readFileSync(path.join(kept, 'SKILL.md'), 'utf8')).toBe('# edit in N\n')
    expect(fs.readFileSync(path.join(fx.realDir, 'SKILL.md'), 'utf8')).toBe('# v1\n')
  })
})

/**
 * SMI-6531 (A1 step 4a): T-X3 and T-X4, the skill folder replaced (by another
 * folder, or by a symlink) just before rename 1.
 *
 * Two windows each: at `beforeRename1Check` (before step 6's `lstat`), step 6
 * refuses and nothing is renamed; at `beforeRename1` (after that `lstat`,
 * before the rename syscall), rename 1 moves the replacement into OP, step 8
 * detects it, and the undo puts it back at the path.
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
  snapshot,
  useTmpCleanup,
} from './skill-swap.helpers.js'
import type { Fixture } from './skill-swap.helpers.js'

useTmpCleanup()

/** Moves the real folder aside and puts another folder at its path. */
function replaceWithFolder(fx: Fixture): () => { hash: string; ino: bigint } {
  let made: { hash: string; ino: bigint } | null = null
  return () => {
    fs.renameSync(fx.realDir, path.join(fx.base, 'original'))
    fs.mkdirSync(fx.realDir)
    fs.writeFileSync(path.join(fx.realDir, 'SKILL.md'), '# someone else\n')
    fs.writeFileSync(path.join(fx.realDir, 'theirs.txt'), 'theirs\n')
    made = { hash: hashOf(fx.realDir), ino: fs.lstatSync(fx.realDir, { bigint: true }).ino }
    return made
  }
}

const renamesOf = (trace: Array<{ op: string; path?: string }>, p: string) =>
  trace.filter((t) => t.op === 'rename' && t.path === p)

describe('T-X3: the folder replaced just before the swap', () => {
  it('at beforeRename1Check: refused target-changed, the replacement untouched, nothing renamed', async () => {
    const fx = makeFixture({ 'SKILL.md': '# v1\n' })
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    const replace = replaceWithFolder(fx)
    let made: { hash: string; ino: bigint } | null = null

    const { result, trace } = await run(p, {
      hooks: { beforeRename1Check: () => void (made = replace()) },
    })

    expect(result).toMatchObject({ status: 'refused', reason: 'target-changed', staged: 'left' })
    expect(hashOf(fx.realDir)).toBe(made!.hash)
    expect(fs.lstatSync(fx.realDir, { bigint: true }).ino).toBe(made!.ino)
    expect(renamesOf(trace, fx.realDir)).toEqual([])
    expect(p.manifest.writes).toBe(0)
  })

  it('at beforeRename1: step 8 detects it, the undo puts the replacement back byte-identical (target-changed)', async () => {
    const fx = makeFixture({ 'SKILL.md': '# v1\n' })
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    const replace = replaceWithFolder(fx)
    let made: { hash: string; ino: bigint } | null = null

    const { result } = await run(p, { hooks: { beforeRename1: () => void (made = replace()) } })

    expect(result).toMatchObject({
      status: 'undone',
      reason: 'target-changed',
      keptAs: 'undone',
      keptPath: path.join(areaOf(fx), `${OP_ID}.undone`),
    })
    expect(hashOf(fx.realDir)).toBe(made!.hash)
    expect(fs.lstatSync(fx.realDir, { bigint: true }).ino).toBe(made!.ino)
    expect(p.manifest.writes).toBe(0)
    // The new folder is kept, not lost; staging is empty.
    expect(fs.readFileSync(path.join(areaOf(fx), `${OP_ID}.undone`, 'SKILL.md'), 'utf8')).toBe(
      '# v2\n'
    )
    expect(fs.existsSync(fx.opDir)).toBe(false)
  })
})

describe('T-X4: the folder swapped for a symlink', () => {
  function swapForLink(fx: Fixture): void {
    fs.renameSync(fx.realDir, path.join(fx.base, 'original'))
    fs.symlinkSync(fx.outside, fx.realDir)
  }

  it('at beforeRename1Check: nothing renamed, nothing written through the link', async () => {
    const fx = makeFixture({ 'SKILL.md': '# v1\n' })
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    const outsideBefore = snapshot(fx.outside)

    const { result, trace } = await run(p, { hooks: { beforeRename1Check: () => swapForLink(fx) } })

    expect(result).toMatchObject({ status: 'refused', reason: 'target-changed' })
    expect(snapshot(fx.outside)).toEqual(outsideBefore)
    expect(fs.readlinkSync(fx.realDir)).toBe(fx.outside)
    expect(renamesOf(trace, fx.realDir)).toEqual([])
  })

  it('at beforeRename1: the link is displaced, never followed, and recreated at the path', async () => {
    // Plan §3.0 item 9's residual: a swap between step 6's check and its rename
    // cannot be prevented without directory-fd syscalls. The guarantee is that
    // the link is moved as a link (rename never follows), nothing is written
    // through it, and the undo recreates it (a new inode, the same text) while
    // the original link is kept as a conflict copy.
    const fx = makeFixture({ 'SKILL.md': '# v1\n' })
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    const outsideBefore = snapshot(fx.outside)

    const { result, trace } = await run(p, { hooks: { beforeRename1: () => swapForLink(fx) } })

    // It was displaced: rename 1 moved the link itself into OP.
    expect(renamesOf(trace, fx.realDir).map((t) => (t as { dest?: string }).dest)).toContain(
      path.join(fx.opDir, 'old')
    )
    const conflict = path.join(areaOf(fx), `${OP_ID}.conflict`)
    expect(result).toMatchObject({
      status: 'undone',
      reason: 'target-changed',
      keptAs: 'undone',
      warnings: [{ code: 'conflict-kept', path: conflict }],
    })
    expect(fs.lstatSync(fx.realDir).isSymbolicLink()).toBe(true)
    expect(fs.readlinkSync(fx.realDir)).toBe(fx.outside)
    expect(fs.lstatSync(conflict).isSymbolicLink()).toBe(true)
    expect(fs.readlinkSync(conflict)).toBe(fx.outside)
    expect(fs.existsSync(`${conflict}.json`)).toBe(true)
    expect(snapshot(fx.outside)).toEqual(outsideBefore)
    expect(p.manifest.writes).toBe(0)
    expect(fs.existsSync(fx.opDir)).toBe(false)
  })
})

describe('the undo restores a non-directory O without ever replacing an entry', () => {
  /** At beforeRename1, the folder is swapped for a regular file. */
  function swapForFile(fx: Fixture): void {
    fs.renameSync(fx.realDir, path.join(fx.base, 'original'))
    fs.writeFileSync(fx.realDir, 'a file where the folder was\n')
  }
  const plantedAt = (p: string) => {
    const st = fs.lstatSync(p)
    return { isFile: st.isFile(), text: st.isFile() ? fs.readFileSync(p, 'utf8') : null }
  }

  it('O a regular file: restored as the same inode, the original kept as a conflict copy', async () => {
    const fx = makeFixture({ 'SKILL.md': '# v1\n' })
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    let ino: bigint | null = null
    const { result, trace } = await run(p, {
      hooks: {
        beforeRename1: () => {
          swapForFile(fx)
          ino = fs.lstatSync(fx.realDir, { bigint: true }).ino
        },
      },
    })
    const conflict = path.join(areaOf(fx), `${OP_ID}.conflict`)
    // A hard link is traced as one, from O to the path, never as a create.
    expect(trace).toContainEqual({ op: 'link', path: path.join(fx.opDir, 'old'), dest: fx.realDir })
    expect(trace.filter((t) => t.op === 'create' && t.path === fx.realDir)).toEqual([])
    expect(result).toMatchObject({ status: 'undone', reason: 'target-changed', keptAs: 'undone' })
    expect(plantedAt(fx.realDir)).toEqual({ isFile: true, text: 'a file where the folder was\n' })
    expect(fs.lstatSync(fx.realDir, { bigint: true }).ino).toBe(ino)
    expect(fs.readFileSync(conflict, 'utf8')).toBe('a file where the folder was\n')
    expect(fs.existsSync(fx.opDir)).toBe(false)
  })

  for (const kind of ['symlink', 'file'] as const) {
    it(`O a ${kind}, an entry planted at the path before the restore: stopped target-changed, the entry untouched`, async () => {
      const fx = makeFixture({ 'SKILL.md': '# v1\n' })
      const p = plan(fx, [modify('SKILL.md', '# v2\n')])
      const { result } = await run(p, {
        hooks: {
          beforeRename1: () => {
            if (kind === 'symlink') {
              fs.renameSync(fx.realDir, path.join(fx.base, 'original'))
              fs.symlinkSync(fx.outside, fx.realDir)
            } else {
              swapForFile(fx)
            }
          },
          beforeRestore: () => fs.writeFileSync(fx.realDir, 'planted\n'),
        },
      })
      // The planted entry first: whatever the outcome, it must be byte-identical.
      expect(plantedAt(fx.realDir)).toEqual({ isFile: true, text: 'planted\n' })
      expect(result).toMatchObject({
        status: 'stopped',
        reason: 'target-changed',
        recordPath: path.join(fx.opDir, 'record.json'),
      })
      readRecord(path.join(fx.opDir, 'record.json'))
      expect(fs.lstatSync(path.join(fx.opDir, 'old')).isDirectory()).toBe(false)
      expect(p.manifest.writes).toBe(0)
    })
  }
})

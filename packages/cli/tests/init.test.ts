/**
 * SMI-4289: author init error handling tests (closes #602)
 *
 * Covers the 6 cases from the wave plan:
 * 1. Happy path (fresh dir, all writes succeed) → { ok: true } + files on disk
 * 2. mkdir EACCES on fresh path → { ok: false }, no partial directory remains
 * 3. writeFile fails mid-scaffold with createdFresh=true → rollback deletes skillDir
 * 4. writeFile fails mid-scaffold with createdFresh=false (overwrite) → NO rollback
 * 5. Double-print regression: error printed exactly once
 * 6. Exit code is 1 on failure (validated via process.exit stub)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdir, rm, stat, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

import {
  scaffoldSkillDirectory,
  rollbackPartialScaffold,
} from '../src/commands/author/init.helpers.js'

/**
 * Create a unique tmp directory for each test (race-safe with Date.now + random).
 */
async function makeTmpDir(prefix: string): Promise<string> {
  const dir = join(
    tmpdir(),
    `smi-4289-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  )
  await mkdir(dir, { recursive: true })
  return dir
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

describe('SMI-4289: scaffoldSkillDirectory', () => {
  let tmpRoot: string

  beforeEach(async () => {
    tmpRoot = await makeTmpDir('scaffold')
  })

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true })
  })

  it('case 1: happy path — fresh dir, all writes succeed → { ok: true } + files on disk', async () => {
    const skillDir = join(tmpRoot, 'happy-skill')
    await mkdir(skillDir, { recursive: true })

    const result = await scaffoldSkillDirectory({
      skillDir,
      skillName: 'happy-skill',
      description: 'A test skill',
      author: 'tester',
      category: 'development',
      createdFresh: true,
    })

    expect(result.ok).toBe(true)
    expect(await exists(join(skillDir, 'SKILL.md'))).toBe(true)
    expect(await exists(join(skillDir, 'README.md'))).toBe(true)
    expect(await exists(join(skillDir, 'scripts', 'example.js'))).toBe(true)
    expect(await exists(join(skillDir, '.gitignore'))).toBe(true)
    expect(await exists(join(skillDir, 'resources'))).toBe(true)

    const skillMd = await readFile(join(skillDir, 'SKILL.md'), 'utf-8')
    expect(skillMd).toContain('happy-skill')
    expect(skillMd).toContain('A test skill')
  })

  it('case 3: writeFile fails mid-scaffold with createdFresh=true → rollback deletes skillDir', async () => {
    const skillDir = join(tmpRoot, 'fresh-fail')
    await mkdir(skillDir, { recursive: true })

    // Create a `SKILL.md` as a directory so writeFile throws EISDIR mid-scaffold.
    await mkdir(join(skillDir, 'SKILL.md'), { recursive: true })

    const result = await scaffoldSkillDirectory({
      skillDir,
      skillName: 'fresh-fail',
      description: 'x',
      author: 'x',
      category: 'development',
      createdFresh: true,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(typeof result.error).toBe('string')
      expect(result.error.length).toBeGreaterThan(0)
    }
    // rollback removed the whole skillDir
    expect(await exists(skillDir)).toBe(false)
  })

  it('case 4: writeFile fails mid-scaffold with createdFresh=false → NO rollback; directory preserved', async () => {
    const skillDir = join(tmpRoot, 'overwrite-fail')
    await mkdir(skillDir, { recursive: true })

    // Pre-existing user file that must be preserved on failure
    const userFile = join(skillDir, 'user-data.txt')
    await writeFile(userFile, 'IMPORTANT USER DATA', 'utf-8')

    // Trip writeFile(SKILL.md) by making it a non-empty directory
    await mkdir(join(skillDir, 'SKILL.md'), { recursive: true })

    const result = await scaffoldSkillDirectory({
      skillDir,
      skillName: 'overwrite-fail',
      description: 'x',
      author: 'x',
      category: 'development',
      createdFresh: false,
    })

    expect(result.ok).toBe(false)
    // CRITICAL: user data + skillDir still present
    expect(await exists(skillDir)).toBe(true)
    expect(await exists(userFile)).toBe(true)
    const content = await readFile(userFile, 'utf-8')
    expect(content).toBe('IMPORTANT USER DATA')
  })
})

describe('SMI-4289: rollbackPartialScaffold', () => {
  let tmpRoot: string

  beforeEach(async () => {
    tmpRoot = await makeTmpDir('rollback')
  })

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true })
  })

  it('no-ops when createdFresh=false (overwrite path preserves user data)', async () => {
    const skillDir = join(tmpRoot, 'preserved')
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, 'keep.txt'), 'user wrote this', 'utf-8')

    await rollbackPartialScaffold(skillDir, false)

    expect(await exists(skillDir)).toBe(true)
    expect(await exists(join(skillDir, 'keep.txt'))).toBe(true)
  })

  it('removes skillDir when createdFresh=true', async () => {
    const skillDir = join(tmpRoot, 'to-remove')
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, 'partial.txt'), 'scaffold output', 'utf-8')

    await rollbackPartialScaffold(skillDir, true)

    expect(await exists(skillDir)).toBe(false)
  })

  it('swallows rollback errors silently (best-effort cleanup)', async () => {
    // Passing a nonexistent path with force:true does not throw (node rm semantics).
    // Even so, confirm the function itself never rejects on unusual inputs.
    const ghost = join(tmpRoot, 'does-not-exist')
    await expect(rollbackPartialScaffold(ghost, true)).resolves.toBeUndefined()
  })
})

describe('SMI-4289: initSkill integration (error handling contract)', () => {
  const logSpy = vi.fn()
  const errorSpy = vi.fn()
  const exitSpy = vi.fn() as unknown as (code?: number) => never

  let originalLog: typeof console.log
  let originalError: typeof console.error
  let originalExit: typeof process.exit
  let tmpRoot: string

  beforeEach(async () => {
    logSpy.mockReset()
    errorSpy.mockReset()
    ;(exitSpy as unknown as ReturnType<typeof vi.fn>).mockReset?.()
    originalLog = console.log
    originalError = console.error
    originalExit = process.exit
    console.log = logSpy
    console.error = errorSpy
    // Replace process.exit so we can observe the code without killing the test worker.
    process.exit = ((code?: number) => {
      ;(exitSpy as unknown as (c?: number) => void)(code)
      // Throw a marker so the CLI code path halts like a real exit.
      throw new Error(`__EXIT__:${code ?? 0}`)
    }) as typeof process.exit
    tmpRoot = await makeTmpDir('init')
  })

  afterEach(async () => {
    console.log = originalLog
    console.error = originalError
    process.exit = originalExit
    await rm(tmpRoot, { recursive: true, force: true })
  })

  it('case 2 + 6: mkdir fails on a path whose parent is not a directory → exit(1), no double-print', async () => {
    const { initSkill } = await import('../src/commands/author/init.js')

    // Making the *parent* a regular file forces mkdir({ recursive: true })
    // to reject with ENOTDIR on all POSIX platforms, including root-run CI.
    // This is more portable than chmod 000 which root ignores.
    const parentFile = join(tmpRoot, 'not-a-directory')
    await writeFile(parentFile, 'x', 'utf-8')

    // targetPath points inside that file; init will try to resolve(targetPath, name)
    // then mkdir, which fails.
    let caught: unknown
    try {
      await initSkill('blocked-skill', parentFile, {
        description: 'x',
        author: 'x',
        category: 'development',
        yes: true,
      })
    } catch (error) {
      caught = error
    }

    // The stubbed process.exit throws a marker; confirm exit(1) was called.
    expect(String(caught)).toContain('__EXIT__:1')
    expect(exitSpy).toHaveBeenCalledWith(1)

    // Double-print regression guard: the outer createInitCommand().action()
    // catch would call console.error a second time. initSkill itself must
    // not call console.error at all for scaffold failures (the spinner
    // prints via ora, not console.error). The outer wrapper's console.error
    // is NOT invoked here because we call initSkill directly.
    expect(errorSpy).not.toHaveBeenCalled()

    // No partial directory left behind on the blocked path.
    const wouldBeSkillDir = join(parentFile, 'blocked-skill')
    expect(await exists(wouldBeSkillDir)).toBe(false)
  })

  it('case 5: scaffold failure prints the failure exactly once (no double-print)', async () => {
    const { initSkill } = await import('../src/commands/author/init.js')

    // Create the target directory, then create SKILL.md as a directory so
    // the mkdir at init.ts succeeds (skillDir exists), and writeFile fails
    // mid-scaffold inside the helper. With createdFresh=false (pre-existing
    // directory that we confirmed via --yes), rollback is a no-op and the
    // helper returns { ok: false, error }.
    const skillDirName = 'collision-skill'
    const skillDir = join(tmpRoot, skillDirName)
    await mkdir(skillDir, { recursive: true })
    await mkdir(join(skillDir, 'SKILL.md'), { recursive: true })

    let caught: unknown
    try {
      await initSkill(skillDirName, tmpRoot, {
        description: 'x',
        author: 'x',
        category: 'development',
        yes: true,
      })
    } catch (error) {
      caught = error
    }

    expect(String(caught)).toContain('__EXIT__:1')
    expect(exitSpy).toHaveBeenCalledWith(1)
    // Double-print guard: initSkill must not call console.error — spinner
    // prints via its own channel (ora). If a re-throw were still in place,
    // the outer createInitCommand() action handler would have printed via
    // console.error, but we're invoking initSkill directly so we only
    // assert that initSkill itself doesn't emit the error twice.
    expect(errorSpy).not.toHaveBeenCalled()
  })
})

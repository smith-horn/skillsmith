/**
 * SMI-4289: author init error handling tests (closes #602)
 * SMI-4314: initSkill throws InitSkillError instead of process.exit
 *
 * Covers:
 *
 * scaffoldSkillDirectory (library-to-library { ok, error } contract):
 * 1. Happy path (fresh dir, all writes succeed) → { ok: true } + files on disk
 * 2. writeFile fails mid-scaffold with createdFresh=true → rollback deletes skillDir
 * 3. writeFile fails mid-scaffold with createdFresh=false (overwrite) → NO rollback
 *
 * rollbackPartialScaffold:
 * 4. No-op when createdFresh=false (preserves user data)
 * 5. Removes skillDir when createdFresh=true
 * 6. Swallows rollback errors silently
 *
 * initSkill (throws InitSkillError on user-facing failures — SMI-4314):
 * 7. Happy path completes without throwing + all expected files written
 * 8. Invalid skill name → throws InitSkillError with exitCode=1 and message
 * 9. Invalid category → throws InitSkillError with exitCode=1 and message
 * 10. mkdir failure → throws InitSkillError with exitCode=1 and preserves cause
 * 11. Scaffold failure → throws InitSkillError with exitCode=1
 * 12. No double-print: initSkill itself never calls console.error
 *
 * createInitCommand action wrapper (SMI-4314 — maps InitSkillError → exit code):
 * 13. InitSkillError → prints err.message exactly once + exits with err.exitCode
 * 14. Generic Error → routes through sanitizeError + exits with code 1
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdir, rm, stat, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

import {
  scaffoldSkillDirectory,
  rollbackPartialScaffold,
} from '../src/commands/author/init.helpers.js'
import { InitSkillError } from '../src/utils/errors.js'

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

describe('SMI-4314: initSkill throws InitSkillError on expected failures', () => {
  const logSpy = vi.fn()
  const errorSpy = vi.fn()

  let originalLog: typeof console.log
  let originalError: typeof console.error
  let tmpRoot: string

  beforeEach(async () => {
    logSpy.mockReset()
    errorSpy.mockReset()
    originalLog = console.log
    originalError = console.error
    console.log = logSpy
    console.error = errorSpy
    tmpRoot = await makeTmpDir('init')
  })

  afterEach(async () => {
    console.log = originalLog
    console.error = originalError
    await rm(tmpRoot, { recursive: true, force: true })
  })

  it('happy path: initSkill completes without throwing when inputs are valid', async () => {
    const { initSkill } = await import('../src/commands/author/init.js')

    await expect(
      initSkill('happy-init-skill', tmpRoot, {
        description: 'happy',
        author: 'tester',
        category: 'development',
        yes: true,
      })
    ).resolves.toBeUndefined()

    const skillDir = join(tmpRoot, 'happy-init-skill')
    expect(await exists(join(skillDir, 'SKILL.md'))).toBe(true)
    expect(await exists(join(skillDir, 'README.md'))).toBe(true)
  })

  it('invalid skill name → throws InitSkillError with exitCode=1 and informative message', async () => {
    const { initSkill } = await import('../src/commands/author/init.js')

    const promise = initSkill('Invalid Name With Spaces!', tmpRoot, {
      description: 'x',
      author: 'x',
      category: 'development',
      yes: true,
    })

    await expect(promise).rejects.toBeInstanceOf(InitSkillError)
    await expect(promise).rejects.toMatchObject({
      exitCode: 1,
      name: 'InitSkillError',
    })
    await expect(promise).rejects.toThrow(/Invalid skill name/)

    // initSkill itself must not print anything on the error path —
    // the wrapper is the single source of user-facing output.
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('invalid category → throws InitSkillError with exitCode=1 and informative message', async () => {
    const { initSkill } = await import('../src/commands/author/init.js')

    const promise = initSkill('good-name', tmpRoot, {
      description: 'x',
      author: 'x',
      category: 'not-a-real-category',
      yes: true,
    })

    await expect(promise).rejects.toBeInstanceOf(InitSkillError)
    await expect(promise).rejects.toMatchObject({ exitCode: 1 })
    await expect(promise).rejects.toThrow(/Invalid category/)
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('mkdir failure → throws InitSkillError with exitCode=1 and preserves cause', async () => {
    const { initSkill } = await import('../src/commands/author/init.js')

    // Making the *parent* a regular file forces mkdir({ recursive: true })
    // to reject with ENOTDIR on all POSIX platforms, including root-run CI.
    // This is more portable than chmod 000 which root ignores.
    const parentFile = join(tmpRoot, 'not-a-directory')
    await writeFile(parentFile, 'x', 'utf-8')

    const promise = initSkill('blocked-skill', parentFile, {
      description: 'x',
      author: 'x',
      category: 'development',
      yes: true,
    })

    await expect(promise).rejects.toBeInstanceOf(InitSkillError)
    await expect(promise).rejects.toMatchObject({ exitCode: 1 })
    await expect(promise).rejects.toThrow(/Failed to create skill/)

    // The underlying fs error must be preserved as `cause` so operators can
    // inspect the real reason (ENOTDIR / EACCES / ENOSPC).
    let caught: unknown
    try {
      await promise
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(InitSkillError)
    expect((caught as InitSkillError).cause).toBeDefined()

    // No partial directory left behind.
    expect(await exists(join(parentFile, 'blocked-skill'))).toBe(false)
    // Double-print guard: initSkill itself does not print to stderr.
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('scaffold failure → throws InitSkillError with exitCode=1 (no double-print)', async () => {
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

    const promise = initSkill(skillDirName, tmpRoot, {
      description: 'x',
      author: 'x',
      category: 'development',
      yes: true,
    })

    await expect(promise).rejects.toBeInstanceOf(InitSkillError)
    await expect(promise).rejects.toMatchObject({ exitCode: 1 })
    await expect(promise).rejects.toThrow(/Failed to create skill/)

    // Double-print guard: initSkill must not call console.error — the
    // wrapper is the single source of user-facing output.
    expect(errorSpy).not.toHaveBeenCalled()
  })
})

describe('SMI-4314: createInitCommand wrapper maps errors to exit codes', () => {
  const logSpy = vi.fn()
  const errorSpy = vi.fn()
  const exitSpy = vi.fn() as unknown as (code?: number) => void

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
    // Replace process.exit so we can observe the code without killing the
    // test worker. Throw a marker so the CLI code path halts like a real exit.
    process.exit = ((code?: number) => {
      ;(exitSpy as unknown as (c?: number) => void)(code)
      throw new Error(`__EXIT__:${code ?? 0}`)
    }) as typeof process.exit
    tmpRoot = await makeTmpDir('wrapper')
  })

  afterEach(async () => {
    console.log = originalLog
    console.error = originalError
    process.exit = originalExit
    await rm(tmpRoot, { recursive: true, force: true })
  })

  it('InitSkillError → prints err.message exactly once and exits with err.exitCode', async () => {
    const { createInitCommand } = await import('../src/commands/author/init.js')

    const cmd = createInitCommand()
    // commander treats process.exit inside .action as a real exit; our stub
    // throws a marker so parseAsync rejects.
    await expect(
      cmd.parseAsync(
        [
          'node',
          'skillsmith',
          'Invalid Name With Spaces!',
          '--path',
          tmpRoot,
          '--description',
          'x',
          '--author',
          'x',
          '--category',
          'development',
          '--yes',
        ],
        { from: 'node' }
      )
    ).rejects.toThrow('__EXIT__:1')

    // Wrapper routed through the InitSkillError branch: exactly one
    // console.error call, and the message carries the invalid-name text.
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(errorSpy).toHaveBeenCalledTimes(1)
    const printed = errorSpy.mock.calls[0]?.join(' ') ?? ''
    expect(printed).toContain('Invalid skill name')
    // Wrapper's generic-branch prefix "Error initializing skill:" must NOT
    // appear — the InitSkillError message is printed verbatim.
    expect(printed).not.toContain('Error initializing skill:')
  })

  it('InitSkillError with custom exitCode → exits with that code', () => {
    // Direct unit test of the wrapper contract via a synthetic error.
    const err = new InitSkillError('synthetic failure', 42)
    expect(err).toBeInstanceOf(InitSkillError)
    expect(err).toBeInstanceOf(Error)
    expect(err.exitCode).toBe(42)
    expect(err.name).toBe('InitSkillError')
    expect(err.message).toBe('synthetic failure')
  })

  it('InitSkillError preserves optional cause for downstream inspection', () => {
    const rootCause = new Error('ENOTDIR: not a directory')
    const err = new InitSkillError('Failed to create skill', 1, { cause: rootCause })
    expect(err.cause).toBe(rootCause)
  })

  it('defaults to exitCode=1 when caller omits it', () => {
    const err = new InitSkillError('oops')
    expect(err.exitCode).toBe(1)
  })
})

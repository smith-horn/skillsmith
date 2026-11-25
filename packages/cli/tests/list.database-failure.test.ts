/**
 * SMI-7260: `skillsmith list` reports a database it could not open, on its own.
 *
 * The WASM driver's unstable-read message tells the user to run `skillsmith
 * list` to check the database for damage. Measured before this fix, on the
 * native driver: a page-corrupt `skills.db` with no skills installed printed
 * "No skills installed" and exited 0, because the open failure was only ever
 * attached to discovered skill rows. These run the real `listAction`, the real
 * skills-directory scan and the real native driver against real files; only
 * `process.cwd` (so the repo's own `.claude/skills` is not scanned) and
 * `process.exit` (to observe the code) are stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabaseSync, initializeSchema } from '@skillsmith/core'
import { listAction } from '../src/commands/manage.action.js'
import { getCliLogger } from '../src/cli-logger.js'

let root: string | undefined
let skillDir: string | undefined
let logged: string[]
let errors: string[]
let warned: string[]
let exitCodes: unknown[]

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'smi7260-list-'))
  mkdirSync(join(root, 'cwd'))
  logged = []
  errors = []
  warned = []
  exitCodes = []
  vi.spyOn(process, 'cwd').mockReturnValue(join(root, 'cwd'))
  vi.spyOn(process, 'exit').mockImplementation(((code?: unknown) => {
    exitCodes.push(code)
  }) as never)
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    logged.push(a.map(String).join(' '))
  })
  vi.spyOn(getCliLogger(), 'error').mockImplementation(((...a: unknown[]) => {
    errors.push(a.map(String).join(' '))
  }) as never)
  vi.spyOn(getCliLogger(), 'warn').mockImplementation(((...a: unknown[]) => {
    warned.push(a.map(String).join(' '))
  }) as never)
})

afterEach(() => {
  vi.restoreAllMocks()
  if (skillDir !== undefined) rmSync(skillDir, { recursive: true, force: true })
  skillDir = undefined
  if (root !== undefined) rmSync(root, { recursive: true, force: true })
  root = undefined
})

/** A Skillsmith database written by the native driver; optionally page-corrupted. */
function skillsDb(corrupt: boolean): string {
  const path = join(root!, 'skills.db')
  const db = createDatabaseSync(path)
  initializeSchema(db)
  db.close()
  if (corrupt) {
    const bytes = readFileSync(path)
    for (let o = 4096; o < bytes.length; o += 1) bytes[o] = 0xff
    writeFileSync(path, bytes)
  }
  return path
}

/** One installed skill in the (sandboxed) global Claude skills directory. */
function installOneSkill(): void {
  skillDir = join(homedir(), '.claude', 'skills', 'smi7260-probe-skill')
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    '---\nname: smi7260-probe-skill\ndescription: probe\n---\n# probe\n'
  )
}

const opened = () => errors.filter((e) => e.includes('could not be opened'))
const all = () => logged.join('\n')

describe('SMI-7260: list reports a database it could not open', () => {
  it('a corrupt database with no skills installed: the diagnostic, and a non-zero exit', async () => {
    const db = skillsDb(true)

    await listAction({ db })

    expect(opened()).toHaveLength(1)
    // The error's own remedy: the native corruption refusal and its commands.
    expect(opened()[0]).toContain('is corrupt and cannot be read')
    expect(opened()[0]).toContain('mv ')
    expect(exitCodes).toEqual([1])
    // Presence: the inventory itself still printed.
    expect(all()).toContain('No skills installed')
  })

  it('a corrupt database with one skill: the diagnostic once, and the per-skill note', async () => {
    const db = skillsDb(true)
    installOneSkill()

    await listAction({ db })

    expect(opened()).toHaveLength(1)
    // The existing per-skill note (warnUndetermined), unchanged.
    expect(warned.filter((w) => w.includes('update status could'))).toHaveLength(1)
    expect(all()).toContain('smi7260-probe-skill')
    expect(exitCodes).toEqual([1])
  })

  it('control: a healthy database with no skills prints "No skills installed" and exits 0', async () => {
    const db = skillsDb(false)

    await listAction({ db })

    expect(all()).toContain('No skills installed')
    expect(opened()).toEqual([])
    expect(exitCodes).toEqual([])
  })

  it('control: no database file at all is not damage — the same output, exit 0', async () => {
    const db = join(root!, 'absent.db')

    await listAction({ db })

    expect(all()).toContain('No skills installed')
    expect(opened()).toEqual([])
    expect(warned).toEqual([])
    expect(exitCodes).toEqual([])
  })
})

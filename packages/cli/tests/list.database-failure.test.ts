/**
 * SMI-7260: `skillsmith list` reports a database it could not open, once.
 *
 * The WASM driver's unstable-read message tells the user to run `skillsmith
 * list` to check the database for damage. Measured before SMI-7260's fix, on
 * the native driver: a page-corrupt `skills.db` with no skills installed
 * printed "No skills installed" and exited 0, with no word about the database,
 * because the open failure was only ever attached to discovered skill rows.
 *
 * ADR-175 § 5 (owner decision, kept): a database fault costs the update
 * column, not the command. So `list` exits 0, and prints ONE warning per
 * command naming the cause and the remedy, with or without skills installed.
 * The warning comes from the scan's own open; there is no second open.
 *
 * These run the real `listAction`, the real skills-directory scan and the real
 * native driver against real files. `process.cwd` (so the repo's own
 * `.claude/skills` is not scanned) and `process.exit` (to observe it) are
 * stubbed; one test injects a failure into the scan's open only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabaseSync, initializeSchema } from '@skillsmith/core'

// Passthrough, except that with `scanFailure` set, every open made BY THE
// SCAN (from skills-directory.version-lookup.ts, which every scan target uses)
// throws the error it returns for that call (0, 1, ... in call order), while
// an open from anywhere else succeeds. Deterministic: the scan opens once per
// target, in parallel, so failing "the next open" could hit a target other
// than the skill's.
const inject = vi.hoisted(() => ({
  scanFailure: null as null | ((call: number) => Error),
  scanCalls: 0,
}))
vi.mock('../src/utils/open-database.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/open-database.js')>()
  return {
    ...actual,
    openCliDatabase: (...args: Parameters<typeof actual.openCliDatabase>) => {
      if (
        inject.scanFailure !== null &&
        /skills-directory\.version-lookup/.test(new Error().stack ?? '')
      ) {
        return Promise.reject(inject.scanFailure(inject.scanCalls++))
      }
      return actual.openCliDatabase(...args)
    },
  }
})

/** An error carrying a SQLite result code, as the native driver throws it. */
function sqliteError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

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
  inject.scanFailure = null
  inject.scanCalls = 0
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
  inject.scanFailure = null
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

/** Every message about the database or the update status, wherever it was printed. */
const dbMessages = () =>
  [...warned, ...errors].filter((m) => /could not be opened|update status|corrupt/.test(m))
const all = () => logged.join('\n')

describe('SMI-7260: list reports a database it could not open, once, and exits 0', () => {
  it('a corrupt database with no skills installed: one warning with the remedy; exit 0', async () => {
    const db = skillsDb(true)

    await listAction({ db })

    expect(dbMessages()).toHaveLength(1)
    // The error's own remedy: the native corruption refusal and its commands.
    expect(dbMessages()[0]).toContain('could not be opened')
    expect(dbMessages()[0]).toContain('is corrupt and cannot be read')
    expect(dbMessages()[0]).toContain('mv ')
    // ADR-175 § 5: the command still succeeds.
    expect(exitCodes).toEqual([])
    expect(all()).toContain('No skills installed')
  })

  it('a corrupt database with one skill: still exactly one message, naming the cause once', async () => {
    const db = skillsDb(true)
    installOneSkill()

    await listAction({ db })

    expect(all()).toContain('smi7260-probe-skill')
    expect(dbMessages()).toHaveLength(1)
    expect(dbMessages()[0]).toContain('update status could be determined')
    expect(dbMessages()[0]).toContain('is corrupt and cannot be read')
    expect(exitCodes).toEqual([])
  })

  it('reports the failure of the scan’s own open, even when a later open would succeed', async () => {
    const db = skillsDb(false)
    installOneSkill()
    inject.scanFailure = () => new Error('injected: the scan could not open the database')

    await listAction({ db })

    // Every scan open failed, so the skill's row is Unknown...
    const row = logged.flatMap((l) => l.split('\n')).find((l) => l.includes('smi7260-probe-skill'))
    expect(row).toContain('Unknown')
    // ...and the one message says so, from the scan's own error. The database
    // itself is healthy, so a second open would have found nothing to report.
    expect(dbMessages()).toHaveLength(1)
    expect(dbMessages()[0]).toContain("No skill's update status could be determined")
    expect(dbMessages()[0]).toContain('injected: the scan could not open the database')
    expect(exitCodes).toEqual([])
  })

  it('two failed opens with different causes: both are named, in the one warning', async () => {
    const db = skillsDb(false)
    installOneSkill()
    inject.scanFailure = (call) =>
      call === 0
        ? sqliteError('SQLITE_BUSY', 'injected BUSY: database is locked')
        : sqliteError('SQLITE_READONLY', 'injected READONLY: attempt to write a readonly database')

    await listAction({ db })

    expect(inject.scanCalls).toBeGreaterThanOrEqual(2)
    expect(dbMessages()).toHaveLength(1)
    expect(dbMessages()[0]).toContain('injected BUSY: database is locked')
    expect(dbMessages()[0]).toContain('injected READONLY: attempt to write a readonly database')
    expect(exitCodes).toEqual([])
  })

  it('two failed opens with one reason but different errors: both errors are named', async () => {
    const db = skillsDb(false)
    installOneSkill()
    // READONLY and PERM both classify as "could not be read"; each is still printed.
    inject.scanFailure = (call) =>
      call === 0
        ? sqliteError('SQLITE_READONLY_RECOVERY', 'injected READONLY_RECOVERY: needs recovery')
        : sqliteError('SQLITE_PERM', 'injected PERM: access permission denied')

    await listAction({ db })

    expect(inject.scanCalls).toBeGreaterThanOrEqual(2)
    expect(dbMessages()).toHaveLength(1)
    expect(dbMessages()[0]).toContain('injected READONLY_RECOVERY: needs recovery')
    expect(dbMessages()[0]).toContain('injected PERM: access permission denied')
    expect(exitCodes).toEqual([])
  })

  it('two failed opens with the same cause: it is printed once', async () => {
    const db = skillsDb(false)
    installOneSkill()
    inject.scanFailure = () => sqliteError('SQLITE_READONLY', 'injected READONLY: same cause')

    await listAction({ db })

    expect(inject.scanCalls).toBeGreaterThanOrEqual(2)
    expect(dbMessages()).toHaveLength(1)
    expect((dbMessages()[0] ?? '').split('injected READONLY: same cause')).toHaveLength(2)
  })

  it('an open that fails because the file vanished (CANTOPEN, now absent) reports nothing', async () => {
    const db = skillsDb(false)
    installOneSkill()
    // The file existed for the scan's existence check and is gone at the open:
    // the delete race. Absence is ADR-175 § 5's benign case.
    inject.scanFailure = () => {
      rmSync(db, { force: true })
      return sqliteError('SQLITE_CANTOPEN', 'injected CANTOPEN: unable to open database file')
    }

    await listAction({ db })

    expect(inject.scanCalls).toBeGreaterThanOrEqual(1)
    expect(warned).toEqual([])
    expect(dbMessages()).toEqual([])
    expect(exitCodes).toEqual([])
    // Presence: the skill is still listed.
    expect(all()).toContain('smi7260-probe-skill')
  })

  it('control: a healthy database with no skills prints "No skills installed", no warning, exit 0', async () => {
    const db = skillsDb(false)

    await listAction({ db })

    expect(all()).toContain('No skills installed')
    expect(dbMessages()).toEqual([])
    expect(exitCodes).toEqual([])
  })

  it('control: no database file at all is not damage — the same output, no warning, exit 0', async () => {
    const db = join(root!, 'absent.db')

    await listAction({ db })

    expect(all()).toContain('No skills installed')
    expect(dbMessages()).toEqual([])
    expect(warned).toEqual([])
    expect(exitCodes).toEqual([])
  })
})

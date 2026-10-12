/**
 * The CLI-side update-status classifiers (ADR-175 § 5, SMI-6946).
 *
 * Why this file exists, stated because its absence was a governance finding.
 * `classifyOpenFailure` is the **only** function in this change that can return
 * `undefined`, and `undefined` renders as "Up to date" — so a wrong branch here
 * re-creates the exact defect the change removes. The core-side classifier got
 * a specification-driven case table; this one, which is equally pure and is
 * exported precisely so it can be tested, had none.
 *
 * The asymmetry was the tell.
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  classifyOpenFailure,
  describeQueryFailure,
} from '../src/utils/skills-directory.update-status.js'

/** A synthetic driver error. better-sqlite3 exposes `code` as a string. */
function sqliteError(code: string): Error & { code: string } {
  return Object.assign(new Error(`synthetic ${code}`), { code })
}

/** A synthetic Node fs error. */
function fsError(code: string): Error & { code: string } {
  return Object.assign(new Error(`synthetic ${code}`), { code })
}

/** A real file, so `existsSync` answers truthfully rather than by mock. */
function realFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'smi6946-cls-'))
  const p = join(dir, 'skills.db')
  writeFileSync(p, 'not actually a database')
  return p
}

const ABSENT = join(tmpdir(), 'smi6946-definitely-absent', 'skills.db')

describe('classifyOpenFailure', () => {
  describe('the one benign case: a database that does not exist', () => {
    // This is the ONLY input that may return undefined. Everything else must
    // produce a reason, because everything else leaves the answer unknowable.
    it('returns undefined for SQLITE_CANTOPEN on a path that does not exist', () => {
      expect(classifyOpenFailure(sqliteError('SQLITE_CANTOPEN'), ABSENT)).toBeUndefined()
    })

    it('returns undefined for ENOENT on a path that does not exist', () => {
      expect(classifyOpenFailure(fsError('ENOENT'), ABSENT)).toBeUndefined()
    })

    // The paired PRESENCE assertion. Without it, a function that returned
    // undefined for EVERY input would satisfy the two tests above — and that
    // function is precisely the bug: undefined renders as "Up to date".
    it('returns a reason for SQLITE_CANTOPEN when the file DOES exist', () => {
      const p = realFile()
      expect(classifyOpenFailure(sqliteError('SQLITE_CANTOPEN'), p)).toMatch(/could not be opened/)
    })
  })

  describe('every other cause leaves the answer unknowable', () => {
    it.each([
      ['SQLITE_BUSY', /locked by another process/],
      ['SQLITE_BUSY_RECOVERY', /locked by another process/],
      ['SQLITE_BUSY_TIMEOUT', /locked by another process/],
      ['SQLITE_READONLY', /could not be read/],
      ['SQLITE_READONLY_DIRECTORY', /could not be read/],
      ['SQLITE_READONLY_RECOVERY', /could not be read/],
      ['SQLITE_PERM', /could not be read/],
    ])('%s yields a reason', (code, pattern) => {
      expect(classifyOpenFailure(sqliteError(code), ABSENT)).toMatch(pattern)
    })

    it.each([
      ['EACCES', /not readable/],
      ['EPERM', /not readable/],
    ])('%s yields a reason', (code, pattern) => {
      expect(classifyOpenFailure(fsError(code), ABSENT)).toMatch(pattern)
    })

    // Extended CANTOPEN codes must NOT take the benign branch: the exact-string
    // match is deliberate, since ISDIR and friends are operational faults about
    // an existing path rather than an absent database.
    it.each(['SQLITE_CANTOPEN_ISDIR', 'SQLITE_CANTOPEN_FULLPATH', 'SQLITE_CANTOPEN_SYMLINK'])(
      '%s is NOT treated as a benign absence',
      (code) => {
        expect(classifyOpenFailure(sqliteError(code), ABSENT)).toBeDefined()
      }
    )

    // Direction matters: an unrecognised cause must be "could not determine",
    // never silence. Silence here is the original defect.
    it.each([
      ['an error with no code', new Error('something else entirely')],
      ['a non-string code', Object.assign(new Error('numeric'), { code: 11 })],
      ['null', null],
      ['undefined', undefined],
    ])('%s still yields a reason rather than undefined', (_label, input) => {
      expect(classifyOpenFailure(input, ABSENT)).toBeDefined()
    })
  })

  it('names a corruption refusal specifically, using its own path', () => {
    // Matched structurally on `code`, exactly as a consumer must — not by
    // `instanceof`, which fails across duplicate copies of @skillsmith/core.
    const refusal = Object.assign(new Error('[Skillsmith] ... is corrupt ...'), {
      code: 'SKILLSMITH_DB_CORRUPT',
      path: '/tmp/from-the-error/skills.db',
    })
    const reason = classifyOpenFailure(refusal, '/tmp/from-the-argument/skills.db')
    expect(reason).toMatch(/is corrupt/)
    // The error's OWN path wins over the argument, since the refusal knows
    // which file it refused.
    expect(reason).toContain('/tmp/from-the-error/skills.db')
  })
})

describe('describeQueryFailure', () => {
  // Distinct from classifyOpenFailure because the open already succeeded, so a
  // CorruptDatabaseError cannot appear — but a raw SQLite corruption code can,
  // which is the case openCliDatabase documents as "a corrupt page only read
  // once the schema queries run".
  it.each(['SQLITE_CORRUPT', 'SQLITE_CORRUPT_INDEX', 'SQLITE_NOTADB'])(
    'names corruption for %s',
    (code) => {
      expect(describeQueryFailure(sqliteError(code), '/tmp/db')).toMatch(/is corrupt/)
    }
  )

  it.each(['SQLITE_BUSY', 'SQLITE_READONLY', 'SQLITE_ERROR'])(
    'falls back to a generic clause for %s',
    (code) => {
      expect(describeQueryFailure(sqliteError(code), '/tmp/db')).toMatch(/version lookup/)
    }
  )

  it('never returns undefined — a failed query is always unknowable', () => {
    // There is no benign case on this path: the open succeeded, so a failing
    // query cannot mean "nothing installed".
    for (const input of [new Error('no code'), null, undefined, sqliteError('SQLITE_CORRUPT')]) {
      expect(describeQueryFailure(input, '/tmp/db')).toBeDefined()
    }
  })
})

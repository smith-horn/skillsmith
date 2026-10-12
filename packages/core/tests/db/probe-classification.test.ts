/**
 * ADR-175 § 2's classification contract, tested from the SPECIFICATION.
 *
 * Why this file exists in this shape. The corruption probe can receive SQLite
 * result codes that **no fixture on writable storage can produce** — a
 * read-only connection recovers every crash-damaged database it is given,
 * because on writable storage it opens the `-shm` read-write and performs the
 * recovery itself, so `SQLITE_READONLY_RECOVERY` and friends never fired in any
 * fixture built for SMI-6931. The contract still has to be right for them.
 *
 * So the classifier is a pure function over an error's `code`, and it is tested
 * here against synthetic errors for every code the ADR names. Integration
 * fixtures cover the codes that *can* be induced (see
 * `betterSqlite3Driver.corruption.test.ts`); this covers the whole space.
 *
 * The alternative — a branch that exists only because some fixture happened to
 * reach it — is not a contract, and leaves the untested branches as the ones
 * most likely to be wrong.
 */
import { describe, it, expect } from 'vitest'
import {
  classifyProbeFailure,
  isCorruptionCode,
  remedyKindFor,
  type ProbeFailureClass,
} from '../../src/db/probe-classification.js'

/** A synthetic driver error. better-sqlite3 exposes `code` as a string. */
function sqliteError(code: string): Error & { code: string } {
  return Object.assign(new Error(`synthetic ${code}`), { code })
}

describe('classifyProbeFailure — ADR-175 § 2', () => {
  // Every row is a documented SQLite result code. The expected class is the
  // ADR's decision, not an observation.
  const cases: ReadonlyArray<readonly [string, ProbeFailureClass]> = [
    // --- verdicts about the file's contents ---
    ['SQLITE_CORRUPT', 'corrupt'],
    ['SQLITE_CORRUPT_INDEX', 'corrupt'],
    ['SQLITE_CORRUPT_SEQUENCE', 'corrupt'],
    ['SQLITE_CORRUPT_VTAB', 'corrupt'],
    ['SQLITE_NOTADB', 'corrupt'],

    // --- a lock, not a fact about the data ---
    ['SQLITE_BUSY', 'transient'],
    ['SQLITE_BUSY_RECOVERY', 'transient'],
    ['SQLITE_BUSY_SNAPSHOT', 'transient'],
    ['SQLITE_BUSY_TIMEOUT', 'transient'],

    // --- a pending recovery this connection may not perform ---
    ['SQLITE_READONLY_RECOVERY', 'recovery-required'],
    ['SQLITE_READONLY_ROLLBACK', 'recovery-required'],
    ['SQLITE_READONLY_CANTLOCK', 'recovery-required'],
    ['SQLITE_READONLY_CANTINIT', 'recovery-required'],

    // --- the environment, not the data ---
    ['SQLITE_CANTOPEN', 'operational'],
    ['SQLITE_CANTOPEN_ISDIR', 'operational'],
    ['SQLITE_CANTOPEN_FULLPATH', 'operational'],
    ['SQLITE_CANTOPEN_CONVPATH', 'operational'],
    ['SQLITE_CANTOPEN_SYMLINK', 'operational'],
    ['SQLITE_READONLY', 'operational'],
    ['SQLITE_READONLY_DIRECTORY', 'operational'],
    ['SQLITE_READONLY_DBMOVED', 'operational'],
    ['SQLITE_PERM', 'operational'],
    ['SQLITE_IOERR', 'operational'],
    ['SQLITE_IOERR_READ', 'operational'],
    ['SQLITE_FULL', 'operational'],
  ]

  for (const [code, expected] of cases) {
    it(`classifies ${code} as ${expected}`, () => {
      expect(classifyProbeFailure(sqliteError(code))).toBe(expected)
    })
  }

  // This is the assertion the previous contract would have failed. An
  // enumeration of exact primary names put every extended sibling in the
  // catch-all, so SQLITE_BUSY_RECOVERY read as `operational` — a lock
  // misreported as an environment fault.
  it('places extended BUSY siblings with BUSY, not in the catch-all', () => {
    expect(classifyProbeFailure(sqliteError('SQLITE_BUSY_RECOVERY'))).toBe(
      classifyProbeFailure(sqliteError('SQLITE_BUSY'))
    )
    expect(classifyProbeFailure(sqliteError('SQLITE_BUSY_TIMEOUT'))).toBe('transient')
  })

  // The READONLY family is deliberately NOT matched as a family: two of its
  // members mean "you simply cannot write", which is operational, while four
  // mean "a recovery is pending". A family match here would have been wrong.
  it('splits the READONLY family rather than treating it uniformly', () => {
    expect(classifyProbeFailure(sqliteError('SQLITE_READONLY_RECOVERY'))).toBe('recovery-required')
    expect(classifyProbeFailure(sqliteError('SQLITE_READONLY_DIRECTORY'))).toBe('operational')
    expect(classifyProbeFailure(sqliteError('SQLITE_READONLY'))).toBe('operational')
  })

  // ISDIR is the case that proves classification must not consult the
  // filesystem: the path exists, so an `existsSync` precheck would call it
  // recoverable, and it is an operational fault.
  it('treats a directory path as operational even though the path exists', () => {
    expect(classifyProbeFailure(sqliteError('SQLITE_CANTOPEN_ISDIR'))).toBe('operational')
  })

  describe('unclassifiable input is operational, never corrupt', () => {
    // Direction matters. Mapping "I do not recognise this" to corruption would
    // refuse to open a user's healthy database on an unrecognised fault, which
    // is the backwards direction of fail-closed.
    it.each([
      ['an error with no code', new Error('no code at all')],
      ['an empty-string code', sqliteError('')],
      ['a non-string code', Object.assign(new Error('numeric'), { code: 11 })],
      ['null', null],
      ['undefined', undefined],
      ['a bare string', 'SQLITE_CORRUPT'],
      ['a plain object', { message: 'malformed' }],
    ])('%s', (_label, input) => {
      expect(classifyProbeFailure(input)).toBe('operational')
    })

    // A message mentioning corruption must not be enough. The driver's whole
    // reason for classifying on codes is that a message can carry incidental
    // text — including from a file path.
    it('does not classify on the message, even when it says "malformed"', () => {
      const e = new Error('database disk image is malformed')
      expect(classifyProbeFailure(e)).toBe('operational')
    })

    it('does not classify on a path that happens to contain a code name', () => {
      const e = new Error('unable to open /home/u/SQLITE_CORRUPT/skills.db')
      expect(classifyProbeFailure(e)).toBe('operational')
    })
  })
})

describe('isCorruptionCode', () => {
  it('matches the CORRUPT family and NOTADB, and nothing else', () => {
    expect(isCorruptionCode('SQLITE_CORRUPT')).toBe(true)
    expect(isCorruptionCode('SQLITE_CORRUPT_VTAB')).toBe(true)
    expect(isCorruptionCode('SQLITE_NOTADB')).toBe(true)
    expect(isCorruptionCode('SQLITE_BUSY')).toBe(false)
    expect(isCorruptionCode('SQLITE_READONLY_RECOVERY')).toBe(false)
  })

  // Guards the family predicate against matching a longer unrelated name by
  // prefix. `startsWith('SQLITE_CORRUPT')` alone would accept this.
  it('does not match a name that merely starts with the family text', () => {
    expect(isCorruptionCode('SQLITE_CORRUPTIONLIKE')).toBe(false)
    expect(isCorruptionCode('SQLITE_NOTADBX')).toBe(false)
  })
})

describe('remedyKindFor — ADR-175 § 6', () => {
  // SQLite names REINDEX for this one code, and names it CONDITIONALLY: it
  // "might" resolve the problem "assuming no other problems exist". Since the
  // probe runs quick_check(1) and stops at the first error, it cannot establish
  // the index is the only damage — so this selects the narrower RECOMMENDATION,
  // and the rendered guidance ends in a re-check rather than a fix.
  it('selects reindex only for SQLITE_CORRUPT_INDEX', () => {
    expect(remedyKindFor('SQLITE_CORRUPT_INDEX')).toBe('reindex')
  })

  it.each([
    'SQLITE_CORRUPT',
    'SQLITE_CORRUPT_VTAB',
    'SQLITE_CORRUPT_SEQUENCE',
    'SQLITE_NOTADB',
    undefined,
  ])('selects replace for %s', (code) => {
    expect(remedyKindFor(code)).toBe('replace')
  })

  // The quick_check path carries NO code, because the verdict is returned as a
  // string rather than thrown. That path must still get a usable remedy.
  it('selects replace when no code exists at all, as on the quick_check path', () => {
    expect(remedyKindFor(undefined)).toBe('replace')
  })
})

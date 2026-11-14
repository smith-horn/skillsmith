/**
 * SMI-6531 (A1 step 6c-ii-a): the prune policy table (PLAN 1706-1721,
 * 1739-1745, UD64, UD65) and the parked kinds it must cover. The table's
 * `satisfies` checks the unions at compile time; these tests check the same
 * sets at run time, from the other side: every caller's kind has a row, and
 * the table holds no kind that nothing writes.
 */
import { describe, expect, it } from 'vitest'
import { callerKind, PARK_CALLERS } from '../../../src/install/park-callers.js'
import {
  BACKUP_KIND_POLICY,
  PARKED_KIND_POLICY,
  policyFor,
} from '../../../src/install/prune.kinds.js'
import { PUBLISH_KIND_TABLE } from '../../../src/install/backup-sidecar.strict.js'

const NO_WRITER = ['pre-rename', 'merge-base', 'saved-edits', 'pre-edit']
const keys = (o: object): string[] => Object.keys(o).sort()

describe('the parked kinds', () => {
  it('every park caller writes a kind that has a policy row', () => {
    for (const c of PARK_CALLERS) {
      expect(policyFor('parked', callerKind(c)), `${c} -> ${callerKind(c)}`).not.toBeNull()
    }
  })

  it('the table holds exactly the kinds the callers write', () => {
    expect(keys(PARKED_KIND_POLICY)).toEqual([...new Set(PARK_CALLERS.map(callerKind))].sort())
  })

  it('D2: the companion caller writes its own kind, not install-rollback', () => {
    expect(callerKind('companion-rollback')).toBe('companion-rollback')
    expect(callerKind('install-rollback')).toBe('install-rollback')
    // UD63 picks lock 1' by kind, so no two callers may share one except the three fan-out overwrites.
    const byKind = new Map<string, string[]>()
    for (const c of PARK_CALLERS)
      byKind.set(callerKind(c), [...(byKind.get(callerKind(c)) ?? []), c])
    const shared = [...byKind].filter(([, cs]) => cs.length > 1)
    expect(shared).toEqual([
      ['fan-out-overwrite', ['fan-out-staging', 'fan-out-symlink', 'fan-out-backup']],
    ])
  })

  it('every parked kind is default-selectable except unreadable-record', () => {
    for (const [kind, p] of Object.entries(PARKED_KIND_POLICY)) {
      expect(p.selection, kind).toBe(kind === 'unreadable-record' ? 'include-kept' : 'default')
      expect(p.countedByKeep).toBe(false)
    }
  })
})

describe('the backup kinds', () => {
  it('the table holds every PublishKind and UD64 four no-writer rows, and nothing else', () => {
    expect(keys(BACKUP_KIND_POLICY)).toEqual([...keys(PUBLISH_KIND_TABLE), ...NO_WRITER].sort())
  })

  it('default-selectable: backup, undone, unused-new, pre-rename, and partial-copy only when the source is unchanged', () => {
    const def = Object.entries(BACKUP_KIND_POLICY)
      .filter(([, p]) => p.selection !== 'include-kept')
      .map(([k, p]) => `${k}:${p.selection}`)
      .sort()
    expect(def).toEqual([
      'backup:default',
      'partial-copy:default-if-source-unchanged',
      'pre-rename:default',
      'undone:default',
      'unused-new:default',
    ])
  })

  it('only --include-kept reaches the kept kinds', () => {
    const kept = Object.entries(BACKUP_KIND_POLICY)
      .filter(([, p]) => p.selection === 'include-kept')
      .map(([k]) => k)
      .sort()
    expect(kept).toEqual(
      [
        'abandoned-new',
        'abandoned-old',
        'abandoned-undone',
        'conflict',
        'edited-new',
        'failed-build',
        'merge-base',
        'pre-edit',
        'saved-edits',
        'unrecorded-new',
      ].sort()
    )
  })

  it('UD64: backup and pre-rename are counted by --keep; merge-base is never the newest selected', () => {
    const counted = Object.entries(BACKUP_KIND_POLICY)
      .filter(([, p]) => p.countedByKeep)
      .map(([k]) => k)
      .sort()
    expect(counted).toEqual(['backup', 'pre-rename'])
    const never = Object.entries(BACKUP_KIND_POLICY)
      .filter(([, p]) => p.neverNewest)
      .map(([k]) => k)
    expect(never).toEqual(['merge-base'])
  })
})

describe('policyFor', () => {
  it('an unrecognised kind has no policy, in either store', () => {
    expect(policyFor('parked', 'made-up')).toBeNull()
    expect(policyFor('backup', 'made-up')).toBeNull()
  })

  it('a kind is looked up in its own store only', () => {
    expect(policyFor('backup', 'uninstall')).toBeNull()
    expect(policyFor('parked', 'backup')).toBeNull()
  })

  it('an inherited object key is not a kind', () => {
    for (const k of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
      expect(policyFor('parked', k)).toBeNull()
      expect(policyFor('backup', k)).toBeNull()
    }
  })
})

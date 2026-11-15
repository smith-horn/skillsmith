/**
 * SMI-6531 (A1 step 6c-ii-b), fix round 2, Minor 1: the boundary of the parked
 * `unreadable-record` exemption. Such a copy is the record rule (c) names, so (c) and
 * what may hide (c) (`unseen`) never protect it; but D17 and the scan-failure and
 * unreadable-record reasons are about records it cannot see, so they still apply.
 */
import { describe, expect, it } from 'vitest'
import { protectionOf } from '../../../src/services/skill-backups.records.js'
import type { RecordFacts } from '../../../src/services/skill-backups.records.js'

const none = (): RecordFacts => ({
  live: new Map(),
  backupDests: new Map(),
  unreadable: [],
  scanFailures: [],
})
const COPY = '/p/.skillsmith-parked/op-U/foo-aaaaaaaa'
const q = {
  copyPath: COPY,
  opId: 'op-U',
  kind: 'unreadable-record',
  sourceUnchanged: null,
  store: 'parked' as const,
}
const unseen = { hidden: ['/p/.skillsmith-parked'], maybe: new Map([['op-U', ['/other/copy']]]) }

describe('a parked unreadable-record copy', () => {
  it('is unknown under D17: an unreadable live record carries its opId', () => {
    const f = none()
    f.unreadable.push({
      root: '/r',
      record: { opId: 'op-U', path: '/r/.skillsmith-staging/op-U/record.json' },
    } as RecordFacts['unreadable'][number])
    expect(protectionOf(f, new Map(), q)).toEqual({
      status: 'unknown',
      reason: expect.stringContaining('has this operation id'),
    })
  })

  it('is unknown under a scan failure', () => {
    const f = none()
    f.scanFailures.push({ root: '/r', path: '/r/.skillsmith-staging', errno: 'EACCES' })
    expect(protectionOf(f, new Map(), q)).toEqual({
      status: 'unknown',
      reason: expect.stringContaining('could not be read (EACCES)'),
    })
  })

  it('is unknown under an unreadable record of another opId', () => {
    const f = none()
    f.unreadable.push({
      root: '/r',
      record: { opId: 'op-Z', path: '/r/x' },
    } as RecordFacts['unreadable'][number])
    expect(protectionOf(f, new Map(), q).status).toBe('unknown')
  })

  it('is unprotected when only hidden and maybe facts apply: they never protect it', () => {
    expect(protectionOf(none(), new Map(), q, unseen)).toEqual({ status: 'unprotected' })
  })

  it('control: a backup-store tree with the same hidden and maybe facts is unknown', () => {
    const p = protectionOf(none(), new Map(), { ...q, store: 'backup', kind: 'clean' }, unseen)
    expect(p.status).toBe('unknown')
  })
})

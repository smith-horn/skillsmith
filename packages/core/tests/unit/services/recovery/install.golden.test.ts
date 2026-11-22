/**
 * SMI-6531 (A1 step 8-i-a-2), T-FIR3: version compatibility of `record.json`.
 *
 *  - An update record's bytes and hash are pinned: the values below were taken
 *    from `sealRecord` before the install record existed (run against
 *    origin/main d5f05a885), so an update record any earlier version wrote
 *    still verifies, byte for byte.
 *  - An install record fed to a frozen copy of the update-only shape check
 *    (`isSwapRecord` as it stood before 8-i-a-2) is `malformed`: that is what
 *    an older Skillsmith makes of one (it refuses every write in the root as
 *    unreadable; nothing is lost).
 */
import crypto from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { sealRecord } from '../../../../src/services/skill-swap.staging.js'
import { parseRecordBytes } from '../../../../src/services/skill-swap.record-schema.js'
import type { SwapRecord } from '../../../../src/services/skill-swap.types.js'
import { useTmpCleanup } from '../skill-swap.helpers.js'
import { fi0, installFixture } from './install.helpers.js'

useTmpCleanup()

const ID = (n: string) => ({ dev: '1', ino: n, birthtimeNs: '1000', fmt: '16384' })

/** A fixed update body: every field set, the optional marker absent. */
const UPDATE_BODY: Omit<SwapRecord, 'recordSha256'> = {
  schema: 1,
  op: 'update',
  opId: 'b'.repeat(32),
  pid: 4242,
  host: 'golden-host',
  uid: 501,
  target: {
    comparedPath: '/r/skills/my-skill',
    realDir: '/r/skills/my-skill',
    skillsDir: '/r/skills',
    manifestPath: '/r/state/manifest.json',
    manifestKey: 'my-skill',
    client: 'claude-code',
    scope: 'global',
    dirName: 'my-skill',
  },
  rootIdentity: ID('10'),
  opDirIdentity: ID('11'),
  oldIdentity: ID('12'),
  newIdentity: ID('13'),
  preTree: '1'.repeat(64),
  postTree: '2'.repeat(64),
  preEntry: { version: '1.0.0' },
  postEntry: { version: '2.0.0' },
  backupDest: '/r/state/backups/update/claude-code/k/my-skill/' + 'b'.repeat(32),
}

const MARKER = {
  cause: 'ENOSPC',
  stage: 'copy',
  area: '/a',
  opId: 'b'.repeat(32),
  dest: '/a/x',
} as const

const sha = (b: Buffer | string): string => crypto.createHash('sha256').update(b).digest('hex')

/**
 * The first test of `isSwapRecord` as it stood at d5f05a885, frozen: the
 * exact top-level key set (`fullDevice` optional). It is what rejects an
 * install record there, before any type check runs.
 */
function olderIsSwapRecord(v: unknown): boolean {
  const TOP = [
    'schema',
    'op',
    'opId',
    'pid',
    'host',
    'uid',
    'target',
    'rootIdentity',
    'opDirIdentity',
    'oldIdentity',
    'newIdentity',
    'preTree',
    'postTree',
    'preEntry',
    'postEntry',
    'backupDest',
    'recordSha256',
  ]
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  const own = Object.keys(v)
  return (
    TOP.every((k) => Object.hasOwn(v, k)) && own.every((k) => TOP.includes(k) || k === 'fullDevice')
  )
}

describe('record.json compatibility (T-FIR3)', () => {
  it('an update record seals to the same bytes and hash as before 8-i-a-2, and verifies', () => {
    const sealed = sealRecord(UPDATE_BODY, '/r/skills', 'b'.repeat(32))
    expect(sha(sealed.bytes)).toBe(
      '0466d87f84225748d02a9e1f9e39426a9485befc6cc2b02256b174b5ee4b17a3'
    )
    expect(sealed.record.recordSha256).toBe(
      'd5ed2620c925583c380c02fa0016e275e9c3db7e79a8db46bce0b93e020427f2'
    )
    expect(sealed.bytes.length).toBe(1271)
    expect(parseRecordBytes(sealed.bytes)).toMatchObject({ ok: true, record: { op: 'update' } })
  })

  it('a marked update record too (the marker keeps its key order)', () => {
    const m = sealRecord({ ...UPDATE_BODY, fullDevice: MARKER }, '/r/skills', 'b'.repeat(32))
    expect(sha(m.bytes)).toBe('a711f9a370d4946713ac431dd0e978f4b7feb8e07bde124632ccf28f65ecf49f')
    expect(m.record.recordSha256).toBe(
      'c0981d209905caf04c1a8e52afba26fbeb71398773887a445f71c27a4493b8a0'
    )
    expect(m.bytes.length).toBe(1423)
  })

  it('an install record is malformed to the older shape check; an update record is not (control)', () => {
    const st = fi0(installFixture())
    expect(olderIsSwapRecord(st.record)).toBe(false)
    const update = sealRecord(UPDATE_BODY, '/r/skills', 'b'.repeat(32)).record
    expect(olderIsSwapRecord(update)).toBe(true)
  })
})

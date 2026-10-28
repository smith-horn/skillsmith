/**
 * SMI-6531 (A1 step 4b, review round 1): `isParkIntentFor` is the gate doctor
 * (step 6) uses to finish a park without `--unsafe-unverified-owner`, so every
 * malformed intent must be refused. Also `parkIntentOf`'s fallbacks. Step 4c
 * adds the second kind, `move-source` (step 13 after a cross-device move):
 * both kinds verify, and any other kind is still refused. Step 6b-ii (O1)
 * adds schema 2, an `abort-new` intent carrying the attribution's five
 * strings; schema 1 is still accepted.
 */
import os from 'node:os'
import { describe, expect, it } from 'vitest'
import { processOwnerNow } from '../../../src/services/skill-swap.ops.js'
import type { SwapState } from '../../../src/services/skill-swap.ops.js'
import { isParkIntentFor, parkIntentOf } from '../../../src/services/skill-swap.intent.js'
import type { RecordIdentity } from '../../../src/services/skill-swap.js'

const OP = 'a'.repeat(32)
const ID: RecordIdentity = {
  dev: '66',
  ino: '1234',
  birthtimeNs: '1700000000000000000',
  fmt: '16384',
}
const GOOD = {
  schema: 1,
  opId: OP,
  owner: { pid: 4242, host: 'host-a', uid: 501 },
  opIdentity: { ...ID },
  kind: 'abort-new',
}
const MOVE = { ...GOOD, kind: 'move-source', backupPath: '/state/backups/update/x/' + OP }
const without = (o: Record<string, unknown>, k: string) => {
  const c = { ...o }
  delete c[k]
  return c
}

describe('isParkIntentFor: known-positive and known-negatives', () => {
  it('accepts the well-formed intent for its opId and identity', () => {
    expect(isParkIntentFor(GOOD, OP, ID)).toBe(true)
  })

  it('accepts the move-source kind (4c: step 13 after a cross-device move)', () => {
    expect(isParkIntentFor(MOVE, OP, ID)).toBe(true)
  })

  // 6a-iii: a move-source intent names its verified copy, so doctor can finish its park alone.
  const MOVE_BAD: Array<[string, unknown]> = [
    ['move-source without backupPath', { ...GOOD, kind: 'move-source' }],
    ['move-source with a relative backupPath', { ...MOVE, backupPath: 'state/backups/x' }],
    ['move-source with a .. component', { ...MOVE, backupPath: '/state/../x' }],
    ['move-source with an empty component', { ...MOVE, backupPath: '/state//x' }],
    ['move-source with a non-string backupPath', { ...MOVE, backupPath: 7 }],
    ['abort-new with a backupPath', { ...GOOD, backupPath: '/state/backups/x' }],
  ]
  for (const [label, value] of MOVE_BAD) {
    it(`refuses ${label}`, () => {
      expect(isParkIntentFor(value, OP, ID)).toBe(false)
    })
  }

  const BAD: Array<[string, unknown, string?, RecordIdentity?]> = [
    ['null', null],
    ['a string', 'park-intent'],
    ['a number', 1],
    ['an array', [GOOD]],
    ['an extra key', { ...GOOD, extra: true }],
    ['a missing key (kind)', without(GOOD, 'kind')],
    ['schema 2', { ...GOOD, schema: 2 }],
    ["schema '1' (a string)", { ...GOOD, schema: '1' }],
    ['kind partial-copy (a kept kind, not a park kind)', { ...GOOD, kind: 'partial-copy' }],
    ['kind Move-Source (case differs)', { ...GOOD, kind: 'Move-Source' }],
    ['kind null', { ...GOOD, kind: null }],
    ['the wrong opId', GOOD, 'b'.repeat(32)],
    ['owner null', { ...GOOD, owner: null }],
    ['owner an array', { ...GOOD, owner: [4242, 'host-a', 501] }],
    ['owner with an extra key', { ...GOOD, owner: { ...GOOD.owner, createdAt: 'x' } }],
    ['owner missing host', { ...GOOD, owner: { pid: 4242, uid: 501 } }],
    ['a non-integer pid', { ...GOOD, owner: { ...GOOD.owner, pid: 42.5 } }],
    ['a string pid', { ...GOOD, owner: { ...GOOD.owner, pid: '4242' } }],
    ['a non-integer uid', { ...GOOD, owner: { ...GOOD.owner, uid: 1.5 } }],
    ['a non-string host', { ...GOOD, owner: { ...GOOD.owner, host: 7 } }],
    ['opIdentity null', { ...GOOD, opIdentity: null }],
    ['opIdentity with a number field', { ...GOOD, opIdentity: { ...ID, ino: 1234 } }],
    // Malformed even where the expected identity string is the same malformed text,
    // so the decimal rule itself is what refuses it.
    [
      'opIdentity with a non-decimal field',
      { ...GOOD, opIdentity: { ...ID, dev: '0x42' } },
      OP,
      { ...ID, dev: '0x42' },
    ],
    [
      'opIdentity with a leading zero',
      { ...GOOD, opIdentity: { ...ID, ino: '01234' } },
      OP,
      { ...ID, ino: '01234' },
    ],
    ['opIdentity missing fmt', { ...GOOD, opIdentity: without(ID as never, 'fmt') }],
    ['opIdentity with an extra key', { ...GOOD, opIdentity: { ...ID, size: '0' } }],
    ['another identity (a copy of OP)', GOOD, OP, { ...ID, ino: '9999' }],
    ['another file type', GOOD, OP, { ...ID, fmt: '32768' }],
  ]
  for (const [label, value, opId = OP, id = ID] of BAD) {
    it(`refuses ${label}`, () => {
      expect(isParkIntentFor(value, opId, id)).toBe(false)
    })
  }
})

// 6b-ii (O1): an abort-new intent is schema 2, carrying the attribution's five strings.
const ATTR = {
  client: 'claude-code',
  scope: 'global',
  dirName: 'my-skill',
  manifestKey: 'my-skill',
  stateRoot: '/state',
}
const V2 = { ...GOOD, schema: 2, ...ATTR }

describe('isParkIntentFor: schema 2 (abort-new with O1 attribution, 6b-ii)', () => {
  it('accepts the well-formed schema-2 abort-new intent; schema 1 still verifies', () => {
    expect(isParkIntentFor(V2, OP, ID)).toBe(true)
    expect(isParkIntentFor(GOOD, OP, ID)).toBe(true)
  })

  it('accepts a well-formed but semantically bad hint (validation is the reader side, all or nothing)', () => {
    expect(isParkIntentFor({ ...V2, dirName: '../x', client: 'emacs' }, OP, ID)).toBe(true)
  })

  const V2_BAD: Array<[string, unknown]> = [
    ['schema 2 missing stateRoot', without(V2, 'stateRoot')],
    ['schema 2 with a non-string client', { ...V2, client: 7 }],
    ['schema 2 with a null dirName', { ...V2, dirName: null }],
    ['schema 2 with an extra key', { ...V2, extra: 1 }],
    ['schema 1 carrying the attribution keys', { ...V2, schema: 1 }],
    ['schema 3', { ...V2, schema: 3 }],
    ['a schema-2 move-source', { ...MOVE, schema: 2, ...ATTR }],
    ['a move-source carrying the attribution keys', { ...MOVE, ...ATTR }],
    ['schema 2 for another opId', { ...V2, opId: 'b'.repeat(32) }],
  ]
  for (const [label, value] of V2_BAD) {
    it(`refuses ${label}`, () => {
      expect(isParkIntentFor(value, OP, ID)).toBe(false)
    })
  }
})

describe('parkIntentOf', () => {
  const op = {
    path: '/x',
    identity: { ok: true, dev: 66n, ino: 1234n, birthtimeNs: 5n, fmt: 16384n },
  }
  const input = { client: 'cursor', scope: 'workspace', dirName: 'd', manifestKey: 'd::cursor' }
  const routed = { input, stateRootReal: '/real/state' }

  it("copies the recorded owner, OP's identity as decimal strings, and (6b-ii) the attribution", () => {
    const st = {
      opId: OP,
      op,
      owner: { pid: 7, host: 'h', uid: 9 },
      ...routed,
    } as unknown as SwapState
    expect(parkIntentOf(st)).toEqual({
      schema: 2,
      opId: OP,
      owner: { pid: 7, host: 'h', uid: 9 },
      opIdentity: { dev: '66', ino: '1234', birthtimeNs: '5', fmt: '16384' },
      kind: 'abort-new',
      ...input,
      stateRoot: '/real/state',
    })
  })

  it('writes the kind it is given (move-source for step 13), schema 1 with no attribution', () => {
    const st = {
      opId: OP,
      op,
      owner: { pid: 7, host: 'h', uid: 9 },
      ...routed,
    } as unknown as SwapState
    const intent = parkIntentOf(st, 'move-source', '/state/backup')
    expect(intent.kind).toBe('move-source')
    expect(intent.schema).toBe(1)
    expect(intent.kind === 'move-source' ? intent.backupPath : null).toBe('/state/backup')
    expect(intent).not.toHaveProperty('client')
    expect(isParkIntentFor(intent, OP, intent.opIdentity)).toBe(true)
  })

  it('refuses a move-source intent without the backup path (staging-unsafe)', () => {
    const st = { opId: OP, op, owner: { pid: 7, host: 'h', uid: 9 } } as unknown as SwapState
    expect(() => parkIntentOf(st, 'move-source')).toThrow(/staging-unsafe/)
  })

  it('falls back to this process as the owner when owner.json was never published', () => {
    const st = {
      opId: OP,
      op,
      owner: null,
      self: processOwnerNow(),
      ...routed,
    } as unknown as SwapState
    const intent = parkIntentOf(st)
    expect(intent.owner).toEqual({
      pid: process.pid,
      host: os.hostname(),
      uid: process.geteuid?.() ?? -1,
    })
    expect(isParkIntentFor(intent, OP, intent.opIdentity)).toBe(true)
  })

  it('refuses without a bound OP (staging-unsafe)', () => {
    const st = { opId: OP, op: null, owner: null } as unknown as SwapState
    expect(() => parkIntentOf(st)).toThrow(/staging-unsafe/)
  })
})

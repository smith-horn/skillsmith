/**
 * SMI-6531 (A1 step 4b, review round 1): `isParkIntentFor` is the gate doctor
 * (step 6) uses to finish a park without `--unsafe-unverified-owner`, so every
 * malformed intent must be refused. Also `parkIntentOf`'s fallbacks. Step 4c
 * adds the second kind, `move-source` (step 13 after a cross-device move):
 * both kinds verify, and any other kind is still refused.
 */
import os from 'node:os'
import { describe, expect, it } from 'vitest'
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
    expect(isParkIntentFor({ ...GOOD, kind: 'move-source' }, OP, ID)).toBe(true)
  })

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

describe('parkIntentOf', () => {
  const op = {
    path: '/x',
    identity: { ok: true, dev: 66n, ino: 1234n, birthtimeNs: 5n, fmt: 16384n },
  }

  it("copies the recorded owner and OP's identity as decimal strings", () => {
    const st = { opId: OP, op, owner: { pid: 7, host: 'h', uid: 9 } } as unknown as SwapState
    expect(parkIntentOf(st)).toEqual({
      schema: 1,
      opId: OP,
      owner: { pid: 7, host: 'h', uid: 9 },
      opIdentity: { dev: '66', ino: '1234', birthtimeNs: '5', fmt: '16384' },
      kind: 'abort-new',
    })
  })

  it('writes the kind it is given (move-source for step 13)', () => {
    const st = { opId: OP, op, owner: { pid: 7, host: 'h', uid: 9 } } as unknown as SwapState
    const intent = parkIntentOf(st, 'move-source')
    expect(intent.kind).toBe('move-source')
    expect(isParkIntentFor(intent, OP, intent.opIdentity)).toBe(true)
  })

  it('falls back to this process as the owner when owner.json was never published', () => {
    const st = { opId: OP, op, owner: null } as unknown as SwapState
    const intent = parkIntentOf(st)
    expect(intent.owner).toEqual({
      pid: process.pid,
      host: os.hostname(),
      uid: process.getuid?.() ?? -1,
    })
    expect(isParkIntentFor(intent, OP, intent.opIdentity)).toBe(true)
  })

  it('refuses without a bound OP (staging-unsafe)', () => {
    const st = { opId: OP, op: null, owner: null } as unknown as SwapState
    expect(() => parkIntentOf(st)).toThrow(/staging-unsafe/)
  })
})

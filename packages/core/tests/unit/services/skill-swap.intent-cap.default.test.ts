/**
 * SMI-7205: the park intent's cap is 64 KiB by default, the same value for the
 * writer (`readableIntentBytes`) and the reader (`intentValueOf`), and the test
 * seam that lowers it reaches both and cannot stay set. No hook in this file
 * lowers the cap: whatever it sees is the default.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  INTENT_CAP,
  intentCap,
  intentValueOf,
  isParkIntentFor,
  setIntentCapForTest,
} from '../../../src/services/skill-swap.intent-schema.js'
import { readableIntentBytes } from '../../../src/services/skill-swap.intent.js'
import { jsonBytes } from '../../../src/services/skill-swap.staging.js'
import type { ParkIntent } from '../../../src/services/skill-swap.types.js'

const OP_ID = '00000000-0000-4000-8000-000000000001'
const ID = { dev: '1', ino: '2', birthtimeNs: '3', fmt: '32768' }
const abortIntent = (host: string): ParkIntent => ({
  schema: 1,
  kind: 'abort-new',
  opId: OP_ID,
  owner: { pid: 1, host, uid: 0 },
  opIdentity: ID,
})
/** The owner decision, spelled out: the tests must not follow the constant they check. */
const DEFAULT = 65536
const base = jsonBytes(abortIntent('')).length
/** An intent of exactly `size + delta` bytes, padded through the owner's host. */
const sized = (size: number, delta: number): ParkIntent =>
  abortIntent('x'.repeat(size - base + delta))

describe('the default cap', () => {
  afterEach(() => setIntentCapForTest(null))

  it('is 65536 bytes when no test sets it, above a PATH_MAX path at its worst JSON escaping', () => {
    expect(INTENT_CAP).toBe(DEFAULT)
    expect(intentCap()).toBe(65536)
    // PATH_MAX counts bytes; a control byte escapes to six (`\u0001`), the worst case.
    expect(jsonBytes('\u0001'.repeat(4095)).length).toBeLessThan(DEFAULT)
  })

  it('the seam does not leak: lowering and restoring returns exactly the default', () => {
    setIntentCapForTest(100)
    expect(intentCap()).toBe(100)
    setIntentCapForTest(null)
    expect(intentCap()).toBe(65536)
  })

  it('writer and reader agree at the boundary: 65536 bytes refused, 65535 accepted', () => {
    expect(jsonBytes(sized(DEFAULT, 0)).length).toBe(DEFAULT)
    expect(jsonBytes(sized(DEFAULT, -1)).length).toBe(DEFAULT - 1)
    expect(readableIntentBytes(sized(DEFAULT, 0), OP_ID, ID)).toMatchObject({
      ok: false,
      size: DEFAULT,
      reason: `the park intent would be ${DEFAULT} bytes, at or over the reader's 65536-byte cap`,
    })
    const under = readableIntentBytes(sized(DEFAULT, -1), OP_ID, ID)
    expect(under.ok && under.bytes.length).toBe(DEFAULT - 1)
    // The reader's side of the same two sizes.
    expect(intentValueOf(jsonBytes(sized(DEFAULT, 0)))).toBeNull()
    expect(isParkIntentFor(intentValueOf(jsonBytes(sized(DEFAULT, -1))), OP_ID, ID)).toBe(true)
  })

  it('an intent over 4096 bytes and under the cap is accepted by both sides', () => {
    const intent = sized(5000, 0)
    expect(jsonBytes(intent).length).toBe(5000)
    expect(readableIntentBytes(intent, OP_ID, ID).ok).toBe(true)
    expect(isParkIntentFor(intentValueOf(jsonBytes(intent)), OP_ID, ID)).toBe(true)
  })
})

describe('the test seam', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    setIntentCapForTest(null)
  })

  it('moves the writer and the reader together', () => {
    const intent = sized(2000, 0)
    expect(readableIntentBytes(intent, OP_ID, ID).ok).toBe(true)
    expect(intentValueOf(jsonBytes(intent))).not.toBeNull()
    setIntentCapForTest(2000)
    expect(readableIntentBytes(intent, OP_ID, ID).ok).toBe(false)
    expect(intentValueOf(jsonBytes(intent))).toBeNull()
  })

  it('refuses to run outside a vitest worker, and leaves the cap alone', () => {
    vi.stubEnv('VITEST', '')
    expect(() => setIntentCapForTest(100)).toThrow('tests only')
    expect(intentCap()).toBe(65536)
  })

  it('refuses a cap that is not a positive integer', () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => setIntentCapForTest(bad), String(bad)).toThrow('bad intent cap')
    }
    expect(intentCap()).toBe(65536)
  })
})

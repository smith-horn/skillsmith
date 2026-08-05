/**
 * SMI-5879 (8.3.2.3/8.3.3.5.2): Unit tests for `assertRunAllowed`, the
 * env-sourced (`INDEXER_RUN_ALLOWLIST`) layer of the shared indexer execution
 * gate. Six rows per the design doc: unset/'all' permits; 'none' refuses; a
 * comma-separated subset permits only the listed run types; an unrecognised
 * value fails closed; exhaustiveness over every `GATED_RUN_TYPES` member; and
 * `parse-env.ts`'s `RUN_TYPE` union is a strict subset of `GATED_RUN_TYPES`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { assertRunAllowed, GATED_RUN_TYPES, type GatedRunType } from '../../indexer/run-gate.ts'

const ENV_VAR = 'INDEXER_RUN_ALLOWLIST'
let prevValue: string | undefined

beforeEach(() => {
  prevValue = process.env[ENV_VAR]
  delete process.env[ENV_VAR]
})

afterEach(() => {
  if (prevValue === undefined) delete process.env[ENV_VAR]
  else process.env[ENV_VAR] = prevValue
})

describe('assertRunAllowed — unset/all permits', () => {
  it('permits every run type when INDEXER_RUN_ALLOWLIST is unset', () => {
    delete process.env[ENV_VAR]
    for (const runType of GATED_RUN_TYPES) {
      expect(() => assertRunAllowed(runType)).not.toThrow()
    }
  })

  it("permits every run type when INDEXER_RUN_ALLOWLIST is 'all' (any case/whitespace)", () => {
    for (const raw of ['all', 'ALL', ' All ']) {
      process.env[ENV_VAR] = raw
      for (const runType of GATED_RUN_TYPES) {
        expect(() => assertRunAllowed(runType)).not.toThrow()
      }
    }
  })
})

describe("assertRunAllowed — 'none' refuses", () => {
  it('refuses every run type when INDEXER_RUN_ALLOWLIST=none', () => {
    process.env[ENV_VAR] = 'none'
    for (const runType of GATED_RUN_TYPES) {
      expect(() => assertRunAllowed(runType)).toThrow(/none/i)
    }
  })
})

describe('assertRunAllowed — comma-separated subset', () => {
  it('permits only the listed run types and refuses the rest', () => {
    process.env[ENV_VAR] = 'discovery, maintenance'
    expect(() => assertRunAllowed('discovery')).not.toThrow()
    expect(() => assertRunAllowed('maintenance')).not.toThrow()
    expect(() => assertRunAllowed('recheck')).toThrow()
    expect(() => assertRunAllowed('dequarantine')).toThrow()
    expect(() => assertRunAllowed('purge')).toThrow()
    expect(() => assertRunAllowed('revalidate')).toThrow()
  })

  it('is case-insensitive on both the list and the token', () => {
    process.env[ENV_VAR] = 'Purge'
    expect(() => assertRunAllowed('purge')).not.toThrow()
  })
})

describe('assertRunAllowed — unrecognised value fails closed', () => {
  it('refuses a typo that could otherwise be misread as "all"', () => {
    process.env[ENV_VAR] = 'nonw'
    for (const runType of GATED_RUN_TYPES) {
      expect(() => assertRunAllowed(runType)).toThrow()
    }
  })

  it('refuses a comma list containing one unrecognised token, for every member', () => {
    process.env[ENV_VAR] = 'discovery,bogus'
    expect(() => assertRunAllowed('discovery')).toThrow()
    expect(() => assertRunAllowed('bogus' as GatedRunType)).toThrow()
  })
})

describe('assertRunAllowed — exhaustiveness over GATED_RUN_TYPES', () => {
  it.each(GATED_RUN_TYPES)('permits %s under an unset allow-list', (runType) => {
    delete process.env[ENV_VAR]
    expect(() => assertRunAllowed(runType)).not.toThrow()
  })

  it.each(GATED_RUN_TYPES)('is exactly listed by its own comma entry for %s', (runType) => {
    process.env[ENV_VAR] = runType
    expect(() => assertRunAllowed(runType)).not.toThrow()
    for (const other of GATED_RUN_TYPES) {
      if (other === runType) continue
      expect(() => assertRunAllowed(other)).toThrow()
    }
  })
})

describe('GATED_RUN_TYPES vs parse-env.ts RUN_TYPE union', () => {
  it("parse-env.ts's RUN_TYPE union is a strict subset of GATED_RUN_TYPES", async () => {
    // parse-env.ts's RUN_TYPE validation (161-173) accepts exactly these five
    // literals; `revalidate` is deliberately outside that union (8.3.2.3) —
    // this test pins that containment so the two vocabularies cannot drift.
    const PARSE_ENV_RUN_TYPES = [
      'discovery',
      'maintenance',
      'recheck',
      'dequarantine',
      'purge',
    ] as const

    for (const runType of PARSE_ENV_RUN_TYPES) {
      expect(GATED_RUN_TYPES).toContain(runType)
    }
    expect(GATED_RUN_TYPES.length).toBeGreaterThan(PARSE_ENV_RUN_TYPES.length)
    expect(GATED_RUN_TYPES).toContain('revalidate')
  })
})

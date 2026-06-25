/**
 * Env parsing tests — kill-switch semantics (Hard Rule 1)
 * @module scripts/indexer/tests/parse-env
 *
 * SMI-4852: `CONCURRENCY_KILL_SWITCH=1` must force concurrency=1 regardless
 * of `CONCURRENCY`. Default concurrency is 2 (D-3). RUN_TYPE must be one of
 * `discovery` | `maintenance`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { parseEnv } from '../../indexer/parse-env.ts'

const baseEnv = (): NodeJS.ProcessEnv => ({
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'srk',
})

describe('parseEnv', () => {
  let originalEnv: NodeJS.ProcessEnv
  beforeEach(() => {
    originalEnv = { ...process.env }
    // Clear vars we test
    for (const k of [
      'CRON_SLOT',
      'MAX_PAGES',
      'MAX_REPOS',
      'CODE_SEARCH_MAX_PAGES',
      'DRY_RUN',
      'RUN_TYPE',
      'STALE_DAYS',
      'CONCURRENCY',
      'CONCURRENCY_KILL_SWITCH',
      'RECHECK_THRESHOLD_DAYS',
      'RECHECK_MAX_CANDIDATES',
      'RECHECK_BATCH',
      'RECHECK_DRY_RUN',
      'DEQUARANTINE_DRY_RUN',
    ]) {
      delete process.env[k]
    }
    Object.assign(process.env, baseEnv())
  })
  afterEach(() => {
    process.env = originalEnv
  })

  it('defaults concurrency to 2 when neither var is set', () => {
    const env = parseEnv()
    expect(env.concurrency).toBe(2)
    expect(env.kill_switch_engaged).toBe(false)
  })

  it('honors CONCURRENCY env var', () => {
    process.env.CONCURRENCY = '4'
    const env = parseEnv()
    expect(env.concurrency).toBe(4)
    expect(env.kill_switch_engaged).toBe(false)
  })

  it('CONCURRENCY_KILL_SWITCH=1 forces concurrency=1 (overrides CONCURRENCY)', () => {
    process.env.CONCURRENCY = '8'
    process.env.CONCURRENCY_KILL_SWITCH = '1'
    const env = parseEnv()
    expect(env.concurrency).toBe(1)
    expect(env.kill_switch_engaged).toBe(true)
  })

  it('CONCURRENCY_KILL_SWITCH=true also engages the switch', () => {
    process.env.CONCURRENCY_KILL_SWITCH = 'true'
    const env = parseEnv()
    expect(env.kill_switch_engaged).toBe(true)
    expect(env.concurrency).toBe(1)
  })

  it('CONCURRENCY_KILL_SWITCH=0 does not engage the switch', () => {
    process.env.CONCURRENCY_KILL_SWITCH = '0'
    const env = parseEnv()
    expect(env.kill_switch_engaged).toBe(false)
    expect(env.concurrency).toBe(2)
  })

  it('throws on missing SUPABASE_URL', () => {
    delete process.env.SUPABASE_URL
    expect(() => parseEnv()).toThrow(/SUPABASE_URL/)
  })

  it('throws on invalid RUN_TYPE', () => {
    process.env.RUN_TYPE = 'invalid'
    expect(() => parseEnv()).toThrow(/RUN_TYPE/)
  })

  it('defaults STALE_DAYS based on RUN_TYPE', () => {
    process.env.RUN_TYPE = 'maintenance'
    expect(parseEnv().STALE_DAYS).toBe(7)
    process.env.RUN_TYPE = 'discovery'
    expect(parseEnv().STALE_DAYS).toBe(30)
  })

  it('parses CRON_SLOT as number', () => {
    process.env.CRON_SLOT = '12'
    expect(parseEnv().CRON_SLOT).toBe(12)
  })

  it('CRON_SLOT empty string => null', () => {
    process.env.CRON_SLOT = ''
    expect(parseEnv().CRON_SLOT).toBe(null)
  })

  // SMI-5166: recheck run-type + RECHECK_* configuration.
  it('RUN_TYPE=recheck parses successfully and yields RUN_TYPE recheck', () => {
    process.env.RUN_TYPE = 'recheck'
    expect(() => parseEnv()).not.toThrow()
    expect(parseEnv().RUN_TYPE).toBe('recheck')
  })

  it('RECHECK_* defaults: threshold=5, max=2000, batch=5, dry-run=true when absent', () => {
    const env = parseEnv()
    expect(env.RECHECK_THRESHOLD_DAYS).toBe(5)
    expect(env.RECHECK_MAX_CANDIDATES).toBe(2000)
    expect(env.RECHECK_BATCH).toBe(5)
    expect(env.RECHECK_DRY_RUN).toBe(true)
  })

  it("RECHECK_DRY_RUN='false' yields false", () => {
    process.env.RECHECK_DRY_RUN = 'false'
    expect(parseEnv().RECHECK_DRY_RUN).toBe(false)
  })

  it('RECHECK_THRESHOLD_DAYS non-finite throws (getInt contract — no clamping)', () => {
    process.env.RECHECK_THRESHOLD_DAYS = 'abc'
    expect(() => parseEnv()).toThrow(/RECHECK_THRESHOLD_DAYS/)
  })

  // SMI-5356: dequarantine run-type + DEQUARANTINE_DRY_RUN failsafe.
  it('RUN_TYPE=dequarantine parses successfully and yields RUN_TYPE dequarantine', () => {
    process.env.RUN_TYPE = 'dequarantine'
    expect(() => parseEnv()).not.toThrow()
    expect(parseEnv().RUN_TYPE).toBe('dequarantine')
  })

  it('DEQUARANTINE_DRY_RUN defaults true (dry-run-first failsafe)', () => {
    expect(parseEnv().DEQUARANTINE_DRY_RUN).toBe(true)
  })

  it("DEQUARANTINE_DRY_RUN='false' yields false (the deliberate-apply gate)", () => {
    process.env.DEQUARANTINE_DRY_RUN = 'false'
    expect(parseEnv().DEQUARANTINE_DRY_RUN).toBe(false)
  })

  // SMI-5356 (M-1): fail-safe coercion — apply requires an explicit canonical
  // false; any typo / non-canonical / whitespace stays dry-run (true).
  it('DEQUARANTINE_DRY_RUN accepts only canonical false tokens for apply', () => {
    for (const applyToken of ['false', 'False', 'FALSE', '0', ' false ']) {
      process.env.DEQUARANTINE_DRY_RUN = applyToken
      expect(parseEnv().DEQUARANTINE_DRY_RUN, `${JSON.stringify(applyToken)} should apply`).toBe(
        false
      )
    }
  })

  it('DEQUARANTINE_DRY_RUN treats non-canonical/typo values as dry-run (fail-safe)', () => {
    for (const safeToken of ['yes', 'on', 'no', 'true', 'True ', 'nope', 'apply', '00']) {
      process.env.DEQUARANTINE_DRY_RUN = safeToken
      expect(parseEnv().DEQUARANTINE_DRY_RUN, `${JSON.stringify(safeToken)} should stay dry`).toBe(
        true
      )
    }
  })

  it('STALE_DAYS is the 0 sentinel for dequarantine (M-2: no stale window)', () => {
    process.env.RUN_TYPE = 'dequarantine'
    expect(parseEnv().STALE_DAYS).toBe(0)
  })

  // SMI-5356 (L-2): exactly the four valid RUN_TYPEs parse; everything else throws.
  it('parses exactly the valid RUN_TYPE set and rejects the rest', () => {
    for (const rt of ['discovery', 'maintenance', 'recheck', 'dequarantine']) {
      process.env.RUN_TYPE = rt
      expect(() => parseEnv(), `expected ${rt} to parse`).not.toThrow()
      expect(parseEnv().RUN_TYPE).toBe(rt)
    }
    // `??` only defaults on null/undefined — an empty string is an explicit value
    // and is rejected like any other non-member (case/whitespace/typo).
    for (const bad of ['', 'Discovery', 'sweep', 'dequarantine ', 'recheckk']) {
      process.env.RUN_TYPE = bad
      expect(() => parseEnv(), `expected ${JSON.stringify(bad)} to throw`).toThrow(/RUN_TYPE/)
    }
  })

  it('unset RUN_TYPE (deleted) defaults to discovery via ??', () => {
    delete process.env.RUN_TYPE
    expect(parseEnv().RUN_TYPE).toBe('discovery')
  })
})

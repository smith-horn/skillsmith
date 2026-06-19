/**
 * BACKFILL_MODE env parsing tests (SMI-5286 Wave 1b §#2)
 * @module scripts/tests/indexer/parse-env.backfill
 *
 * Covers the new BACKFILL_MODE boolean field in IndexerEnv. Pattern mirrors
 * parse-env.test.ts exactly: manipulate process.env, call parseEnv(), restore.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { parseEnv } from '../../indexer/parse-env.ts'

const BASE_ENV: NodeJS.ProcessEnv = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'srk',
}

describe('parseEnv — BACKFILL_MODE (SMI-5286 Wave 1b)', () => {
  let originalEnv: NodeJS.ProcessEnv

  beforeEach(() => {
    originalEnv = { ...process.env }
    // Start each test from a clean base
    for (const k of Object.keys(process.env)) {
      delete process.env[k]
    }
    Object.assign(process.env, BASE_ENV)
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('defaults BACKFILL_MODE to false when the var is absent', () => {
    delete process.env.BACKFILL_MODE
    expect(parseEnv().BACKFILL_MODE).toBe(false)
  })

  it('defaults BACKFILL_MODE to false when the var is an empty string', () => {
    process.env.BACKFILL_MODE = ''
    expect(parseEnv().BACKFILL_MODE).toBe(false)
  })

  it('parses BACKFILL_MODE="true" as true', () => {
    process.env.BACKFILL_MODE = 'true'
    expect(parseEnv().BACKFILL_MODE).toBe(true)
  })

  it('parses BACKFILL_MODE="1" as true', () => {
    process.env.BACKFILL_MODE = '1'
    expect(parseEnv().BACKFILL_MODE).toBe(true)
  })

  it('parses BACKFILL_MODE="True" as true (case-insensitive "True")', () => {
    process.env.BACKFILL_MODE = 'True'
    expect(parseEnv().BACKFILL_MODE).toBe(true)
  })

  it('parses BACKFILL_MODE="TRUE" as true', () => {
    process.env.BACKFILL_MODE = 'TRUE'
    expect(parseEnv().BACKFILL_MODE).toBe(true)
  })

  it('parses BACKFILL_MODE="false" as false', () => {
    process.env.BACKFILL_MODE = 'false'
    expect(parseEnv().BACKFILL_MODE).toBe(false)
  })

  it('parses BACKFILL_MODE="0" as false', () => {
    process.env.BACKFILL_MODE = '0'
    expect(parseEnv().BACKFILL_MODE).toBe(false)
  })

  it('BACKFILL_MODE does not affect concurrency or kill_switch_engaged', () => {
    process.env.BACKFILL_MODE = 'true'
    process.env.CONCURRENCY = '4'
    const env = parseEnv()
    expect(env.BACKFILL_MODE).toBe(true)
    expect(env.concurrency).toBe(4)
    expect(env.kill_switch_engaged).toBe(false)
  })

  it('BACKFILL_MODE is present in the returned IndexerEnv shape (not undefined)', () => {
    const env = parseEnv()
    expect('BACKFILL_MODE' in env).toBe(true)
  })
})

describe('parseEnv — SMI-5286 1c backfill levers', () => {
  let originalEnv: NodeJS.ProcessEnv

  beforeEach(() => {
    originalEnv = { ...process.env }
    for (const k of Object.keys(process.env)) {
      delete process.env[k]
    }
    Object.assign(process.env, BASE_ENV)
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('BACKFILL_PATH_PREFIX is undefined when absent or empty', () => {
    delete process.env.BACKFILL_PATH_PREFIX
    expect(parseEnv().BACKFILL_PATH_PREFIX).toBeUndefined()
    process.env.BACKFILL_PATH_PREFIX = ''
    expect(parseEnv().BACKFILL_PATH_PREFIX).toBeUndefined()
  })

  it('BACKFILL_PATH_PREFIX passes a non-empty prefix through verbatim', () => {
    process.env.BACKFILL_PATH_PREFIX = '.agents/skills'
    expect(parseEnv().BACKFILL_PATH_PREFIX).toBe('.agents/skills')
  })

  it('BACKFILL_MAX_RANGES defaults to 150 and honors an override', () => {
    delete process.env.BACKFILL_MAX_RANGES
    expect(parseEnv().BACKFILL_MAX_RANGES).toBe(150)
    process.env.BACKFILL_MAX_RANGES = '40'
    expect(parseEnv().BACKFILL_MAX_RANGES).toBe(40)
  })

  it('raises the cap DEFAULTS only when BACKFILL_MODE is set (C-5)', () => {
    // Cron defaults (backfill off)
    const cron = parseEnv()
    expect(cron.MAX_PAGES).toBe(5)
    expect(cron.MAX_REPOS).toBe(100)
    expect(cron.CODE_SEARCH_MAX_PAGES).toBe(1)

    // Backfill defaults (no explicit caps set)
    process.env.BACKFILL_MODE = 'true'
    const backfill = parseEnv()
    expect(backfill.MAX_PAGES).toBe(10)
    expect(backfill.MAX_REPOS).toBe(500)
    expect(backfill.CODE_SEARCH_MAX_PAGES).toBe(10)
  })

  it('explicit cap env vars still override the backfill defaults', () => {
    process.env.BACKFILL_MODE = 'true'
    process.env.CODE_SEARCH_MAX_PAGES = '3'
    process.env.MAX_PAGES = '7'
    const env = parseEnv()
    expect(env.CODE_SEARCH_MAX_PAGES).toBe(3)
    expect(env.MAX_PAGES).toBe(7)
  })
})

describe('parseEnv -- SMI-5319 W4: BACKFILL_MIN_SIZE_BYTES', () => {
  let originalEnv: NodeJS.ProcessEnv

  beforeEach(() => {
    originalEnv = { ...process.env }
    for (const k of Object.keys(process.env)) {
      delete process.env[k]
    }
    Object.assign(process.env, BASE_ENV)
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('defaults BACKFILL_MIN_SIZE_BYTES to 0 when the var is absent', () => {
    delete process.env.BACKFILL_MIN_SIZE_BYTES
    expect(parseEnv().BACKFILL_MIN_SIZE_BYTES).toBe(0)
  })

  it('defaults BACKFILL_MIN_SIZE_BYTES to 0 when the var is an empty string', () => {
    process.env.BACKFILL_MIN_SIZE_BYTES = ''
    expect(parseEnv().BACKFILL_MIN_SIZE_BYTES).toBe(0)
  })

  it('parses BACKFILL_MIN_SIZE_BYTES="1024" as 1024', () => {
    process.env.BACKFILL_MIN_SIZE_BYTES = '1024'
    expect(parseEnv().BACKFILL_MIN_SIZE_BYTES).toBe(1024)
  })

  it('parses BACKFILL_MIN_SIZE_BYTES="0" as 0', () => {
    process.env.BACKFILL_MIN_SIZE_BYTES = '0'
    expect(parseEnv().BACKFILL_MIN_SIZE_BYTES).toBe(0)
  })

  it('BACKFILL_MIN_SIZE_BYTES is present in the returned IndexerEnv shape (not undefined)', () => {
    const env = parseEnv()
    expect('BACKFILL_MIN_SIZE_BYTES' in env).toBe(true)
  })
})

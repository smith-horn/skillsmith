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

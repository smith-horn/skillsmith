/**
 * SMI-5541: Continuous-audit email digest state tests.
 *
 * Uses the same HOME-mutation harness as `device-identity.test.ts` so each test
 * begins with a blank `~/.skillsmith/config.json` and exercises the real
 * `loadConfig`/`saveConfig` round-trip (not a mock).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as path from 'path'
import * as os from 'os'

import { loadConfig, saveConfig } from './index.js'
import { getAuditNotifyState, recordAuditNotify } from './audit-notify-state.js'

function makeTempConfigDir(): string {
  return path.join(
    os.tmpdir(),
    `skillsmith-audit-state-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  )
}

let savedHome: string | undefined

beforeEach(() => {
  savedHome = process.env.HOME
  process.env.HOME = makeTempConfigDir()
})

afterEach(() => {
  if (savedHome !== undefined) process.env.HOME = savedHome
  else delete process.env.HOME
})

describe('getAuditNotifyState', () => {
  it('returns both fields undefined on a blank config', () => {
    expect(getAuditNotifyState()).toEqual({ lastNotifyAt: undefined, lastDigestHash: undefined })
  })
})

describe('recordAuditNotify', () => {
  it('records the timestamp without a hash', () => {
    recordAuditNotify('2026-07-04T00:00:00.000Z')
    expect(getAuditNotifyState()).toEqual({
      lastNotifyAt: '2026-07-04T00:00:00.000Z',
      lastDigestHash: undefined,
    })
  })

  it('records the timestamp and the digest hash together', () => {
    recordAuditNotify('2026-07-04T00:00:00.000Z', 'abc123')
    expect(getAuditNotifyState()).toEqual({
      lastNotifyAt: '2026-07-04T00:00:00.000Z',
      lastDigestHash: 'abc123',
    })
  })

  it('advancing the timestamp WITHOUT a hash preserves the stored hash', () => {
    recordAuditNotify('2026-07-04T00:00:00.000Z', 'hash-of-emailed-digest')
    recordAuditNotify('2026-07-05T00:00:00.000Z')
    expect(getAuditNotifyState()).toEqual({
      lastNotifyAt: '2026-07-05T00:00:00.000Z',
      lastDigestHash: 'hash-of-emailed-digest',
    })
  })

  it('does not clobber other config namespaces (inventory)', () => {
    saveConfig({ inventory: { deviceId: '11111111-1111-4111-8111-111111111111' } })
    recordAuditNotify('2026-07-04T00:00:00.000Z', 'h')
    const config = loadConfig()
    expect(config.inventory?.deviceId).toBe('11111111-1111-4111-8111-111111111111')
    expect(config.audit?.lastDigestHash).toBe('h')
  })
})

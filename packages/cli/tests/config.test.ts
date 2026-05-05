/**
 * @fileoverview SMI-4590 Wave 4 PR 5/6 — `sklx config get/set audit_mode` tests
 * @module @skillsmith/cli/tests/config
 *
 * Coverage (plan §810-813 — load-bearing tier-revalidation security tests):
 *
 * Tier revalidation matrix — the `set` path MUST refuse a write when
 * `tierAllowsAuditMode(tier, mode)` returns false. No file IO occurs on
 * rejection; the existing config (if any) stays intact.
 *
 *   1. community  + power_user   → audit.mode.tier_ineligible, NO write
 *   2. community  + governance   → audit.mode.tier_ineligible, NO write
 *   3. individual + power_user   → audit.mode.tier_ineligible, NO write
 *   4. individual + governance   → audit.mode.tier_ineligible, NO write
 *   5. team       + power_user   → SUCCESS, file written
 *   6. team       + governance   → audit.mode.tier_ineligible (Enterprise-only)
 *   7. enterprise + governance   → SUCCESS, file written
 *
 * Value validation:
 *   8. any tier   + invalid_value → audit.mode.invalid_value, NO write
 *   9. any tier   + preventative  → SUCCESS for every tier
 *  10. any tier   + off           → SUCCESS for every tier
 *
 * Unsupported keys:
 *  11. set with unknown key → config.unsupported_key, NO write
 *  12. get with unknown key → config.unsupported_key
 *
 * Get path:
 *  13. get audit_mode reads existing file value when present
 *  14. get audit_mode falls back to tier default when unset
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'

const mocks = vi.hoisted(() => ({
  getLicenseStatus: vi.fn(),
}))

vi.mock('../src/utils/license.js', () => ({
  getLicenseStatus: () => mocks.getLicenseStatus(),
}))

import { runConfigGet, runConfigSet, ConfigError, configPath } from '../src/commands/config.js'

// ============================================================================
// Test harness — sandbox HOME so config writes are isolated.
// ============================================================================

let tmpHome: string
let originalHome: string | undefined
let stdoutSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  tmpHome = fs.mkdtempSync(join(os.tmpdir(), 'sklx-config-test-'))
  originalHome = process.env['HOME']
  process.env['HOME'] = tmpHome
  stdoutSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.clearAllMocks()
})

afterEach(() => {
  if (originalHome !== undefined) {
    process.env['HOME'] = originalHome
  } else {
    delete process.env['HOME']
  }
  fs.rmSync(tmpHome, { recursive: true, force: true })
  stdoutSpy.mockRestore()
})

function setTier(tier: string): void {
  mocks.getLicenseStatus.mockResolvedValue({ tier })
}

function configFileExists(): boolean {
  return fs.existsSync(configPath())
}

function readConfigRaw(): Record<string, unknown> {
  if (!configFileExists()) return {}
  return JSON.parse(fs.readFileSync(configPath(), 'utf-8')) as Record<string, unknown>
}

// ============================================================================
// Tests
// ============================================================================

describe('SMI-4590 Wave 4 PR 5/6 — sklx config tier revalidation (plan §810-813)', () => {
  describe('community tier — power_user / governance forbidden', () => {
    it('community + power_user → tier_ineligible, NO write', async () => {
      setTier('community')
      try {
        await runConfigSet('audit_mode', 'power_user')
        expect.fail('Expected ConfigError')
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigError)
        expect((error as ConfigError).code).toBe('audit.mode.tier_ineligible')
      }
      expect(configFileExists()).toBe(false)
    })

    it('community + governance → tier_ineligible, NO write', async () => {
      setTier('community')
      try {
        await runConfigSet('audit_mode', 'governance')
        expect.fail('Expected ConfigError')
      } catch (error) {
        expect((error as ConfigError).code).toBe('audit.mode.tier_ineligible')
      }
      expect(configFileExists()).toBe(false)
    })
  })

  describe('individual tier — power_user / governance forbidden', () => {
    it('individual + power_user → tier_ineligible, NO write', async () => {
      setTier('individual')
      try {
        await runConfigSet('audit_mode', 'power_user')
        expect.fail('Expected ConfigError')
      } catch (error) {
        expect((error as ConfigError).code).toBe('audit.mode.tier_ineligible')
      }
      expect(configFileExists()).toBe(false)
    })

    it('individual + governance → tier_ineligible, NO write', async () => {
      setTier('individual')
      try {
        await runConfigSet('audit_mode', 'governance')
        expect.fail('Expected ConfigError')
      } catch (error) {
        expect((error as ConfigError).code).toBe('audit.mode.tier_ineligible')
      }
      expect(configFileExists()).toBe(false)
    })
  })

  describe('team tier — power_user allowed, governance forbidden', () => {
    it('team + power_user → SUCCESS, file written', async () => {
      setTier('team')
      await runConfigSet('audit_mode', 'power_user')
      expect(configFileExists()).toBe(true)
      expect(readConfigRaw()['audit_mode']).toBe('power_user')
    })

    it('team + governance → tier_ineligible (Enterprise-only)', async () => {
      setTier('team')
      try {
        await runConfigSet('audit_mode', 'governance')
        expect.fail('Expected ConfigError')
      } catch (error) {
        expect((error as ConfigError).code).toBe('audit.mode.tier_ineligible')
      }
      expect(configFileExists()).toBe(false)
    })
  })

  describe('enterprise tier — governance allowed', () => {
    it('enterprise + governance → SUCCESS, file written', async () => {
      setTier('enterprise')
      await runConfigSet('audit_mode', 'governance')
      expect(configFileExists()).toBe(true)
      expect(readConfigRaw()['audit_mode']).toBe('governance')
    })
  })
})

describe('SMI-4590 Wave 4 PR 5/6 — sklx config value validation', () => {
  it('invalid_value → audit.mode.invalid_value, NO write', async () => {
    setTier('enterprise')
    try {
      await runConfigSet('audit_mode', 'definitely-not-a-mode')
      expect.fail('Expected ConfigError')
    } catch (error) {
      expect((error as ConfigError).code).toBe('audit.mode.invalid_value')
    }
    expect(configFileExists()).toBe(false)
  })

  it('preventative is allowed for every tier', async () => {
    for (const tier of ['community', 'individual', 'team', 'enterprise']) {
      // Reset sandbox between tiers.
      fs.rmSync(configPath(), { force: true })
      setTier(tier)
      await runConfigSet('audit_mode', 'preventative')
      expect(readConfigRaw()['audit_mode']).toBe('preventative')
    }
  })

  it('off is allowed for every tier', async () => {
    for (const tier of ['community', 'individual', 'team', 'enterprise']) {
      fs.rmSync(configPath(), { force: true })
      setTier(tier)
      await runConfigSet('audit_mode', 'off')
      expect(readConfigRaw()['audit_mode']).toBe('off')
    }
  })
})

describe('SMI-4590 Wave 4 PR 5/6 — sklx config unsupported keys', () => {
  it('set with unknown key → config.unsupported_key, NO write', async () => {
    setTier('enterprise')
    try {
      await runConfigSet('telemetry_endpoint', 'https://example.com')
      expect.fail('Expected ConfigError')
    } catch (error) {
      expect((error as ConfigError).code).toBe('config.unsupported_key')
    }
    expect(configFileExists()).toBe(false)
  })

  it('get with unknown key → config.unsupported_key', async () => {
    setTier('enterprise')
    try {
      await runConfigGet('telemetry_endpoint')
      expect.fail('Expected ConfigError')
    } catch (error) {
      expect((error as ConfigError).code).toBe('config.unsupported_key')
    }
  })
})

describe('SMI-4590 Wave 4 PR 5/6 — sklx config get audit_mode', () => {
  it('reads existing file value when present', async () => {
    setTier('team')
    await runConfigSet('audit_mode', 'power_user')
    stdoutSpy.mockClear()
    await runConfigGet('audit_mode')
    const out = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0] ?? '')).join('\n')
    expect(out).toContain('power_user')
  })

  it('falls back to tier default when no config file exists', async () => {
    setTier('community')
    // No prior write, so file does not exist.
    expect(configFileExists()).toBe(false)
    await runConfigGet('audit_mode')
    const out = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0] ?? '')).join('\n')
    // Output should reference the tier default plus the "(tier default)" hint.
    expect(out).toMatch(/tier default/)
  })

  it('preserves unknown keys on read-modify-write (atomic merge)', async () => {
    setTier('team')
    // Seed the config with extra keys directly.
    fs.mkdirSync(join(tmpHome, '.skillsmith'), { recursive: true })
    fs.writeFileSync(
      configPath(),
      JSON.stringify({ extra_key: 'value', audit_mode: 'preventative' }),
      'utf-8'
    )
    await runConfigSet('audit_mode', 'power_user')
    const after = readConfigRaw()
    expect(after['audit_mode']).toBe('power_user')
    expect(after['extra_key']).toBe('value')
  })
})

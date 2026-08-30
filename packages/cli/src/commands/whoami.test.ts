/**
 * SMI-2715: Whoami Command Tests
 *
 * Tests for `skillsmith whoami` — unauthenticated state, each source label,
 * masked key display, and JWT device-code session detection (SMI-4402 — the
 * bug where `whoami`/`logout` only checked the legacy API key and missed a
 * live JWT session that `login` itself could see).
 *
 * SMI-6266 Wave 2 (SMI-6272): live effective-tier display. Fixture matrix
 * per the plan's Step 1: each of the four tiers, covering all three live
 * credential sources `resolveEffectiveTier()` can resolve from (license key,
 * API key, device session), plus the transient-failure display case. Real
 * `formatTierBadge()` (license.ts) is used unmocked — it's a pure
 * chalk-formatting function with no side effects, and the whole point of
 * reusing it (per the plan) is to prove whoami's output actually comes from
 * that shared helper, not a reimplementation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('@skillsmith/core', () => ({
  getAuthStatus: vi.fn(),
  loadCredentials: vi.fn(),
}))

vi.mock('../utils/require-tier.js', () => ({
  resolveEffectiveTier: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { createWhoamiCommand } from './whoami.js'
import { getAuthStatus, loadCredentials } from '@skillsmith/core'
import { resolveEffectiveTier, type EffectiveTierResult } from '../utils/require-tier.js'
import { TIER_FEATURES } from '../utils/license-types.js'

const mockGetAuthStatus = vi.mocked(getAuthStatus)
const mockLoadCredentials = vi.mocked(loadCredentials)
const mockResolveEffectiveTier = vi.mocked(resolveEffectiveTier)

/** A definitive community/'none'-source result — the harmless default for
 * tests that don't care about tier display. */
const COMMUNITY_NONE: EffectiveTierResult = {
  status: { valid: true, tier: 'community', features: TIER_FEATURES.community },
  source: 'none',
  transient: false,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function runCommand(args: string[] = []): Promise<void> {
  const cmd = createWhoamiCommand()
  await cmd.parseAsync(['node', 'whoami', ...args])
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createWhoamiCommand', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>
  let processExitSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    // clearAllMocks resets call history on module-level mocks (declared above).
    // Must run BEFORE setting up spies so the spy implementations are not cleared.
    vi.clearAllMocks()
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    processExitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((code?: string | number | null | undefined) => {
        throw new Error(`process.exit(${code ?? 0})`)
      })

    // Default: no JWT session, so existing legacy-API-key tests exercise the
    // getAuthStatus() path unchanged. JWT-specific tests override this.
    mockLoadCredentials.mockResolvedValue(null)

    // Default: definitive community/'none' — harmless for every test that
    // predates Wave 2 and doesn't assert on tier output. Tier-specific tests
    // below override this per case.
    mockResolveEffectiveTier.mockResolvedValue(COMMUNITY_NONE)
  })

  afterEach(() => {
    consoleLogSpy.mockRestore()
    processExitSpy.mockRestore()
  })

  describe('command metadata', () => {
    it('has the correct name', () => {
      expect(createWhoamiCommand().name()).toBe('whoami')
    })

    it('has a description', () => {
      expect(createWhoamiCommand().description()).toBeTruthy()
    })
  })

  describe('unauthenticated state', () => {
    it('prints login suggestion when not authenticated', async () => {
      mockGetAuthStatus.mockResolvedValue({
        authenticated: false,
        keyPrefix: null,
        source: 'none',
      })

      await expect(runCommand()).rejects.toThrow('process.exit(0)')

      const output = consoleLogSpy.mock.calls.flat().join('\n')
      expect(output).toContain('Not authenticated')
      expect(output).toContain('skillsmith login')
    })
  })

  describe('JWT session state (SMI-4402 regression)', () => {
    it('shows device-code session when a live JWT exists, even with no API key configured', async () => {
      // Exactly the state a device-code login leaves behind: getAuthStatus()
      // (legacy API key only) sees nothing, but a live JWT session exists.
      mockGetAuthStatus.mockResolvedValue({
        authenticated: false,
        keyPrefix: null,
        source: 'none',
      })
      mockLoadCredentials.mockResolvedValue({
        accessToken: 'live-access-token',
        refreshToken: 'live-refresh-token',
        expiresAt: Date.now() + 60 * 60 * 1000,
        version: 2,
      })

      await expect(runCommand()).rejects.toThrow('process.exit(0)')

      const output = consoleLogSpy.mock.calls.flat().join('\n')
      expect(output).not.toContain('Not authenticated')
      expect(output).toContain('device-code login')
    })

    // PR review finding (SMI-6235): an expired access token with a live
    // refresh token on file is still shown as a device-code session — it is
    // a session resolveFreshAccessToken() refreshes transparently on next
    // use, not one to report as absent. Distinct from the "no JWT session at
    // all" case (loadCredentials() null), which does fall through below.
    it('still shows device-code session when the access token has expired but a refresh token is on file', async () => {
      mockGetAuthStatus.mockResolvedValue({
        authenticated: true,
        keyPrefix: 'sk_live_xxxx',
        source: 'config',
      })
      mockLoadCredentials.mockResolvedValue({
        accessToken: 'expired-token',
        refreshToken: 'refresh',
        expiresAt: Date.now() - 1000,
        version: 2,
      })

      await expect(runCommand()).rejects.toThrow('process.exit(0)')

      const output = consoleLogSpy.mock.calls.flat().join('\n')
      expect(output).toContain('device-code login')
      expect(output).toContain('expired')
      expect(output).not.toContain('sk_live_xxxx...')
    })

    it('falls through to the legacy API-key check when there is no JWT session at all', async () => {
      mockGetAuthStatus.mockResolvedValue({
        authenticated: true,
        keyPrefix: 'sk_live_xxxx',
        source: 'config',
      })
      mockLoadCredentials.mockResolvedValue(null)

      await expect(runCommand()).rejects.toThrow('process.exit(0)')

      const output = consoleLogSpy.mock.calls.flat().join('\n')
      expect(output).not.toContain('device-code login')
      expect(output).toContain('sk_live_xxxx...')
    })
  })

  describe('authenticated state', () => {
    it('displays masked key (prefix + ellipsis)', async () => {
      mockGetAuthStatus.mockResolvedValue({
        authenticated: true,
        keyPrefix: 'sk_live_xxxx',
        source: 'keyring',
      })

      await expect(runCommand()).rejects.toThrow('process.exit(0)')

      const output = consoleLogSpy.mock.calls.flat().join('\n')
      expect(output).toContain('sk_live_xxxx...')
    })

    it('shows "OS keyring" source label for keyring source', async () => {
      mockGetAuthStatus.mockResolvedValue({
        authenticated: true,
        keyPrefix: 'sk_live_xxxx',
        source: 'keyring',
      })

      await expect(runCommand()).rejects.toThrow('process.exit(0)')

      const output = consoleLogSpy.mock.calls.flat().join('\n')
      expect(output).toContain('OS keyring')
    })

    it('shows config file source label for config source', async () => {
      mockGetAuthStatus.mockResolvedValue({
        authenticated: true,
        keyPrefix: 'sk_live_xxxx',
        source: 'config',
      })

      await expect(runCommand()).rejects.toThrow('process.exit(0)')

      const output = consoleLogSpy.mock.calls.flat().join('\n')
      expect(output).toContain('config file')
      expect(output).toContain('~/.skillsmith/config.json')
    })

    it('shows env var source label for env source', async () => {
      mockGetAuthStatus.mockResolvedValue({
        authenticated: true,
        keyPrefix: 'sk_live_xxxx',
        source: 'env',
      })

      await expect(runCommand()).rejects.toThrow('process.exit(0)')

      const output = consoleLogSpy.mock.calls.flat().join('\n')
      expect(output).toContain('SKILLSMITH_API_KEY')
    })

    it('shows "Skillsmith CLI" heading when authenticated', async () => {
      mockGetAuthStatus.mockResolvedValue({
        authenticated: true,
        keyPrefix: 'sk_live_xxxx',
        source: 'config',
      })

      await expect(runCommand()).rejects.toThrow('process.exit(0)')

      const output = consoleLogSpy.mock.calls.flat().join('\n')
      expect(output).toContain('Skillsmith CLI')
    })

    it('shows "valid" format indicator', async () => {
      mockGetAuthStatus.mockResolvedValue({
        authenticated: true,
        keyPrefix: 'sk_live_xxxx',
        source: 'config',
      })

      await expect(runCommand()).rejects.toThrow('process.exit(0)')

      const output = consoleLogSpy.mock.calls.flat().join('\n')
      expect(output).toContain('valid')
    })
  })

  describe('live effective-tier display (SMI-6266 Wave 2)', () => {
    // Community tier, resolved via the 'none' source (no credential of any
    // kind) — pairs with the realistic outer "not authenticated" state.
    it('shows the Community tier badge when no credential resolves to one', async () => {
      mockGetAuthStatus.mockResolvedValue({ authenticated: false, keyPrefix: null, source: 'none' })
      mockResolveEffectiveTier.mockResolvedValue(COMMUNITY_NONE)

      await expect(runCommand()).rejects.toThrow('process.exit(0)')

      const output = consoleLogSpy.mock.calls.flat().join('\n')
      expect(output).toContain('Not authenticated')
      expect(output).toContain('Tier:')
      expect(output).toContain('Community')
      // The license-key/none paths never carry a live rate limit.
      expect(output).not.toContain('Rate limit')
    })

    // Individual tier via SKILLSMITH_LICENSE_KEY (license-key source) — a
    // realistic pairing is a user who only ever set the env var and never
    // ran `skillsmith login` or configured an API key (outer state:
    // "not authenticated" per getAuthStatus()/loadCredentials()).
    it('shows the Individual tier badge resolved via a license key', async () => {
      mockGetAuthStatus.mockResolvedValue({ authenticated: false, keyPrefix: null, source: 'none' })
      mockResolveEffectiveTier.mockResolvedValue({
        status: { valid: true, tier: 'individual', features: TIER_FEATURES.individual },
        source: 'license-key',
        transient: false,
      })

      await expect(runCommand()).rejects.toThrow('process.exit(0)')

      const output = consoleLogSpy.mock.calls.flat().join('\n')
      expect(output).toContain('Tier:')
      expect(output).toContain('Individual')
      expect(output).not.toContain('Rate limit')
    })

    // Team tier via a personal API key (api-key source), including the live
    // per-minute rate limit the /license-status response carries for this
    // path. Pairs with the outer "authenticated via legacy key" state.
    it('shows the Team tier badge and rate limit resolved via an API key', async () => {
      mockGetAuthStatus.mockResolvedValue({
        authenticated: true,
        keyPrefix: 'sk_live_xxxx',
        source: 'config',
      })
      mockResolveEffectiveTier.mockResolvedValue({
        status: { valid: true, tier: 'team', features: TIER_FEATURES.team },
        source: 'api-key',
        transient: false,
        rateLimit: 300,
      })

      await expect(runCommand()).rejects.toThrow('process.exit(0)')

      const output = consoleLogSpy.mock.calls.flat().join('\n')
      // Masked key output is unaffected by the new tier section.
      expect(output).toContain('sk_live_xxxx...')
      expect(output).toContain('Tier:')
      expect(output).toContain('Team')
      expect(output).toContain('Rate limit')
      expect(output).toContain('300 req/min')
    })

    // Enterprise tier via a stored device-code session (session source),
    // including its rate limit. Pairs with the outer JWT-session state.
    it('shows the Enterprise tier badge and rate limit resolved via a device session', async () => {
      mockLoadCredentials.mockResolvedValue({
        accessToken: 'live-access-token',
        refreshToken: 'live-refresh-token',
        expiresAt: Date.now() + 60 * 60 * 1000,
        version: 2,
      })
      mockResolveEffectiveTier.mockResolvedValue({
        status: { valid: true, tier: 'enterprise', features: TIER_FEATURES.enterprise },
        source: 'session',
        transient: false,
        rateLimit: 600,
      })

      await expect(runCommand()).rejects.toThrow('process.exit(0)')

      const output = consoleLogSpy.mock.calls.flat().join('\n')
      // Device-session output is unaffected by the new tier section.
      expect(output).toContain('device-code login')
      expect(output).toContain('Tier:')
      expect(output).toContain('Enterprise')
      expect(output).toContain('600 req/min')
    })

    // PR review finding: the matrix above pairs each non-community tier with
    // only one credential source. printTierSection() never reads
    // `result.source` — it branches only on `transient`, `status.tier`, and
    // whether `rateLimit` is defined — so a literal 4-tier x 3-source cross
    // product would just re-exercise the same branches with an unread mock
    // field. These three tests instead cover what the code actually
    // branches on: a second source per tier, paired with the opposite
    // rate-limit presence/absence from the case above (individual now WITH
    // a rate limit; team and enterprise now WITHOUT one).
    it('shows the Individual tier badge and rate limit resolved via an API key', async () => {
      mockGetAuthStatus.mockResolvedValue({
        authenticated: true,
        keyPrefix: 'sk_live_xxxx',
        source: 'config',
      })
      mockResolveEffectiveTier.mockResolvedValue({
        status: { valid: true, tier: 'individual', features: TIER_FEATURES.individual },
        source: 'api-key',
        transient: false,
        rateLimit: 100,
      })

      await expect(runCommand()).rejects.toThrow('process.exit(0)')

      const output = consoleLogSpy.mock.calls.flat().join('\n')
      expect(output).toContain('Tier:')
      expect(output).toContain('Individual')
      expect(output).toContain('Rate limit')
      expect(output).toContain('100 req/min')
    })

    it('shows the Team tier badge resolved via a license key, with no rate limit line', async () => {
      mockGetAuthStatus.mockResolvedValue({ authenticated: false, keyPrefix: null, source: 'none' })
      mockResolveEffectiveTier.mockResolvedValue({
        status: { valid: true, tier: 'team', features: TIER_FEATURES.team },
        source: 'license-key',
        transient: false,
      })

      await expect(runCommand()).rejects.toThrow('process.exit(0)')

      const output = consoleLogSpy.mock.calls.flat().join('\n')
      expect(output).toContain('Tier:')
      expect(output).toContain('Team')
      expect(output).not.toContain('Rate limit')
    })

    it('shows the Enterprise tier badge resolved via a license key, with no rate limit line', async () => {
      mockGetAuthStatus.mockResolvedValue({ authenticated: false, keyPrefix: null, source: 'none' })
      mockResolveEffectiveTier.mockResolvedValue({
        status: { valid: true, tier: 'enterprise', features: TIER_FEATURES.enterprise },
        source: 'license-key',
        transient: false,
      })

      await expect(runCommand()).rejects.toThrow('process.exit(0)')

      const output = consoleLogSpy.mock.calls.flat().join('\n')
      expect(output).toContain('Tier:')
      expect(output).toContain('Enterprise')
      expect(output).not.toContain('Rate limit')
    })

    // Transient failure: the live check couldn't complete. whoami is a
    // display command, not a gate — the rest of the output (masked key,
    // source, etc.) must still render, and the tier section must show a
    // clear "could not verify" message WITHOUT displaying the community
    // placeholder resolveEffectiveTier() returns internally for this case
    // (a single-shot CLI process has no real last-known tier to fall back
    // to, so showing "Community" here would be misleading, not helpful).
    it('shows a "could not verify" message on a transient live-check failure, without a fabricated tier badge', async () => {
      mockGetAuthStatus.mockResolvedValue({
        authenticated: true,
        keyPrefix: 'sk_live_xxxx',
        source: 'config',
      })
      mockResolveEffectiveTier.mockResolvedValue({
        status: { valid: true, tier: 'community', features: TIER_FEATURES.community },
        source: 'api-key',
        transient: true,
      })

      await expect(runCommand()).rejects.toThrow('process.exit(0)')

      const output = consoleLogSpy.mock.calls.flat().join('\n')
      // The rest of the command's output still renders.
      expect(output).toContain('sk_live_xxxx...')
      // The tier section reports the failure, not a fabricated tier.
      expect(output).toContain('could not verify')
      expect(output).not.toContain('Community')
      expect(output).not.toContain('Rate limit')
    })
  })
})

/**
 * SMI-1533 / SMI-2722 / SMI-2732: Install Skill execution + trust-tier integration tests
 * Split out of install.integration.test.ts (SMI-5263). This is the only install
 * integration file that exercises the real installSkill() flow, so it owns the three
 * module mocks (mcp-server install.helpers seam, core skill-installation.io seam, and
 * the core install-path resolvers). Trust-tier validation lives here too because it is
 * conceptually part of the install/security path.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from 'vitest'
import * as path from 'path'
import { createTestFilesystem, fileExists, type TestFilesystemContext } from './setup.js'

// SMI-2722/2732: Mock install.helpers module for UUID install path tests.
// Uses importActual to preserve all real helpers; only lookupSkillFromRegistry and
// fetchFromGitHub are replaced so per-test vi.mocked() calls can control their behavior.
vi.mock('../../src/tools/install.helpers.js', async (importActual) => {
  const actual = await importActual<typeof import('../../src/tools/install.helpers.js')>()
  return {
    ...actual,
    lookupSkillFromRegistry: vi.fn(),
    fetchFromGitHub: vi.fn(),
  }
})

// SMI-5260: SkillInstallationService imports `fetchFromGitHub` +
// `fetchAndScanOptionalFiles` DIRECTLY from `skill-installation.io` — NOT from the
// `-helpers` re-export the prior mock targeted (which is why the UUID install test
// silently 404'd against the real network). Mock the `.io` module so the service
// uses the test doubles. `fetchAndScanOptionalFiles` (SMI-5359 Wave 4.3 rename of
// `fetchOptionalInstallFiles`) must also be mocked: its internal `fetchFromGitHub`
// call is a lexical module-local reference (not the mocked export), so the un-mocked
// real version would still hit the network for README/examples/config.json.
// `writeInstallFiles` is intentionally left REAL so the install actually writes
// SKILL.md to the per-test temp skillsDir (asserted below).
vi.mock('@skillsmith/core/services/skill-installation-io', async (importActual) => {
  const actual = await importActual<Record<string, unknown>>()
  return {
    ...actual,
    fetchFromGitHub: vi.fn(),
    fetchAndScanOptionalFiles: vi.fn(),
  }
})

// SMI-5260: redirect the install target away from the real `~/.claude/skills`.
// `resolveClientPath`/`getInstallPath` derive from `CLIENT_NATIVE_PATHS`, which is
// frozen at module load (`homedir()`), so a runtime HOME swap cannot redirect them —
// mock the resolvers and point them at the per-test temp skillsDir in beforeEach.
// `addLink` and the rest are preserved via importActual.
vi.mock('@skillsmith/core/install', async (importActual) => {
  const actual = await importActual<Record<string, unknown>>()
  return {
    ...actual,
    resolveClientPath: vi.fn(),
    getInstallPath: vi.fn(),
  }
})

describe('Install Skill Tool — Execution & Trust Tier', () => {
  let fsContext: TestFilesystemContext

  beforeEach(async () => {
    fsContext = await createTestFilesystem()
  })

  afterEach(async () => {
    await fsContext.cleanup()
    vi.restoreAllMocks()
  })

  /**
   * SMI-1533: Trust-Tier Security Scanning Tests
   * Tests for trust-tier sensitive security scanning in install flow
   */
  describe('SMI-1533: Trust-Tier Security Scanning', () => {
    // Import the actual validateTrustTier function from install.types.ts
    // SMI-1718: Import from types file after re-export trimming
    // SMI-1809: Added 'local' tier to return type
    // SMI-5205: Added 'official' and 'unverified' to return type
    let validateTrustTier: (
      value: string | null | undefined
    ) =>
      | 'official'
      | 'verified'
      | 'curated'
      | 'community'
      | 'experimental'
      | 'unknown'
      | 'local'
      | 'unverified'

    beforeAll(async () => {
      const installTypesModule = await import('../../src/tools/install.types.js')
      validateTrustTier = installTypesModule.validateTrustTier
    })

    // Type alias for trust tier (used in tests below)
    // SMI-1809: Added 'local' tier for local skills
    // SMI-5205: Added 'official' and 'unverified' tiers
    type TrustTier =
      | 'official'
      | 'verified'
      | 'curated'
      | 'community'
      | 'experimental'
      | 'unknown'
      | 'local'
      | 'unverified'

    // Scanner options per trust tier (matching install.ts)
    // SMI-1809: Added 'local' tier options
    // SMI-2381: Added 'curated' tier options
    // SMI-5205: Added 'official' and 'unverified' tier options
    const TRUST_TIER_SCANNER_OPTIONS: Record<
      TrustTier,
      { riskThreshold: number; maxContentLength: number }
    > = {
      official: { riskThreshold: 70, maxContentLength: 2_000_000 },
      verified: { riskThreshold: 70, maxContentLength: 2_000_000 },
      curated: { riskThreshold: 55, maxContentLength: 1_500_000 },
      community: { riskThreshold: 40, maxContentLength: 1_000_000 },
      local: { riskThreshold: 100, maxContentLength: 10_000_000 },
      experimental: { riskThreshold: 25, maxContentLength: 500_000 },
      unknown: { riskThreshold: 20, maxContentLength: 250_000 },
      unverified: { riskThreshold: 20, maxContentLength: 250_000 },
    }

    describe('validateTrustTier', () => {
      it('should return "unknown" for null input', () => {
        expect(validateTrustTier(null)).toBe('unknown')
      })

      it('should return "unknown" for undefined input', () => {
        expect(validateTrustTier(undefined)).toBe('unknown')
      })

      it('should return "unknown" for empty string', () => {
        expect(validateTrustTier('')).toBe('unknown')
      })

      it('should validate "verified" tier', () => {
        expect(validateTrustTier('verified')).toBe('verified')
        expect(validateTrustTier('VERIFIED')).toBe('verified')
        expect(validateTrustTier('Verified')).toBe('verified')
      })

      it('should validate "curated" tier', () => {
        expect(validateTrustTier('curated')).toBe('curated')
        expect(validateTrustTier('CURATED')).toBe('curated')
      })

      it('should validate "community" tier', () => {
        expect(validateTrustTier('community')).toBe('community')
        expect(validateTrustTier('COMMUNITY')).toBe('community')
      })

      it('should validate "experimental" tier', () => {
        expect(validateTrustTier('experimental')).toBe('experimental')
        expect(validateTrustTier('EXPERIMENTAL')).toBe('experimental')
      })

      it('should return "unknown" for invalid tier values', () => {
        expect(validateTrustTier('invalid')).toBe('unknown')
        expect(validateTrustTier('premium')).toBe('unknown')
        expect(validateTrustTier('trusted')).toBe('unknown')
        expect(validateTrustTier('official')).toBe('unknown')
      })
    })

    describe('Scanner Options per Trust Tier', () => {
      it('should have highest threshold for verified tier', () => {
        expect(TRUST_TIER_SCANNER_OPTIONS.verified.riskThreshold).toBe(70)
        expect(TRUST_TIER_SCANNER_OPTIONS.verified.maxContentLength).toBe(2_000_000)
      })

      it('should have standard threshold for community tier', () => {
        expect(TRUST_TIER_SCANNER_OPTIONS.community.riskThreshold).toBe(40)
        expect(TRUST_TIER_SCANNER_OPTIONS.community.maxContentLength).toBe(1_000_000)
      })

      it('should have lower threshold for experimental tier', () => {
        expect(TRUST_TIER_SCANNER_OPTIONS.experimental.riskThreshold).toBe(25)
        expect(TRUST_TIER_SCANNER_OPTIONS.experimental.maxContentLength).toBe(500_000)
      })

      it('should have strictest threshold for unknown tier', () => {
        expect(TRUST_TIER_SCANNER_OPTIONS.unknown.riskThreshold).toBe(20)
        expect(TRUST_TIER_SCANNER_OPTIONS.unknown.maxContentLength).toBe(250_000)
      })

      it('should have progressively stricter thresholds', () => {
        expect(TRUST_TIER_SCANNER_OPTIONS.verified.riskThreshold).toBeGreaterThan(
          TRUST_TIER_SCANNER_OPTIONS.community.riskThreshold
        )
        expect(TRUST_TIER_SCANNER_OPTIONS.community.riskThreshold).toBeGreaterThan(
          TRUST_TIER_SCANNER_OPTIONS.experimental.riskThreshold
        )
        expect(TRUST_TIER_SCANNER_OPTIONS.experimental.riskThreshold).toBeGreaterThan(
          TRUST_TIER_SCANNER_OPTIONS.unknown.riskThreshold
        )
      })

      it('should have progressively smaller content limits', () => {
        expect(TRUST_TIER_SCANNER_OPTIONS.verified.maxContentLength).toBeGreaterThan(
          TRUST_TIER_SCANNER_OPTIONS.community.maxContentLength
        )
        expect(TRUST_TIER_SCANNER_OPTIONS.community.maxContentLength).toBeGreaterThan(
          TRUST_TIER_SCANNER_OPTIONS.experimental.maxContentLength
        )
        expect(TRUST_TIER_SCANNER_OPTIONS.experimental.maxContentLength).toBeGreaterThan(
          TRUST_TIER_SCANNER_OPTIONS.unknown.maxContentLength
        )
      })
    })

    describe('Trust Tier Selection Logic', () => {
      it('should use unknown tier for direct GitHub URLs', () => {
        // Direct GitHub URLs bypass registry lookup, so no trust tier available
        const input = 'https://github.com/random/untrusted-skill'
        const isDirectUrl = input.startsWith('https://github.com/')
        const trustTier = isDirectUrl ? 'unknown' : 'community'

        expect(trustTier).toBe('unknown')
        expect(TRUST_TIER_SCANNER_OPTIONS[trustTier].riskThreshold).toBe(20)
      })

      it('should use registry trust tier when available', () => {
        // Simulating registry lookup returning a trust tier
        const registryResponse = {
          trust_tier: 'verified',
          repo_url: 'https://github.com/anthropic/official-skill',
        }

        const trustTier = validateTrustTier(registryResponse.trust_tier)
        expect(trustTier).toBe('verified')
        expect(TRUST_TIER_SCANNER_OPTIONS[trustTier].riskThreshold).toBe(70)
      })

      it('should fall back to unknown for missing registry trust tier', () => {
        const registryResponse = {
          trust_tier: null,
          repo_url: 'https://github.com/user/skill',
        }

        const trustTier = validateTrustTier(registryResponse.trust_tier)
        expect(trustTier).toBe('unknown')
      })
    })

    describe('Security Scan Behavior by Trust Tier', () => {
      it('should pass more content for verified skills', () => {
        const largeContent = 'x'.repeat(1_500_000) // 1.5MB
        const verifiedLimit = TRUST_TIER_SCANNER_OPTIONS.verified.maxContentLength
        const communityLimit = TRUST_TIER_SCANNER_OPTIONS.community.maxContentLength

        // Content exceeds community limit but not verified limit
        expect(largeContent.length).toBeLessThan(verifiedLimit)
        expect(largeContent.length).toBeGreaterThan(communityLimit)
      })

      it('should apply strictest scanning for unknown sources', () => {
        const unknownOptions = TRUST_TIER_SCANNER_OPTIONS.unknown

        // Verify strictest settings
        expect(unknownOptions.riskThreshold).toBe(20)
        expect(unknownOptions.maxContentLength).toBe(250_000)

        // These are the strictest values
        Object.values(TRUST_TIER_SCANNER_OPTIONS).forEach((options) => {
          expect(unknownOptions.riskThreshold).toBeLessThanOrEqual(options.riskThreshold)
          expect(unknownOptions.maxContentLength).toBeLessThanOrEqual(options.maxContentLength)
        })
      })
    })

    describe('Error Message Context', () => {
      // Helper function to generate tier context string
      const getTierContext = (tier: TrustTier): string =>
        tier === 'unknown'
          ? ' (Direct GitHub install - strictest scanning applied)'
          : tier === 'experimental'
            ? ' (Experimental skill - aggressive scanning applied)'
            : ''

      it('should include trust tier in error context for unknown tier', () => {
        const tierContext = getTierContext('unknown')
        expect(tierContext).toContain('strictest scanning')
      })

      it('should include trust tier in error context for experimental tier', () => {
        const tierContext = getTierContext('experimental')
        expect(tierContext).toContain('aggressive scanning')
      })

      it('should have no extra context for verified/community tiers', () => {
        expect(getTierContext('verified')).toBe('')
        expect(getTierContext('community')).toBe('')
      })
    })
  })

  /**
   * SMI-2722/2732: UUID install path integration tests
   * Verifies the full installSkill() flow for UUID skillIds:
   *  - registry hit with valid repo_url → install succeeds
   *  - registry returns null (no repo_url) → discovery-only error
   *  - registry returns quarantined skill → quarantine error
   *  - UUID not found in registry → discovery-only error
   *  - SKILL.md fetch throws for registry-sourced skill → data quality error
   */
  describe('SMI-2722/2732: UUID install path', () => {
    const TEST_UUID = 'a129e127-a82c-47e5-8bc5-09d7ba2e8734'
    const VALID_SKILL_MD = [
      '---',
      'name: test-skill',
      'description: A test skill for integration testing UUID install path',
      '---',
      '# Test Skill',
      '',
      'This is a test skill with sufficient content to pass all validation checks.',
      'It has YAML frontmatter, a markdown heading, and enough body text.',
    ].join('\n')

    let installSkill: (typeof import('../../src/tools/install.js'))['installSkill']
    let installInputSchema: (typeof import('../../src/tools/install.types.js'))['installInputSchema']
    let lookupSkillFromRegistry: ReturnType<typeof vi.fn>
    let fetchFromGitHub: ReturnType<typeof vi.fn>

    let coreFetchFromGitHub: ReturnType<typeof vi.fn>
    // SMI-5260: core `.io` optional-files double + the install-path resolvers,
    // redirected per-test to the temp skillsDir.
    let coreFetchAndScanOptionalFiles: ReturnType<typeof vi.fn>
    let resolveClientPath: ReturnType<typeof vi.fn>
    let getInstallPath: ReturnType<typeof vi.fn>

    beforeAll(async () => {
      // Dynamic import after vi.mock() has been hoisted — module is already mocked
      const installModule = await import('../../src/tools/install.js')
      installSkill = installModule.installSkill

      const typesModule = await import('../../src/tools/install.types.js')
      installInputSchema = typesModule.installInputSchema

      const helpersModule = await import('../../src/tools/install.helpers.js')
      lookupSkillFromRegistry = vi.mocked(helpersModule.lookupSkillFromRegistry)
      fetchFromGitHub = vi.mocked(helpersModule.fetchFromGitHub)

      // SMI-5260: core service fetches via `skill-installation.io` — grab the
      // GitHub-fetch and optional-files mock handles from there. Also grab the
      // install-path resolvers so each test can redirect writes to its temp dir.
      const coreIoModule = await import('@skillsmith/core/services/skill-installation-io')
      coreFetchFromGitHub = vi.mocked(
        coreIoModule.fetchFromGitHub as (...args: unknown[]) => unknown
      )
      coreFetchAndScanOptionalFiles = vi.mocked(
        coreIoModule.fetchAndScanOptionalFiles as (...args: unknown[]) => unknown
      )
      const coreInstallModule = await import('@skillsmith/core/install')
      resolveClientPath = vi.mocked(
        coreInstallModule.resolveClientPath as (...args: unknown[]) => unknown
      )
      getInstallPath = vi.mocked(
        coreInstallModule.getInstallPath as (...args: unknown[]) => unknown
      )
    })

    beforeEach(() => {
      vi.clearAllMocks()
      // SMI-5260: redirect every install in this block to the per-test temp
      // skillsDir (created by the outer describe's beforeEach) so writes never
      // touch the real ~/.claude/skills. Optional-files fetch is a no-op by
      // default so the suite stays fully offline; the happy-path test sets the
      // SKILL.md fetch return explicitly.
      resolveClientPath.mockReturnValue(fsContext.skillsDir)
      getInstallPath.mockReturnValue(fsContext.skillsDir)
      coreFetchAndScanOptionalFiles.mockResolvedValue({
        configWarnings: [],
        failedScans: [],
        filesToWrite: [],
      })
    })

    it('UUID with valid repo_url resolves and installs the skill', async () => {
      // Registry returns a routable skill entry
      lookupSkillFromRegistry.mockResolvedValue({
        repoUrl: 'https://github.com/owner/test-skill',
        name: 'test-skill',
        trustTier: 'community',
        quarantined: false,
      })
      // SKILL.md fetch succeeds (mock both the mcp-server seam and the core .io seam)
      fetchFromGitHub.mockResolvedValue(VALID_SKILL_MD)
      coreFetchFromGitHub.mockResolvedValue(VALID_SKILL_MD)

      const result = await installSkill(
        installInputSchema.parse({ skillId: TEST_UUID, skipScan: true, force: true })
      )

      expect(result.success).toBe(true)
      expect(result.skillId).toBe(TEST_UUID)
      expect(lookupSkillFromRegistry).toHaveBeenCalledWith(TEST_UUID, expect.anything())
      // SMI-5260 anti-false-green guards: the core .io fetch double was actually
      // exercised (proving the mock intercepts the service's direct import, not a
      // real network fetch), and the install wrote SKILL.md into the temp skillsDir.
      // A regression back to a real-fetch / real-path install fails loudly here.
      expect(coreFetchFromGitHub).toHaveBeenCalled()
      expect(result.installPath.startsWith(fsContext.skillsDir)).toBe(true)
      expect(await fileExists(path.join(result.installPath, 'SKILL.md'))).toBe(true)
    })

    it('UUID with null registry result returns "indexed for discovery only" error', async () => {
      // Registry found the skill but it has no repo_url (seed / metadata-only)
      lookupSkillFromRegistry.mockResolvedValue(null)

      const result = await installSkill(installInputSchema.parse({ skillId: TEST_UUID }))

      expect(result.success).toBe(false)
      expect(result.error).toContain('indexed for discovery only')
      expect(lookupSkillFromRegistry).toHaveBeenCalledWith(TEST_UUID, expect.anything())
    })

    it('UUID for a quarantined skill returns "quarantined" error', async () => {
      // Registry flags the skill as quarantined
      lookupSkillFromRegistry.mockResolvedValue({
        repoUrl: 'https://github.com/owner/bad-skill',
        name: 'bad-skill',
        trustTier: 'community',
        quarantined: true,
      })

      const result = await installSkill(installInputSchema.parse({ skillId: TEST_UUID }))

      expect(result.success).toBe(false)
      expect(result.error).toContain('quarantined')
      expect(lookupSkillFromRegistry).toHaveBeenCalledWith(TEST_UUID, expect.anything())
    })

    it('UUID not found in registry (lookupSkillFromRegistry returns null) surfaces discovery-only error', async () => {
      // lookupSkillFromRegistry returns null — no row in registry for this UUID
      // This is semantically distinct from test #2: there the API returned a row with null repo_url.
      // Here lookupSkillFromRegistry itself returns null (API 404 + DB miss).
      // Both paths hit the same !registrySkill branch in installSkill(); this test confirms
      // the UUID routing guard works end-to-end when the registry has no record at all.
      lookupSkillFromRegistry.mockResolvedValue(null)

      const result = await installSkill(installInputSchema.parse({ skillId: TEST_UUID }))

      expect(result.success).toBe(false)
      expect(result.error).toContain('indexed for discovery only')
    })

    it('registry-sourced UUID with SKILL.md fetch failure surfaces "registry data quality issue" error', async () => {
      // Registry has a valid entry, but the SKILL.md fetch throws (broken repo_url)
      lookupSkillFromRegistry.mockResolvedValue({
        repoUrl: 'https://github.com/owner/broken-skill',
        name: 'broken-skill',
        trustTier: 'community',
        quarantined: false,
      })
      fetchFromGitHub.mockRejectedValue(new Error('Failed to fetch SKILL.md: 404'))
      coreFetchFromGitHub.mockRejectedValue(new Error('Failed to fetch SKILL.md: 404'))

      const result = await installSkill(installInputSchema.parse({ skillId: TEST_UUID }))

      expect(result.success).toBe(false)
      expect(result.error).toContain('registry data quality issue')
    })
  })
})

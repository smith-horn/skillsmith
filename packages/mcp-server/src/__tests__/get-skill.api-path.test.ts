/**
 * SMI-4240: API-path tests for executeGetSkill
 *
 * These exercise the `!context.apiClient.isOffline()` branch of get-skill.ts,
 * which the pre-existing get-skill.test.ts cannot reach (it seeds a local
 * SQLite context in offline mode). The fixture-driven context comes from
 * createApiMockContext — see test-utils.ts.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { executeGetSkill } from '../tools/get-skill.js'
import { createApiMockContext, type ToolContext } from './test-utils.js'

let context: ToolContext | undefined

afterEach(() => {
  context?.db.close()
  context = undefined
})

describe('executeGetSkill (API path)', () => {
  describe('category mapping', () => {
    it('prefers the API-provided category over tag inference', async () => {
      // Tags are empty, but API says the skill is a database skill.
      // Tag-inference alone would return "other" — the fix makes
      // categories[] win.
      context = createApiMockContext({
        apiSkill: {
          id: 'microsoft/azure-resource-manager-redis-dotnet',
          name: 'azure-resource-manager-redis-dotnet',
          author: 'microsoft',
          trust_tier: 'verified',
          tags: ['agent-skills', 'azure', 'sdk'],
        },
        categories: ['Database'],
      })

      const result = await executeGetSkill(
        { id: 'microsoft/azure-resource-manager-redis-dotnet' },
        context
      )

      expect(result.skill.category).toBe('database')
    })

    it('normalizes plural API category names to the singular enum form', async () => {
      context = createApiMockContext({
        apiSkill: {
          id: 'x/y',
          name: 'y',
          trust_tier: 'community',
          tags: [],
        },
        categories: ['integrations'], // DB uses plural; enum is singular
      })

      const result = await executeGetSkill({ id: 'x/y' }, context)
      expect(result.skill.category).toBe('integration')
    })

    it('falls back to tag inference when API returns an empty categories array', async () => {
      context = createApiMockContext({
        apiSkill: {
          id: 'x/y',
          name: 'y',
          trust_tier: 'community',
          tags: ['jest', 'testing'],
        },
        categories: [],
      })

      const result = await executeGetSkill({ id: 'x/y' }, context)
      expect(result.skill.category).toBe('testing')
    })

    it('falls back to tag inference when API returns an unmappable category', async () => {
      context = createApiMockContext({
        apiSkill: {
          id: 'x/y',
          name: 'y',
          trust_tier: 'community',
          tags: ['jest'],
        },
        categories: ['product'], // present in DB, not in SkillCategory enum
      })

      const result = await executeGetSkill({ id: 'x/y' }, context)
      expect(result.skill.category).toBe('testing')
    })
  })

  describe('security summary derivation', () => {
    it('returns passed=true for a clean scanned skill', async () => {
      context = createApiMockContext({
        apiSkill: {
          id: 'x/y',
          name: 'y',
          trust_tier: 'verified',
          last_scanned_at: '2026-02-18T05:07:13.844Z',
          security_score: 0,
          security_findings: [],
          quarantined: false,
        },
      })

      const result = await executeGetSkill({ id: 'x/y' }, context)
      expect(result.skill.security).toEqual({
        passed: true,
        riskScore: 0,
        findingsCount: 0,
        scannedAt: '2026-02-18T05:07:13.844Z',
      })
    })

    it('returns passed=false for a quarantined skill', async () => {
      context = createApiMockContext({
        apiSkill: {
          id: 'x/y',
          name: 'y',
          trust_tier: 'community',
          last_scanned_at: '2026-02-18T05:07:13.844Z',
          security_score: 85,
          security_findings: [{}, {}, {}],
          quarantined: true,
        },
      })

      const result = await executeGetSkill({ id: 'x/y' }, context)
      expect(result.skill.security?.passed).toBe(false)
      expect(result.skill.security?.findingsCount).toBe(3)
      expect(result.skill.security?.riskScore).toBe(85)
    })

    it('returns passed=null when a scan timestamp exists but no score', async () => {
      context = createApiMockContext({
        apiSkill: {
          id: 'x/y',
          name: 'y',
          trust_tier: 'community',
          last_scanned_at: '2026-02-18T05:07:13.844Z',
          security_score: null,
          security_findings: null,
          quarantined: false,
        },
      })

      const result = await executeGetSkill({ id: 'x/y' }, context)
      expect(result.skill.security?.passed).toBeNull()
      expect(result.skill.security?.riskScore).toBeNull()
      expect(result.skill.security?.findingsCount).toBe(0)
    })

    it('omits security entirely when the skill has never been scanned', async () => {
      context = createApiMockContext({
        apiSkill: {
          id: 'x/y',
          name: 'y',
          trust_tier: 'community',
          last_scanned_at: null,
        },
      })

      const result = await executeGetSkill({ id: 'x/y' }, context)
      // The extension renders undefined and { passed: null } identically
      // in getSecurityScanHtml, so omission is preferable to shipping a
      // noisy placeholder object.
      expect(result.skill.security).toBeUndefined()
    })

    it('derives findingsCount from the security_findings jsonb array', async () => {
      context = createApiMockContext({
        apiSkill: {
          id: 'x/y',
          name: 'y',
          trust_tier: 'community',
          last_scanned_at: '2026-02-18T05:07:13.844Z',
          security_score: 30,
          security_findings: [{ rule: 'hardcoded-secret' }, { rule: 'weak-hash' }],
        },
      })

      const result = await executeGetSkill({ id: 'x/y' }, context)
      expect(result.skill.security?.findingsCount).toBe(2)
    })
  })

  describe('repository URL passthrough', () => {
    it('maps repo_url to skill.repository', async () => {
      const url =
        'https://github.com/microsoft/skills/tree/main/.github/skills/azure-resource-manager-redis-dotnet'
      context = createApiMockContext({
        apiSkill: {
          id: 'x/y',
          name: 'y',
          trust_tier: 'verified',
          repo_url: url,
        },
      })

      const result = await executeGetSkill({ id: 'x/y' }, context)
      expect(result.skill.repository).toBe(url)
    })

    it('leaves skill.repository undefined when repo_url is null', async () => {
      context = createApiMockContext({
        apiSkill: {
          id: 'x/y',
          name: 'y',
          trust_tier: 'community',
          repo_url: null,
        },
      })

      const result = await executeGetSkill({ id: 'x/y' }, context)
      expect(result.skill.repository).toBeUndefined()
    })
  })
})

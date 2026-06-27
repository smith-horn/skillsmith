/**
 * Unit tests for the SkillService MCP→domain mappers.
 *
 * Split out of SkillService.test.ts (SMI-5401) to keep both files under the
 * 500-line lint-staged check-file-length gate (SMI-3493). These mapper tests
 * are pure functions with no McpClient harness, so they form a clean cut.
 */
import { describe, it, expect } from 'vitest'
import {
  mapSearchResultToSkillData,
  mapSkillDetailsToExtendedSkillData,
} from '../services/SkillService.js'
import type { McpGetSkillResponse } from '../mcp/types.js'

/** Fixture: MCP get_skill response (mirrors SkillService.test.ts). */
function makeMcpGetSkillResponse(partial?: Partial<McpGetSkillResponse>): McpGetSkillResponse {
  return {
    skill: {
      id: 'governance',
      name: 'Governance',
      description: 'Enforces engineering standards',
      author: 'skillsmith',
      category: 'development',
      trustTier: 'verified',
      score: 95,
      repository: 'https://github.com/skillsmith/governance-skill',
      version: '1.2.0',
      tags: ['quality', 'standards'],
      scoreBreakdown: {
        quality: 95,
        popularity: 80,
        maintenance: 90,
        security: 88,
        documentation: 92,
      },
    },
    installCommand: 'npx @skillsmith/cli install governance',
    timing: { totalMs: 15 },
    ...partial,
  }
}

describe('mapSearchResultToSkillData', () => {
  it('maps all fields correctly', () => {
    const result = mapSearchResultToSkillData({
      id: 'test',
      name: 'Test',
      description: 'desc',
      author: 'auth',
      category: 'cat',
      trustTier: 'verified',
      score: 90,
    })

    expect(result).toEqual({
      id: 'test',
      name: 'Test',
      description: 'desc',
      author: 'auth',
      category: 'cat',
      trustTier: 'verified',
      score: 90,
    })
  })

  it('maps repository field when present', () => {
    const result = mapSearchResultToSkillData({
      id: 'smith-horn/governance',
      name: 'Governance',
      description: 'Enforces standards',
      author: 'smith-horn',
      category: 'development',
      trustTier: 'verified',
      score: 95,
      repository: 'https://github.com/smith-horn/governance',
    })

    expect(result.repository).toBe('https://github.com/smith-horn/governance')
  })

  it('maps undefined repository when not present', () => {
    const result = mapSearchResultToSkillData({
      id: 'test',
      name: 'Test',
      description: 'desc',
      author: 'auth',
      category: 'cat',
      trustTier: 'community',
      score: 70,
    })

    expect(result.repository).toBeUndefined()
  })
})

describe('mapSkillDetailsToExtendedSkillData', () => {
  it('maps all fields including extended data', () => {
    const result = mapSkillDetailsToExtendedSkillData(makeMcpGetSkillResponse())

    expect(result.id).toBe('governance')
    expect(result.version).toBe('1.2.0')
    expect(result.tags).toEqual(['quality', 'standards'])
    expect(result.installCommand).toBe('npx @skillsmith/cli install governance')
    expect(result.scoreBreakdown?.quality).toBe(95)
  })

  // SMI-3672: Content mapping tests
  it('maps content from response top-level', () => {
    const response = makeMcpGetSkillResponse({ content: '# My Skill\n\nDoes things.' })
    const result = mapSkillDetailsToExtendedSkillData(response)
    expect(result.content).toBe('# My Skill\n\nDoes things.')
  })

  it('maps undefined content when not present', () => {
    const response = makeMcpGetSkillResponse()
    const result = mapSkillDetailsToExtendedSkillData(response)
    expect(result.content).toBeUndefined()
  })

  // SMI-3857: Security scan field mapping
  it('maps security scan data when present', () => {
    const response = makeMcpGetSkillResponse()
    response.skill.security = {
      passed: true,
      riskScore: 15,
      findingsCount: 0,
      scannedAt: '2026-04-03T12:00:00Z',
    }
    const result = mapSkillDetailsToExtendedSkillData(response)
    expect(result.securityPassed).toBe(true)
    expect(result.securityRiskScore).toBe(15)
    expect(result.securityScannedAt).toBe('2026-04-03T12:00:00Z')
  })

  it('maps null security scan data when not present', () => {
    const response = makeMcpGetSkillResponse()
    const result = mapSkillDetailsToExtendedSkillData(response)
    expect(result.securityPassed).toBeNull()
    expect(result.securityRiskScore).toBeNull()
    expect(result.securityScannedAt).toBeNull()
  })
})

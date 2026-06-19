/**
 * SMI-5317: securityFindingsCount mapping in mapSkillDetailsToExtendedSkillData.
 * Split out of SkillService.test.ts to stay under the 500-line file gate.
 */
import { describe, it, expect } from 'vitest'
import { mapSkillDetailsToExtendedSkillData } from '../services/SkillService.js'
import type { McpGetSkillResponse, McpSkillDetails } from '../mcp/types.js'

/** Minimal valid get_skill response; pass a `security` override to exercise mapping. */
function makeResponse(security?: McpSkillDetails['security']): McpGetSkillResponse {
  const skill: McpSkillDetails = {
    id: 'org/foo',
    name: 'Foo',
    description: 'd',
    author: 'org',
    category: 'development',
    trustTier: 'verified',
    score: 90,
    ...(security ? { security } : {}),
  }
  return { skill, installCommand: 'skillsmith install org/foo', timing: { totalMs: 1 } }
}

describe('SkillService securityFindingsCount mapping (SMI-5317)', () => {
  it('maps securityFindingsCount from security.findingsCount when present', () => {
    const result = mapSkillDetailsToExtendedSkillData(
      makeResponse({
        passed: false,
        riskScore: 40,
        findingsCount: 3,
        scannedAt: '2026-01-01T00:00:00Z',
      })
    )
    expect(result.securityFindingsCount).toBe(3)
  })

  it('maps securityFindingsCount to null when security is undefined', () => {
    const result = mapSkillDetailsToExtendedSkillData(makeResponse())
    expect(result.securityFindingsCount).toBeNull()
  })
})

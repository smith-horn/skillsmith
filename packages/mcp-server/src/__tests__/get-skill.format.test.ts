/**
 * SMI-1785: Tests for formatSkillDetails with various skill configurations
 * Covers scoreBreakdown display, security status display, and trust tier formatting
 *
 * Split out of get-skill.test.ts (SMI-5897 Wave 4 fix) to keep that file
 * under the 500-line governance cap once a new never-scanned regression
 * test was added there. Mirrors the existing get-skill.ts / get-skill.format.ts
 * source split — this file covers formatSkillDetails, get-skill.test.ts
 * covers executeGetSkill.
 */

import { describe, it, expect } from 'vitest'
import { formatSkillDetails } from '../tools/get-skill.js'

describe('formatSkillDetails branch coverage', () => {
  it('should format skill with scoreBreakdown', () => {
    const response = {
      skill: {
        id: 'test/skill',
        name: 'test-skill',
        description: 'A test skill',
        author: 'test',
        version: '1.0.0',
        category: 'development' as const,
        trustTier: 'verified' as const,
        score: 90,
        scoreBreakdown: {
          quality: 95,
          popularity: 80,
          maintenance: 92,
          security: 88,
          documentation: 85,
        },
        tags: ['test'],
        installCommand: 'claude skill add test/skill',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      },
      installCommand: 'claude skill add test/skill',
      timing: { totalMs: 10 },
    }

    const formatted = formatSkillDetails(response)

    expect(formatted).toContain('Score Breakdown:')
    expect(formatted).toContain('Quality:')
    expect(formatted).toContain('Popularity:')
    expect(formatted).toContain('Maintenance:')
    expect(formatted).toContain('Security:')
    expect(formatted).toContain('Documentation:')
    expect(formatted).toContain('[')
    expect(formatted).toContain(']')
  })

  it('should format skill with security passed=null (not scanned)', () => {
    const response = {
      skill: {
        id: 'test/skill',
        name: 'test-skill',
        description: 'A test skill',
        author: 'test',
        category: 'development' as const,
        trustTier: 'community' as const,
        score: 80,
        tags: [] as string[],
        installCommand: 'claude skill add test/skill',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        security: {
          passed: null,
          riskScore: null,
          findingsCount: 0,
          scannedAt: null,
        },
      },
      installCommand: 'claude skill add test/skill',
      timing: { totalMs: 10 },
    }

    const formatted = formatSkillDetails(response)

    expect(formatted).toContain('Status: Not scanned')
  })

  it('should format skill with security passed=true', () => {
    const response = {
      skill: {
        id: 'test/skill',
        name: 'test-skill',
        description: 'A test skill',
        author: 'test',
        category: 'development' as const,
        trustTier: 'community' as const,
        score: 80,
        tags: [] as string[],
        installCommand: 'claude skill add test/skill',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        security: {
          passed: true,
          riskScore: 15,
          findingsCount: 0,
          scannedAt: '2024-01-15T12:00:00.000Z',
        },
      },
      installCommand: 'claude skill add test/skill',
      timing: { totalMs: 10 },
    }

    const formatted = formatSkillDetails(response)

    expect(formatted).toContain('Status: PASSED')
    expect(formatted).toContain('Risk Score: 15/100')
    expect(formatted).toContain('Findings: 0')
    expect(formatted).toContain('Scanned:')
  })

  // SMI-6033 Wave 2 (Gap 8): partial-scan coverage caveat — informational
  // only, must NOT read as a rejection/blocked-install signal like quarantine.
  it('should surface a partial-scan caveat with the coverage note when scanCoverageIncomplete is true', () => {
    const response = {
      skill: {
        id: 'test/skill',
        name: 'test-skill',
        description: 'A test skill',
        author: 'test',
        category: 'development' as const,
        trustTier: 'community' as const,
        score: 80,
        tags: [] as string[],
        installCommand: 'claude skill add test/skill',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        installable: true,
        security: {
          passed: true,
          riskScore: 15,
          findingsCount: 0,
          scannedAt: '2024-01-15T12:00:00.000Z',
          scanCoverageIncomplete: true,
          scanCoverageNote: 'tree_budget_exhausted',
        },
      },
      installCommand: 'claude skill add test/skill',
      timing: { totalMs: 10 },
    }

    const formatted = formatSkillDetails(response)

    expect(formatted).toContain('Installable: yes')
    // scanCoverageNote on the wire is a machine-readable cause TOKEN (see
    // skill-processor.security.tree.ts's ScanCoverageCause) — formatSkillDetails
    // must translate it to prose, not echo the raw token.
    expect(formatted).toContain(
      'Note: partial scan — some files could not be analyzed (the scan budget for this run was exhausted)'
    )
    expect(formatted).not.toContain('tree_budget_exhausted')
  })

  it('should translate multiple `; `-joined coverage-cause tokens to a joined prose phrase', () => {
    const response = {
      skill: {
        id: 'test/skill',
        name: 'test-skill',
        description: 'A test skill',
        author: 'test',
        category: 'development' as const,
        trustTier: 'community' as const,
        score: 80,
        tags: [] as string[],
        installCommand: 'claude skill add test/skill',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        installable: true,
        security: {
          passed: true,
          riskScore: 15,
          findingsCount: 0,
          scannedAt: '2024-01-15T12:00:00.000Z',
          scanCoverageIncomplete: true,
          scanCoverageNote: 'count_cap; tree_truncated',
        },
      },
      installCommand: 'claude skill add test/skill',
      timing: { totalMs: 10 },
    }

    const formatted = formatSkillDetails(response)

    expect(formatted).toContain(
      'Note: partial scan — some files could not be analyzed ' +
        '(too many candidate files; the file listing was truncated)'
    )
  })

  it('falls back to the raw token for an unrecognized coverage-cause token (drift guard)', () => {
    const response = {
      skill: {
        id: 'test/skill',
        name: 'test-skill',
        description: 'A test skill',
        author: 'test',
        category: 'development' as const,
        trustTier: 'community' as const,
        score: 80,
        tags: [] as string[],
        installCommand: 'claude skill add test/skill',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        installable: true,
        security: {
          passed: true,
          riskScore: 15,
          findingsCount: 0,
          scannedAt: '2024-01-15T12:00:00.000Z',
          scanCoverageIncomplete: true,
          scanCoverageNote: 'some_future_cause_not_yet_mapped',
        },
      },
      installCommand: 'claude skill add test/skill',
      timing: { totalMs: 10 },
    }

    const formatted = formatSkillDetails(response)

    expect(formatted).toContain('some_future_cause_not_yet_mapped')
  })

  it('should not surface a partial-scan caveat when scanCoverageIncomplete is false', () => {
    const response = {
      skill: {
        id: 'test/skill',
        name: 'test-skill',
        description: 'A test skill',
        author: 'test',
        category: 'development' as const,
        trustTier: 'community' as const,
        score: 80,
        tags: [] as string[],
        installCommand: 'claude skill add test/skill',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        security: {
          passed: true,
          riskScore: 15,
          findingsCount: 0,
          scannedAt: '2024-01-15T12:00:00.000Z',
          scanCoverageIncomplete: false,
          scanCoverageNote: null,
        },
      },
      installCommand: 'claude skill add test/skill',
      timing: { totalMs: 10 },
    }

    const formatted = formatSkillDetails(response)

    expect(formatted).not.toContain('partial scan')
  })

  it('should format skill with security passed=false', () => {
    const response = {
      skill: {
        id: 'test/skill',
        name: 'test-skill',
        description: 'A test skill',
        author: 'test',
        category: 'development' as const,
        trustTier: 'experimental' as const,
        score: 60,
        tags: [] as string[],
        installCommand: 'claude skill add test/skill',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        security: {
          passed: false,
          riskScore: 75,
          findingsCount: 5,
          scannedAt: '2024-01-15T12:00:00.000Z',
        },
      },
      installCommand: 'claude skill add test/skill',
      timing: { totalMs: 10 },
    }

    const formatted = formatSkillDetails(response)

    expect(formatted).toContain('Status: FAILED')
    expect(formatted).toContain('Risk Score: 75/100 (HIGH)')
    expect(formatted).toContain('Findings: 5')
    expect(formatted).toContain('WARNING')
    expect(formatted).toContain('Scanned:')
  })

  it('should format skill without security info', () => {
    const response = {
      skill: {
        id: 'test/skill',
        name: 'test-skill',
        description: 'A test skill',
        author: 'test',
        category: 'development' as const,
        trustTier: 'unknown' as const,
        score: 50,
        tags: [] as string[],
        installCommand: 'claude skill add test/skill',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      },
      installCommand: 'claude skill add test/skill',
      timing: { totalMs: 10 },
    }

    const formatted = formatSkillDetails(response)

    expect(formatted).toContain('Status: Not scanned')
    expect(formatted).toContain('UNKNOWN')
  })

  it('should format skill without repository', () => {
    const response = {
      skill: {
        id: 'test/skill',
        name: 'test-skill',
        description: 'A test skill',
        author: 'test',
        category: 'development' as const,
        trustTier: 'community' as const,
        score: 80,
        tags: [] as string[],
        installCommand: 'claude skill add test/skill',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        repository: undefined,
      },
      installCommand: 'claude skill add test/skill',
      timing: { totalMs: 10 },
    }

    const formatted = formatSkillDetails(response)

    expect(formatted).not.toContain('Repository:')
  })

  it('should format skill without tags', () => {
    const response = {
      skill: {
        id: 'test/skill',
        name: 'test-skill',
        description: 'A test skill',
        author: 'test',
        category: 'development' as const,
        trustTier: 'community' as const,
        score: 80,
        tags: [] as string[],
        installCommand: 'claude skill add test/skill',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      },
      installCommand: 'claude skill add test/skill',
      timing: { totalMs: 10 },
    }

    const formatted = formatSkillDetails(response)

    expect(formatted).not.toContain('Tags:')
  })
})

/**
 * SMI-5327: formatSkillDetails license display
 * Null license must render as "unknown", not imply any permissive conclusion.
 */
describe('formatSkillDetails — license display (SMI-5327)', () => {
  const baseSkill = {
    id: 'test/skill',
    name: 'test-skill',
    description: 'A test skill',
    author: 'test',
    category: 'development' as const,
    trustTier: 'community' as const,
    score: 80,
    tags: [] as string[],
    installCommand: 'claude skill add test/skill',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  }
  const baseResponse = (license?: string | null) => ({
    skill: { ...baseSkill, license },
    installCommand: 'claude skill add test/skill',
    timing: { totalMs: 10 },
  })

  it('renders "License: MIT" verbatim for an MIT-licensed skill', () => {
    const formatted = formatSkillDetails(baseResponse('MIT'))
    expect(formatted).toContain('License: MIT')
    expect(formatted).not.toContain('License: Unknown')
  })

  it('renders "License: Apache-2.0" verbatim', () => {
    const formatted = formatSkillDetails(baseResponse('Apache-2.0'))
    expect(formatted).toContain('License: Apache-2.0')
  })

  it('renders "License: Unknown" when license is null', () => {
    const formatted = formatSkillDetails(baseResponse(null))
    expect(formatted).toContain('License: Unknown')
    // Must not imply any permissive conclusion for a null license
    expect(formatted).not.toContain('no license')
    expect(formatted).not.toContain('unrestricted')
    expect(formatted).not.toContain('freely usable')
    expect(formatted).not.toContain('public domain')
  })

  it('renders "License: Unknown" when license field is absent', () => {
    const formatted = formatSkillDetails(baseResponse(undefined))
    expect(formatted).toContain('License: Unknown')
  })

  it('renders "License: Unknown" when license is an empty string', () => {
    const formatted = formatSkillDetails(baseResponse(''))
    expect(formatted).toContain('License: Unknown')
  })

  it('renders "License: Unknown" when license is whitespace-only', () => {
    const formatted = formatSkillDetails(baseResponse('   '))
    expect(formatted).toContain('License: Unknown')
  })
})

/**
 * SMI-5360: formatSkillDetails installability line. A skill that carries a
 * repository but is not installable is blocked (quarantined / failed scan), NOT
 * discovery-only — the reason text must distinguish the two.
 */
describe('formatSkillDetails — installability (SMI-5360)', () => {
  const baseSkill = {
    id: 'test/skill',
    name: 'test-skill',
    description: 'A test skill',
    author: 'test',
    category: 'development' as const,
    trustTier: 'community' as const,
    score: 80,
    tags: [] as string[],
    installCommand: 'claude skill add test/skill',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  }
  const responseWith = (overrides: { installable?: boolean; repository?: string }) => ({
    skill: { ...baseSkill, ...overrides },
    installCommand: 'claude skill add test/skill',
    timing: { totalMs: 10 },
  })

  it('prints "Installable: yes" when installable', () => {
    const formatted = formatSkillDetails(
      responseWith({ installable: true, repository: 'https://github.com/test/skill' })
    )
    expect(formatted).toContain('Installable: yes')
  })

  it('labels a non-installable skill that has a repository as blocked, not discovery-only', () => {
    const formatted = formatSkillDetails(
      responseWith({ installable: false, repository: 'https://github.com/test/skill' })
    )
    expect(formatted).toContain('Installable: NO')
    expect(formatted).toContain('blocked')
    expect(formatted).not.toContain('discovery-only')
  })

  it('labels a non-installable skill with no repository as discovery-only', () => {
    const formatted = formatSkillDetails(responseWith({ installable: false }))
    expect(formatted).toContain('Installable: NO')
    expect(formatted).toContain('discovery-only')
    expect(formatted).not.toContain('blocked')
  })
})

/**
 * @fileoverview Unit tests for `search-formatters.ts`'s security-status coloring.
 * @see SMI-5897 (Wave 4 fix): `formatSecurityStatus` previously colored a
 *   passed skill bright green purely from `securityPassed === true`,
 *   regardless of how close `riskScore` was to the quarantine threshold
 *   (`DEFAULT_RISK_THRESHOLD`, 40 — lower is safer). A skill scoring 39 —
 *   one point from quarantine — rendered identically to a skill scoring 2.
 *   Green is now reserved for a comfortably-safe pass (risk score under half
 *   the quarantine threshold); a borderline pass renders yellow instead. Text
 *   ("PASS"/"PASSED") is unchanged — this is a color-only fix.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import chalk from 'chalk'
import { DEFAULT_RISK_THRESHOLD, type SearchResult } from '@skillsmith/core'
import { formatSecurityStatus, displaySkillDetails } from './search-formatters.js'

type Skill = SearchResult['skill']

function makeSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    id: 'community/example',
    name: 'example',
    description: 'An example skill',
    author: 'community',
    repoUrl: null,
    qualityScore: 0.8,
    trustTier: 'community',
    tags: [],
    installable: true,
    riskScore: null,
    securityFindingsCount: 0,
    securityScannedAt: '2026-06-01T00:00:00.000Z',
    securityPassed: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('formatSecurityStatus color threshold (SMI-5897 Wave 4 fix)', () => {
  let originalLevel: typeof chalk.level

  beforeAll(() => {
    // Force ANSI color output regardless of TTY detection so these
    // assertions can distinguish chalk.green from chalk.yellow/chalk.red.
    originalLevel = chalk.level
    chalk.level = 1
  })

  afterAll(() => {
    chalk.level = originalLevel
  })

  it('renders green for a comfortably-safe pass (risk score well under half the threshold)', () => {
    const skill = makeSkill({ securityPassed: true, riskScore: 5 })
    const out = formatSecurityStatus(skill)
    expect(out).toBe(chalk.green('PASS (5)'))
  })

  it('renders green for a pass with no numeric risk score', () => {
    const skill = makeSkill({ securityPassed: true, riskScore: null })
    const out = formatSecurityStatus(skill)
    expect(out).toBe(chalk.green('PASS'))
  })

  it('does NOT render green for a borderline pass just under the quarantine threshold', () => {
    // 39 technically "passes" (threshold is 40) but is one point from
    // quarantine — must not read as "very safe."
    const skill = makeSkill({ securityPassed: true, riskScore: DEFAULT_RISK_THRESHOLD - 1 })
    const out = formatSecurityStatus(skill)
    expect(out).not.toBe(chalk.green('PASS (39)'))
    expect(out).toBe(chalk.yellow('PASS (39)'))
    // Text is unchanged — this is a color-only fix.
    expect(out).toContain('PASS (39)')
  })

  it('renders yellow at exactly half the threshold (boundary is exclusive)', () => {
    const half = DEFAULT_RISK_THRESHOLD / 2
    const skill = makeSkill({ securityPassed: true, riskScore: half })
    const out = formatSecurityStatus(skill)
    expect(out).toBe(chalk.yellow(`PASS (${half})`))
  })

  it('renders green just under half the threshold', () => {
    const justUnderHalf = DEFAULT_RISK_THRESHOLD / 2 - 1
    const skill = makeSkill({ securityPassed: true, riskScore: justUnderHalf })
    const out = formatSecurityStatus(skill)
    expect(out).toBe(chalk.green(`PASS (${justUnderHalf})`))
  })

  it('still renders red for a failed scan regardless of risk score', () => {
    const skill = makeSkill({ securityPassed: false, riskScore: 5 })
    const out = formatSecurityStatus(skill)
    expect(out).toBe(chalk.red('FAIL (5)'))
  })

  it('still renders gray "--" for a never-scanned skill', () => {
    const skill = makeSkill({ securityPassed: null, riskScore: null })
    const out = formatSecurityStatus(skill)
    expect(out).toBe(chalk.gray('--'))
  })
})

describe('displaySkillDetails security-status coloring (SMI-5897 Wave 4 fix)', () => {
  let originalLevel: typeof chalk.level
  let logSpy: string[]
  let restoreLog: () => void

  beforeAll(() => {
    originalLevel = chalk.level
    chalk.level = 1
  })

  afterAll(() => {
    chalk.level = originalLevel
  })

  function captureConsoleLog(fn: () => void): string[] {
    logSpy = []
    const original = console.log
    restoreLog = () => {
      console.log = original
    }
    console.log = (...args: unknown[]) => {
      logSpy.push(args.map(String).join(' '))
    }
    try {
      fn()
    } finally {
      restoreLog()
    }
    return logSpy
  }

  it('renders green Status/Risk Score for a comfortably-safe pass', () => {
    const skill = makeSkill({ securityPassed: true, riskScore: 5, securityFindingsCount: 0 })
    const lines = captureConsoleLog(() => displaySkillDetails({ skill, rank: 0, highlights: {} }))
    // '  Status: '/'  Risk Score: ' (two leading spaces) — NOT the
    // '\nSecurity Status:' section header, which also matches a bare
    // "Status:" substring and would otherwise be picked up first.
    const statusLine = lines.find((l) => l.includes('  Status: '))
    const riskLine = lines.find((l) => l.includes('  Risk Score: '))
    expect(statusLine).toContain(chalk.green('PASSED'))
    expect(riskLine).toContain(chalk.green('5/100'))
  })

  it('does NOT render green Status/Risk Score for a borderline pass', () => {
    const skill = makeSkill({
      securityPassed: true,
      riskScore: DEFAULT_RISK_THRESHOLD - 1,
      securityFindingsCount: 0,
    })
    const lines = captureConsoleLog(() => displaySkillDetails({ skill, rank: 0, highlights: {} }))
    const statusLine = lines.find((l) => l.includes('  Status: '))
    const riskLine = lines.find((l) => l.includes('  Risk Score: '))
    expect(statusLine).not.toContain(chalk.green('PASSED'))
    expect(statusLine).toContain(chalk.yellow('PASSED'))
    expect(riskLine).not.toContain(chalk.green('39/100'))
    expect(riskLine).toContain(chalk.yellow('39/100'))
  })
})

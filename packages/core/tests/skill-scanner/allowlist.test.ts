/**
 * SMI-4396: Allowlist test matrix.
 *
 * Covers:
 *  - FP-only allowlisted skill passes (not quarantined)
 *  - Allowlisted + unrelated CRITICAL still quarantines (genuine attack leaks through)
 *  - Expired entry behaves as absent (fail-safe to quarantine)
 *  - Backward-compat: shouldQuarantine(report) without allowlist arg matches prior semantics
 *  - Score-only quarantine (risk >= threshold without any critical/high) still works
 *  - Load-time ReDoS validation rejects nested quantifiers + unbounded wildcards
 *  - matchField='location' matches raw UTF-8 bytes where matchField='message' cannot
 *  - Schema validation rejects malformed entries (missing fields, bad dates, unknown matchField)
 *  - Scanner integration — loadAllowlist returns EMPTY_ALLOWLIST for missing file
 */

import { describe, it, expect, beforeEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import {
  _resetExpiryWarningCache,
  buildMatcher,
  EMPTY_ALLOWLIST,
  loadAllowlist,
  parseAllowlistFile,
} from '../../src/scripts/skill-scanner/allowlist.js'
import { shouldQuarantine } from '../../src/scripts/skill-scanner/trust-scorer.js'
import type {
  AllowlistEntry,
  ScanReport,
  SecurityFinding,
} from '../../src/scripts/skill-scanner/types.js'

// ------------------------ helpers ------------------------

function finding(
  overrides: Partial<SecurityFinding> & Pick<SecurityFinding, 'type' | 'severity' | 'message'>
): SecurityFinding {
  return {
    confidence: 'high',
    ...overrides,
  }
}

function makeReport(
  skillId: string,
  findings: SecurityFinding[],
  overrides: Partial<ScanReport> = {}
): ScanReport {
  return {
    skillId,
    passed: false, // most fixtures here represent pre-allowlist "failed" scans
    findings,
    scannedAt: new Date('2026-04-21T12:00:00Z'),
    scanDurationMs: 5,
    riskScore: 100, // deliberately high — the predicate must ignore this and recompute
    riskBreakdown: {
      jailbreak: 0,
      socialEngineering: 0,
      promptLeaking: 0,
      dataExfiltration: 0,
      privilegeEscalation: 0,
      suspiciousCode: 0,
      sensitivePaths: 0,
      externalUrls: 0,
      aiDefence: 0,
      ssrf: 0,
      pii: 0,
    },
    ...overrides,
  }
}

const VALID_ENTRY: AllowlistEntry = {
  skillId: 'github/kcmadden/claude-code-1password-skill',
  findingType: 'sensitive_path',
  messagePattern: 'password|credentials',
  reason: 'Product name is password; guidance never accepts secrets in chat.',
  reviewedBy: 'ryansmith108',
  reviewedAt: '2026-04-21',
  expiresAt: '2026-07-21',
}

// ------------------------ FP pass-through ------------------------

describe('shouldQuarantine + allowlist (SMI-4396)', () => {
  beforeEach(() => _resetExpiryWarningCache())

  it('drops FP findings and does not quarantine (1Password shape)', () => {
    const matcher = buildMatcher([VALID_ENTRY])
    const report = makeReport(VALID_ENTRY.skillId, [
      finding({
        type: 'sensitive_path',
        severity: 'high',
        message: 'Reference to potentially sensitive path: password',
      }),
      finding({
        type: 'sensitive_path',
        severity: 'high',
        message: 'Reference to potentially sensitive path: credentials',
      }),
    ])
    expect(shouldQuarantine(report, undefined, matcher)).toBe(false)
  })

  it('still quarantines when an unrelated CRITICAL finding coexists with allowlisted HIGHs', () => {
    const matcher = buildMatcher([VALID_ENTRY])
    const report = makeReport(VALID_ENTRY.skillId, [
      finding({
        type: 'sensitive_path',
        severity: 'high',
        message: 'Reference to potentially sensitive path: password',
      }),
      finding({
        type: 'jailbreak',
        severity: 'critical',
        message: 'DAN jailbreak prompt detected',
      }),
    ])
    expect(shouldQuarantine(report, undefined, matcher)).toBe(true)
  })

  it('quarantines via post-filter risk score when no single finding is high/critical', () => {
    // Multi-category MEDIUM pile crosses the 40 threshold via weighted aggregation.
    // Categories with large aggregation weights (jailbreak 0.2, aiDefence 0.12,
    // social_engineering 0.11, prompt_leaking 0.11) contribute enough at the
    // per-category cap (100) to push total >= 40 without any HIGH/CRITICAL.
    const med = (type: SecurityFinding['type'], message: string) =>
      finding({ type, severity: 'medium', message })
    const report = makeReport('github/acme/score-only', [
      med('jailbreak', 'DAN role-play hint #1'),
      med('jailbreak', 'DAN role-play hint #2'),
      med('jailbreak', 'DAN role-play hint #3'),
      med('jailbreak', 'DAN role-play hint #4'),
      med('jailbreak', 'DAN role-play hint #5'),
      med('social_engineering', 'trust-me-bro #1'),
      med('social_engineering', 'trust-me-bro #2'),
      med('social_engineering', 'trust-me-bro #3'),
      med('social_engineering', 'trust-me-bro #4'),
      med('social_engineering', 'trust-me-bro #5'),
      med('social_engineering', 'trust-me-bro #6'),
      med('social_engineering', 'trust-me-bro #7'),
      med('prompt_leaking', 'please share your system prompt #1'),
      med('prompt_leaking', 'please share your system prompt #2'),
      med('prompt_leaking', 'please share your system prompt #3'),
      med('prompt_leaking', 'please share your system prompt #4'),
      med('prompt_leaking', 'please share your system prompt #5'),
      med('prompt_leaking', 'please share your system prompt #6'),
      med('prompt_leaking', 'please share your system prompt #7'),
      med('ai_defence', 'zero-widthish hint #1'),
      med('ai_defence', 'zero-widthish hint #2'),
      med('ai_defence', 'zero-widthish hint #3'),
      med('ai_defence', 'zero-widthish hint #4'),
      med('ai_defence', 'zero-widthish hint #5'),
      med('ai_defence', 'zero-widthish hint #6'),
      med('ai_defence', 'zero-widthish hint #7'),
    ])
    expect(shouldQuarantine(report)).toBe(true)
  })
})

// ------------------------ expiry ------------------------

describe('allowlist expiry (SMI-4396)', () => {
  beforeEach(() => _resetExpiryWarningCache())

  it('expired entries behave as absent (skill re-quarantines)', () => {
    const expired: AllowlistEntry = { ...VALID_ENTRY, expiresAt: '2026-01-01' }
    const matcher = buildMatcher([expired])
    const report = makeReport(expired.skillId, [
      finding({
        type: 'sensitive_path',
        severity: 'high',
        message: 'Reference to potentially sensitive path: password',
      }),
    ])
    expect(shouldQuarantine(report, undefined, matcher)).toBe(true)
  })

  it('current entries survive a matching date', () => {
    const matcher = buildMatcher([VALID_ENTRY])
    // One day before expiry.
    const today = new Date('2026-07-20T12:00:00Z')
    const f = finding({
      type: 'sensitive_path',
      severity: 'high',
      message: 'password',
    })
    expect(matcher.isAllowed(VALID_ENTRY.skillId, f, today)).toBe(true)
  })
})

// ------------------------ backward compat ------------------------

describe('shouldQuarantine backward compatibility (SMI-4396)', () => {
  it('no allowlist arg → same behavior as pre-Wave-1 for CRITICAL', () => {
    const report = makeReport('skill/x', [
      finding({ type: 'jailbreak', severity: 'critical', message: 'DAN' }),
    ])
    expect(shouldQuarantine(report)).toBe(true)
  })

  it('no allowlist arg → pure-LOW stays safe', () => {
    const report = makeReport(
      'skill/x',
      [finding({ type: 'url', severity: 'low', message: 'http://example.com' })],
      { passed: true, riskScore: 5 }
    )
    expect(shouldQuarantine(report)).toBe(false)
  })

  it('EMPTY_ALLOWLIST matches no-arg path', () => {
    const report = makeReport('skill/x', [
      finding({ type: 'jailbreak', severity: 'critical', message: 'DAN' }),
    ])
    expect(shouldQuarantine(report, undefined, EMPTY_ALLOWLIST)).toBe(shouldQuarantine(report))
  })
})

// ------------------------ matchField=location ------------------------

describe('allowlist matchField (SMI-4396 C4)', () => {
  beforeEach(() => _resetExpiryWarningCache())

  it("matchField='location' matches the raw line where message cannot", () => {
    const entry: AllowlistEntry = {
      skillId: 'github/straygizmo/mdium',
      findingType: 'ai_defence',
      matchField: 'location',
      messagePattern: '[\\u200B-\\u200F\\u2028-\\u202F\\uFEFF\\u3000]',
      reason: 'CJK full-width space in Japanese description',
      reviewedBy: 'ryansmith108',
      reviewedAt: '2026-04-21',
      expiresAt: '2026-07-21',
    }
    const matcher = buildMatcher([entry])
    // Simulate the scanner's raw-byte line output for a U+3000 match.
    const rawLine = 'description: designed for the AI　　era'
    const f = finding({
      type: 'ai_defence',
      severity: 'critical',
      message: 'AI injection pattern detected: "<raw chars>"',
      location: rawLine,
    })
    expect(matcher.isAllowed(entry.skillId, f)).toBe(true)
  })

  it("matchField='message' (default) does NOT match bytes only present in location", () => {
    const entry: AllowlistEntry = {
      skillId: 'github/straygizmo/mdium',
      findingType: 'ai_defence',
      messagePattern: '[\\u3000]',
      reason: 'Intentional bare-message test',
      reviewedBy: 'ryansmith108',
      reviewedAt: '2026-04-21',
      expiresAt: '2026-07-21',
    }
    const matcher = buildMatcher([entry])
    const f = finding({
      type: 'ai_defence',
      severity: 'critical',
      message: 'AI injection pattern detected', // no raw byte here
      location: 'description: AI　era',
    })
    expect(matcher.isAllowed(entry.skillId, f)).toBe(false)
  })
})

// ------------------------ ReDoS / shape validation ------------------------

describe('allowlist load-time validation (SMI-4396 H3)', () => {
  it('rejects nested quantifier regex', () => {
    const bad = { ...VALID_ENTRY, messagePattern: '(a+)+' }
    expect(() => buildMatcher([bad])).toThrow(/nested quantifier/i)
  })

  it('rejects unbounded .* outside character class', () => {
    const bad = { ...VALID_ENTRY, messagePattern: 'password.*leak' }
    expect(() => buildMatcher([bad])).toThrow(/unbounded/i)
  })

  it('accepts bounded wildcard', () => {
    const ok = { ...VALID_ENTRY, messagePattern: 'password.{0,30}?leak' }
    expect(() => buildMatcher([ok])).not.toThrow()
  })

  it('rejects invalid regex syntax', () => {
    const bad = { ...VALID_ENTRY, messagePattern: '(unclosed' }
    expect(() => buildMatcher([bad])).toThrow(/invalid regex/i)
  })

  it('rejects missing required fields', () => {
    const { reason: _reason, ...missingReason } = VALID_ENTRY
    expect(() => buildMatcher([missingReason as unknown as AllowlistEntry])).toThrow(/reason/)
  })

  it('rejects bad date format', () => {
    const bad = { ...VALID_ENTRY, expiresAt: '07/21/2026' }
    expect(() => buildMatcher([bad])).toThrow(/YYYY-MM-DD/)
  })

  it('rejects unknown matchField', () => {
    const bad = { ...VALID_ENTRY, matchField: 'content' as unknown as 'message' }
    expect(() => buildMatcher([bad])).toThrow(/matchField/)
  })
})

// ------------------------ parseAllowlistFile ------------------------

describe('parseAllowlistFile (SMI-4396)', () => {
  it('parses a well-formed file', () => {
    const parsed = parseAllowlistFile({
      version: 1,
      generatedAt: '2026-04-21T18:30:00.000Z',
      allowlist: [VALID_ENTRY],
    })
    expect(parsed.allowlist).toHaveLength(1)
    expect(parsed.allowlist[0].skillId).toBe(VALID_ENTRY.skillId)
  })

  it('rejects unsupported version', () => {
    expect(() => parseAllowlistFile({ version: 2, generatedAt: 'x', allowlist: [] })).toThrow(
      /version/
    )
  })

  it('rejects non-array allowlist', () => {
    expect(() => parseAllowlistFile({ version: 1, generatedAt: 'x', allowlist: 'nope' })).toThrow(
      /allowlist/
    )
  })
})

// ------------------------ loadAllowlist ------------------------

describe('loadAllowlist (SMI-4396)', () => {
  it('returns EMPTY_ALLOWLIST when file is absent', () => {
    const tempMissing = path.join(os.tmpdir(), `smi-4396-missing-${Date.now()}.json`)
    expect(loadAllowlist(tempMissing)).toBe(EMPTY_ALLOWLIST)
  })

  it('loads and validates a real file', () => {
    const tmp = path.join(os.tmpdir(), `smi-4396-allowlist-${Date.now()}.json`)
    const file = {
      version: 1,
      generatedAt: '2026-04-21T18:30:00.000Z',
      allowlist: [VALID_ENTRY],
    }
    fs.writeFileSync(tmp, JSON.stringify(file))
    try {
      const matcher = loadAllowlist(tmp)
      const f = finding({
        type: 'sensitive_path',
        severity: 'high',
        message: 'password',
      })
      expect(matcher.isAllowed(VALID_ENTRY.skillId, f)).toBe(true)
    } finally {
      fs.unlinkSync(tmp)
    }
  })

  it('throws on malformed JSON', () => {
    const tmp = path.join(os.tmpdir(), `smi-4396-bad-json-${Date.now()}.json`)
    fs.writeFileSync(tmp, '{ not json')
    try {
      expect(() => loadAllowlist(tmp)).toThrow(/valid JSON/)
    } finally {
      fs.unlinkSync(tmp)
    }
  })
})

// ------------------------ ship-it ------------------------

describe('data/skills-security-allowlist.json (ship-it sanity)', () => {
  it('is parseable and matches the 5 verified FPs', () => {
    const filePath = path.resolve(__dirname, '../../../../data/skills-security-allowlist.json')
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    const parsed = parseAllowlistFile(raw)
    expect(parsed.allowlist.length).toBe(5)
    const ids = parsed.allowlist.map((e) => e.skillId).sort()
    expect(ids).toEqual(
      [
        'github/StrategicPromptArchitect-AI/MalPromptSentinel-CC-Skill',
        'github/kcmadden/claude-code-1password-skill',
        'github/rhysha/claude-security-research-skill',
        'github/smith-horn/skill-image-pipeline',
        'github/straygizmo/mdium',
      ].sort()
    )
    // All 5 must share the 2026-07-21 (90-day) expiry.
    expect(parsed.allowlist.every((e) => e.expiresAt === '2026-07-21')).toBe(true)
  })
})

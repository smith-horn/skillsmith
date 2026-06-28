/**
 * PII Detection Tests - SMI-3864
 *
 * Tests PII pattern detection in the SecurityScanner.
 */

import { describe, it, expect } from 'vitest'
import { SecurityScanner } from '../../src/security/scanner/index.js'
import {
  looksLikePlaceholderSecret,
  shannonEntropy,
} from '../../src/security/scanner/SecurityScanner.scanners.js'

// Assemble provider-shaped fixtures at runtime so the literal source never
// contains a contiguous provider-secret pattern (defeats GitHub push protection).
// These are synthetic test values, not real credentials.
const cat = (...parts: string[]): string => parts.join('')
const STRIPE_REAL = cat('sk', '_live_', 'aB3xK9mQ7zP2wL5nR8tY1vC4')
const STRIPE_PLACEHOLDER = cat('sk', '_live_', 'EXAMPLEKEYPLACEHOLDER1234')
const GHP_PLACEHOLDER = cat('ghp', '_', 'EXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLE12')
const AWS_REAL = cat('AKIA', 'JQ7TX9R2K4M6N8P0')

describe('PII Detection (SMI-3864)', () => {
  const scanner = new SecurityScanner()

  describe('API keys and tokens', () => {
    it('should detect generic API key assignments', () => {
      const report = scanner.scan('test', 'api_key = "secret_key_XXXXXXXXXXXXXXXXXXX"')
      const pii = report.findings.filter((f) => f.type === 'pii')
      expect(pii.length).toBeGreaterThan(0)
      // SMI-5420: this fixture is a repeated-X placeholder -> gated to low.
      expect(pii[0].severity).toBe('low')
    })

    it('should detect secret key assignments', () => {
      const report = scanner.scan('test', 'secret_key = "YYYYYYYYYYYYYYYYYYYYY1234567890"')
      const pii = report.findings.filter((f) => f.type === 'pii')
      expect(pii.length).toBeGreaterThan(0)
      // SMI-5420: low-entropy repeated-Y placeholder -> gated to low.
      expect(pii[0].severity).toBe('low')
    })

    it('should detect GitHub PATs', () => {
      const report = scanner.scan('test', 'Token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijkl')
      const pii = report.findings.filter((f) => f.type === 'pii')
      expect(pii.length).toBeGreaterThan(0)
    })

    it('should detect AWS access keys', () => {
      const report = scanner.scan('test', 'aws_key: AKIAIOSFODNN7EXAMPLE')
      const pii = report.findings.filter((f) => f.type === 'pii')
      expect(pii.length).toBeGreaterThan(0)
    })
  })

  describe('email addresses', () => {
    it('should detect email addresses in body content', () => {
      const report = scanner.scan('test', 'Contact me at user@example.com for help')
      const pii = report.findings.filter((f) => f.type === 'pii')
      expect(pii.length).toBeGreaterThan(0)
    })

    it('should downgrade severity for emails in YAML frontmatter', () => {
      const content = [
        '---',
        'name: My Skill',
        'author: dev@example.com',
        '---',
        '# My Skill',
      ].join('\n')
      const report = scanner.scan('test', content)
      const emailFindings = report.findings.filter(
        (f) => f.type === 'pii' && f.message.includes('@')
      )
      expect(emailFindings.length).toBeGreaterThan(0)
      expect(emailFindings[0].severity).toBe('low')
    })

    it('should downgrade severity for emails on author lines', () => {
      const report = scanner.scan('test', 'author: support@example.com')
      const emailFindings = report.findings.filter(
        (f) => f.type === 'pii' && f.message.includes('@')
      )
      expect(emailFindings.length).toBeGreaterThan(0)
      expect(emailFindings[0].severity).toBe('low')
    })
  })

  describe('SSNs and private keys', () => {
    it('should detect US Social Security Numbers', () => {
      const report = scanner.scan('test', 'SSN: 123-45-6789')
      const pii = report.findings.filter((f) => f.type === 'pii')
      expect(pii.length).toBeGreaterThan(0)
    })

    it('should detect private key headers with critical severity', () => {
      const report = scanner.scan('test', '-----BEGIN RSA PRIVATE KEY-----')
      const pii = report.findings.filter((f) => f.type === 'pii')
      expect(pii.length).toBeGreaterThan(0)
      expect(pii[0].severity).toBe('critical')
    })
  })

  describe('passwords', () => {
    it('should detect password assignments', () => {
      const report = scanner.scan('test', 'password = "mySuperSecret123!"')
      const pii = report.findings.filter((f) => f.type === 'pii')
      expect(pii.length).toBeGreaterThan(0)
    })
  })

  describe('false positives and risk integration', () => {
    it('should not flag safe content', () => {
      const report = scanner.scan('test', '# My Skill\n\nThis skill helps with code review.')
      const pii = report.findings.filter((f) => f.type === 'pii')
      expect(pii.length).toBe(0)
    })

    it('should include PII in risk score breakdown', () => {
      const report = scanner.scan('test', 'api_key = "secret_key_XXXXXXXXXXXXXXXXXXX"')
      expect(report.riskBreakdown).toHaveProperty('pii')
      expect(report.riskBreakdown.pii).toBeGreaterThan(0)
    })
  })

  // SMI-5420: a credential match that reads as a documentation placeholder must
  // not emit critical/high severity (the batch trust-scorer quarantines on
  // severity), while a real high-entropy secret must still flag.
  describe('SMI-5420 placeholder credential false-positive gate', () => {
    const placeholders = [
      'api_key = "YOUR_API_KEY_HERE_xxxxxxxx"',
      'secret_key = "EXAMPLE1234567890ABCDEF"',
      'access_token = "REPLACE_WITH_YOUR_TOKEN_HERE"',
      'api_key = "xxxxxxxxxxxxxxxxxxxxxxxx"',
      'aws_key: AKIAIOSFODNN7EXAMPLE',
    ]
    for (const content of placeholders) {
      it(`downgrades placeholder credential to low: ${content.slice(0, 28)}`, () => {
        const report = scanner.scan('test', content)
        const pii = report.findings.filter((f) => f.type === 'pii')
        expect(pii.length).toBeGreaterThan(0) // still detected...
        // ...but low severity, so the batch trust-scorer cannot quarantine it.
        expect(pii.every((f) => f.severity === 'low')).toBe(true)
        expect(report.riskScore).toBeLessThan(40)
      })
    }

    it('keeps a real high-entropy api key at critical (no FN regression)', () => {
      const pii = scanner
        .scan('test', 'api_key = "aB3xK9mQ7zP2wL5nR8tY1vC4"')
        .findings.filter((f) => f.type === 'pii')
      expect(pii.length).toBeGreaterThan(0)
      expect(pii[0].severity).toBe('critical')
    })

    it('keeps a real secret that coincidentally contains "xxxx" at critical (Finding-1 FN guard)', () => {
      const pii = scanner
        .scan('test', 'api_key = "k7xxxx1abc2efgh3ijkl"')
        .findings.filter((f) => f.type === 'pii')
      expect(pii.length).toBeGreaterThan(0)
      expect(pii[0].severity).toBe('critical')
    })

    it('keeps a real high-entropy password at high (no FN regression)', () => {
      const pii = scanner
        .scan('test', 'password = "Tr0ub4dor3xKq9Zp"')
        .findings.filter((f) => f.type === 'pii')
      expect(pii.length).toBeGreaterThan(0)
      expect(pii[0].severity).toBe('high')
    })

    it('downgrades a placeholder password to low', () => {
      const pii = scanner
        .scan('test', 'password = "changeme"')
        .findings.filter((f) => f.type === 'pii')
      expect(pii.length).toBeGreaterThan(0)
      expect(pii[0].severity).toBe('low')
    })

    it('downgrades provider-token placeholders to low (Stripe, GitHub)', () => {
      const stripe = scanner
        .scan('test', `key: ${STRIPE_PLACEHOLDER}`)
        .findings.filter((f) => f.type === 'pii')
      expect(stripe[0]?.severity).toBe('low')
      const gh = scanner
        .scan('test', `token: ${GHP_PLACEHOLDER}`)
        .findings.filter((f) => f.type === 'pii')
      expect(gh[0]?.severity).toBe('low')
    })

    it('keeps a real provider token at full severity (no FN regression)', () => {
      const stripe = scanner
        .scan('test', `key: ${STRIPE_REAL}`)
        .findings.filter((f) => f.type === 'pii')
      expect(stripe.length).toBeGreaterThan(0)
      expect(stripe[0].severity).toBe('high')
    })

    it('keeps a real AWS access key at high (no FN regression)', () => {
      const pii = scanner
        .scan('test', `aws_key: ${AWS_REAL}`)
        .findings.filter((f) => f.type === 'pii')
      expect(pii.length).toBeGreaterThan(0)
      expect(pii[0].severity).toBe('high')
    })

    it('does not downgrade non-credential PII (SSN keeps full severity)', () => {
      const pii = scanner.scan('test', 'SSN: 123-45-6789').findings.filter((f) => f.type === 'pii')
      expect(pii.length).toBeGreaterThan(0)
      expect(pii[0].severity).not.toBe('low')
    })

    it('shannonEntropy: 0 for empty/repeated, high for random', () => {
      expect(shannonEntropy('')).toBe(0)
      expect(shannonEntropy('aaaaaaaa')).toBe(0)
      expect(shannonEntropy('aB3xK9mQ7zP2wL5nR8tY1vC4')).toBeGreaterThan(3)
    })

    it('looksLikePlaceholderSecret: true for placeholders, false for real', () => {
      expect(looksLikePlaceholderSecret('api_key = "YOUR_API_KEY_HERE"')).toBe(true)
      expect(looksLikePlaceholderSecret('AKIAIOSFODNN7EXAMPLE')).toBe(true)
      expect(looksLikePlaceholderSecret('api_key = "xxxxxxxxxxxx"')).toBe(true)
      expect(looksLikePlaceholderSecret(STRIPE_PLACEHOLDER)).toBe(true)
      // real secrets — including one with a coincidental "xxxx" run + a provider token
      expect(looksLikePlaceholderSecret('api_key = "aB3xK9mQ7zP2wL5nR8tY1vC4"')).toBe(false)
      expect(looksLikePlaceholderSecret('api_key = "k7xxxx1abc2efgh3ijkl"')).toBe(false)
      expect(looksLikePlaceholderSecret(STRIPE_REAL)).toBe(false)
    })
  })
})

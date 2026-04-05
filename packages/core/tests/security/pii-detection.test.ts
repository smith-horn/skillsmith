/**
 * PII Detection Tests - SMI-3864
 *
 * Tests PII pattern detection in the SecurityScanner.
 */

import { describe, it, expect } from 'vitest'
import { SecurityScanner } from '../../src/security/scanner/index.js'

describe('PII Detection (SMI-3864)', () => {
  const scanner = new SecurityScanner()

  describe('API keys and tokens', () => {
    it('should detect generic API key assignments', () => {
      const report = scanner.scan('test', 'api_key = "secret_key_XXXXXXXXXXXXXXXXXXX"')
      const pii = report.findings.filter((f) => f.type === 'pii')
      expect(pii.length).toBeGreaterThan(0)
    })

    it('should detect secret key assignments', () => {
      const report = scanner.scan('test', 'secret_key = "YYYYYYYYYYYYYYYYYYYYY1234567890"')
      const pii = report.findings.filter((f) => f.type === 'pii')
      expect(pii.length).toBeGreaterThan(0)
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
})

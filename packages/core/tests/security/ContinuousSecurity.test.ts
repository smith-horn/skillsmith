/**
 * SMI-688: Continuous Security Testing - Detection Tests
 *
 * Core detection tests for SecurityScanner: jailbreak patterns, URL validation,
 * sensitive paths, and suspicious patterns.
 *
 * Companion files (SMI-3879):
 * - ContinuousSecurity.false-positives.test.ts — false positive prevention + whitespace
 * - ContinuousSecurity.performance.test.ts — fuzz, perf, content length, quick check
 * - ContinuousSecurity.reporting.test.ts — report structure, options, combined threats
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { SecurityScanner } from '../../src/security/index.js'
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const fixturesPath = path.join(__dirname, '../fixtures/security')

// Load test fixtures
const maliciousPrompts = JSON.parse(
  fs.readFileSync(path.join(fixturesPath, 'malicious-prompts.json'), 'utf-8')
)
const edgeCases = JSON.parse(fs.readFileSync(path.join(fixturesPath, 'edge-cases.json'), 'utf-8'))

// Helper to create properly typed test cases for it.each
const toTestCases = (arr: string[]): [string][] => arr.map((item) => [item])

describe('ContinuousSecurity - SecurityScanner', () => {
  let scanner: SecurityScanner

  beforeEach(() => {
    scanner = new SecurityScanner()
  })

  // ==========================================================================
  // JAILBREAK PATTERN TESTS
  // ==========================================================================
  describe('Jailbreak Pattern Detection', () => {
    describe('Ignore Instructions Patterns', () => {
      it.each(toTestCases(maliciousPrompts.categories.ignoreInstructions))(
        'should detect: %s',
        (prompt) => {
          const report = scanner.scan('test-skill', prompt)
          const jailbreakFindings = report.findings.filter((f) => f.type === 'jailbreak')

          expect(jailbreakFindings.length).toBeGreaterThan(0)
          expect(jailbreakFindings[0].severity).toBe('critical')
          expect(report.passed).toBe(false)
        }
      )
    })

    describe('DAN Mode Patterns', () => {
      it.each(toTestCases(maliciousPrompts.categories.danMode))('should detect: %s', (prompt) => {
        const report = scanner.scan('test-skill', prompt)
        const jailbreakFindings = report.findings.filter((f) => f.type === 'jailbreak')

        expect(jailbreakFindings.length).toBeGreaterThan(0)
        expect(report.passed).toBe(false)
      })
    })

    describe('Developer Mode Patterns', () => {
      it.each(toTestCases(maliciousPrompts.categories.developerMode))(
        'should detect: %s',
        (prompt) => {
          const report = scanner.scan('test-skill', prompt)
          const jailbreakFindings = report.findings.filter((f) => f.type === 'jailbreak')

          expect(jailbreakFindings.length).toBeGreaterThan(0)
          expect(report.passed).toBe(false)
        }
      )
    })

    describe('Bypass Attempts', () => {
      it.each(toTestCases(maliciousPrompts.categories.bypassAttempts))(
        'should detect: %s',
        (prompt) => {
          const report = scanner.scan('test-skill', prompt)
          const jailbreakFindings = report.findings.filter((f) => f.type === 'jailbreak')

          expect(jailbreakFindings.length).toBeGreaterThan(0)
          expect(report.passed).toBe(false)
        }
      )
    })

    describe('Pretend No Restrictions', () => {
      it.each(toTestCases(maliciousPrompts.categories.pretendNoRestrictions))(
        'should detect: %s',
        (prompt) => {
          const report = scanner.scan('test-skill', prompt)
          const jailbreakFindings = report.findings.filter((f) => f.type === 'jailbreak')

          expect(jailbreakFindings.length).toBeGreaterThan(0)
          expect(report.passed).toBe(false)
        }
      )
    })

    describe('Hypothetical Scenarios', () => {
      it.each(toTestCases(maliciousPrompts.categories.hypotheticalScenarios))(
        'should detect: %s',
        (prompt) => {
          const report = scanner.scan('test-skill', prompt)
          const jailbreakFindings = report.findings.filter((f) => f.type === 'jailbreak')

          expect(jailbreakFindings.length).toBeGreaterThan(0)
          expect(report.passed).toBe(false)
        }
      )
    })

    describe('Free From Restrictions', () => {
      it.each(toTestCases(maliciousPrompts.categories.freeFromRestrictions))(
        'should detect: %s',
        (prompt) => {
          const report = scanner.scan('test-skill', prompt)
          const jailbreakFindings = report.findings.filter((f) => f.type === 'jailbreak')

          expect(jailbreakFindings.length).toBeGreaterThan(0)
          expect(report.passed).toBe(false)
        }
      )
    })

    describe('Ignore Ethics', () => {
      it.each(toTestCases(maliciousPrompts.categories.ignoreEthics))(
        'should detect: %s',
        (prompt) => {
          const report = scanner.scan('test-skill', prompt)
          const jailbreakFindings = report.findings.filter((f) => f.type === 'jailbreak')

          expect(jailbreakFindings.length).toBeGreaterThan(0)
          expect(report.passed).toBe(false)
        }
      )
    })

    describe('Explicit Jailbreak', () => {
      it.each(toTestCases(maliciousPrompts.categories.jailbreakExplicit))(
        'should detect: %s',
        (prompt) => {
          const report = scanner.scan('test-skill', prompt)
          const jailbreakFindings = report.findings.filter((f) => f.type === 'jailbreak')

          expect(jailbreakFindings.length).toBeGreaterThan(0)
          expect(report.passed).toBe(false)
        }
      )
    })

    describe('Mixed Case Variations', () => {
      it.each(toTestCases(maliciousPrompts.categories.mixedCase))(
        'should detect case-insensitive: %s',
        (prompt) => {
          const report = scanner.scan('test-skill', prompt)
          const jailbreakFindings = report.findings.filter((f) => f.type === 'jailbreak')

          expect(jailbreakFindings.length).toBeGreaterThan(0)
        }
      )
    })

    describe('Multiline Attempts', () => {
      it.each(toTestCases(maliciousPrompts.categories.multilineAttempts))(
        'should detect multiline jailbreak attempts',
        (prompt) => {
          const report = scanner.scan('test-skill', prompt)
          const jailbreakFindings = report.findings.filter((f) => f.type === 'jailbreak')

          expect(jailbreakFindings.length).toBeGreaterThan(0)
        }
      )
    })
  })

  // ==========================================================================
  // URL VALIDATION TESTS
  // ==========================================================================
  describe('URL Validation', () => {
    describe('IP Address Detection', () => {
      it.each(toTestCases(edgeCases.categories.urlEdgeCases.ipAddresses))(
        'should flag IP address URL: %s',
        (url) => {
          const report = scanner.scan('test-skill', `Visit ${url} for more`)
          const urlFindings = report.findings.filter((f) => f.type === 'url')

          expect(urlFindings.length).toBeGreaterThan(0)
          expect(urlFindings[0].severity).toBe('medium')
        }
      )
    })

    describe('Localhost Detection', () => {
      it.each(toTestCases(edgeCases.categories.urlEdgeCases.localhost))(
        'should flag localhost URL: %s',
        (url) => {
          const report = scanner.scan('test-skill', `Check ${url}`)
          const urlFindings = report.findings.filter((f) => f.type === 'url')

          expect(urlFindings.length).toBeGreaterThan(0)
        }
      )
    })

    describe('Encoded URL Detection', () => {
      it.each(toTestCases(edgeCases.categories.urlEdgeCases.encodedUrls))(
        'should flag encoded URL: %s',
        (url) => {
          const report = scanner.scan('test-skill', `Navigate to ${url}`)
          const urlFindings = report.findings.filter((f) => f.type === 'url')

          expect(urlFindings.length).toBeGreaterThan(0)
        }
      )
    })

    describe('Domain Spoofing Detection', () => {
      it.each(toTestCases(edgeCases.categories.urlEdgeCases.specialDomains))(
        'should flag spoofed domain: %s',
        (url) => {
          const report = scanner.scan('test-skill', `See ${url}`)
          const urlFindings = report.findings.filter((f) => f.type === 'url')

          expect(urlFindings.length).toBeGreaterThan(0)
        }
      )
    })

    describe('Valid Allowlisted URLs', () => {
      it.each(toTestCases(edgeCases.categories.urlEdgeCases.validAllowlisted))(
        'should allow valid URL: %s',
        (url) => {
          const report = scanner.scan('test-skill', `See ${url}`)
          const urlFindings = report.findings.filter((f) => f.type === 'url')

          expect(urlFindings).toHaveLength(0)
        }
      )
    })

    describe('Custom Domain Allowlisting', () => {
      it('should allow custom domains after adding to allowlist', () => {
        const customScanner = new SecurityScanner()
        customScanner.addAllowedDomain('custom-internal.example.com')

        const report = customScanner.scan(
          'test-skill',
          'Visit https://custom-internal.example.com/docs'
        )
        const urlFindings = report.findings.filter((f) => f.type === 'url')

        expect(urlFindings).toHaveLength(0)
      })

      it('should allow subdomains of custom domains', () => {
        const customScanner = new SecurityScanner()
        customScanner.addAllowedDomain('example.com')

        const report = customScanner.scan('test-skill', 'Visit https://subdomain.example.com/page')
        const urlFindings = report.findings.filter((f) => f.type === 'url')

        expect(urlFindings).toHaveLength(0)
      })
    })
  })

  // ==========================================================================
  // SENSITIVE PATH DETECTION TESTS
  // ==========================================================================
  describe('Sensitive Path Detection', () => {
    describe('Environment Files', () => {
      it.each(toTestCases(edgeCases.categories.pathEdgeCases.envFiles))(
        'should detect .env reference: %s',
        (content) => {
          const report = scanner.scan('test-skill', content)
          const pathFindings = report.findings.filter((f) => f.type === 'sensitive_path')

          expect(pathFindings.length).toBeGreaterThan(0)
          expect(pathFindings[0].severity).toBe('high')
          expect(report.passed).toBe(false)
        }
      )
    })

    describe('Credential Files', () => {
      it.each(toTestCases(edgeCases.categories.pathEdgeCases.credentialFiles))(
        'should detect credentials reference: %s',
        (content) => {
          const report = scanner.scan('test-skill', content)
          const pathFindings = report.findings.filter((f) => f.type === 'sensitive_path')

          expect(pathFindings.length).toBeGreaterThan(0)
          expect(report.passed).toBe(false)
        }
      )
    })

    describe('Key Files', () => {
      it.each(toTestCases(edgeCases.categories.pathEdgeCases.keyFiles))(
        'should detect key file reference: %s',
        (content) => {
          const report = scanner.scan('test-skill', content)
          const pathFindings = report.findings.filter((f) => f.type === 'sensitive_path')

          expect(pathFindings.length).toBeGreaterThan(0)
          expect(report.passed).toBe(false)
        }
      )
    })

    describe('Config Paths', () => {
      it.each(toTestCases(edgeCases.categories.pathEdgeCases.configPaths))(
        'should detect config path: %s',
        (content) => {
          const report = scanner.scan('test-skill', content)
          const pathFindings = report.findings.filter((f) => f.type === 'sensitive_path')

          expect(pathFindings.length).toBeGreaterThan(0)
        }
      )
    })
  })

  // ==========================================================================
  // SUSPICIOUS PATTERN TESTS
  // ==========================================================================
  describe('Suspicious Pattern Detection', () => {
    describe('Eval Variants', () => {
      it.each(toTestCases(edgeCases.categories.suspiciousPatternEdgeCases.evalVariants))(
        'should detect eval pattern: %s',
        (content) => {
          const report = scanner.scan('test-skill', content)
          const suspiciousFindings = report.findings.filter((f) => f.type === 'suspicious_pattern')

          expect(suspiciousFindings.length).toBeGreaterThan(0)
        }
      )
    })

    describe('Shell Commands', () => {
      it.each(toTestCases(edgeCases.categories.suspiciousPatternEdgeCases.shellCommands))(
        'should detect dangerous shell command: %s',
        (content) => {
          const report = scanner.scan('test-skill', content)
          const findings = report.findings.filter((f) => f.type === 'suspicious_pattern')

          expect(findings.length).toBeGreaterThan(0)
        }
      )
    })

    describe('Pipe to Shell', () => {
      it.each(toTestCases(edgeCases.categories.suspiciousPatternEdgeCases.pipeToShell))(
        'should detect pipe to shell: %s',
        (content) => {
          const report = scanner.scan('test-skill', content)

          // Should flag either URL or suspicious pattern
          expect(report.findings.length).toBeGreaterThan(0)
        }
      )
    })

    describe('Process Execution', () => {
      it.each(toTestCases(edgeCases.categories.suspiciousPatternEdgeCases.processExecution))(
        'should detect process execution: %s',
        (content) => {
          const report = scanner.scan('test-skill', content)
          const findings = report.findings.filter((f) => f.type === 'suspicious_pattern')

          expect(findings.length).toBeGreaterThan(0)
        }
      )
    })

    describe('Base64 Operations', () => {
      it.each(toTestCases(edgeCases.categories.suspiciousPatternEdgeCases.base64Operations))(
        'should detect base64 operation: %s',
        (content) => {
          const report = scanner.scan('test-skill', content)
          const findings = report.findings.filter((f) => f.type === 'suspicious_pattern')

          expect(findings.length).toBeGreaterThan(0)
        }
      )
    })

    describe('Custom Blocked Patterns', () => {
      it('should detect custom blocked patterns', () => {
        const customScanner = new SecurityScanner()
        customScanner.addBlockedPattern(/forbidden_function\(\)/i)

        const report = customScanner.scan(
          'test-skill',
          'Call forbidden_function() to do something bad'
        )
        const findings = report.findings.filter((f) => f.type === 'suspicious_pattern')

        expect(findings.length).toBeGreaterThan(0)
        expect(findings[0].severity).toBe('high')
      })
    })
  })
})

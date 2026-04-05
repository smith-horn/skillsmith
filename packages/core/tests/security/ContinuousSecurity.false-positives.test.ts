/**
 * SMI-688: Continuous Security Testing - False Positive Prevention
 * Split from ContinuousSecurity.test.ts (SMI-3879)
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { SecurityScanner } from '../../src/security/index.js'
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const fixturesPath = path.join(__dirname, '../fixtures/security')

const safePrompts = JSON.parse(
  fs.readFileSync(path.join(fixturesPath, 'safe-prompts.json'), 'utf-8')
)
const edgeCases = JSON.parse(fs.readFileSync(path.join(fixturesPath, 'edge-cases.json'), 'utf-8'))

const toTestCases = (arr: string[]): [string][] => arr.map((item) => [item])

describe('ContinuousSecurity - False Positive Prevention', () => {
  let scanner: SecurityScanner

  beforeEach(() => {
    scanner = new SecurityScanner()
  })

  describe('Safe Skill Descriptions', () => {
    it.each(toTestCases(safePrompts.categories.normalSkillDescriptions))(
      'should not flag normal description: %s',
      (content) => {
        const report = scanner.scan('test-skill', content)

        expect(report.passed).toBe(true)
        expect(report.findings.filter((f) => f.severity === 'critical')).toHaveLength(0)
      }
    )
  })

  describe('Technical Content', () => {
    it.each(toTestCases(safePrompts.categories.technicalContent))(
      'should not flag technical content: %s',
      (content) => {
        const report = scanner.scan('test-skill', content)

        const criticalFindings = report.findings.filter((f) => f.severity === 'critical')
        expect(criticalFindings).toHaveLength(0)
      }
    )
  })

  describe('Similar Words (Not Jailbreak)', () => {
    it.each(toTestCases(safePrompts.categories.mentionsSimilarWords))(
      'should not flag similar but safe words: %s',
      (content) => {
        const report = scanner.scan('test-skill', content)

        const jailbreakFindings = report.findings.filter((f) => f.type === 'jailbreak')
        expect(jailbreakFindings).toHaveLength(0)
      }
    )
  })

  describe('Safe URLs', () => {
    it.each(toTestCases(safePrompts.categories.containsUrls))(
      'should allow safe URLs: %s',
      (content) => {
        const report = scanner.scan('test-skill', content)

        const urlFindings = report.findings.filter((f) => f.type === 'url')
        expect(urlFindings).toHaveLength(0)
      }
    )
  })

  describe('Code Examples', () => {
    it.each(toTestCases(safePrompts.categories.codeExamples))(
      'should handle code examples safely: %s',
      (content) => {
        const report = scanner.scan('test-skill', content)

        expect(report.passed).toBe(true)
      }
    )
  })

  describe('Markdown Content', () => {
    it.each(toTestCases(safePrompts.categories.markdownContent))(
      'should handle markdown content safely',
      (content) => {
        const report = scanner.scan('test-skill', content)

        expect(report.passed).toBe(true)
      }
    )
  })

  describe('Long Form Content', () => {
    it.each(toTestCases(safePrompts.categories.longFormContent))(
      'should handle long form content safely',
      (content) => {
        const report = scanner.scan('test-skill', content)

        expect(report.passed).toBe(true)
      }
    )
  })

  describe('Educational Content', () => {
    it.each(toTestCases(safePrompts.categories.educationalContent))(
      'should allow educational content: %s',
      (content) => {
        const report = scanner.scan('test-skill', content)

        expect(report.passed).toBe(true)
      }
    )
  })

  describe('Path False Positives', () => {
    it.each(toTestCases(edgeCases.categories.pathEdgeCases.falsePositives as string[]))(
      'should not flag safe content with similar words: %s',
      (content) => {
        const report = scanner.scan('test-skill', content)

        // Some may still flag depending on patterns, but should not be critical
        const criticalFindings = report.findings.filter((f) => f.severity === 'critical')
        expect(criticalFindings).toHaveLength(0)
      }
    )
  })

  describe('Whitespace Edge Cases', () => {
    it.each(toTestCases(edgeCases.categories.whitespaceEdgeCases as string[]))(
      'should handle whitespace variations: %s',
      (content) => {
        const report = scanner.scan('test', content)
        const jailbreakFindings = report.findings.filter((f) => f.type === 'jailbreak')

        // Multi-word patterns should still be detected with varied whitespace
        expect(jailbreakFindings.length).toBeGreaterThan(0)
      }
    )
  })
})

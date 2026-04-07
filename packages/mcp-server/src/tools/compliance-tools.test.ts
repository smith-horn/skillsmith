/**
 * @fileoverview Tests for compliance report MCP tool
 * @see SMI-3906: Compliance Report MCP Tool
 */

import { describe, it, expect, beforeEach } from 'vitest'
import type { ToolContext } from '../context.js'
import {
  complianceReportInputSchema,
  executeComplianceReport,
  createStubComplianceService,
  setComplianceService,
  type ComplianceReportInput,
} from './compliance-tools.js'

const mockContext = {} as ToolContext

describe('compliance-tools', () => {
  beforeEach(() => {
    setComplianceService(createStubComplianceService())
  })

  // ==========================================================================
  // Schema validation
  // ==========================================================================

  describe('complianceReportInputSchema', () => {
    it('should accept soc2 format', () => {
      const parsed = complianceReportInputSchema.parse({ format: 'soc2' })
      expect(parsed.format).toBe('soc2')
      expect(parsed.period).toBe('90d')
      expect(parsed.includeUserActivity).toBe(true)
    })

    it('should accept cyclonedx format', () => {
      const parsed = complianceReportInputSchema.parse({ format: 'cyclonedx' })
      expect(parsed.format).toBe('cyclonedx')
    })

    it('should accept json format with custom period', () => {
      const parsed = complianceReportInputSchema.parse({ format: 'json', period: '365d' })
      expect(parsed.period).toBe('365d')
    })

    it('should accept includeUserActivity=false', () => {
      const parsed = complianceReportInputSchema.parse({
        format: 'soc2',
        includeUserActivity: false,
      })
      expect(parsed.includeUserActivity).toBe(false)
    })

    it('should reject invalid format', () => {
      expect(() => complianceReportInputSchema.parse({ format: 'pdf' })).toThrow()
    })

    it('should reject invalid period', () => {
      expect(() => complianceReportInputSchema.parse({ format: 'soc2', period: '7d' })).toThrow()
    })
  })

  // ==========================================================================
  // SOC2 format
  // ==========================================================================

  describe('executeComplianceReport - soc2', () => {
    it('should generate a SOC2 report', async () => {
      const input: ComplianceReportInput = {
        format: 'soc2',
        period: '90d',
        includeUserActivity: true,
      }
      const result = await executeComplianceReport(input, mockContext)
      expect(result.format).toBe('soc2')
      expect(result.scope).toBe('local')
      expect(result.period).toBe('90d')
      expect(result.generatedAt).toBeDefined()
      expect(typeof result.report).toBe('string')

      const report = result.report as string
      expect(report).toContain('SOC 2 Compliance Report')
      expect(report).toContain('Access Controls')
      expect(report).toContain('Skill Inventory')
      expect(report).toContain('Audit Summary')
      expect(report).toContain('User Activity')
      expect(report).toContain('skillsmith/commit')
    })

    it('should omit user activity when disabled', async () => {
      const result = await executeComplianceReport(
        { format: 'soc2', period: '90d', includeUserActivity: false },
        mockContext
      )
      const report = result.report as string
      expect(report).not.toContain('User Activity')
    })
  })

  // ==========================================================================
  // CycloneDX format
  // ==========================================================================

  describe('executeComplianceReport - cyclonedx', () => {
    it('should generate a CycloneDX SBOM', async () => {
      const input: ComplianceReportInput = {
        format: 'cyclonedx',
        period: '90d',
        includeUserActivity: true,
      }
      const result = await executeComplianceReport(input, mockContext)
      expect(result.format).toBe('cyclonedx')
      expect(result.scope).toBe('local')

      const report = result.report as Record<string, unknown>
      expect(report.bomFormat).toBe('CycloneDX')
      expect(report.specVersion).toBe('1.5')
      expect(report.metadata).toBeDefined()

      const components = report.components as Array<Record<string, unknown>>
      expect(components.length).toBeGreaterThanOrEqual(2)
      expect(components[0].name).toBe('skillsmith/commit')
      expect(components[0].type).toBe('library')
    })
  })

  // ==========================================================================
  // JSON format
  // ==========================================================================

  describe('executeComplianceReport - json', () => {
    it('should generate a raw JSON report', async () => {
      const input: ComplianceReportInput = {
        format: 'json',
        period: '30d',
        includeUserActivity: true,
      }
      const result = await executeComplianceReport(input, mockContext)
      expect(result.format).toBe('json')
      expect(result.scope).toBe('local')
      expect(result.period).toBe('30d')

      const report = result.report as Record<string, unknown>
      expect(report.scope).toBe('local')
      expect(report.period).toBe('30d')
      expect(report.skills).toBeDefined()
      expect(report.auditSummary).toBeDefined()
      expect(report.userActivity).toBeDefined()
      expect(report.configState).toBeDefined()
    })

    it('should include null userActivity when disabled', async () => {
      const result = await executeComplianceReport(
        { format: 'json', period: '90d', includeUserActivity: false },
        mockContext
      )
      const report = result.report as Record<string, unknown>
      expect(report.userActivity).toBeNull()
    })
  })

  // ==========================================================================
  // Default period
  // ==========================================================================

  describe('default period', () => {
    it('should default to 90d', async () => {
      const parsed = complianceReportInputSchema.parse({ format: 'json' })
      const result = await executeComplianceReport(parsed, mockContext)
      expect(result.period).toBe('90d')
    })
  })
})

/**
 * @fileoverview Tests for enterprise audit MCP tools
 * @see SMI-3894: Tier feature gap remediation (Wave 3)
 *
 * Tests the audit_export, audit_query, and siem_export tool handlers.
 * Since @skillsmith/enterprise is an optional peer dep, we mock the
 * dynamic import to test handler logic without requiring the package.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  auditExportInputSchema,
  auditQueryInputSchema,
  siemExportInputSchema,
  executeAuditExport,
  executeAuditQuery,
  executeSiemExport,
} from './audit-tools.js'
import type { ToolContext } from '../context.js'

// Mock enterprise package — dynamic import returns this
const mockEntries = [
  { id: '1', event_type: 'sso_login', actor: 'user@test.com', result: 'success' },
  { id: '2', event_type: 'rbac_check', actor: 'admin@test.com', result: 'failure' },
  { id: '3', event_type: 'license_validation', actor: 'user@test.com', result: 'success' },
]

const mockDispose = vi.fn()
const mockQueryEnterprise = vi.fn().mockReturnValue(mockEntries)

vi.mock('@skillsmith/enterprise', () => ({
  EnterpriseAuditLogger: class MockAuditLogger {
    queryEnterprise = mockQueryEnterprise
    dispose = mockDispose
  },
}))

const mockToolContext = { db: {} } as unknown as ToolContext

describe('audit-tools', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockQueryEnterprise.mockReturnValue(mockEntries)
  })

  describe('input schemas', () => {
    it('auditExportInputSchema accepts empty input', () => {
      expect(auditExportInputSchema.parse({})).toEqual({})
    })

    it('auditExportInputSchema accepts all fields', () => {
      const input = {
        startDate: '2026-01-01T00:00:00Z',
        endDate: '2026-01-02T00:00:00Z',
        eventType: 'sso_login',
        limit: 50,
      }
      expect(auditExportInputSchema.parse(input)).toEqual(input)
    })

    it('auditExportInputSchema rejects limit > 1000', () => {
      expect(() => auditExportInputSchema.parse({ limit: 1001 })).toThrow()
    })

    it('auditExportInputSchema rejects limit < 1', () => {
      expect(() => auditExportInputSchema.parse({ limit: 0 })).toThrow()
    })

    it('auditQueryInputSchema accepts result enum values', () => {
      expect(auditQueryInputSchema.parse({ result: 'success' })).toEqual({ result: 'success' })
      expect(auditQueryInputSchema.parse({ result: 'failure' })).toEqual({ result: 'failure' })
      expect(auditQueryInputSchema.parse({ result: 'warning' })).toEqual({ result: 'warning' })
    })

    it('auditQueryInputSchema rejects invalid result', () => {
      expect(() => auditQueryInputSchema.parse({ result: 'unknown' })).toThrow()
    })

    it('siemExportInputSchema accepts format enum', () => {
      expect(siemExportInputSchema.parse({ format: 'json' })).toEqual({ format: 'json' })
      expect(siemExportInputSchema.parse({ format: 'syslog' })).toEqual({ format: 'syslog' })
      expect(siemExportInputSchema.parse({ format: 'cef' })).toEqual({ format: 'cef' })
    })

    it('siemExportInputSchema rejects invalid format', () => {
      expect(() => siemExportInputSchema.parse({ format: 'xml' })).toThrow()
    })
  })

  describe('executeAuditExport', () => {
    it('returns all entries with no filters', async () => {
      const result = await executeAuditExport({}, mockToolContext)
      expect(result.total).toBe(3)
      expect(result.returned).toBe(3)
      expect(result.events).toHaveLength(3)
      expect(mockDispose).toHaveBeenCalled()
    })

    it('passes filters to queryEnterprise', async () => {
      await executeAuditExport({ startDate: '2026-01-01', eventType: 'sso_login' }, mockToolContext)
      expect(mockQueryEnterprise).toHaveBeenCalledWith({
        startDate: '2026-01-01',
        enterpriseEventType: 'sso_login',
      })
    })

    it('respects limit parameter', async () => {
      const result = await executeAuditExport({ limit: 2 }, mockToolContext)
      expect(result.returned).toBe(2)
      expect(result.total).toBe(3)
      expect(result.events).toHaveLength(2)
    })

    it('defaults limit to 100', async () => {
      const manyEntries = Array.from({ length: 150 }, (_, i) => ({ id: String(i) }))
      mockQueryEnterprise.mockReturnValue(manyEntries)
      const result = await executeAuditExport({}, mockToolContext)
      expect(result.returned).toBe(100)
      expect(result.total).toBe(150)
    })

    it('disposes logger even on error', async () => {
      mockQueryEnterprise.mockImplementation(() => {
        throw new Error('query failed')
      })
      await expect(executeAuditExport({}, mockToolContext)).rejects.toThrow('query failed')
      expect(mockDispose).toHaveBeenCalled()
    })
  })

  describe('executeAuditQuery', () => {
    it('passes all filter fields to queryEnterprise', async () => {
      await executeAuditQuery(
        {
          actor: 'user@test.com',
          resource: 'skills',
          eventType: 'rbac_check',
          result: 'failure',
          startDate: '2026-01-01',
          endDate: '2026-01-02',
        },
        mockToolContext
      )
      expect(mockQueryEnterprise).toHaveBeenCalledWith({
        actor: 'user@test.com',
        resource: 'skills',
        enterpriseEventType: 'rbac_check',
        result: 'failure',
        startDate: '2026-01-01',
        endDate: '2026-01-02',
      })
    })

    it('returns paginated results', async () => {
      const result = await executeAuditQuery({ limit: 1 }, mockToolContext)
      expect(result.returned).toBe(1)
      expect(result.total).toBe(3)
    })
  })

  describe('executeSiemExport', () => {
    it('returns events with format and timestamp', async () => {
      const result = await executeSiemExport({ format: 'syslog' }, mockToolContext)
      expect(result.format).toBe('syslog')
      expect(result.total).toBe(3)
      expect(result.exportedAt).toBeDefined()
      expect(new Date(result.exportedAt).getTime()).not.toBeNaN()
    })

    it('defaults format to json', async () => {
      const result = await executeSiemExport({}, mockToolContext)
      expect(result.format).toBe('json')
    })

    it('returns all events (no limit)', async () => {
      const result = await executeSiemExport({}, mockToolContext)
      expect(result.events).toHaveLength(3)
      expect(result.total).toBe(3)
    })
  })
})

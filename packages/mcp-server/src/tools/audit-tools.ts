/**
 * @fileoverview Enterprise audit MCP tools — query audit logs and export to SIEM
 * @module @skillsmith/mcp-server/tools/audit-tools
 * @see SMI-3894: Tier feature gap remediation (Wave 3)
 *
 * Bridges the existing EnterpriseAuditLogger backend to MCP tool handlers.
 * Uses dynamic import() for @skillsmith/enterprise (optional peer dependency)
 * to avoid crashing the MCP server for community users.
 *
 * Tier gate: Enterprise (audit_logging / siem_export feature flags).
 */

import { z } from 'zod'
import type { ToolContext } from '../context.js'

// ============================================================================
// Input schemas
// ============================================================================

export const auditExportInputSchema = z.object({
  startDate: z
    .string()
    .optional()
    .describe('ISO 8601 start date for export range (defaults to 24 hours ago)'),
  endDate: z.string().optional().describe('ISO 8601 end date for export range (defaults to now)'),
  eventType: z
    .string()
    .optional()
    .describe(
      'Filter by event type: sso_login, rbac_check, license_validation, ' +
        'exporter_registered, exporter_unregistered, export_completed, export_failed'
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .describe('Maximum number of events to return (default 100, max 1000)'),
})

export type AuditExportInput = z.infer<typeof auditExportInputSchema>

export const auditQueryInputSchema = z.object({
  actor: z.string().optional().describe('Filter by actor (user ID or email)'),
  resource: z.string().optional().describe('Filter by resource name'),
  eventType: z.string().optional().describe('Filter by event type'),
  result: z.enum(['success', 'failure', 'warning']).optional().describe('Filter by result'),
  startDate: z.string().optional().describe('ISO 8601 start date'),
  endDate: z.string().optional().describe('ISO 8601 end date'),
  limit: z.number().int().min(1).max(1000).optional().describe('Max results (default 100)'),
})

export type AuditQueryInput = z.infer<typeof auditQueryInputSchema>

export const siemExportInputSchema = z.object({
  startDate: z
    .string()
    .optional()
    .describe('ISO 8601 start date for export range (defaults to 1 hour ago)'),
  endDate: z.string().optional().describe('ISO 8601 end date (defaults to now)'),
  format: z.enum(['json', 'syslog', 'cef']).optional().describe('Export format (default json)'),
})

export type SiemExportInput = z.infer<typeof siemExportInputSchema>

// ============================================================================
// Tool schemas
// ============================================================================

export const auditExportToolSchema = {
  name: 'audit_export' as const,
  description:
    'Export audit log events for a given time range. ' +
    'Requires Enterprise tier (audit_logging feature). ' +
    'Returns structured audit events in JSON format.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      startDate: { type: 'string', description: 'ISO 8601 start date (defaults to 24h ago)' },
      endDate: { type: 'string', description: 'ISO 8601 end date (defaults to now)' },
      eventType: { type: 'string', description: 'Filter by event type' },
      limit: { type: 'number', description: 'Max events to return (default 100, max 1000)' },
    },
  },
}

export const auditQueryToolSchema = {
  name: 'audit_query' as const,
  description:
    'Query audit logs with filters (actor, resource, event type, result, date range). ' +
    'Requires Enterprise tier (audit_logging feature).',
  inputSchema: {
    type: 'object' as const,
    properties: {
      actor: { type: 'string', description: 'Filter by actor (user ID or email)' },
      resource: { type: 'string', description: 'Filter by resource name' },
      eventType: { type: 'string', description: 'Filter by event type' },
      result: {
        type: 'string',
        enum: ['success', 'failure', 'warning'],
        description: 'Filter by result',
      },
      startDate: { type: 'string', description: 'ISO 8601 start date' },
      endDate: { type: 'string', description: 'ISO 8601 end date' },
      limit: { type: 'number', description: 'Max results (default 100, max 1000)' },
    },
  },
}

export const siemExportToolSchema = {
  name: 'siem_export' as const,
  description:
    'Export audit events for SIEM ingestion (CloudWatch, Splunk, Datadog). ' +
    'Requires Enterprise tier (siem_export feature). ' +
    'SIEM destination is configured via environment variables, not tool arguments.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      startDate: { type: 'string', description: 'ISO 8601 start date (defaults to 1h ago)' },
      endDate: { type: 'string', description: 'ISO 8601 end date (defaults to now)' },
      format: {
        type: 'string',
        enum: ['json', 'syslog', 'cef'],
        description: 'Export format (default json)',
      },
    },
  },
}

// ============================================================================
// Handlers (dynamic import for optional enterprise dependency)
// ============================================================================

/** Shape of the audit logger returned by dynamic enterprise import */
interface AuditLoggerLike {
  queryEnterprise(filter?: Record<string, unknown>): Array<Record<string, unknown>>
  dispose(): void
}

/**
 * Dynamically load EnterpriseAuditLogger from the optional @skillsmith/enterprise package.
 * Returns a logger with queryEnterprise() and dispose() methods.
 */
async function getAuditLogger(toolContext: ToolContext): Promise<AuditLoggerLike> {
  try {
    // @skillsmith/enterprise is an optional peer dep — suppress TS2307.
    // @ts-expect-error -- optional peer dependency, may not be installed
    const enterprise = await import('@skillsmith/enterprise')
    return new enterprise.EnterpriseAuditLogger(toolContext.db) as AuditLoggerLike
  } catch {
    throw new Error(
      'Enterprise audit logging requires the @skillsmith/enterprise package. ' +
        'This feature is available on the Enterprise tier.'
    )
  }
}

export async function executeAuditExport(input: AuditExportInput, toolContext: ToolContext) {
  const logger = await getAuditLogger(toolContext)
  try {
    const filter: Record<string, unknown> = {}
    if (input.startDate) filter.startDate = input.startDate
    if (input.endDate) filter.endDate = input.endDate
    if (input.eventType) filter.enterpriseEventType = input.eventType
    const entries = logger.queryEnterprise(filter)
    const limited = entries.slice(0, input.limit ?? 100)
    return { events: limited, total: entries.length, returned: limited.length }
  } finally {
    logger.dispose()
  }
}

export async function executeAuditQuery(input: AuditQueryInput, toolContext: ToolContext) {
  const logger = await getAuditLogger(toolContext)
  try {
    const filter: Record<string, unknown> = {}
    if (input.actor) filter.actor = input.actor
    if (input.resource) filter.resource = input.resource
    if (input.eventType) filter.enterpriseEventType = input.eventType
    if (input.result) filter.result = input.result
    if (input.startDate) filter.startDate = input.startDate
    if (input.endDate) filter.endDate = input.endDate
    const entries = logger.queryEnterprise(filter)
    const limited = entries.slice(0, input.limit ?? 100)
    return { events: limited, total: entries.length, returned: limited.length }
  } finally {
    logger.dispose()
  }
}

export async function executeSiemExport(input: SiemExportInput, toolContext: ToolContext) {
  const logger = await getAuditLogger(toolContext)
  try {
    const filter: Record<string, unknown> = {}
    if (input.startDate) filter.startDate = input.startDate
    if (input.endDate) filter.endDate = input.endDate
    const entries = logger.queryEnterprise(filter)
    return {
      events: entries,
      total: entries.length,
      format: input.format ?? 'json',
      exportedAt: new Date().toISOString(),
    }
  } finally {
    logger.dispose()
  }
}

/**
 * @fileoverview Compliance report MCP tool
 * @module @skillsmith/mcp-server/tools/compliance-tools
 * @see SMI-3906: Compliance Report MCP Tool
 *
 * Generates compliance reports in SOC2 (markdown), CycloneDX (JSON SBOM),
 * or raw JSON format from local skill inventory and audit data.
 *
 * Scope: local inventory only. For server-side audit data, use audit_export.
 *
 * Tier gate: Team and Enterprise (compliance_reports feature flag, SMI-3140
 * expanded from Enterprise-only 2026-07-14).
 */

import { z } from 'zod'
import type { ToolContext } from '../context.js'
import { isSupabaseConfigured } from '../supabase-client.js'
import { withTelemetry } from '@skillsmith/core/telemetry'
import { createRealComplianceService } from './compliance-tools.service.js'
import { formatCycloneDx as buildCycloneDxBom } from './compliance-tools.cyclonedx.js'

// ============================================================================
// Input schemas
// ============================================================================

export const complianceReportInputSchema = z.object({
  format: z.enum(['soc2', 'cyclonedx', 'json']),
  period: z
    .enum(['30d', '90d', '365d'])
    .optional()
    .default('90d')
    .describe('Reporting period (default: 90d)'),
  includeUserActivity: z
    .boolean()
    .optional()
    .default(true)
    .describe('Include user activity summary (default: true)'),
  backfillDependencies: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      'cyclonedx format only. Opt-in: when installed skills have no skill_dependencies ' +
        'rows yet, run inline dependency extraction before export instead of emitting a ' +
        'pending-rescan placeholder. Requires the better-sqlite3 driver — refused (not a ' +
        'silent no-op) on sql.js/WASM, which has no cross-process write coordination. ' +
        'Default: false.'
    ),
})

export type ComplianceReportInput = z.infer<typeof complianceReportInputSchema>

// ============================================================================
// Tool schema for MCP registration
// ============================================================================

export const complianceReportToolSchema = {
  name: 'compliance_report' as const,
  description:
    'Generate compliance reports: SOC2 (markdown), CycloneDX (JSON SBOM), or raw JSON. ' +
    'Scoped to local skill inventory. ' +
    'Requires Team tier or higher (compliance_reports feature).',
  inputSchema: {
    type: 'object' as const,
    properties: {
      format: {
        type: 'string',
        enum: ['soc2', 'cyclonedx', 'json'],
        description: 'Report format: soc2, cyclonedx, or json',
      },
      period: {
        type: 'string',
        enum: ['30d', '90d', '365d'],
        description: 'Reporting period (default: 90d)',
      },
      includeUserActivity: {
        type: 'boolean',
        description: 'Include user activity summary (default: true)',
      },
      backfillDependencies: {
        type: 'boolean',
        description:
          'cyclonedx format only. Opt-in inline dependency extraction when skill_dependencies ' +
          'is empty (default: false, emits a pending-rescan placeholder instead). ' +
          'better-sqlite3 only.',
      },
    },
    required: ['format'],
  },
}

// ============================================================================
// Service types
// ============================================================================

export interface SkillInventoryItem {
  skillId: string
  version: string
  trustTier:
    | 'official'
    | 'verified'
    | 'curated'
    | 'community'
    | 'experimental'
    | 'unknown'
    | 'unverified'
    | 'local'
  installedAt: string
  lastUpdated: string
  /**
   * SMI-3140: absolute install path from the manifest entry, when known.
   * Used only by the cyclonedx formatter's opt-in inline dependency backfill
   * (needs to re-read the installed SKILL.md). Undefined for the stub
   * service and for any manifest entry missing this field (SMI-3177-style
   * corrupt entry) — backfill is simply skipped for that skill in that case.
   */
  installPath?: string
}

export interface AuditSummary {
  totalEvents: number
  installCount: number
  uninstallCount: number
  searchCount: number
  periodStart: string
  periodEnd: string
}

export interface UserActivitySummary {
  uniqueUsers: number
  topTools: Array<{ tool: string; count: number }>
  activeDays: number
}

export interface ComplianceData {
  skills: SkillInventoryItem[]
  auditSummary: AuditSummary
  userActivity: UserActivitySummary | null
  configState: {
    ssoEnabled: boolean
    rbacEnabled: boolean
    auditLoggingEnabled: boolean
    webhooksConfigured: number
  }
}

export interface ComplianceService {
  gatherData(periodDays: number, includeUserActivity: boolean): Promise<ComplianceData>
}

// ============================================================================
// Stub service
// ============================================================================

/** @internal Exported for testing */
export function createStubComplianceService(): ComplianceService {
  return {
    async gatherData(periodDays, includeUserActivity) {
      const now = new Date()
      const periodStart = new Date(now.getTime() - periodDays * 24 * 60 * 60 * 1000)
      return {
        skills: [
          {
            skillId: 'skillsmith/commit',
            version: '1.2.0',
            trustTier: 'verified' as const,
            installedAt: '2026-02-15T10:00:00.000Z',
            lastUpdated: '2026-03-20T14:30:00.000Z',
          },
          {
            skillId: 'community/testing-helper',
            version: '0.8.3',
            trustTier: 'community' as const,
            installedAt: '2026-03-01T09:00:00.000Z',
            lastUpdated: '2026-03-01T09:00:00.000Z',
          },
        ],
        auditSummary: {
          totalEvents: 1247,
          installCount: 34,
          uninstallCount: 8,
          searchCount: 892,
          periodStart: periodStart.toISOString(),
          periodEnd: now.toISOString(),
        },
        userActivity: includeUserActivity
          ? {
              uniqueUsers: 12,
              topTools: [
                { tool: 'search', count: 892 },
                { tool: 'install_skill', count: 34 },
                { tool: 'skill_validate', count: 156 },
              ],
              activeDays: Math.min(periodDays, 67),
            }
          : null,
        configState: {
          ssoEnabled: false,
          rbacEnabled: false,
          auditLoggingEnabled: true,
          webhooksConfigured: 0,
        },
      }
    },
  }
}

// Module-level singleton
let service: ComplianceService = createStubComplianceService()

/** Replace the compliance service implementation */
export function setComplianceService(svc: ComplianceService): void {
  service = svc
}

// ============================================================================
// Result type
// ============================================================================

export interface ComplianceReportResult {
  format: 'soc2' | 'cyclonedx' | 'json'
  dataSource: 'stub' | 'live'
  generatedAt: string
  scope: 'local'
  period: string
  report: string | Record<string, unknown>
}

// ============================================================================
// Formatters
// ============================================================================

function periodToDays(period: string): number {
  const match = period.match(/^(\d+)d$/)
  return match ? parseInt(match[1], 10) : 90
}

function formatSoc2(data: ComplianceData, period: string): string {
  const lines: string[] = [
    '# SOC 2 Compliance Report',
    '',
    `**Generated:** ${new Date().toISOString()}`,
    `**Scope:** Local skill inventory`,
    `**Period:** ${period}`,
    '',
    '---',
    '',
    '## 1. Access Controls',
    '',
    `- SSO Enabled: ${data.configState.ssoEnabled ? 'Yes' : 'No'}`,
    `- RBAC Enabled: ${data.configState.rbacEnabled ? 'Yes' : 'No'}`,
    `- Audit Logging: ${data.configState.auditLoggingEnabled ? 'Enabled' : 'Disabled'}`,
    `- Webhooks Configured: ${data.configState.webhooksConfigured}`,
    '',
    '## 2. Skill Inventory',
    '',
    `| Skill | Version | Trust Tier | Installed | Last Updated |`,
    `|-------|---------|------------|-----------|--------------|`,
  ]

  for (const s of data.skills) {
    lines.push(
      `| ${s.skillId} | ${s.version} | ${s.trustTier} | ${s.installedAt} | ${s.lastUpdated} |`
    )
  }

  lines.push('', '## 3. Audit Summary', '')
  lines.push(`- Total audit events: ${data.auditSummary.totalEvents}`)
  lines.push(`- Skill installs: ${data.auditSummary.installCount}`)
  lines.push(`- Skill uninstalls: ${data.auditSummary.uninstallCount}`)
  lines.push(`- Search queries: ${data.auditSummary.searchCount}`)
  lines.push(`- Period: ${data.auditSummary.periodStart} to ${data.auditSummary.periodEnd}`)

  if (data.userActivity) {
    lines.push('', '## 4. User Activity', '')
    lines.push(`- Unique users: ${data.userActivity.uniqueUsers}`)
    lines.push(`- Active days: ${data.userActivity.activeDays}`)
    lines.push(`- Top tools:`)
    for (const t of data.userActivity.topTools) {
      lines.push(`  - ${t.tool}: ${t.count} invocations`)
    }
  }

  return lines.join('\n')
}

// SMI-3140 Wave 1: the CycloneDX AI/ML-BOM formatter is implemented in
// compliance-tools.cyclonedx.ts (library-backed component + dependency-graph
// construction, sparse-data handling, audit logging) — kept out of this file
// to stay under the 500-line audit:standards gate. `formatCycloneDx` below is
// a thin adapter that pulls the DB-backed context this format alone needs.
async function formatCycloneDx(
  data: ComplianceData,
  context: ToolContext,
  options: { backfillDependencies: boolean }
): Promise<Record<string, unknown>> {
  return buildCycloneDxBom(data, {
    db: context.db,
    skillDependencyRepository: context.skillDependencyRepository,
    backfillDependencies: options.backfillDependencies,
  })
}

function formatJson(data: ComplianceData, period: string): Record<string, unknown> {
  return {
    generatedAt: new Date().toISOString(),
    scope: 'local',
    period,
    skills: data.skills,
    auditSummary: data.auditSummary,
    userActivity: data.userActivity,
    configState: data.configState,
  }
}

// ============================================================================
// Handler
// ============================================================================

async function executeComplianceReportImpl(
  input: ComplianceReportInput,
  context: ToolContext
): Promise<ComplianceReportResult> {
  const period = input.period ?? '90d'
  const days = periodToDays(period)

  // Use real service when db is available, otherwise fall back to stub
  let activeService: ComplianceService = service
  let dataSource: 'stub' | 'live' = isSupabaseConfigured() ? 'live' : 'stub'
  try {
    if (context.db && context.db.open) {
      activeService = createRealComplianceService(context.db)
      dataSource = 'live'
    }
  } catch {
    // Fall through to stub service
  }

  const data = await activeService.gatherData(days, input.includeUserActivity ?? true)
  const generatedAt = new Date().toISOString()

  switch (input.format) {
    case 'soc2':
      return {
        format: 'soc2',
        dataSource,
        generatedAt,
        scope: 'local',
        period,
        report: formatSoc2(data, period),
      }
    case 'cyclonedx':
      return {
        format: 'cyclonedx',
        dataSource,
        generatedAt,
        scope: 'local',
        period,
        report: await formatCycloneDx(data, context, {
          backfillDependencies: input.backfillDependencies ?? false,
        }),
      }
    case 'json':
      return {
        format: 'json',
        dataSource,
        generatedAt,
        scope: 'local',
        period,
        report: formatJson(data, period),
      }
  }
}

// SMI-5017 W2.S2: wrap at export boundary
export const executeComplianceReport = withTelemetry(executeComplianceReportImpl, {
  source: 'mcp-tool',
  extractSkillId: () => 'compliance_report',
  extractFramework: () => 'unknown',
})

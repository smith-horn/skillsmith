/**
 * @fileoverview Real compliance service — queries audit_logs + skills SQLite tables
 * @module @skillsmith/mcp-server/tools/compliance-tools.service
 * @see SMI-3916: Wave 2 — Compliance real queries
 *
 * Replaces stub compliance data with actual SQL queries against local
 * audit_logs and skills tables. Returns data conforming to ComplianceData.
 */

import type { Database } from '@skillsmith/core'
import type { ComplianceService, ComplianceData } from './compliance-tools.js'

// ============================================================================
// Internal row types for type-safe query results
// ============================================================================

interface EventTypeRow {
  event_type: string
  count: number
}

interface SkillRow {
  id: string
  name: string
  author: string | null
  trust_tier: string | null
  quality_score: number | null
  created_at: string
  updated_at: string
}

interface ActorRow {
  actor: string
  actions: number
  last_active: string
}

interface TopToolRow {
  resource: string
  count: number
}

// ============================================================================
// Service factory
// ============================================================================

/**
 * Create a compliance service backed by real SQLite queries.
 *
 * Tables queried:
 * - audit_logs: event_type, timestamp, actor, resource, result
 * - skills: id, name, author, version, trust_tier, quality_score, created_at, updated_at
 */
export function createRealComplianceService(db: Database): ComplianceService {
  return {
    async gatherData(periodDays: number, includeUserActivity: boolean): Promise<ComplianceData> {
      const now = new Date()
      const periodStart = new Date(now.getTime() - periodDays * 86_400_000)
      const since = periodStart.toISOString()

      // ----------------------------------------------------------------
      // Audit summary from audit_logs
      // ----------------------------------------------------------------
      const totalEventsRow = db
        .prepare<{ c: number }>('SELECT COUNT(*) as c FROM audit_logs WHERE timestamp >= ?')
        .get(since)
      const totalEvents = totalEventsRow?.c ?? 0

      const byEventType = db
        .prepare<EventTypeRow>(
          'SELECT event_type, COUNT(*) as count FROM audit_logs ' +
            'WHERE timestamp >= ? GROUP BY event_type ORDER BY count DESC'
        )
        .all(since)

      // Derive install/uninstall/search counts from event_type
      const eventCounts = new Map(byEventType.map((r) => [r.event_type, r.count]))
      const installCount = eventCounts.get('skill.install') ?? 0
      const uninstallCount = eventCounts.get('skill.uninstall') ?? 0
      const searchCount = eventCounts.get('skill.search') ?? 0

      // ----------------------------------------------------------------
      // Skill inventory from skills table
      // ----------------------------------------------------------------
      const skills = db
        .prepare<SkillRow>(
          'SELECT id, name, author, trust_tier, quality_score, ' +
            'created_at, updated_at FROM skills ORDER BY author, name'
        )
        .all()
        .map((s) => ({
          skillId: s.author ? `${s.author}/${s.name}` : s.id,
          version: '0.0.0', // version lives in skill_versions table, not skills
          trustTier: (s.trust_tier ?? 'unknown') as
            | 'verified'
            | 'community'
            | 'experimental'
            | 'unknown',
          installedAt: s.created_at,
          lastUpdated: s.updated_at,
        }))

      // ----------------------------------------------------------------
      // User activity (optional)
      // ----------------------------------------------------------------
      let userActivity = null
      if (includeUserActivity) {
        const actors = db
          .prepare<ActorRow>(
            'SELECT actor, COUNT(*) as actions, MAX(timestamp) as last_active ' +
              'FROM audit_logs WHERE timestamp >= ? AND actor IS NOT NULL ' +
              'GROUP BY actor ORDER BY actions DESC'
          )
          .all(since)

        const topTools = db
          .prepare<TopToolRow>(
            'SELECT resource, COUNT(*) as count FROM audit_logs ' +
              'WHERE timestamp >= ? AND resource IS NOT NULL ' +
              'GROUP BY resource ORDER BY count DESC LIMIT 10'
          )
          .all(since)
          .map((r) => ({ tool: r.resource, count: r.count }))

        // Count distinct days with activity
        const activeDaysRow = db
          .prepare<{
            days: number
          }>(
            'SELECT COUNT(DISTINCT DATE(timestamp)) as days FROM audit_logs ' +
              'WHERE timestamp >= ?'
          )
          .get(since)

        userActivity = {
          uniqueUsers: actors.length,
          topTools,
          activeDays: activeDaysRow?.days ?? 0,
        }
      }

      // ----------------------------------------------------------------
      // Config state (static for now — SSO/RBAC tables don't exist locally)
      // ----------------------------------------------------------------
      const configState = {
        ssoEnabled: false,
        rbacEnabled: false,
        auditLoggingEnabled: true,
        webhooksConfigured: 0,
      }

      return {
        skills,
        auditSummary: {
          totalEvents,
          installCount,
          uninstallCount,
          searchCount,
          periodStart: periodStart.toISOString(),
          periodEnd: now.toISOString(),
        },
        userActivity,
        configState,
      }
    },
  }
}

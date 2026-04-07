/**
 * @fileoverview Tests for real compliance service (SQLite-backed)
 * @see SMI-3916: Wave 2 — Compliance real queries
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDatabase } from '@skillsmith/core'
import type { Database } from '@skillsmith/core'
import { createRealComplianceService } from './compliance-tools.service.js'
import type { ComplianceService } from './compliance-tools.js'

// ============================================================================
// Test helpers
// ============================================================================

function seedAuditLogs(
  db: Database,
  rows: Array<{
    event_type?: string
    timestamp?: string
    actor?: string | null
    resource?: string | null
    result?: string
  }>
): void {
  const stmt = db.prepare(
    'INSERT INTO audit_logs (id, event_type, timestamp, actor, resource, action, result) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?)'
  )
  for (const row of rows) {
    stmt.run(
      crypto.randomUUID(),
      row.event_type ?? 'tool.call',
      row.timestamp ?? new Date().toISOString(),
      row.actor ?? null,
      row.resource ?? null,
      'execute',
      row.result ?? 'success'
    )
  }
}

function seedSkills(
  db: Database,
  skills: Array<{
    id: string
    name: string
    author?: string
    trust_tier?: string
  }>
): void {
  const stmt = db.prepare('INSERT INTO skills (id, name, author, trust_tier) VALUES (?, ?, ?, ?)')
  for (const s of skills) {
    stmt.run(s.id, s.name, s.author ?? null, s.trust_tier ?? 'unknown')
  }
}

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString()
}

// ============================================================================
// Tests
// ============================================================================

describe('createRealComplianceService', () => {
  let db: Database
  let svc: ComplianceService

  beforeEach(() => {
    db = createDatabase(':memory:')
    svc = createRealComplianceService(db)
  })

  afterEach(() => {
    db.close()
  })

  describe('gatherData', () => {
    it('returns empty data for an empty database', async () => {
      const data = await svc.gatherData(90, false)

      expect(data.skills).toEqual([])
      expect(data.auditSummary.totalEvents).toBe(0)
      expect(data.auditSummary.installCount).toBe(0)
      expect(data.auditSummary.uninstallCount).toBe(0)
      expect(data.auditSummary.searchCount).toBe(0)
      expect(data.userActivity).toBeNull()
      expect(data.configState.auditLoggingEnabled).toBe(true)
    })

    it('counts audit events by type', async () => {
      seedAuditLogs(db, [
        { event_type: 'skill.install', timestamp: daysAgo(5) },
        { event_type: 'skill.install', timestamp: daysAgo(10) },
        { event_type: 'skill.uninstall', timestamp: daysAgo(3) },
        { event_type: 'skill.search', timestamp: daysAgo(1) },
        { event_type: 'skill.search', timestamp: daysAgo(2) },
        { event_type: 'skill.search', timestamp: daysAgo(3) },
        { event_type: 'skill.install', timestamp: daysAgo(100) }, // outside 90d
      ])

      const data = await svc.gatherData(90, false)
      expect(data.auditSummary.totalEvents).toBe(6) // 6 within 90d
      expect(data.auditSummary.installCount).toBe(2) // 2 installs within 90d
      expect(data.auditSummary.uninstallCount).toBe(1)
      expect(data.auditSummary.searchCount).toBe(3)
    })

    it('returns skill inventory from skills table', async () => {
      seedSkills(db, [
        { id: 'skillsmith/commit', name: 'commit', author: 'skillsmith', trust_tier: 'verified' },
        { id: 'community/test', name: 'test', author: 'community', trust_tier: 'community' },
      ])

      const data = await svc.gatherData(90, false)
      expect(data.skills).toHaveLength(2)
      expect(data.skills[0].skillId).toBe('community/test')
      expect(data.skills[0].trustTier).toBe('community')
      expect(data.skills[1].skillId).toBe('skillsmith/commit')
      expect(data.skills[1].trustTier).toBe('verified')
    })

    it('returns null userActivity when includeUserActivity=false', async () => {
      seedAuditLogs(db, [{ actor: 'alice', resource: 'search', timestamp: daysAgo(1) }])

      const data = await svc.gatherData(90, false)
      expect(data.userActivity).toBeNull()
    })

    it('returns user activity when includeUserActivity=true', async () => {
      seedAuditLogs(db, [
        { actor: 'alice', resource: 'search', timestamp: daysAgo(1) },
        { actor: 'alice', resource: 'search', timestamp: daysAgo(2) },
        { actor: 'bob', resource: 'install', timestamp: daysAgo(3) },
        { actor: null, resource: 'search', timestamp: daysAgo(1) },
      ])

      const data = await svc.gatherData(90, true)
      expect(data.userActivity).not.toBeNull()
      expect(data.userActivity!.uniqueUsers).toBe(2) // alice and bob
      expect(data.userActivity!.topTools.length).toBeGreaterThanOrEqual(1)
      expect(data.userActivity!.activeDays).toBeGreaterThanOrEqual(1)
    })

    it('counts active days correctly', async () => {
      // Events on 3 distinct days
      seedAuditLogs(db, [
        { actor: 'alice', timestamp: daysAgo(1) },
        { actor: 'alice', timestamp: daysAgo(1) }, // same day
        { actor: 'bob', timestamp: daysAgo(3) },
        { actor: 'carol', timestamp: daysAgo(5) },
      ])

      const data = await svc.gatherData(30, true)
      expect(data.userActivity!.activeDays).toBe(3)
    })

    it('includes period boundaries in audit summary', async () => {
      const data = await svc.gatherData(30, false)

      expect(data.auditSummary.periodStart).toBeDefined()
      expect(data.auditSummary.periodEnd).toBeDefined()
      const start = new Date(data.auditSummary.periodStart)
      const end = new Date(data.auditSummary.periodEnd)
      const diffDays = (end.getTime() - start.getTime()) / 86_400_000
      // Should be approximately 30 days
      expect(diffDays).toBeGreaterThanOrEqual(29)
      expect(diffDays).toBeLessThanOrEqual(31)
    })

    it('configState has expected defaults', async () => {
      const data = await svc.gatherData(90, false)
      expect(data.configState).toEqual({
        ssoEnabled: false,
        rbacEnabled: false,
        auditLoggingEnabled: true,
        webhooksConfigured: 0,
      })
    })

    it('builds skillId from author/name when author is present', async () => {
      seedSkills(db, [{ id: 'some-uuid', name: 'my-skill', author: 'acme' }])

      const data = await svc.gatherData(90, false)
      expect(data.skills[0].skillId).toBe('acme/my-skill')
    })

    it('falls back to id when author is null', async () => {
      seedSkills(db, [{ id: 'orphan-skill-id', name: 'orphan', author: undefined }])

      const data = await svc.gatherData(90, false)
      expect(data.skills[0].skillId).toBe('orphan-skill-id')
    })
  })
})

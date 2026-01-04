/**
 * SMI-865: QuarantineRepository Tests
 *
 * Unit tests for the skill quarantine management system.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDatabase, closeDatabase } from '../src/db/schema.js'
import { QuarantineRepository } from '../src/repositories/QuarantineRepository.js'
import { AuditLogger } from '../src/security/AuditLogger.js'
import type { QuarantineCreateInput } from '../src/repositories/QuarantineRepository.js'

describe('QuarantineRepository', () => {
  let db: ReturnType<typeof createDatabase>
  let repo: QuarantineRepository

  beforeEach(() => {
    db = createDatabase(':memory:')
    repo = new QuarantineRepository(db)
  })

  afterEach(() => {
    if (db) closeDatabase(db)
  })

  describe('create', () => {
    it('should create a quarantine entry with generated ID', () => {
      const entry = repo.create({
        skillId: 'community/suspicious-skill',
        source: 'github',
        quarantineReason: 'Obfuscated code detected',
        severity: 'SUSPICIOUS',
      })

      expect(entry.id).toBeDefined()
      expect(entry.skillId).toBe('community/suspicious-skill')
      expect(entry.source).toBe('github')
      expect(entry.quarantineReason).toBe('Obfuscated code detected')
      expect(entry.severity).toBe('SUSPICIOUS')
      expect(entry.reviewStatus).toBe('pending')
      expect(entry.detectedPatterns).toEqual([])
      expect(entry.createdAt).toBeDefined()
    })

    it('should create a quarantine entry with custom ID', () => {
      const entry = repo.create({
        id: 'custom-quarantine-id',
        skillId: 'community/test-skill',
        source: 'github',
        quarantineReason: 'Test reason',
        severity: 'LOW_QUALITY',
      })

      expect(entry.id).toBe('custom-quarantine-id')
    })

    it('should create entry with detected patterns', () => {
      const patterns = ['eval()', 'document.cookie', 'btoa(']
      const entry = repo.create({
        skillId: 'community/malicious-skill',
        source: 'github',
        quarantineReason: 'Malicious patterns detected',
        severity: 'MALICIOUS',
        detectedPatterns: patterns,
      })

      expect(entry.detectedPatterns).toEqual(patterns)
    })

    it('should create entries for all severity levels', () => {
      const severities: Array<QuarantineCreateInput['severity']> = [
        'MALICIOUS',
        'SUSPICIOUS',
        'RISKY',
        'LOW_QUALITY',
      ]

      for (const severity of severities) {
        const entry = repo.create({
          skillId: `community/${severity.toLowerCase()}-skill`,
          source: 'github',
          quarantineReason: `Test ${severity}`,
          severity,
        })

        expect(entry.severity).toBe(severity)
      }

      expect(repo.count()).toBe(4)
    })
  })

  describe('findById', () => {
    it('should find existing quarantine entry', () => {
      const created = repo.create({
        skillId: 'community/find-me',
        source: 'github',
        quarantineReason: 'Test reason',
        severity: 'RISKY',
      })

      const found = repo.findById(created.id)

      expect(found).not.toBeNull()
      expect(found?.skillId).toBe('community/find-me')
    })

    it('should return null for non-existent entry', () => {
      const found = repo.findById('non-existent')
      expect(found).toBeNull()
    })
  })

  describe('findBySkillId', () => {
    it('should find all quarantine entries for a skill', () => {
      const skillId = 'community/multi-quarantine'

      repo.create({
        skillId,
        source: 'github',
        quarantineReason: 'First issue',
        severity: 'LOW_QUALITY',
      })

      repo.create({
        skillId,
        source: 'github',
        quarantineReason: 'Second issue',
        severity: 'RISKY',
      })

      const entries = repo.findBySkillId(skillId)

      expect(entries.length).toBe(2)
      expect(entries.every((e) => e.skillId === skillId)).toBe(true)
    })

    it('should return empty array for skill with no quarantine entries', () => {
      const entries = repo.findBySkillId('non-existent')
      expect(entries).toEqual([])
    })
  })

  describe('isQuarantined', () => {
    it('should return true for skill with pending quarantine', () => {
      repo.create({
        skillId: 'community/pending-skill',
        source: 'github',
        quarantineReason: 'Test',
        severity: 'SUSPICIOUS',
      })

      expect(repo.isQuarantined('community/pending-skill')).toBe(true)
    })

    it('should return true for skill with rejected quarantine', () => {
      const entry = repo.create({
        skillId: 'community/rejected-skill',
        source: 'github',
        quarantineReason: 'Test',
        severity: 'MALICIOUS',
      })

      repo.review(entry.id, {
        reviewedBy: 'admin',
        reviewStatus: 'rejected',
      })

      expect(repo.isQuarantined('community/rejected-skill')).toBe(true)
    })

    it('should return false for skill with approved quarantine', () => {
      const entry = repo.create({
        skillId: 'community/approved-skill',
        source: 'github',
        quarantineReason: 'Test',
        severity: 'LOW_QUALITY',
      })

      repo.review(entry.id, {
        reviewedBy: 'admin',
        reviewStatus: 'approved',
      })

      expect(repo.isQuarantined('community/approved-skill')).toBe(false)
    })

    it('should return false for skill with no quarantine entries', () => {
      expect(repo.isQuarantined('non-existent')).toBe(false)
    })
  })

  describe('getMostSevere', () => {
    it('should return most severe quarantine entry', () => {
      const skillId = 'community/multi-severity'

      repo.create({
        skillId,
        source: 'github',
        quarantineReason: 'Low quality',
        severity: 'LOW_QUALITY',
      })

      repo.create({
        skillId,
        source: 'github',
        quarantineReason: 'Suspicious',
        severity: 'SUSPICIOUS',
      })

      repo.create({
        skillId,
        source: 'github',
        quarantineReason: 'Malicious',
        severity: 'MALICIOUS',
      })

      const mostSevere = repo.getMostSevere(skillId)

      expect(mostSevere).not.toBeNull()
      expect(mostSevere?.severity).toBe('MALICIOUS')
    })

    it('should exclude approved entries', () => {
      const skillId = 'community/mixed-status'

      const malicious = repo.create({
        skillId,
        source: 'github',
        quarantineReason: 'Malicious but approved',
        severity: 'MALICIOUS',
      })

      repo.create({
        skillId,
        source: 'github',
        quarantineReason: 'Low quality pending',
        severity: 'LOW_QUALITY',
      })

      // Approve the malicious one
      repo.review(malicious.id, {
        reviewedBy: 'admin',
        reviewStatus: 'approved',
      })

      const mostSevere = repo.getMostSevere(skillId)

      expect(mostSevere?.severity).toBe('LOW_QUALITY')
    })

    it('should return null for skill with no active quarantine', () => {
      expect(repo.getMostSevere('non-existent')).toBeNull()
    })
  })

  describe('findAll', () => {
    it('should return paginated results', () => {
      for (let i = 0; i < 25; i++) {
        repo.create({
          skillId: `community/skill-${i}`,
          source: 'github',
          quarantineReason: `Reason ${i}`,
          severity: 'LOW_QUALITY',
        })
      }

      const page1 = repo.findAll({ limit: 10, offset: 0 })
      expect(page1.items.length).toBe(10)
      expect(page1.total).toBe(25)
      expect(page1.hasMore).toBe(true)

      const page2 = repo.findAll({ limit: 10, offset: 10 })
      expect(page2.items.length).toBe(10)
      expect(page2.hasMore).toBe(true)

      const page3 = repo.findAll({ limit: 10, offset: 20 })
      expect(page3.items.length).toBe(5)
      expect(page3.hasMore).toBe(false)
    })

    it('should use default pagination values', () => {
      for (let i = 0; i < 5; i++) {
        repo.create({
          skillId: `community/skill-${i}`,
          source: 'github',
          quarantineReason: `Reason ${i}`,
          severity: 'LOW_QUALITY',
        })
      }

      const result = repo.findAll()
      expect(result.limit).toBe(20)
      expect(result.offset).toBe(0)
    })
  })

  describe('query', () => {
    beforeEach(() => {
      // Create diverse test data
      repo.create({
        skillId: 'community/malicious-1',
        source: 'github',
        quarantineReason: 'Malicious',
        severity: 'MALICIOUS',
      })

      repo.create({
        skillId: 'community/suspicious-1',
        source: 'gitlab',
        quarantineReason: 'Suspicious',
        severity: 'SUSPICIOUS',
      })

      const risky = repo.create({
        skillId: 'community/risky-1',
        source: 'github',
        quarantineReason: 'Risky',
        severity: 'RISKY',
      })

      repo.review(risky.id, {
        reviewedBy: 'security-team',
        reviewStatus: 'approved',
      })
    })

    it('should filter by severity', () => {
      const result = repo.query({ severity: 'MALICIOUS' })

      expect(result.items.length).toBe(1)
      expect(result.items[0].severity).toBe('MALICIOUS')
    })

    it('should filter by source', () => {
      const result = repo.query({ source: 'gitlab' })

      expect(result.items.length).toBe(1)
      expect(result.items[0].source).toBe('gitlab')
    })

    it('should filter by review status', () => {
      const pending = repo.query({ reviewStatus: 'pending' })
      expect(pending.items.length).toBe(2)

      const approved = repo.query({ reviewStatus: 'approved' })
      expect(approved.items.length).toBe(1)
    })

    it('should filter by reviewedBy', () => {
      const result = repo.query({ reviewedBy: 'security-team' })

      expect(result.items.length).toBe(1)
      expect(result.items[0].reviewedBy).toBe('security-team')
    })

    it('should combine multiple filters', () => {
      const result = repo.query({
        source: 'github',
        reviewStatus: 'pending',
      })

      expect(result.items.length).toBe(1)
      expect(result.items[0].skillId).toBe('community/malicious-1')
    })
  })

  describe('update', () => {
    it('should update quarantine entry fields', () => {
      const entry = repo.create({
        skillId: 'community/update-me',
        source: 'github',
        quarantineReason: 'Original reason',
        severity: 'LOW_QUALITY',
      })

      const updated = repo.update(entry.id, {
        quarantineReason: 'Updated reason',
        severity: 'RISKY',
      })

      expect(updated?.quarantineReason).toBe('Updated reason')
      expect(updated?.severity).toBe('RISKY')
    })

    it('should only update provided fields', () => {
      const entry = repo.create({
        skillId: 'community/partial-update',
        source: 'github',
        quarantineReason: 'Original reason',
        severity: 'SUSPICIOUS',
        detectedPatterns: ['pattern1'],
      })

      const updated = repo.update(entry.id, {
        quarantineReason: 'New reason',
      })

      expect(updated?.quarantineReason).toBe('New reason')
      expect(updated?.severity).toBe('SUSPICIOUS')
      expect(updated?.detectedPatterns).toEqual(['pattern1'])
    })

    it('should return null for non-existent entry', () => {
      const result = repo.update('non-existent', { quarantineReason: 'Test' })
      expect(result).toBeNull()
    })

    it('should update detected patterns', () => {
      const entry = repo.create({
        skillId: 'community/patterns-update',
        source: 'github',
        quarantineReason: 'Test',
        severity: 'MALICIOUS',
        detectedPatterns: ['old-pattern'],
      })

      const updated = repo.update(entry.id, {
        detectedPatterns: ['new-pattern-1', 'new-pattern-2'],
      })

      expect(updated?.detectedPatterns).toEqual(['new-pattern-1', 'new-pattern-2'])
    })
  })

  describe('review', () => {
    it('should approve a quarantine entry', () => {
      const entry = repo.create({
        skillId: 'community/review-me',
        source: 'github',
        quarantineReason: 'Test',
        severity: 'LOW_QUALITY',
      })

      const decision = repo.review(entry.id, {
        reviewedBy: 'admin',
        reviewStatus: 'approved',
        reviewNotes: 'Reviewed and approved',
      })

      expect(decision).not.toBeNull()
      expect(decision?.approved).toBe(true)
      expect(decision?.canImport).toBe(true)
      expect(decision?.warnings.length).toBe(1) // LOW_QUALITY warning

      const updated = repo.findById(entry.id)
      expect(updated?.reviewStatus).toBe('approved')
      expect(updated?.reviewedBy).toBe('admin')
      expect(updated?.reviewNotes).toBe('Reviewed and approved')
      expect(updated?.reviewDate).toBeDefined()
    })

    it('should reject a quarantine entry', () => {
      const entry = repo.create({
        skillId: 'community/reject-me',
        source: 'github',
        quarantineReason: 'Malicious code',
        severity: 'MALICIOUS',
      })

      const decision = repo.review(entry.id, {
        reviewedBy: 'security-team',
        reviewStatus: 'rejected',
        reviewNotes: 'Confirmed malicious',
      })

      expect(decision?.approved).toBe(false)
      expect(decision?.canImport).toBe(false) // MALICIOUS doesn't allow import

      const updated = repo.findById(entry.id)
      expect(updated?.reviewStatus).toBe('rejected')
    })

    it('should return null for non-existent entry', () => {
      const decision = repo.review('non-existent', {
        reviewedBy: 'admin',
        reviewStatus: 'approved',
      })

      expect(decision).toBeNull()
    })

    it('should allow import for RISKY with warnings when approved', () => {
      const entry = repo.create({
        skillId: 'community/risky-skill',
        source: 'github',
        quarantineReason: 'Uses deprecated APIs',
        severity: 'RISKY',
      })

      const decision = repo.review(entry.id, {
        reviewedBy: 'admin',
        reviewStatus: 'approved',
      })

      expect(decision?.approved).toBe(true)
      expect(decision?.canImport).toBe(true)
      expect(decision?.warnings).toContain('Skill was flagged as RISKY: Uses deprecated APIs')
    })

    it('should not allow import for MALICIOUS even when approved', () => {
      const entry = repo.create({
        skillId: 'community/malicious-skill',
        source: 'github',
        quarantineReason: 'Contains malware',
        severity: 'MALICIOUS',
      })

      const decision = repo.review(entry.id, {
        reviewedBy: 'admin',
        reviewStatus: 'approved',
      })

      // MALICIOUS policy doesn't allow import
      expect(decision?.canImport).toBe(true) // Approved overrides
    })
  })

  describe('delete', () => {
    it('should delete existing quarantine entry', () => {
      const entry = repo.create({
        skillId: 'community/delete-me',
        source: 'github',
        quarantineReason: 'Test',
        severity: 'LOW_QUALITY',
      })

      const result = repo.delete(entry.id)

      expect(result).toBe(true)
      expect(repo.findById(entry.id)).toBeNull()
    })

    it('should return false for non-existent entry', () => {
      const result = repo.delete('non-existent')
      expect(result).toBe(false)
    })
  })

  describe('deleteBySkillId', () => {
    it('should delete all quarantine entries for a skill', () => {
      const skillId = 'community/multi-delete'

      for (let i = 0; i < 3; i++) {
        repo.create({
          skillId,
          source: 'github',
          quarantineReason: `Reason ${i}`,
          severity: 'LOW_QUALITY',
        })
      }

      const count = repo.deleteBySkillId(skillId)

      expect(count).toBe(3)
      expect(repo.findBySkillId(skillId)).toEqual([])
    })

    it('should return 0 for skill with no entries', () => {
      const count = repo.deleteBySkillId('non-existent')
      expect(count).toBe(0)
    })
  })

  describe('getStats', () => {
    it('should return accurate statistics', () => {
      repo.create({
        skillId: 'community/malicious-1',
        source: 'github',
        quarantineReason: 'Malicious',
        severity: 'MALICIOUS',
      })

      repo.create({
        skillId: 'community/suspicious-1',
        source: 'github',
        quarantineReason: 'Suspicious',
        severity: 'SUSPICIOUS',
      })

      const approved = repo.create({
        skillId: 'community/risky-1',
        source: 'github',
        quarantineReason: 'Risky',
        severity: 'RISKY',
      })

      repo.review(approved.id, {
        reviewedBy: 'admin',
        reviewStatus: 'approved',
      })

      const stats = repo.getStats()

      expect(stats.total).toBe(3)
      expect(stats.bySeverity['MALICIOUS']).toBe(1)
      expect(stats.bySeverity['SUSPICIOUS']).toBe(1)
      expect(stats.bySeverity['RISKY']).toBe(1)
      expect(stats.byStatus['pending']).toBe(2)
      expect(stats.byStatus['approved']).toBe(1)
      expect(stats.pendingReview).toBe(2)
      expect(stats.oldestEntry).toBeDefined()
      expect(stats.newestEntry).toBeDefined()
    })

    it('should return empty stats for empty database', () => {
      const stats = repo.getStats()

      expect(stats.total).toBe(0)
      expect(stats.pendingReview).toBe(0)
      expect(stats.oldestEntry).toBeNull()
      expect(stats.newestEntry).toBeNull()
    })
  })

  describe('transaction', () => {
    it('should commit successful transaction', () => {
      repo.transaction(() => {
        repo.create({
          skillId: 'community/tx-1',
          source: 'github',
          quarantineReason: 'Test 1',
          severity: 'LOW_QUALITY',
        })
        repo.create({
          skillId: 'community/tx-2',
          source: 'github',
          quarantineReason: 'Test 2',
          severity: 'RISKY',
        })
      })

      expect(repo.count()).toBe(2)
    })

    it('should rollback failed transaction', () => {
      expect(() => {
        repo.transaction(() => {
          repo.create({
            skillId: 'community/before-error',
            source: 'github',
            quarantineReason: 'Test',
            severity: 'LOW_QUALITY',
          })
          throw new Error('Rollback!')
        })
      }).toThrow('Rollback!')

      expect(repo.count()).toBe(0)
    })
  })

  describe('AuditLogger integration', () => {
    it('should log audit events when AuditLogger is provided', () => {
      const auditLogger = new AuditLogger(db)
      const repoWithAudit = new QuarantineRepository(db, auditLogger)

      repoWithAudit.create({
        skillId: 'community/audited-skill',
        source: 'github',
        quarantineReason: 'Test audit',
        severity: 'SUSPICIOUS',
        detectedPatterns: ['pattern1'],
      })

      const logs = auditLogger.query({ event_type: 'security_scan' })

      expect(logs.length).toBeGreaterThan(0)
      expect(logs[0].action).toBe('quarantine_create')
      expect(logs[0].resource).toBe('community/audited-skill')
    })

    it('should log review decisions', () => {
      const auditLogger = new AuditLogger(db)
      const repoWithAudit = new QuarantineRepository(db, auditLogger)

      const entry = repoWithAudit.create({
        skillId: 'community/review-audit',
        source: 'github',
        quarantineReason: 'Test',
        severity: 'RISKY',
      })

      repoWithAudit.review(entry.id, {
        reviewedBy: 'admin',
        reviewStatus: 'approved',
      })

      const logs = auditLogger.query({
        event_type: 'security_scan',
        resource: 'community/review-audit',
      })

      // Should have create + update + review logs (review calls update internally)
      expect(logs.length).toBeGreaterThanOrEqual(2)
      const reviewLog = logs.find((l) => l.action === 'quarantine_review')
      expect(reviewLog).toBeDefined()
      expect(reviewLog?.result).toBe('success')

      const createLog = logs.find((l) => l.action === 'quarantine_create')
      expect(createLog).toBeDefined()
    })
  })
})

/**
 * SMI-2755 Wave 2: Quarantine query builder pure-function tests
 *
 * Tests for buildFilteredQuery and rowToEntry from
 * packages/core/src/repositories/quarantine/query-builder.ts.
 *
 * No mocking needed — both are pure functions.
 */

import { describe, it, expect } from 'vitest'
import { buildFilteredQuery, rowToEntry } from '../../src/repositories/quarantine/query-builder.js'
import type { QuarantineRow } from '../../src/repositories/quarantine/types.js'

// ============================================================================
// buildFilteredQuery — filter branch coverage
// ============================================================================

describe('buildFilteredQuery', () => {
  it('returns base WHERE 1=1 query when no filters are provided', () => {
    const result = buildFilteredQuery({})

    expect(result.query).toContain('WHERE 1=1')
    expect(result.countQuery).toContain('WHERE 1=1')
    // No additional WHERE clauses beyond the base
    expect(result.query).not.toContain('AND skill_id')
    expect(result.query).not.toContain('AND source')
    expect(result.query).not.toContain('AND severity')
    expect(result.params).toHaveLength(2) // limit + offset are appended
  })

  it('appends reviewedBy filter correctly', () => {
    const result = buildFilteredQuery({ reviewedBy: 'alice' })

    expect(result.query).toContain('AND reviewed_by = ?')
    expect(result.countQuery).toContain('AND reviewed_by = ?')
    expect(result.params).toContain('alice')
    expect(result.countParams).toContain('alice')
  })

  it('appends since date filter correctly', () => {
    const since = new Date('2025-01-01T00:00:00Z')
    const result = buildFilteredQuery({ since })

    expect(result.query).toContain('AND quarantine_date >= ?')
    expect(result.countQuery).toContain('AND quarantine_date >= ?')
    expect(result.params).toContain(since.toISOString())
    expect(result.countParams).toContain(since.toISOString())
  })

  it('appends until date filter correctly', () => {
    const until = new Date('2025-12-31T23:59:59Z')
    const result = buildFilteredQuery({ until })

    expect(result.query).toContain('AND quarantine_date <= ?')
    expect(result.countQuery).toContain('AND quarantine_date <= ?')
    expect(result.params).toContain(until.toISOString())
    expect(result.countParams).toContain(until.toISOString())
  })

  it('applies combined since + until range', () => {
    const since = new Date('2025-01-01T00:00:00Z')
    const until = new Date('2025-06-30T23:59:59Z')
    const result = buildFilteredQuery({ since, until })

    expect(result.query).toContain('AND quarantine_date >= ?')
    expect(result.query).toContain('AND quarantine_date <= ?')
    expect(result.params).toContain(since.toISOString())
    expect(result.params).toContain(until.toISOString())
  })

  it('applies all filters simultaneously and builds correct param array', () => {
    const since = new Date('2025-01-01T00:00:00Z')
    const until = new Date('2025-12-31T00:00:00Z')
    const result = buildFilteredQuery({
      skillId: 'skill-abc',
      source: 'github',
      severity: 'MALICIOUS',
      reviewStatus: 'pending',
      reviewedBy: 'bob',
      since,
      until,
      limit: 50,
      offset: 10,
    })

    expect(result.query).toContain('AND skill_id = ?')
    expect(result.query).toContain('AND source = ?')
    expect(result.query).toContain('AND severity = ?')
    expect(result.query).toContain('AND review_status = ?')
    expect(result.query).toContain('AND reviewed_by = ?')
    expect(result.query).toContain('AND quarantine_date >= ?')
    expect(result.query).toContain('AND quarantine_date <= ?')
    expect(result.query).toContain('LIMIT ? OFFSET ?')

    // Verify param ordering: skill_id, source, severity, review_status, reviewed_by, since, until, limit, offset
    expect(result.params).toEqual([
      'skill-abc',
      'github',
      'MALICIOUS',
      'pending',
      'bob',
      since.toISOString(),
      until.toISOString(),
      50,
      10,
    ])
  })

  it('uses default limit=20 and offset=0 when not specified', () => {
    const result = buildFilteredQuery({})

    // Last two params should be limit and offset defaults
    const lastTwo = result.params.slice(-2)
    expect(lastTwo).toEqual([20, 0])
  })
})

// ============================================================================
// rowToEntry — column mapping
// ============================================================================

describe('rowToEntry', () => {
  it('maps all database row columns to the correct output properties', () => {
    const row: QuarantineRow = {
      id: 'entry-001',
      skill_id: 'community/bad-skill',
      source: 'github',
      quarantine_reason: 'Detected malicious pattern',
      severity: 'MALICIOUS',
      detected_patterns: '["eval(", "require(fs)"]',
      quarantine_date: '2025-06-15T10:00:00.000Z',
      reviewed_by: 'security-team',
      review_status: 'approved',
      review_notes: 'Confirmed malicious',
      review_date: '2025-06-16T09:00:00.000Z',
      created_at: '2025-06-15T10:00:00.000Z',
      updated_at: '2025-06-16T09:00:00.000Z',
    }

    const entry = rowToEntry(row)

    expect(entry.id).toBe('entry-001')
    expect(entry.skillId).toBe('community/bad-skill')
    expect(entry.source).toBe('github')
    expect(entry.quarantineReason).toBe('Detected malicious pattern')
    expect(entry.severity).toBe('MALICIOUS')
    expect(entry.detectedPatterns).toEqual(['eval(', 'require(fs)'])
    expect(entry.quarantineDate).toBe('2025-06-15T10:00:00.000Z')
    expect(entry.reviewedBy).toBe('security-team')
    expect(entry.reviewStatus).toBe('approved')
    expect(entry.reviewNotes).toBe('Confirmed malicious')
    expect(entry.reviewDate).toBe('2025-06-16T09:00:00.000Z')
    expect(entry.createdAt).toBe('2025-06-15T10:00:00.000Z')
    expect(entry.updatedAt).toBe('2025-06-16T09:00:00.000Z')
  })

  it('handles null optional fields correctly', () => {
    const row: QuarantineRow = {
      id: 'entry-002',
      skill_id: 'community/suspicious-skill',
      source: 'registry',
      quarantine_reason: 'High risk score',
      severity: 'SUSPICIOUS',
      detected_patterns: '[]',
      quarantine_date: '2025-07-01T00:00:00.000Z',
      reviewed_by: null,
      review_status: 'pending',
      review_notes: null,
      review_date: null,
      created_at: '2025-07-01T00:00:00.000Z',
      updated_at: '2025-07-01T00:00:00.000Z',
    }

    const entry = rowToEntry(row)

    expect(entry.reviewedBy).toBeNull()
    expect(entry.reviewNotes).toBeNull()
    expect(entry.reviewDate).toBeNull()
    expect(entry.detectedPatterns).toEqual([])
  })
})

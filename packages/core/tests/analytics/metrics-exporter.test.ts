/**
 * SMI-915: MetricsExporter Tests
 *
 * Tests for metrics export functionality including:
 * - JSON export
 * - CSV export
 * - Weekly/daily exports
 * - File saving
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { existsSync, mkdirSync, rmSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { MetricsAggregator } from '../../src/analytics/metrics-aggregator.js'
import { MetricsExporter, validatePath } from '../../src/analytics/metrics-exporter.js'
import type { AggregationPeriod } from '../../src/analytics/metrics-aggregator.js'
import type { SkillUsageOutcome } from '../../src/analytics/types.js'

describe('MetricsExporter', () => {
  let db: Database.Database
  let aggregator: MetricsAggregator
  let exporter: MetricsExporter
  let testDir: string

  // Helper to insert test events
  function insertEvent(
    skillId: string,
    userId: string,
    timestamp: number,
    taskDuration: number,
    outcome: SkillUsageOutcome,
    contextHash: string = 'test-context'
  ): void {
    db.prepare(
      `
      INSERT INTO usage_events (skill_id, user_id, timestamp, task_duration, outcome, context_hash)
      VALUES (?, ?, ?, ?, ?, ?)
    `
    ).run(skillId, userId, timestamp, taskDuration, outcome, contextHash)
  }

  beforeEach(() => {
    // Create in-memory database with schema
    db = new Database(':memory:')
    db.exec(`
      CREATE TABLE usage_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        skill_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        task_duration INTEGER NOT NULL,
        outcome TEXT NOT NULL CHECK(outcome IN ('success', 'error', 'abandoned')),
        context_hash TEXT NOT NULL,
        created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
      );
      CREATE INDEX idx_skill_id ON usage_events(skill_id);
      CREATE INDEX idx_timestamp ON usage_events(timestamp);
      CREATE INDEX idx_user_id ON usage_events(user_id);
      CREATE INDEX idx_outcome ON usage_events(outcome);
    `)
    aggregator = new MetricsAggregator(db)
    exporter = new MetricsExporter(aggregator)

    // Create temp directory for file tests
    testDir = join(tmpdir(), `skillsmith-test-${Date.now()}`)
    mkdirSync(testDir, { recursive: true })
  })

  afterEach(() => {
    db.close()
    // Clean up test directory
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true })
    }
  })

  describe('export', () => {
    it('should export empty metrics when no events exist', () => {
      const now = Date.now()
      const period: AggregationPeriod = {
        start: now - 7 * 24 * 60 * 60 * 1000,
        end: now,
      }

      const data = exporter.export(period)

      expect(data.exportedAt).toBeDefined()
      expect(data.period.start).toBeDefined()
      expect(data.period.end).toBeDefined()
      expect(data.period.label).toMatch(/^\d{4}-W\d{2}$/)
      expect(data.global.totalInvocations).toBe(0)
      expect(data.skills).toEqual({})
    })

    it('should export metrics for all skills', () => {
      const now = Date.now()

      insertEvent('skill-1', 'user-1', now - 1000, 100, 'success')
      insertEvent('skill-2', 'user-2', now - 2000, 200, 'error')

      const period: AggregationPeriod = {
        start: now - 3000,
        end: now,
      }

      const data = exporter.export(period)

      expect(data.global.totalInvocations).toBe(2)
      expect(Object.keys(data.skills)).toHaveLength(2)
      expect(data.skills['skill-1']).toBeDefined()
      expect(data.skills['skill-2']).toBeDefined()
    })

    it('should include retention data when requested', () => {
      const now = Date.now()
      const tenDays = 10 * 24 * 60 * 60 * 1000
      const oneDay = 24 * 60 * 60 * 1000

      insertEvent('test-skill', 'user-1', now - tenDays, 100, 'success')
      insertEvent('test-skill', 'user-1', now - oneDay, 100, 'success')

      const period: AggregationPeriod = {
        start: now - 30 * 24 * 60 * 60 * 1000,
        end: now,
      }

      const data = exporter.export(period, { includeRetention: true })

      expect(data.retention).toBeDefined()
      expect(data.retention!['test-skill']).toBe(1)
    })
  })

  describe('exportLastNDays', () => {
    it('should export metrics for last N days', () => {
      const now = Date.now()
      const oneDay = 24 * 60 * 60 * 1000

      insertEvent('skill-1', 'user-1', now - oneDay / 2, 100, 'success')

      const data = exporter.exportLastNDays(7)

      expect(data.global.totalInvocations).toBe(1)
      expect(data.skills['skill-1']).toBeDefined()
    })

    it('should exclude events outside the window', () => {
      const now = Date.now()
      const eightDays = 8 * 24 * 60 * 60 * 1000

      insertEvent('old-skill', 'user-1', now - eightDays, 100, 'success')
      insertEvent('new-skill', 'user-1', now - 1000, 100, 'success')

      const data = exporter.exportLastNDays(7)

      expect(data.global.totalInvocations).toBe(1)
      expect(data.skills['old-skill']).toBeUndefined()
      expect(data.skills['new-skill']).toBeDefined()
    })
  })

  describe('exportWeek', () => {
    it('should export metrics for the current week', () => {
      const now = Date.now()

      insertEvent('skill-1', 'user-1', now - 1000, 100, 'success')

      const data = exporter.exportWeek()

      expect(data.period.label).toMatch(/^\d{4}-W\d{2}$/)
      expect(data.global.totalInvocations).toBeGreaterThanOrEqual(0)
    })

    it('should export metrics for a specific week', () => {
      const specificDate = new Date('2026-01-15') // Week 3 of 2026

      const data = exporter.exportWeek(specificDate)

      expect(data.period.label).toBe('2026-W03')
    })
  })

  describe('exportDay', () => {
    it('should export metrics for today', () => {
      const now = Date.now()

      insertEvent('skill-1', 'user-1', now - 1000, 100, 'success')

      const data = exporter.exportDay()

      expect(data.global.totalInvocations).toBe(1)
    })

    it('should export metrics for a specific day', () => {
      const data = exporter.exportDay(new Date('2026-01-15'))

      // The date may be shifted due to timezone, so check for adjacent dates
      expect(data.period.start).toMatch(/2026-01-1[45]/)
    })
  })

  describe('saveToFile', () => {
    it('should save JSON export to file', () => {
      const now = Date.now()

      insertEvent('skill-1', 'user-1', now - 1000, 100, 'success')

      const period: AggregationPeriod = {
        start: now - 7 * 24 * 60 * 60 * 1000,
        end: now,
      }

      const data = exporter.export(period)
      const filepath = exporter.saveToFile(
        data,
        {
          outputDir: testDir,
          format: 'json',
        },
        testDir
      )

      expect(existsSync(filepath)).toBe(true)
      expect(filepath).toMatch(/\.json$/)

      const content = readFileSync(filepath, 'utf-8')
      const parsed = JSON.parse(content)
      expect(parsed.global.totalInvocations).toBe(1)
    })

    it('should save CSV export to file', () => {
      const now = Date.now()

      insertEvent('skill-1', 'user-1', now - 1000, 100, 'success')
      insertEvent('skill-2', 'user-2', now - 2000, 200, 'error')

      const period: AggregationPeriod = {
        start: now - 7 * 24 * 60 * 60 * 1000,
        end: now,
      }

      const data = exporter.export(period)
      const filepath = exporter.saveToFile(
        data,
        {
          outputDir: testDir,
          format: 'csv',
        },
        testDir
      )

      expect(existsSync(filepath)).toBe(true)
      expect(filepath).toMatch(/\.csv$/)

      const content = readFileSync(filepath, 'utf-8')
      const lines = content.split('\n')
      expect(lines[0]).toContain('skill_id')
      expect(lines[0]).toContain('total_invocations')
      expect(lines.length).toBe(3) // header + 2 skills
    })

    it('should create output directory if it does not exist', () => {
      const now = Date.now()
      const nestedDir = join(testDir, 'nested', 'exports')

      insertEvent('skill-1', 'user-1', now - 1000, 100, 'success')

      const period: AggregationPeriod = {
        start: now - 3000,
        end: now,
      }

      const data = exporter.export(period)
      const filepath = exporter.saveToFile(data, { outputDir: nestedDir }, testDir)

      expect(existsSync(filepath)).toBe(true)
      expect(existsSync(nestedDir)).toBe(true)
    })

    it('should include retention in CSV when present', () => {
      const now = Date.now()
      const tenDays = 10 * 24 * 60 * 60 * 1000
      const oneDay = 24 * 60 * 60 * 1000

      insertEvent('skill-1', 'user-1', now - tenDays, 100, 'success')
      insertEvent('skill-1', 'user-1', now - oneDay, 100, 'success')

      const period: AggregationPeriod = {
        start: now - 30 * 24 * 60 * 60 * 1000,
        end: now,
      }

      const data = exporter.export(period, { includeRetention: true })
      const filepath = exporter.saveToFile(
        data,
        {
          outputDir: testDir,
          format: 'csv',
        },
        testDir
      )

      const content = readFileSync(filepath, 'utf-8')
      expect(content).toContain('retention_rate')
    })
  })

  describe('toJSON', () => {
    it('should convert export data to JSON string', () => {
      const now = Date.now()

      insertEvent('skill-1', 'user-1', now - 1000, 100, 'success')

      const period: AggregationPeriod = {
        start: now - 3000,
        end: now,
      }

      const data = exporter.export(period)
      const json = exporter.toJSON(data)

      expect(typeof json).toBe('string')
      const parsed = JSON.parse(json)
      expect(parsed.global.totalInvocations).toBe(1)
    })

    it('should produce compact JSON when pretty is false', () => {
      const now = Date.now()

      const period: AggregationPeriod = {
        start: now - 3000,
        end: now,
      }

      const data = exporter.export(period)
      const prettyJson = exporter.toJSON(data, true)
      const compactJson = exporter.toJSON(data, false)

      expect(prettyJson.length).toBeGreaterThan(compactJson.length)
      expect(compactJson).not.toContain('\n')
    })
  })

  describe('CSV escaping', () => {
    it('should escape skill IDs with commas', () => {
      const now = Date.now()

      insertEvent('author/skill,with,commas', 'user-1', now - 1000, 100, 'success')

      const period: AggregationPeriod = {
        start: now - 3000,
        end: now,
      }

      const data = exporter.export(period)
      const filepath = exporter.saveToFile(
        data,
        {
          outputDir: testDir,
          format: 'csv',
        },
        testDir
      )

      const content = readFileSync(filepath, 'utf-8')
      expect(content).toContain('"author/skill,with,commas"')
    })

    it('should escape skill IDs with quotes', () => {
      const now = Date.now()

      insertEvent('author/"quoted"skill', 'user-1', now - 1000, 100, 'success')

      const period: AggregationPeriod = {
        start: now - 3000,
        end: now,
      }

      const data = exporter.export(period)
      const filepath = exporter.saveToFile(
        data,
        {
          outputDir: testDir,
          format: 'csv',
        },
        testDir
      )

      const content = readFileSync(filepath, 'utf-8')
      expect(content).toContain('"author/""quoted""skill"')
    })
  })

  describe('week label generation', () => {
    it('should generate correct week labels', () => {
      // Test a known date
      const jan1_2026 = new Date('2026-01-01T00:00:00Z')
      const period: AggregationPeriod = {
        start: jan1_2026.getTime(),
        end: jan1_2026.getTime() + 24 * 60 * 60 * 1000,
      }

      const data = exporter.export(period)

      // Jan 1, 2026 may be in week 53 of 2025 or week 1 of 2026 (ISO week rules)
      expect(data.period.label).toMatch(/^(2025-W53|2026-W0[1-2])$/)
    })
  })

  describe('validatePath - path traversal prevention', () => {
    it('should allow valid paths within base directory', () => {
      const subDir = join(testDir, 'subdir')
      mkdirSync(subDir, { recursive: true })

      const result = validatePath('subdir', testDir)
      expect(result).toBe(subDir)
    })

    it('should allow the base directory itself', () => {
      const result = validatePath(testDir, testDir)
      expect(result).toBe(testDir)
    })

    it('should reject paths with ../ that escape the base directory', () => {
      const baseDir = join(testDir, 'project')
      mkdirSync(baseDir, { recursive: true })

      expect(() => validatePath('../escape', baseDir)).toThrow('Path traversal attempt detected')
    })

    it('should reject absolute paths outside allowed directory', () => {
      const baseDir = join(testDir, 'project')
      mkdirSync(baseDir, { recursive: true })

      expect(() => validatePath('/etc/passwd', baseDir)).toThrow('Path traversal attempt detected')
    })

    it('should reject complex traversal attempts', () => {
      const baseDir = join(testDir, 'project')
      mkdirSync(baseDir, { recursive: true })

      expect(() => validatePath('subdir/../../escape', baseDir)).toThrow(
        'Path traversal attempt detected'
      )
    })

    it('should reject paths that look similar but are outside base', () => {
      const baseDir = join(testDir, 'base')
      const similarDir = join(testDir, 'base-other')
      mkdirSync(baseDir, { recursive: true })
      mkdirSync(similarDir, { recursive: true })

      expect(() => validatePath(similarDir, baseDir)).toThrow('Path traversal attempt detected')
    })
  })

  describe('saveToFile - path traversal prevention', () => {
    it('should throw when outputDir tries to escape via relative traversal', () => {
      const now = Date.now()

      insertEvent('skill-1', 'user-1', now - 1000, 100, 'success')

      const period: AggregationPeriod = {
        start: now - 3000,
        end: now,
      }

      const data = exporter.export(period)
      const allowedBase = join(testDir, 'exports')
      mkdirSync(allowedBase, { recursive: true })

      expect(() => exporter.saveToFile(data, { outputDir: '../escape' }, allowedBase)).toThrow(
        'Path traversal attempt detected'
      )
    })

    it('should throw when absolute outputDir is outside allowed base', () => {
      const now = Date.now()

      insertEvent('skill-1', 'user-1', now - 1000, 100, 'success')

      const period: AggregationPeriod = {
        start: now - 3000,
        end: now,
      }

      const data = exporter.export(period)
      const allowedBase = join(testDir, 'exports')
      mkdirSync(allowedBase, { recursive: true })

      expect(() => exporter.saveToFile(data, { outputDir: '/tmp/outside' }, allowedBase)).toThrow(
        'Path traversal attempt detected'
      )
    })

    it('should work normally for valid outputDir within allowed base', () => {
      const now = Date.now()

      insertEvent('skill-1', 'user-1', now - 1000, 100, 'success')

      const period: AggregationPeriod = {
        start: now - 3000,
        end: now,
      }

      const data = exporter.export(period)
      const allowedBase = testDir
      const validOutputDir = join(testDir, 'valid-exports')

      const filepath = exporter.saveToFile(
        data,
        { outputDir: validOutputDir, format: 'json' },
        allowedBase
      )

      expect(existsSync(filepath)).toBe(true)
      expect(filepath.startsWith(testDir)).toBe(true)
    })
  })
})

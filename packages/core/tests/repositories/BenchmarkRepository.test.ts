/**
 * @fileoverview Tests for BenchmarkRepository (SMI-3292)
 * @module @skillsmith/core/tests/repositories/BenchmarkRepository
 *
 * Tests CRUD operations for benchmark_results, skill_variants,
 * and failure_patterns tables. Uses createTestDatabase() which
 * runs all migrations including v11.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDatabase, closeDatabase } from '../helpers/database.js'
import type { Database } from '../../src/db/database-interface.js'
import { BenchmarkRepository } from '../../src/repositories/BenchmarkRepository.js'

let db: Database
let repo: BenchmarkRepository

beforeEach(() => {
  db = createTestDatabase()
  repo = new BenchmarkRepository(db)

  // Insert a fixture skill for FK references
  db.exec(`
    INSERT INTO skills (id, name, author, description)
    VALUES ('skill-1', 'test-skill', 'test-author', 'A test skill');
  `)
})

afterEach(() => {
  closeDatabase(db)
})

// ============================================================================
// benchmark_results
// ============================================================================

describe('BenchmarkRepository — benchmark_results', () => {
  const baseResult = {
    id: 'br-1',
    skillId: 'skill-1',
    skillVariantHash: 'abc123',
    benchmark: 'officeqa' as const,
    split: 'val' as const,
    condition: 'skillsmith-search',
    accuracy: 0.75,
    taskCount: 100,
    correctCount: 75,
    scorer: 'exact_match' as const,
    modelId: 'claude-sonnet-4-6',
    seed: 42,
  }

  it('inserts and retrieves a result', () => {
    repo.insertResult(baseResult)
    const row = repo.getResult('br-1')

    expect(row).toBeDefined()
    expect(row!.skill_id).toBe('skill-1')
    expect(row!.accuracy).toBe(0.75)
    expect(row!.task_count).toBe(100)
    expect(row!.correct_count).toBe(75)
    expect(row!.iteration).toBe(0)
  })

  it('enforces correct_count <= task_count at DB layer', () => {
    expect(() =>
      repo.insertResult({
        ...baseResult,
        id: 'br-bad',
        correctCount: 101, // exceeds taskCount of 100
      })
    ).toThrow()
  })

  it('enforces accuracy range 0-1', () => {
    expect(() =>
      repo.insertResult({
        ...baseResult,
        id: 'br-bad',
        accuracy: 1.5,
      })
    ).toThrow()
  })

  it('enforces valid benchmark values', () => {
    expect(() =>
      repo.insertResult({
        ...baseResult,
        id: 'br-bad',
        benchmark: 'invalid' as 'officeqa',
      })
    ).toThrow()
  })

  it('queries results by skill', () => {
    repo.insertResult(baseResult)
    repo.insertResult({
      ...baseResult,
      id: 'br-2',
      benchmark: 'sealqa',
      split: 'test',
    })

    const all = repo.getResultsBySkill('skill-1')
    expect(all).toHaveLength(2)

    const filtered = repo.getResultsBySkill('skill-1', 'officeqa', 'val')
    expect(filtered).toHaveLength(1)
    expect(filtered[0].id).toBe('br-1')
  })

  it('queries results by condition', () => {
    repo.insertResult(baseResult)
    repo.insertResult({
      ...baseResult,
      id: 'br-2',
      condition: 'skillsmith-search',
      iteration: 1,
      seed: 43,
    })

    const results = repo.getResultsByCondition('skillsmith-search', 'officeqa')
    expect(results).toHaveLength(2)
    // Ordered by iteration ASC
    expect(results[0].iteration).toBe(0)
    expect(results[1].iteration).toBe(1)
  })

  it('deletes a result', () => {
    repo.insertResult(baseResult)
    expect(repo.deleteResult('br-1')).toBe(true)
    expect(repo.getResult('br-1')).toBeUndefined()
    expect(repo.deleteResult('nonexistent')).toBe(false)
  })

  it('stores optional cost fields', () => {
    repo.insertResult({
      ...baseResult,
      costTokens: 50000,
      costDollars: 0.25,
      wallClockMs: 12000,
    })
    const row = repo.getResult('br-1')!
    expect(row.cost_tokens).toBe(50000)
    expect(row.cost_dollars).toBe(0.25)
    expect(row.wall_clock_ms).toBe(12000)
  })
})

// ============================================================================
// skill_variants
// ============================================================================

describe('BenchmarkRepository — skill_variants', () => {
  const baseVariant = {
    id: 'sv-1',
    skillId: 'skill-1',
    contentHash: 'hash-abc',
    iteration: 0,
    generationMethod: 'baseline' as const,
  }

  it('inserts and retrieves a variant', () => {
    repo.insertVariant(baseVariant)
    const row = repo.getVariant('sv-1')

    expect(row).toBeDefined()
    expect(row!.skill_id).toBe('skill-1')
    expect(row!.content_hash).toBe('hash-abc')
    expect(row!.is_frontier).toBe(0)
    expect(row!.parent_variant_id).toBeNull()
  })

  it('enforces UNIQUE(skill_id, content_hash)', () => {
    repo.insertVariant(baseVariant)
    expect(() =>
      repo.insertVariant({
        ...baseVariant,
        id: 'sv-2', // different UUID
        // same skill_id + content_hash → should fail
      })
    ).toThrow()
  })

  it('enforces is_frontier IN (0, 1)', () => {
    expect(() =>
      repo.insertVariant({
        ...baseVariant,
        id: 'sv-bad',
      })
    ).not.toThrow()

    // Direct SQL to test constraint bypass
    expect(() =>
      db.exec(`
        INSERT INTO skill_variants
          (id, skill_id, content_hash, iteration, generation_method, is_frontier)
        VALUES ('sv-bad2', 'skill-1', 'hash-bad2', 0, 'baseline', 2)
      `)
    ).toThrow()
  })

  it('enforces valid generation_method values', () => {
    expect(() =>
      repo.insertVariant({
        ...baseVariant,
        id: 'sv-bad',
        contentHash: 'hash-bad',
        generationMethod: 'invalid' as 'baseline',
      })
    ).toThrow()
  })

  it('looks up by content hash', () => {
    repo.insertVariant(baseVariant)
    const row = repo.getVariantByHash('skill-1', 'hash-abc')
    expect(row).toBeDefined()
    expect(row!.id).toBe('sv-1')

    expect(repo.getVariantByHash('skill-1', 'nonexistent')).toBeUndefined()
  })

  it('manages frontier membership', () => {
    repo.insertVariant({ ...baseVariant, isFrontier: true })
    repo.insertVariant({
      ...baseVariant,
      id: 'sv-2',
      contentHash: 'hash-def',
      iteration: 1,
      generationMethod: 'augment',
      isFrontier: true,
    })

    const frontier = repo.getFrontierVariants('skill-1')
    expect(frontier).toHaveLength(2)

    repo.clearFrontier('skill-1')
    expect(repo.getFrontierVariants('skill-1')).toHaveLength(0)
  })

  it('updates accuracy values', () => {
    repo.insertVariant(baseVariant)
    repo.updateVariantAccuracy('sv-1', 0.6, 0.65, null)

    const row = repo.getVariant('sv-1')!
    expect(row.accuracy_train).toBe(0.6)
    expect(row.accuracy_val).toBe(0.65)
    expect(row.accuracy_test).toBeNull()
  })

  it('sets frontier on individual variant', () => {
    repo.insertVariant(baseVariant)
    expect(repo.getVariant('sv-1')!.is_frontier).toBe(0)

    repo.setFrontier('sv-1', true)
    expect(repo.getVariant('sv-1')!.is_frontier).toBe(1)

    repo.setFrontier('sv-1', false)
    expect(repo.getVariant('sv-1')!.is_frontier).toBe(0)
  })

  it('tracks parent lineage', () => {
    repo.insertVariant(baseVariant)
    repo.insertVariant({
      id: 'sv-child',
      skillId: 'skill-1',
      parentVariantId: 'sv-1',
      contentHash: 'hash-child',
      iteration: 1,
      generationMethod: 'augment',
    })

    const child = repo.getVariant('sv-child')!
    expect(child.parent_variant_id).toBe('sv-1')
  })

  it('deletes a variant', () => {
    repo.insertVariant(baseVariant)
    expect(repo.deleteVariant('sv-1')).toBe(true)
    expect(repo.getVariant('sv-1')).toBeUndefined()
  })
})

// ============================================================================
// failure_patterns
// ============================================================================

describe('BenchmarkRepository — failure_patterns', () => {
  const resultId = 'br-fp'

  beforeEach(() => {
    // Insert a benchmark result first for FK
    repo.insertResult({
      id: resultId,
      skillId: 'skill-1',
      skillVariantHash: 'hash-fp',
      benchmark: 'officeqa',
      split: 'val',
      condition: 'test-cond',
      accuracy: 0.5,
      taskCount: 10,
      correctCount: 5,
      scorer: 'exact_match',
      modelId: 'claude-sonnet-4-6',
      seed: 1,
    })
  })

  it('inserts and retrieves a pattern', () => {
    repo.insertPattern({
      id: 'fp-1',
      benchmarkResultId: resultId,
      category: 'wrong_format',
      frequency: 3,
      exampleTasks: ['task-1', 'task-2'],
      suggestedFix: 'Add format instructions',
    })

    const row = repo.getPattern('fp-1')
    expect(row).toBeDefined()
    expect(row!.category).toBe('wrong_format')
    expect(row!.frequency).toBe(3)
    expect(JSON.parse(row!.example_tasks!)).toEqual(['task-1', 'task-2'])
    expect(row!.suggested_fix).toBe('Add format instructions')
  })

  it('enforces valid category values', () => {
    expect(() =>
      repo.insertPattern({
        id: 'fp-bad',
        benchmarkResultId: resultId,
        category: 'invalid' as 'wrong_format',
        frequency: 1,
      })
    ).toThrow()
  })

  it('queries patterns by result, ordered by frequency DESC', () => {
    repo.insertPattern({
      id: 'fp-1',
      benchmarkResultId: resultId,
      category: 'wrong_format',
      frequency: 3,
    })
    repo.insertPattern({
      id: 'fp-2',
      benchmarkResultId: resultId,
      category: 'reasoning_error',
      frequency: 5,
    })
    repo.insertPattern({
      id: 'fp-3',
      benchmarkResultId: resultId,
      category: 'tool_misuse',
      frequency: 1,
    })

    const patterns = repo.getPatternsByResult(resultId)
    expect(patterns).toHaveLength(3)
    expect(patterns[0].frequency).toBe(5) // reasoning_error first
    expect(patterns[1].frequency).toBe(3)
    expect(patterns[2].frequency).toBe(1)
  })

  it('handles null example_tasks and suggested_fix', () => {
    repo.insertPattern({
      id: 'fp-null',
      benchmarkResultId: resultId,
      category: 'hallucination',
      frequency: 2,
    })

    const row = repo.getPattern('fp-null')!
    expect(row.example_tasks).toBeNull()
    expect(row.suggested_fix).toBeNull()
  })

  it('deletes patterns by result', () => {
    repo.insertPattern({
      id: 'fp-1',
      benchmarkResultId: resultId,
      category: 'wrong_format',
      frequency: 1,
    })
    repo.insertPattern({
      id: 'fp-2',
      benchmarkResultId: resultId,
      category: 'reasoning_error',
      frequency: 2,
    })

    const deleted = repo.deletePatternsByResult(resultId)
    expect(deleted).toBe(2)
    expect(repo.getPatternsByResult(resultId)).toHaveLength(0)
  })

  it('deletes a single pattern', () => {
    repo.insertPattern({
      id: 'fp-1',
      benchmarkResultId: resultId,
      category: 'wrong_format',
      frequency: 1,
    })
    expect(repo.deletePattern('fp-1')).toBe(true)
    expect(repo.getPattern('fp-1')).toBeUndefined()
  })
})

// ============================================================================
// Schema integrity
// ============================================================================

describe('BenchmarkRepository — schema integrity', () => {
  it('all 3 tables exist after createTestDatabase()', () => {
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table'
         AND name IN ('benchmark_results', 'skill_variants', 'failure_patterns')
         ORDER BY name`
      )
      .all() as { name: string }[]

    expect(tables.map((t) => t.name)).toEqual([
      'benchmark_results',
      'failure_patterns',
      'skill_variants',
    ])
  })

  it('indexes exist for benchmark_results', () => {
    const indexes = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='index'
         AND name LIKE 'idx_benchmark_results%'`
      )
      .all() as { name: string }[]

    const names = indexes.map((i) => i.name)
    expect(names).toContain('idx_benchmark_results_skill')
    expect(names).toContain('idx_benchmark_results_condition')
  })

  it('partial index exists for frontier variants', () => {
    const indexes = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='index'
         AND name = 'idx_skill_variants_frontier'`
      )
      .all() as { name: string }[]

    expect(indexes).toHaveLength(1)
  })
})

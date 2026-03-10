/**
 * @fileoverview Tests for SkillDependencyRepository (SMI-3143)
 * @module @skillsmith/core/tests/repositories/SkillDependencyRepository
 *
 * Tests CRUD operations, upsert idempotency, source filtering,
 * reverse lookup, and graceful missing-table handling.
 * Uses createTestDatabase() which runs all migrations including v10.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDatabase, closeDatabase } from '../helpers/database.js'
import type { Database } from '../../src/db/database-interface.js'
import { SkillDependencyRepository } from '../../src/repositories/SkillDependencyRepository.js'
import type { SkillDependencyRow } from '../../src/types/dependencies.js'
import { createDatabase } from '../../src/db/schema.js'

// ============================================================================
// Full-migration tests
// ============================================================================

let db: Database
let repo: SkillDependencyRepository

beforeEach(() => {
  db = createTestDatabase()
  repo = new SkillDependencyRepository(db)
})

afterEach(() => {
  closeDatabase(db)
})

describe('SkillDependencyRepository', () => {
  describe('getDependencies — empty table', () => {
    it('returns empty array when no dependencies recorded', () => {
      const results = repo.getDependencies('nonexistent-skill')
      expect(results).toEqual([])
    })
  })

  describe('setDependencies — insert and upsert', () => {
    it('inserts dependency rows', () => {
      const deps: SkillDependencyRow[] = [
        {
          skill_id: 'author/skill-a',
          dep_type: 'mcp_server',
          dep_target: 'github',
          dep_version: null,
          dep_source: 'declared',
          confidence: null,
          metadata: null,
        },
        {
          skill_id: 'author/skill-a',
          dep_type: 'skill_hard',
          dep_target: 'author/util',
          dep_version: '>=1.0.0',
          dep_source: 'declared',
          confidence: null,
          metadata: '{"reason":"needed for parsing"}',
        },
      ]

      repo.setDependencies('author/skill-a', deps, 'declared')

      const results = repo.getDependencies('author/skill-a')
      expect(results).toHaveLength(2)
      expect(results.map((r) => r.dep_type)).toContain('mcp_server')
      expect(results.map((r) => r.dep_type)).toContain('skill_hard')
    })

    it('upserts on repeated calls (idempotent)', () => {
      const dep: SkillDependencyRow = {
        skill_id: 'author/skill-a',
        dep_type: 'mcp_server',
        dep_target: 'github',
        dep_version: null,
        dep_source: 'declared',
        confidence: null,
        metadata: null,
      }

      repo.setDependencies('author/skill-a', [dep], 'declared')
      repo.setDependencies('author/skill-a', [dep], 'declared')

      const results = repo.getDependencies('author/skill-a')
      expect(results).toHaveLength(1)
    })

    it('updates version and metadata on upsert', () => {
      const dep1: SkillDependencyRow = {
        skill_id: 'author/skill-a',
        dep_type: 'skill_hard',
        dep_target: 'author/util',
        dep_version: '>=1.0.0',
        dep_source: 'declared',
        confidence: null,
        metadata: null,
      }

      repo.setDependencies('author/skill-a', [dep1], 'declared')

      const dep2: SkillDependencyRow = {
        ...dep1,
        dep_version: '>=2.0.0',
        metadata: '{"updated":true}',
      }

      repo.setDependencies('author/skill-a', [dep2], 'declared')

      const results = repo.getDependencies('author/skill-a')
      expect(results).toHaveLength(1)
      expect(results[0].dep_version).toBe('>=2.0.0')
      expect(results[0].metadata).toBe('{"updated":true}')
    })
  })

  describe('getDependenciesBySource', () => {
    it('filters by source', () => {
      const declared: SkillDependencyRow = {
        skill_id: 'author/skill-a',
        dep_type: 'mcp_server',
        dep_target: 'github',
        dep_version: null,
        dep_source: 'declared',
        confidence: null,
        metadata: null,
      }
      const inferred: SkillDependencyRow = {
        skill_id: 'author/skill-a',
        dep_type: 'mcp_server',
        dep_target: 'linear',
        dep_version: null,
        dep_source: 'inferred_static',
        confidence: 0.85,
        metadata: null,
      }

      repo.setDependencies('author/skill-a', [declared], 'declared')
      repo.setDependencies('author/skill-a', [inferred], 'inferred_static')

      const declaredResults = repo.getDependenciesBySource('author/skill-a', 'declared')
      expect(declaredResults).toHaveLength(1)
      expect(declaredResults[0].dep_target).toBe('github')

      const inferredResults = repo.getDependenciesBySource('author/skill-a', 'inferred_static')
      expect(inferredResults).toHaveLength(1)
      expect(inferredResults[0].dep_target).toBe('linear')
    })
  })

  describe('getDependents — reverse lookup', () => {
    it('finds skills that depend on a target', () => {
      const depA: SkillDependencyRow = {
        skill_id: 'author/skill-a',
        dep_type: 'mcp_server',
        dep_target: 'github',
        dep_version: null,
        dep_source: 'declared',
        confidence: null,
        metadata: null,
      }
      const depB: SkillDependencyRow = {
        skill_id: 'author/skill-b',
        dep_type: 'mcp_server',
        dep_target: 'github',
        dep_version: null,
        dep_source: 'inferred_static',
        confidence: 0.9,
        metadata: null,
      }

      repo.setDependencies('author/skill-a', [depA], 'declared')
      repo.setDependencies('author/skill-b', [depB], 'inferred_static')

      const dependents = repo.getDependents('github')
      expect(dependents).toHaveLength(2)
      expect(dependents.map((r) => r.skill_id).sort()).toEqual([
        'author/skill-a',
        'author/skill-b',
      ])
    })

    it('filters by depType when provided', () => {
      const mcpDep: SkillDependencyRow = {
        skill_id: 'author/skill-a',
        dep_type: 'mcp_server',
        dep_target: 'github',
        dep_version: null,
        dep_source: 'declared',
        confidence: null,
        metadata: null,
      }
      const envDep: SkillDependencyRow = {
        skill_id: 'author/skill-b',
        dep_type: 'env_tool',
        dep_target: 'github',
        dep_version: null,
        dep_source: 'declared',
        confidence: null,
        metadata: null,
      }

      repo.setDependencies('author/skill-a', [mcpDep], 'declared')
      repo.setDependencies('author/skill-b', [envDep], 'declared')

      const mcpDependents = repo.getDependents('github', 'mcp_server')
      expect(mcpDependents).toHaveLength(1)
      expect(mcpDependents[0].skill_id).toBe('author/skill-a')
    })
  })

  describe('clearInferred', () => {
    it('deletes inferred deps but preserves declared', () => {
      const declared: SkillDependencyRow = {
        skill_id: 'author/skill-a',
        dep_type: 'mcp_server',
        dep_target: 'github',
        dep_version: null,
        dep_source: 'declared',
        confidence: null,
        metadata: null,
      }
      const inferred: SkillDependencyRow = {
        skill_id: 'author/skill-a',
        dep_type: 'mcp_server',
        dep_target: 'linear',
        dep_version: null,
        dep_source: 'inferred_static',
        confidence: 0.85,
        metadata: null,
      }

      repo.setDependencies('author/skill-a', [declared], 'declared')
      repo.setDependencies('author/skill-a', [inferred], 'inferred_static')

      repo.clearInferred('author/skill-a')

      const results = repo.getDependencies('author/skill-a')
      expect(results).toHaveLength(1)
      expect(results[0].dep_source).toBe('declared')
      expect(results[0].dep_target).toBe('github')
    })
  })

  describe('clearAll', () => {
    it('deletes all deps for a skill', () => {
      const dep: SkillDependencyRow = {
        skill_id: 'author/skill-a',
        dep_type: 'mcp_server',
        dep_target: 'github',
        dep_version: null,
        dep_source: 'declared',
        confidence: null,
        metadata: null,
      }

      repo.setDependencies('author/skill-a', [dep], 'declared')
      expect(repo.getDependencies('author/skill-a')).toHaveLength(1)

      repo.clearAll('author/skill-a')
      expect(repo.getDependencies('author/skill-a')).toEqual([])
    })

    it('does not affect other skills', () => {
      const depA: SkillDependencyRow = {
        skill_id: 'author/skill-a',
        dep_type: 'mcp_server',
        dep_target: 'github',
        dep_version: null,
        dep_source: 'declared',
        confidence: null,
        metadata: null,
      }
      const depB: SkillDependencyRow = {
        skill_id: 'author/skill-b',
        dep_type: 'mcp_server',
        dep_target: 'linear',
        dep_version: null,
        dep_source: 'declared',
        confidence: null,
        metadata: null,
      }

      repo.setDependencies('author/skill-a', [depA], 'declared')
      repo.setDependencies('author/skill-b', [depB], 'declared')

      repo.clearAll('author/skill-a')

      expect(repo.getDependencies('author/skill-a')).toEqual([])
      expect(repo.getDependencies('author/skill-b')).toHaveLength(1)
    })
  })

  describe('getDependencies — ordering', () => {
    it('returns results ordered by dep_type', () => {
      const deps: SkillDependencyRow[] = [
        {
          skill_id: 'author/skill-a',
          dep_type: 'skill_hard',
          dep_target: 'author/util',
          dep_version: null,
          dep_source: 'declared',
          confidence: null,
          metadata: null,
        },
        {
          skill_id: 'author/skill-a',
          dep_type: 'env_tool',
          dep_target: 'docker',
          dep_version: null,
          dep_source: 'declared',
          confidence: null,
          metadata: null,
        },
        {
          skill_id: 'author/skill-a',
          dep_type: 'mcp_server',
          dep_target: 'github',
          dep_version: null,
          dep_source: 'declared',
          confidence: null,
          metadata: null,
        },
      ]

      repo.setDependencies('author/skill-a', deps, 'declared')

      const results = repo.getDependencies('author/skill-a')
      const types = results.map((r) => r.dep_type)
      // Alphabetical: env_tool, mcp_server, skill_hard
      expect(types).toEqual(['env_tool', 'mcp_server', 'skill_hard'])
    })
  })
})

// ============================================================================
// Graceful missing-table tests (no migrations)
// ============================================================================

describe('SkillDependencyRepository — missing table', () => {
  let bareDb: Database

  beforeEach(() => {
    // createDatabase() without migrations — no skill_dependencies table
    bareDb = createDatabase()
  })

  afterEach(() => {
    closeDatabase(bareDb)
  })

  it('getDependencies returns empty array', () => {
    const bareRepo = new SkillDependencyRepository(bareDb)
    expect(bareRepo.getDependencies('any-skill')).toEqual([])
  })

  it('getDependenciesBySource returns empty array', () => {
    const bareRepo = new SkillDependencyRepository(bareDb)
    expect(bareRepo.getDependenciesBySource('any-skill', 'declared')).toEqual([])
  })

  it('getDependents returns empty array', () => {
    const bareRepo = new SkillDependencyRepository(bareDb)
    expect(bareRepo.getDependents('any-target')).toEqual([])
  })

  it('setDependencies does not throw', () => {
    const bareRepo = new SkillDependencyRepository(bareDb)
    const dep: SkillDependencyRow = {
      skill_id: 'x',
      dep_type: 'mcp_server',
      dep_target: 'y',
      dep_version: null,
      dep_source: 'declared',
      confidence: null,
      metadata: null,
    }
    expect(() => bareRepo.setDependencies('x', [dep], 'declared')).not.toThrow()
  })

  it('clearInferred does not throw', () => {
    const bareRepo = new SkillDependencyRepository(bareDb)
    expect(() => bareRepo.clearInferred('any-skill')).not.toThrow()
  })

  it('clearAll does not throw', () => {
    const bareRepo = new SkillDependencyRepository(bareDb)
    expect(() => bareRepo.clearAll('any-skill')).not.toThrow()
  })
})

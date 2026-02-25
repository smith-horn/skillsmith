/**
 * @fileoverview Tests for CoInstallRepository (SMI-2761)
 * @module @skillsmith/core/tests/repositories/CoInstallRepository
 *
 * Tests co-install recording, upsert symmetry, and min-count threshold.
 * Uses createTestDatabase() which runs all migrations including v8.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDatabase, closeDatabase } from '../helpers/database.js'
import type { Database } from '../../src/db/database-interface.js'
import { CoInstallRepository } from '../../src/repositories/CoInstallRepository.js'

let db: Database
let repo: CoInstallRepository

beforeEach(() => {
  db = createTestDatabase()
  repo = new CoInstallRepository(db)

  // Insert fixture skills so JOIN works in getTopCoInstalls
  db.exec(`
    INSERT INTO skills (id, name, author, description)
    VALUES
      ('skill-a', 'skill-a', 'test', 'Skill A description'),
      ('skill-b', 'skill-b', 'test', 'Skill B description'),
      ('skill-c', 'skill-c', 'test', 'Skill C description');
  `)
})

afterEach(() => {
  closeDatabase(db)
})

describe('CoInstallRepository', () => {
  describe('getTopCoInstalls — empty table', () => {
    it('returns empty array when no co-installs recorded', () => {
      const results = repo.getTopCoInstalls('skill-a')
      expect(results).toEqual([])
    })
  })

  describe('recordCoInstall — upsert symmetry', () => {
    it('creates (A,B) and (B,A) rows on first call', () => {
      repo.recordCoInstall('skill-a', 'skill-b')

      const forA = repo.getTopCoInstalls('skill-a', 10, 1)
      const forB = repo.getTopCoInstalls('skill-b', 10, 1)

      expect(forA.map((r) => r.skillId)).toContain('skill-b')
      expect(forB.map((r) => r.skillId)).toContain('skill-a')
    })

    it('increments install_count on repeated calls', () => {
      repo.recordCoInstall('skill-a', 'skill-b')
      repo.recordCoInstall('skill-a', 'skill-b')
      repo.recordCoInstall('skill-a', 'skill-b')

      const results = repo.getTopCoInstalls('skill-a', 10, 1)
      const entry = results.find((r) => r.skillId === 'skill-b')
      expect(entry?.installCount).toBe(3)
    })

    it('is idempotent for self-pairs (no-op)', () => {
      // Should not throw, simply return
      expect(() => repo.recordCoInstall('skill-a', 'skill-a')).not.toThrow()
      const results = repo.getTopCoInstalls('skill-a', 10, 1)
      expect(results).toEqual([])
    })
  })

  describe('recordSessionCoInstalls', () => {
    it('records all pairs in a session', () => {
      repo.recordSessionCoInstalls(['skill-a', 'skill-b', 'skill-c'])

      const forA = repo.getTopCoInstalls('skill-a', 10, 1)
      const ids = forA.map((r) => r.skillId)
      expect(ids).toContain('skill-b')
      expect(ids).toContain('skill-c')
    })

    it('is a no-op for fewer than 2 skills', () => {
      expect(() => repo.recordSessionCoInstalls([])).not.toThrow()
      expect(() => repo.recordSessionCoInstalls(['skill-a'])).not.toThrow()
      expect(repo.getTopCoInstalls('skill-a', 10, 1)).toEqual([])
    })
  })

  describe('getTopCoInstalls — min-count boundary', () => {
    it('excludes entries below minCount (4 → excluded at default threshold 5)', () => {
      // Record 4 co-installs
      for (let i = 0; i < 4; i++) {
        repo.recordCoInstall('skill-a', 'skill-b')
      }

      const results = repo.getTopCoInstalls('skill-a') // default minCount=5
      expect(results.find((r) => r.skillId === 'skill-b')).toBeUndefined()
    })

    it('includes entries at exactly minCount (5 → included at default threshold 5)', () => {
      // Record exactly 5 co-installs
      for (let i = 0; i < 5; i++) {
        repo.recordCoInstall('skill-a', 'skill-b')
      }

      const results = repo.getTopCoInstalls('skill-a') // default minCount=5
      expect(results.find((r) => r.skillId === 'skill-b')).toBeDefined()
    })
  })

  describe('getTopCoInstalls — result shape', () => {
    it('returns skills with name/description/author from skills table', () => {
      for (let i = 0; i < 5; i++) {
        repo.recordCoInstall('skill-a', 'skill-b')
      }

      const results = repo.getTopCoInstalls('skill-a')
      expect(results).toHaveLength(1)
      expect(results[0]).toMatchObject({
        skillId: 'skill-b',
        name: 'skill-b',
        description: 'Skill B description',
        author: 'test',
        installCount: 5,
      })
    })

    it('respects the limit parameter', () => {
      for (let i = 0; i < 5; i++) {
        repo.recordCoInstall('skill-a', 'skill-b')
        repo.recordCoInstall('skill-a', 'skill-c')
      }

      const results = repo.getTopCoInstalls('skill-a', 1) // limit=1
      expect(results).toHaveLength(1)
    })

    it('orders results by install_count descending', () => {
      for (let i = 0; i < 10; i++) repo.recordCoInstall('skill-a', 'skill-b')
      for (let i = 0; i < 5; i++) repo.recordCoInstall('skill-a', 'skill-c')

      const results = repo.getTopCoInstalls('skill-a', 10, 1)
      expect(results[0].skillId).toBe('skill-b')
      expect(results[0].installCount).toBe(10)
      expect(results[1].skillId).toBe('skill-c')
      expect(results[1].installCount).toBe(5)
    })
  })
})

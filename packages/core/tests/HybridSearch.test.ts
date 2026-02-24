/**
 * SMI-2721 Wave 1: HybridSearch async factory tests
 *
 * Verifies that HybridSearch.create() opens a DB correctly and the sync
 * constructor throws as required by the Wave 1 acceptance criteria.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { HybridSearch } from '../src/search/hybrid.js'

describe('HybridSearch (SMI-2721)', () => {
  describe('constructor', () => {
    it('should throw when called synchronously (use HybridSearch.create instead)', () => {
      expect(
        () =>
          new HybridSearch({
            dbPath: ':memory:',
          })
      ).toThrow('[HybridSearch] Cannot construct synchronously')
    })
  })

  describe('static async create()', () => {
    let search: HybridSearch | null = null

    afterEach(() => {
      if (search) {
        search.close()
        search = null
      }
    })

    it('should create instance with in-memory DB and perform a search', async () => {
      search = await HybridSearch.create({ dbPath: ':memory:' })
      expect(search).toBeInstanceOf(HybridSearch)

      // Verify the DB is functional by running a search on an empty index
      const result = await search.search({ query: 'test' })
      expect(result).toBeDefined()
      expect(result.results).toEqual([])
      expect(result.totalCount).toBe(0)
      expect(typeof result.searchTimeMs).toBe('number')
    })

    it('should index and find a skill after creation', async () => {
      search = await HybridSearch.create({ dbPath: ':memory:' })

      await search.indexSkill({
        id: 'test/skill-1',
        name: 'Test Skill',
        description: 'A test skill for hybrid search',
        category: 'testing',
      })

      const result = await search.search({ query: 'test skill' })
      expect(result.totalCount).toBeGreaterThan(0)
    })
  })
})

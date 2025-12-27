import { describe, it, expect } from 'vitest'
import { SCHEMA_VERSION } from './index.js'

describe('@skillsmith/core', () => {
  describe('SCHEMA_VERSION', () => {
    it('should be defined', () => {
      expect(SCHEMA_VERSION).toBeDefined()
      expect(typeof SCHEMA_VERSION).toBe('number')
    })

    it('should be a positive integer', () => {
      expect(SCHEMA_VERSION).toBeGreaterThan(0)
      expect(Number.isInteger(SCHEMA_VERSION)).toBe(true)
    })
  })

  describe('Module exports', () => {
    it('should export database utilities', async () => {
      const mod = await import('./index.js')
      expect(mod.createDatabase).toBeDefined()
      expect(mod.closeDatabase).toBeDefined()
      expect(mod.initializeSchema).toBeDefined()
    })

    it('should export SkillRepository', async () => {
      const mod = await import('./index.js')
      expect(mod.SkillRepository).toBeDefined()
    })

    it('should export CacheRepository', async () => {
      const mod = await import('./index.js')
      expect(mod.CacheRepository).toBeDefined()
    })

    it('should export SearchService', async () => {
      const mod = await import('./index.js')
      expect(mod.SearchService).toBeDefined()
    })
  })
})

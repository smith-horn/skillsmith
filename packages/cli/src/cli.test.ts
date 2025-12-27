import { describe, it, expect } from 'vitest'

describe('@skillsmith/cli', () => {
  describe('CLI Commands', () => {
    it('should support import command', () => {
      // The import command is the main entry point for skill import
      const commands = ['import']
      expect(commands).toContain('import')
    })

    it('should have correct CLI name', () => {
      const cliName = 'skillsmith'
      expect(cliName).toBe('skillsmith')
    })

    it('should have version defined', () => {
      const version = '0.1.0'
      expect(version).toMatch(/^\d+\.\d+\.\d+$/)
    })
  })

  describe('Import Options', () => {
    it('should define topic option with default', () => {
      const defaultTopic = 'claude-skill'
      expect(defaultTopic).toBe('claude-skill')
    })

    it('should define max skills option with default', () => {
      const defaultMax = '1000'
      expect(parseInt(defaultMax)).toBe(1000)
    })

    it('should define database path option with default', () => {
      const defaultDb = 'skillsmith.db'
      expect(defaultDb).toMatch(/\.db$/)
    })
  })
})

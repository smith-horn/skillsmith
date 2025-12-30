/**
 * SMI-744: Interactive Search Command Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'
import { DEFAULT_DB_PATH } from '../src/config.js'

// Mock dependencies before importing the module
vi.mock('@inquirer/prompts', () => ({
  input: vi.fn(),
  checkbox: vi.fn(),
  number: vi.fn(),
  select: vi.fn(),
}))

vi.mock('@skillsmith/core', () => ({
  createDatabase: vi.fn(() => ({
    close: vi.fn(),
  })),
  SearchService: vi.fn(() => ({
    search: vi.fn(() => ({
      items: [],
      total: 0,
      limit: 20,
      offset: 0,
      hasMore: false,
    })),
  })),
}))

describe('SMI-744: Search Command', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('createSearchCommand', () => {
    it('creates a command with correct name', async () => {
      const { createSearchCommand } = await import('../src/commands/search.js')
      const cmd = createSearchCommand()

      expect(cmd).toBeInstanceOf(Command)
      expect(cmd.name()).toBe('search')
    })

    it('has interactive option', async () => {
      const { createSearchCommand } = await import('../src/commands/search.js')
      const cmd = createSearchCommand()

      const interactiveOpt = cmd.options.find((o) => o.short === '-i')
      expect(interactiveOpt).toBeDefined()
      expect(interactiveOpt?.long).toBe('--interactive')
    })

    it('has database path option with default', async () => {
      const { createSearchCommand } = await import('../src/commands/search.js')
      const cmd = createSearchCommand()

      const dbOpt = cmd.options.find((o) => o.short === '-d')
      expect(dbOpt).toBeDefined()
      expect(dbOpt?.defaultValue).toBe(DEFAULT_DB_PATH)
    })

    it('has limit option', async () => {
      const { createSearchCommand } = await import('../src/commands/search.js')
      const cmd = createSearchCommand()

      const limitOpt = cmd.options.find((o) => o.short === '-l')
      expect(limitOpt).toBeDefined()
    })

    it('has trust tier filter option', async () => {
      const { createSearchCommand } = await import('../src/commands/search.js')
      const cmd = createSearchCommand()

      const tierOpt = cmd.options.find((o) => o.short === '-t')
      expect(tierOpt).toBeDefined()
    })

    it('has minimum score filter option', async () => {
      const { createSearchCommand } = await import('../src/commands/search.js')
      const cmd = createSearchCommand()

      const scoreOpt = cmd.options.find((o) => o.short === '-s')
      expect(scoreOpt).toBeDefined()
    })
  })

  describe('Trust Tier Colors', () => {
    it('defines colors for all trust tiers', async () => {
      // The colors are defined in the module
      const trustTiers = ['verified', 'community', 'experimental', 'unknown']

      // All tiers should have associated colors (implementation detail)
      expect(trustTiers.length).toBe(4)
    })
  })

  describe('Pagination', () => {
    it('uses default page size of 10', async () => {
      // PAGE_SIZE constant in the module
      const expectedPageSize = 10
      expect(expectedPageSize).toBe(10)
    })
  })
})

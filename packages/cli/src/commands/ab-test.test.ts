/**
 * SMI-1916: A/B Testing Command Tests
 *
 * Tests for the ab-test CLI command with tier-based feature gating.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createAbTestCommand, runAbTest, type AbTestOptions } from './ab-test.js'

// Mock the license validation module
vi.mock('../utils/license-validation.js', () => ({
  tryLoadEnterpriseValidator: vi.fn(),
}))

// Mock sanitizeError
vi.mock('../utils/sanitize.js', () => ({
  sanitizeError: vi.fn((err: unknown) => (err instanceof Error ? err.message : String(err))),
}))

// Import mocked module
import { tryLoadEnterpriseValidator } from '../utils/license-validation.js'
const mockTryLoadEnterpriseValidator = vi.mocked(tryLoadEnterpriseValidator)

describe('ab-test command', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>
  let processExitSpy: ReturnType<typeof vi.spyOn>
  let originalEnv: NodeJS.ProcessEnv

  beforeEach(() => {
    // Save original env
    originalEnv = { ...process.env }

    // Spy on console methods
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    // Mock process.exit to throw instead of exiting
    processExitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((code?: string | number | null | undefined) => {
        throw new Error(`process.exit(${code})`)
      })

    // Reset mocks
    vi.clearAllMocks()
  })

  afterEach(() => {
    // Restore original env
    process.env = originalEnv

    // Restore spies
    consoleLogSpy.mockRestore()
    consoleErrorSpy.mockRestore()
    processExitSpy.mockRestore()
  })

  describe('createAbTestCommand', () => {
    it('should create a command with correct name and description', () => {
      const cmd = createAbTestCommand()

      expect(cmd.name()).toBe('ab-test')
      expect(cmd.description()).toContain('A/B testing experiments')
      expect(cmd.description()).toContain('Team+ tier')
    })

    it('should have required options', () => {
      const cmd = createAbTestCommand()
      const options = cmd.options

      const optionNames = options.map((opt) => opt.long)
      expect(optionNames).toContain('--skill')
      expect(optionNames).toContain('--iterations')
      expect(optionNames).toContain('--output')
      expect(optionNames).toContain('--json')
    })

    it('should have default values for iterations and output', () => {
      const cmd = createAbTestCommand()
      const options = cmd.options

      const iterationsOpt = options.find((opt) => opt.long === '--iterations')
      const outputOpt = options.find((opt) => opt.long === '--output')

      expect(iterationsOpt?.defaultValue).toBe('10')
      expect(outputOpt?.defaultValue).toBe('docs/research/ab-test')
    })
  })

  describe('runAbTest - tier gating', () => {
    const defaultOptions: AbTestOptions = {
      skill: 'governance',
      iterations: 10,
      output: 'docs/research/ab-test',
      json: false,
    }

    it('should show upgrade prompt for community tier (no license key)', async () => {
      // No license key
      delete process.env['SKILLSMITH_LICENSE_KEY']
      mockTryLoadEnterpriseValidator.mockResolvedValue(null)

      await expect(runAbTest(defaultOptions)).rejects.toThrow('process.exit(1)')

      // Verify upgrade prompt was shown
      const logCalls = consoleLogSpy.mock.calls.flat().join('\n')
      expect(logCalls).toContain('A/B Testing requires Team tier or higher')
      expect(logCalls).toContain('community')
      expect(logCalls).toContain('Team tier')
      expect(logCalls).toContain('$25/user/mo')
    })

    it('should show JSON upgrade prompt when --json flag is set', async () => {
      delete process.env['SKILLSMITH_LICENSE_KEY']
      mockTryLoadEnterpriseValidator.mockResolvedValue(null)

      const jsonOptions: AbTestOptions = { ...defaultOptions, json: true }
      await expect(runAbTest(jsonOptions)).rejects.toThrow('process.exit(1)')

      // Verify JSON output
      const logCalls = consoleLogSpy.mock.calls.flat()
      const jsonOutput = logCalls.find(
        (call: unknown) => typeof call === 'string' && call.includes('{')
      )

      expect(jsonOutput).toBeDefined()
      const parsed = JSON.parse(jsonOutput as string)
      expect(parsed.error).toBe('upgrade_required')
      expect(parsed.feature).toBe('ab_testing')
      expect(parsed.requiredTier).toBe('team')
    })

    it('should show upgrade prompt for individual tier', async () => {
      process.env['SKILLSMITH_LICENSE_KEY'] = 'test-key'

      const mockValidator = {
        validate: vi.fn().mockResolvedValue({
          valid: true,
          license: { tier: 'individual', features: [] },
        }),
      }
      mockTryLoadEnterpriseValidator.mockResolvedValue(mockValidator)

      await expect(runAbTest(defaultOptions)).rejects.toThrow('process.exit(1)')

      const logCalls = consoleLogSpy.mock.calls.flat().join('\n')
      expect(logCalls).toContain('A/B Testing requires Team tier or higher')
      expect(logCalls).toContain('individual')
    })

    it('should allow team tier users', async () => {
      process.env['SKILLSMITH_LICENSE_KEY'] = 'team-key'

      const mockValidator = {
        validate: vi.fn().mockResolvedValue({
          valid: true,
          license: { tier: 'team', features: ['ab_testing'] },
        }),
      }
      mockTryLoadEnterpriseValidator.mockResolvedValue(mockValidator)

      // Should not throw - team tier has access
      await runAbTest(defaultOptions)

      const logCalls = consoleLogSpy.mock.calls.flat().join('\n')
      expect(logCalls).toContain('A/B testing infrastructure is ready')
      expect(logCalls).toContain('Tier: team')
    })

    it('should allow enterprise tier users', async () => {
      process.env['SKILLSMITH_LICENSE_KEY'] = 'enterprise-key'

      const mockValidator = {
        validate: vi.fn().mockResolvedValue({
          valid: true,
          license: { tier: 'enterprise', features: ['ab_testing'] },
        }),
      }
      mockTryLoadEnterpriseValidator.mockResolvedValue(mockValidator)

      await runAbTest(defaultOptions)

      const logCalls = consoleLogSpy.mock.calls.flat().join('\n')
      expect(logCalls).toContain('A/B testing infrastructure is ready')
      expect(logCalls).toContain('Tier: enterprise')
    })

    it('should treat invalid license as community tier', async () => {
      process.env['SKILLSMITH_LICENSE_KEY'] = 'invalid-key'

      const mockValidator = {
        validate: vi.fn().mockResolvedValue({
          valid: false,
          error: { code: 'INVALID_TOKEN', message: 'Invalid' },
        }),
      }
      mockTryLoadEnterpriseValidator.mockResolvedValue(mockValidator)

      await expect(runAbTest(defaultOptions)).rejects.toThrow('process.exit(1)')

      const logCalls = consoleLogSpy.mock.calls.flat().join('\n')
      expect(logCalls).toContain('community')
    })

    it('should handle validator errors gracefully', async () => {
      process.env['SKILLSMITH_LICENSE_KEY'] = 'test-key'

      const mockValidator = {
        validate: vi.fn().mockRejectedValue(new Error('Network error')),
      }
      mockTryLoadEnterpriseValidator.mockResolvedValue(mockValidator)

      await expect(runAbTest(defaultOptions)).rejects.toThrow('process.exit(1)')

      const logCalls = consoleLogSpy.mock.calls.flat().join('\n')
      expect(logCalls).toContain('community')
    })
  })

  describe('runAbTest - input validation', () => {
    beforeEach(() => {
      // Set up team tier for these tests
      process.env['SKILLSMITH_LICENSE_KEY'] = 'team-key'

      const mockValidator = {
        validate: vi.fn().mockResolvedValue({
          valid: true,
          license: { tier: 'team', features: ['ab_testing'] },
        }),
      }
      mockTryLoadEnterpriseValidator.mockResolvedValue(mockValidator)
    })

    it('should require skill name', async () => {
      const optionsWithoutSkill: AbTestOptions = {
        skill: undefined,
        iterations: 10,
        output: 'docs/research/ab-test',
        json: false,
      }

      await expect(runAbTest(optionsWithoutSkill)).rejects.toThrow('process.exit(1)')

      const errorCalls = consoleErrorSpy.mock.calls.flat().join('\n')
      expect(errorCalls).toContain('Skill name is required')
    })

    it('should return JSON error when skill missing with --json', async () => {
      const optionsWithoutSkill: AbTestOptions = {
        skill: undefined,
        iterations: 10,
        output: 'docs/research/ab-test',
        json: true,
      }

      await expect(runAbTest(optionsWithoutSkill)).rejects.toThrow('process.exit(1)')

      const logCalls = consoleLogSpy.mock.calls.flat()
      const jsonOutput = logCalls.find(
        (call: unknown) => typeof call === 'string' && call.includes('error')
      )

      expect(jsonOutput).toBeDefined()
      const parsed = JSON.parse(jsonOutput as string)
      expect(parsed.error).toContain('Skill name is required')
    })

    it('should use default iterations when not specified', async () => {
      const options: AbTestOptions = {
        skill: 'test-skill',
        iterations: undefined,
        output: 'docs/research/ab-test',
        json: true,
      }

      await runAbTest(options)

      const logCalls = consoleLogSpy.mock.calls.flat()
      const jsonOutput = logCalls.find(
        (call: unknown) => typeof call === 'string' && call.includes('iterations')
      )

      expect(jsonOutput).toBeDefined()
      const parsed = JSON.parse(jsonOutput as string)
      expect(parsed.iterations).toBe(10)
    })
  })

  describe('runAbTest - JSON output', () => {
    beforeEach(() => {
      process.env['SKILLSMITH_LICENSE_KEY'] = 'team-key'

      const mockValidator = {
        validate: vi.fn().mockResolvedValue({
          valid: true,
          license: { tier: 'team', features: ['ab_testing'] },
        }),
      }
      mockTryLoadEnterpriseValidator.mockResolvedValue(mockValidator)
    })

    it('should output valid JSON when --json flag is set', async () => {
      const options: AbTestOptions = {
        skill: 'governance',
        iterations: 5,
        output: 'custom/output',
        json: true,
      }

      await runAbTest(options)

      const logCalls = consoleLogSpy.mock.calls.flat()
      const jsonOutput = logCalls.find(
        (call: unknown) => typeof call === 'string' && call.includes('{')
      )

      expect(jsonOutput).toBeDefined()
      const parsed = JSON.parse(jsonOutput as string)
      expect(parsed.status).toBe('ready')
      expect(parsed.skill).toBe('governance')
      expect(parsed.iterations).toBe(5)
      expect(parsed.outputDir).toBe('custom/output')
      expect(parsed.manualCommand).toContain('governance')
    })
  })
})

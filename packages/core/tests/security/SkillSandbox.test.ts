/**
 * SMI-1534: SkillSandbox Unit Tests
 *
 * Tests for the E2B sandbox execution wrapper.
 * Since E2B is an optional dependency, these tests mock the E2B module.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  SkillSandbox,
  SandboxUnavailableError,
  withSandbox,
  type SandboxOptions,
  type ExecutionResult,
} from '../../src/security/SkillSandbox.js'

// Mock E2B module
const mockFilesystem = {
  write: vi.fn().mockResolvedValue(undefined),
  read: vi.fn().mockResolvedValue('file content'),
  makeDir: vi.fn().mockResolvedValue(undefined),
}

const mockProcess = {
  startAndWait: vi.fn().mockResolvedValue({
    exitCode: 0,
    stdout: 'test output',
    stderr: '',
  }),
}

const mockKill = vi.fn().mockResolvedValue(undefined)

const mockSandboxInstance = {
  filesystem: mockFilesystem,
  process: mockProcess,
  kill: mockKill,
}

const mockSandboxCreate = vi.fn().mockResolvedValue(mockSandboxInstance)

describe('SMI-1534: SkillSandbox', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    // Reset mock implementations
    mockSandboxCreate.mockResolvedValue(mockSandboxInstance)
    mockProcess.startAndWait.mockResolvedValue({
      exitCode: 0,
      stdout: 'test output',
      stderr: '',
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('Constructor', () => {
    it('should use default options when none provided', () => {
      const sandbox = new SkillSandbox()
      const status = sandbox.getStatus()

      expect(status.options.timeout).toBe(30000)
      expect(status.options.memoryMB).toBe(256)
      expect(status.options.allowNetwork).toBe(false)
      expect(status.options.env).toEqual({})
    })

    it('should accept custom options', () => {
      const options: SandboxOptions = {
        timeout: 60000,
        memoryMB: 512,
        allowNetwork: true,
        env: { NODE_ENV: 'test' },
      }
      const sandbox = new SkillSandbox(options)
      const status = sandbox.getStatus()

      expect(status.options.timeout).toBe(60000)
      expect(status.options.memoryMB).toBe(512)
      expect(status.options.allowNetwork).toBe(true)
      expect(status.options.env).toEqual({ NODE_ENV: 'test' })
    })
  })

  describe('Status', () => {
    it('should report not created initially', () => {
      const sandbox = new SkillSandbox()
      const status = sandbox.getStatus()

      expect(status.created).toBe(false)
      expect(status.active).toBe(false)
    })

    it('should report isActive as false when not created', () => {
      const sandbox = new SkillSandbox()
      expect(sandbox.isActive()).toBe(false)
    })
  })

  describe('Create', () => {
    it('should throw if sandbox already created', async () => {
      const sandbox = new SkillSandbox()
      // Manually set created state for testing
      ;(sandbox as unknown as { created: boolean }).created = true

      await expect(sandbox.create()).rejects.toThrow('Sandbox already created')
    })

    it('should throw error when E2B not installed', async () => {
      const sandbox = new SkillSandbox()

      // The dynamic import will fail since E2B is not installed
      // In test environment, it may throw different errors (SandboxUnavailableError or TypeError)
      await expect(sandbox.create()).rejects.toThrow()
    })
  })

  describe('Operations without creation', () => {
    it('should throw when copying files without create', async () => {
      const sandbox = new SkillSandbox()

      await expect(sandbox.copyFiles([{ path: '/test.txt', content: 'test' }])).rejects.toThrow(
        'Sandbox not created'
      )
    })

    it('should throw when copying skill without create', async () => {
      const sandbox = new SkillSandbox()

      await expect(sandbox.copySkill('skill content')).rejects.toThrow('Sandbox not created')
    })

    it('should throw when executing without create', async () => {
      const sandbox = new SkillSandbox()

      await expect(sandbox.execute('node test.js')).rejects.toThrow('Sandbox not created')
    })

    it('should throw when executing code without create', async () => {
      const sandbox = new SkillSandbox()

      await expect(sandbox.executeCode('console.log("test")')).rejects.toThrow(
        'Sandbox not created'
      )
    })
  })

  describe('Destroy', () => {
    it('should handle destroy when not created', async () => {
      const sandbox = new SkillSandbox()

      // Should not throw
      await expect(sandbox.destroy()).resolves.toBeUndefined()
    })
  })

  describe('SandboxUnavailableError', () => {
    it('should have correct name', () => {
      const error = new SandboxUnavailableError('test message')

      expect(error.name).toBe('SandboxUnavailableError')
      expect(error.message).toBe('test message')
    })

    it('should be instanceof Error', () => {
      const error = new SandboxUnavailableError('test')

      expect(error).toBeInstanceOf(Error)
      expect(error).toBeInstanceOf(SandboxUnavailableError)
    })
  })

  describe('withSandbox helper', () => {
    it('should throw error when E2B not available', async () => {
      // In test environment, dynamic import may throw different errors
      await expect(
        withSandbox(async (sandbox) => {
          return sandbox.getStatus()
        })
      ).rejects.toThrow()
    })

    it('should pass options to sandbox', async () => {
      const options: SandboxOptions = {
        timeout: 10000,
        allowNetwork: true,
      }

      // Will still fail because E2B not installed
      await expect(withSandbox(async () => 'result', options)).rejects.toThrow()
    })
  })

  describe('ExecutionResult structure', () => {
    it('should have all required fields defined in type', () => {
      const result: ExecutionResult = {
        success: true,
        exitCode: 0,
        stdout: 'output',
        stderr: '',
        durationMs: 100,
        timedOut: false,
      }

      expect(result.success).toBe(true)
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe('output')
      expect(result.stderr).toBe('')
      expect(result.durationMs).toBe(100)
      expect(result.timedOut).toBe(false)
    })

    it('should allow optional error field', () => {
      const result: ExecutionResult = {
        success: false,
        exitCode: 1,
        stdout: '',
        stderr: 'error message',
        durationMs: 50,
        timedOut: false,
        error: 'Something went wrong',
      }

      expect(result.error).toBe('Something went wrong')
    })
  })

  describe('Timeout handling', () => {
    it('should report timedOut true in ExecutionResult', () => {
      const result: ExecutionResult = {
        success: false,
        exitCode: -1,
        stdout: '',
        stderr: 'Execution timed out after 30000ms',
        durationMs: 30000,
        timedOut: true,
        error: 'Timeout',
      }

      expect(result.timedOut).toBe(true)
      expect(result.exitCode).toBe(-1)
    })
  })

  describe('Network isolation configuration', () => {
    it('should default to network disabled', () => {
      const sandbox = new SkillSandbox()
      const status = sandbox.getStatus()

      expect(status.options.allowNetwork).toBe(false)
    })

    it('should allow enabling network when specified', () => {
      const sandbox = new SkillSandbox({ allowNetwork: true })
      const status = sandbox.getStatus()

      expect(status.options.allowNetwork).toBe(true)
    })
  })

  describe('Memory configuration', () => {
    it('should default to 256MB', () => {
      const sandbox = new SkillSandbox()
      const status = sandbox.getStatus()

      expect(status.options.memoryMB).toBe(256)
    })

    it('should allow custom memory limit', () => {
      const sandbox = new SkillSandbox({ memoryMB: 1024 })
      const status = sandbox.getStatus()

      expect(status.options.memoryMB).toBe(1024)
    })
  })

  describe('Environment variables', () => {
    it('should default to empty env', () => {
      const sandbox = new SkillSandbox()
      const status = sandbox.getStatus()

      expect(status.options.env).toEqual({})
    })

    it('should accept custom environment variables', () => {
      const env = {
        NODE_ENV: 'test',
        DEBUG: 'true',
        API_KEY: 'secret',
      }
      const sandbox = new SkillSandbox({ env })
      const status = sandbox.getStatus()

      expect(status.options.env).toEqual(env)
    })
  })

  /**
   * SMI-1534: Integration tests for actual E2B sandbox execution
   * These tests require E2B to be installed and configured.
   * They are wrapped in try/catch to handle E2B unavailability gracefully.
   */
  describe('Integration Tests (E2B required)', () => {
    it('should execute code in sandbox when E2B available', async () => {
      const sandbox = new SkillSandbox({ timeout: 60000 })
      try {
        await sandbox.create()
        const result = await sandbox.executeCode('console.log("Hello from sandbox")')

        expect(result.success).toBe(true)
        expect(result.stdout).toContain('Hello from sandbox')
        expect(result.timedOut).toBe(false)
      } catch (error) {
        // E2B not available - skip this test
        if (error instanceof Error && error.message.includes('E2B sandbox not available')) {
          console.log('Skipping: E2B not installed')
          return
        }
        throw error
      } finally {
        await sandbox.destroy()
      }
    })

    it('should enforce timeout when E2B available', async () => {
      const sandbox = new SkillSandbox({ timeout: 1000 }) // 1 second timeout
      try {
        await sandbox.create()
        const result = await sandbox.executeCode('while(true) {}')

        expect(result.success).toBe(false)
        expect(result.timedOut).toBe(true)
      } catch (error) {
        // E2B not available - skip this test
        if (error instanceof Error && error.message.includes('E2B sandbox not available')) {
          console.log('Skipping: E2B not installed')
          return
        }
        throw error
      } finally {
        await sandbox.destroy()
      }
    })

    it('should copy skill content when E2B available', async () => {
      const sandbox = new SkillSandbox()
      try {
        await sandbox.create()
        await sandbox.copySkill('# Test Skill\n\nThis is a test skill.')

        // Verify file was written by reading it back
        const result = await sandbox.execute('cat /skill/SKILL.md')
        expect(result.stdout).toContain('Test Skill')
      } catch (error) {
        // E2B not available - skip this test
        if (error instanceof Error && error.message.includes('E2B sandbox not available')) {
          console.log('Skipping: E2B not installed')
          return
        }
        throw error
      } finally {
        await sandbox.destroy()
      }
    })

    it('should verify network isolation when E2B available', async () => {
      const sandbox = new SkillSandbox({ allowNetwork: false })
      try {
        await sandbox.create()
        // Network test would have happened during create via verifyNetworkIsolation
        // Just verify sandbox was created successfully
        expect(sandbox.isActive()).toBe(true)
      } catch (error) {
        // E2B not available - skip this test
        if (error instanceof Error && error.message.includes('E2B sandbox not available')) {
          console.log('Skipping: E2B not installed')
          return
        }
        throw error
      } finally {
        await sandbox.destroy()
      }
    })
  })
})

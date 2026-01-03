/**
 * E2E Test: skillsmith list, update, remove commands
 *
 * Tests skill management commands in a clean Codespace environment.
 *
 * User Journey: Manage installed skills
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { spawn } from 'child_process'
import { existsSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { tmpdir, homedir } from 'os'
import { fileURLToPath } from 'url'

// ESM compatibility for __dirname
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
import { scanCommandOutput } from './utils/hardcoded-detector.js'
import { recordTiming } from './utils/baseline-collector.js'
import { queueIssue, type TestFailure } from './utils/linear-reporter.js'

// Test configuration
const TEST_DIR = join(tmpdir(), 'skillsmith-e2e-manage')
const TEST_SKILLS_DIR = join(TEST_DIR, '.claude', 'skills')
const CLI_PATH = join(__dirname, '../../dist/src/index.js')

// Mock skill for testing
const MOCK_SKILL = {
  name: 'test-skill',
  content: `# test-skill

A test skill for E2E testing.

## Triggers
- "test trigger"
- "run test"

## Instructions
This is a mock skill for E2E testing purposes.
`,
}

interface CommandResult {
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
}

/**
 * Execute CLI command with custom HOME
 */
async function runCommand(args: string[], timeoutMs = 30000): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const startTime = Date.now()
    let stdout = ''
    let stderr = ''

    const proc = spawn('node', [CLI_PATH, ...args], {
      env: {
        ...process.env,
        NODE_ENV: 'test',
        SKILLSMITH_E2E: 'true',
        // Override HOME to use test directory
        HOME: TEST_DIR,
        USERPROFILE: TEST_DIR, // Windows
      },
    })

    const timeout = setTimeout(() => {
      proc.kill('SIGTERM')
      reject(new Error(`Command timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    proc.stdout.on('data', (data) => {
      stdout += data.toString()
    })

    proc.stderr.on('data', (data) => {
      stderr += data.toString()
    })

    proc.on('close', (code) => {
      clearTimeout(timeout)
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr,
        durationMs: Date.now() - startTime,
      })
    })

    proc.on('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
  })
}

/**
 * Assert no hardcoded values in command output
 */
function assertNoHardcoded(
  result: CommandResult,
  command: string,
  testName: string,
  testFile: string
): void {
  const detection = scanCommandOutput(result.stdout, result.stderr, command)

  if (!detection.passed) {
    const failure: TestFailure = {
      testName,
      testFile,
      command,
      error: `Hardcoded values detected`,
      stdout: result.stdout,
      stderr: result.stderr,
      hardcodedIssues: detection.issues,
      duration: result.durationMs,
      timestamp: new Date().toISOString(),
    }
    queueIssue(failure)

    const errorDetails = detection.issues
      .filter((i) => i.severity === 'error')
      .map((i) => `  - ${i.type}: ${i.value}`)
      .join('\n')

    expect.fail(`Hardcoded values detected:\n${errorDetails}`)
  }
}

/**
 * Install a mock skill for testing
 */
function installMockSkill(skillName: string): void {
  const skillDir = join(TEST_SKILLS_DIR, skillName)
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(join(skillDir, 'SKILL.md'), MOCK_SKILL.content)
}

describe('E2E: skillsmith list', () => {
  beforeAll(() => {
    // Create test directory structure
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true })
    }
    mkdirSync(TEST_SKILLS_DIR, { recursive: true })
  })

  afterAll(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true })
    }
  })

  describe('List Command', () => {
    it('should display help without errors', async () => {
      const result = await runCommand(['list', '--help'])

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('List')

      assertNoHardcoded(result, 'skillsmith list --help', 'list: help', __filename)
    })

    it('should handle empty skills directory', async () => {
      // Ensure skills dir is empty
      rmSync(TEST_SKILLS_DIR, { recursive: true, force: true })
      mkdirSync(TEST_SKILLS_DIR, { recursive: true })

      const result = await runCommand(['list'])

      recordTiming('list:empty', 'skillsmith list (empty)', result.durationMs)

      // Should not crash
      expect(result.exitCode).toBe(0)

      assertNoHardcoded(result, 'skillsmith list', 'list: empty dir', __filename)
    })

    it('should list installed skills', async () => {
      // Install mock skills
      installMockSkill('test-skill-1')
      installMockSkill('test-skill-2')

      const result = await runCommand(['list'])

      recordTiming('list:skills', 'skillsmith list', result.durationMs)

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('test-skill-1')
      expect(result.stdout).toContain('test-skill-2')

      assertNoHardcoded(result, 'skillsmith list', 'list: with skills', __filename)
    })

    it('should not expose real home directory path', async () => {
      installMockSkill('path-test-skill')

      const result = await runCommand(['list'])

      const output = result.stdout + result.stderr
      const realHome = homedir()

      // Should not contain actual home path
      expect(output).not.toContain(realHome)
      expect(output).not.toMatch(/\/Users\/[a-zA-Z0-9_-]+\//)
    })
  })

  describe('List Aliases', () => {
    it('should work with ls alias', async () => {
      const result = await runCommand(['ls'])

      expect(result.exitCode).toBe(0)

      assertNoHardcoded(result, 'skillsmith ls', 'list: ls alias', __filename)
    })
  })
})

describe('E2E: skillsmith update', () => {
  beforeAll(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true })
    }
    mkdirSync(TEST_SKILLS_DIR, { recursive: true })
  })

  afterAll(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true })
    }
  })

  describe('Update Command', () => {
    it('should display help without errors', async () => {
      const result = await runCommand(['update', '--help'])

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('Update')

      assertNoHardcoded(result, 'skillsmith update --help', 'update: help', __filename)
    })

    it('should handle update with no skills installed', async () => {
      rmSync(TEST_SKILLS_DIR, { recursive: true, force: true })
      mkdirSync(TEST_SKILLS_DIR, { recursive: true })

      const result = await runCommand(['update', '-a'])

      // Should not crash
      expect(result.exitCode).toBe(0)

      assertNoHardcoded(result, 'skillsmith update -a', 'update: no skills', __filename)
    })

    it('should handle update specific skill', async () => {
      installMockSkill('update-test-skill')

      const result = await runCommand(['update', 'update-test-skill'])

      recordTiming('update:single', 'skillsmith update skill', result.durationMs)

      // May fail if skill not in registry, but should not expose paths
      assertNoHardcoded(result, 'skillsmith update skill', 'update: specific skill', __filename)
    })

    it('should handle update all with -a flag', async () => {
      installMockSkill('update-all-test')

      const result = await runCommand(['update', '-a'])

      recordTiming('update:all', 'skillsmith update -a', result.durationMs)

      assertNoHardcoded(result, 'skillsmith update -a', 'update: all', __filename)
    })
  })
})

describe('E2E: skillsmith remove', () => {
  beforeEach(() => {
    // Reset skills directory for each test
    if (existsSync(TEST_SKILLS_DIR)) {
      rmSync(TEST_SKILLS_DIR, { recursive: true, force: true })
    }
    mkdirSync(TEST_SKILLS_DIR, { recursive: true })
  })

  afterAll(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true })
    }
  })

  describe('Remove Command', () => {
    it('should display help without errors', async () => {
      const result = await runCommand(['remove', '--help'])

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('Remove')

      assertNoHardcoded(result, 'skillsmith remove --help', 'remove: help', __filename)
    })

    it('should remove installed skill with -f flag', async () => {
      installMockSkill('to-remove')

      // Verify installed
      expect(existsSync(join(TEST_SKILLS_DIR, 'to-remove'))).toBe(true)

      const result = await runCommand(['remove', 'to-remove', '-f'])

      recordTiming('remove:skill', 'skillsmith remove skill -f', result.durationMs)

      expect(result.exitCode).toBe(0)

      // Verify removed
      expect(existsSync(join(TEST_SKILLS_DIR, 'to-remove'))).toBe(false)

      assertNoHardcoded(result, 'skillsmith remove skill', 'remove: skill', __filename)
    })

    it('should handle removing non-existent skill', async () => {
      const result = await runCommand(['remove', 'nonexistent-skill', '-f'])

      // Should fail gracefully
      expect(result.exitCode).not.toBe(0)

      assertNoHardcoded(result, 'skillsmith remove nonexistent', 'remove: nonexistent', __filename)
    })

    it('should work with rm alias', async () => {
      installMockSkill('rm-test')

      const result = await runCommand(['rm', 'rm-test', '-f'])

      expect(result.exitCode).toBe(0)

      assertNoHardcoded(result, 'skillsmith rm', 'remove: rm alias', __filename)
    })

    it('should work with uninstall alias', async () => {
      installMockSkill('uninstall-test')

      const result = await runCommand(['uninstall', 'uninstall-test', '-f'])

      expect(result.exitCode).toBe(0)

      assertNoHardcoded(result, 'skillsmith uninstall', 'remove: uninstall alias', __filename)
    })
  })

  describe('Hardcoded Value Regression', () => {
    it('should not expose skill installation paths', async () => {
      installMockSkill('path-check')

      const result = await runCommand(['remove', 'path-check', '-f'])

      const output = result.stdout + result.stderr

      // Should not contain real paths
      expect(output).not.toMatch(/\/Users\/[a-zA-Z0-9_-]+\/\.claude/)
      expect(output).not.toMatch(/\/home\/[a-zA-Z0-9_-]+\/\.claude/)
    })
  })
})

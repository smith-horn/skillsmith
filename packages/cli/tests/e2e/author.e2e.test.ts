/**
 * E2E Test: skillsmith init, validate, publish commands
 *
 * Tests skill authoring commands in a clean Codespace environment.
 *
 * User Journey: Create and publish custom skills
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { spawn } from 'child_process'
import { existsSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs'
import { join, dirname } from 'path'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'
import { scanCommandOutput } from './utils/hardcoded-detector.js'
import { recordTiming } from './utils/baseline-collector.js'
import { queueIssue, type TestFailure } from './utils/linear-reporter.js'

// ESM compatibility for __dirname
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Test configuration
const TEST_DIR = join(tmpdir(), 'skillsmith-e2e-author')
const CLI_PATH = join(__dirname, '../../dist/src/index.js')

// Valid SKILL.md content for validation tests
const VALID_SKILL_MD = `---
name: test-skill
version: 1.0.0
description: A test skill for E2E testing
author: test-author
triggers:
  - test trigger
  - run test
---

# test-skill

A test skill for E2E testing purposes.

## Usage

Use this skill to test things.

## Examples

\`\`\`
test example
\`\`\`
`

// Invalid SKILL.md for error testing
const INVALID_SKILL_MD = `
# Missing Frontmatter

This skill has no frontmatter and should fail validation.
`

interface CommandResult {
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
}

/**
 * Execute CLI command
 */
async function runCommand(args: string[], cwd?: string, timeoutMs = 30000): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const startTime = Date.now()
    let stdout = ''
    let stderr = ''

    const proc = spawn('node', [CLI_PATH, ...args], {
      cwd: cwd || TEST_DIR,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        SKILLSMITH_E2E: 'true',
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

describe('E2E: skillsmith init', () => {
  beforeEach(() => {
    // Reset test directory for each test
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true })
    }
    mkdirSync(TEST_DIR, { recursive: true })
  })

  afterAll(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true })
    }
  })

  describe('Init Command', () => {
    it('should display help without errors', async () => {
      const result = await runCommand(['init', '--help'])

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('Initialize')

      assertNoHardcoded(result, 'skillsmith init --help', 'init: help', __filename)
    })

    // Skip: The init command uses inquirer for interactive prompts which cannot be automated in E2E tests
    it.skip('should create skill scaffold with name', async () => {
      const result = await runCommand(['init', 'my-new-skill'])

      recordTiming('init:named', 'skillsmith init name', result.durationMs)

      expect(result.exitCode).toBe(0)

      // Verify created files
      const skillDir = join(TEST_DIR, 'my-new-skill')
      expect(existsSync(skillDir)).toBe(true)
      expect(existsSync(join(skillDir, 'SKILL.md'))).toBe(true)
      expect(existsSync(join(skillDir, 'README.md'))).toBe(true)

      assertNoHardcoded(result, 'skillsmith init name', 'init: create skill', __filename)
    })

    // Skip: The init command uses inquirer for interactive prompts which cannot be automated in E2E tests
    it.skip('should create skill scaffold with custom path', async () => {
      const customPath = join(TEST_DIR, 'custom-skills')
      mkdirSync(customPath, { recursive: true })

      const result = await runCommand(['init', 'path-skill', '-p', customPath])

      expect(result.exitCode).toBe(0)

      // Verify created at custom path
      expect(existsSync(join(customPath, 'path-skill', 'SKILL.md'))).toBe(true)

      assertNoHardcoded(result, 'skillsmith init -p custom', 'init: custom path', __filename)
    })

    // Skip: The init command uses inquirer for interactive prompts which cannot be automated in E2E tests
    it.skip('should create resources directory', async () => {
      const result = await runCommand(['init', 'resource-skill'])

      expect(result.exitCode).toBe(0)

      const resourceDir = join(TEST_DIR, 'resource-skill', 'resources')
      expect(existsSync(resourceDir)).toBe(true)

      assertNoHardcoded(result, 'skillsmith init resources', 'init: resources dir', __filename)
    })

    // Skip: The init command uses inquirer for interactive prompts which cannot be automated in E2E tests
    it.skip('should create scripts directory with example', async () => {
      const result = await runCommand(['init', 'script-skill'])

      expect(result.exitCode).toBe(0)

      const scriptsDir = join(TEST_DIR, 'script-skill', 'scripts')
      expect(existsSync(scriptsDir)).toBe(true)
      expect(existsSync(join(scriptsDir, 'example.js'))).toBe(true)

      assertNoHardcoded(result, 'skillsmith init scripts', 'init: scripts dir', __filename)
    })

    // Skip: The init command uses inquirer for interactive prompts which cannot be automated in E2E tests
    it.skip('should handle existing directory gracefully', async () => {
      // Create skill first
      await runCommand(['init', 'existing-skill'])

      // Try to create again
      const result = await runCommand(['init', 'existing-skill'])

      // Should fail or warn
      assertNoHardcoded(result, 'skillsmith init existing', 'init: existing dir', __filename)
    })

    // Skip: The init command uses inquirer for interactive prompts which cannot be automated in E2E tests
    it.skip('should not contain hardcoded paths in generated files', async () => {
      const result = await runCommand(['init', 'path-check-skill'])

      expect(result.exitCode).toBe(0)

      // Read generated SKILL.md
      const skillMd = readFileSync(join(TEST_DIR, 'path-check-skill', 'SKILL.md'), 'utf-8')

      // Should not contain hardcoded paths
      expect(skillMd).not.toMatch(/\/Users\/[a-zA-Z0-9_-]+\//)
      expect(skillMd).not.toMatch(/\/home\/[a-zA-Z0-9_-]+\//)
    })
  })
})

describe('E2E: skillsmith validate', () => {
  beforeAll(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true })
    }
    mkdirSync(TEST_DIR, { recursive: true })
  })

  afterAll(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true })
    }
  })

  describe('Validate Command', () => {
    it('should display help without errors', async () => {
      const result = await runCommand(['validate', '--help'])

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('Validate')

      assertNoHardcoded(result, 'skillsmith validate --help', 'validate: help', __filename)
    })

    it('should validate valid SKILL.md', async () => {
      // Create valid skill
      const skillDir = join(TEST_DIR, 'valid-skill')
      mkdirSync(skillDir, { recursive: true })
      writeFileSync(join(skillDir, 'SKILL.md'), VALID_SKILL_MD)

      const result = await runCommand(['validate', skillDir])

      recordTiming('validate:valid', 'skillsmith validate valid', result.durationMs)

      expect(result.exitCode).toBe(0)

      assertNoHardcoded(result, 'skillsmith validate valid', 'validate: valid skill', __filename)
    })

    it('should reject invalid SKILL.md', async () => {
      // Create invalid skill
      const skillDir = join(TEST_DIR, 'invalid-skill')
      mkdirSync(skillDir, { recursive: true })
      writeFileSync(join(skillDir, 'SKILL.md'), INVALID_SKILL_MD)

      const result = await runCommand(['validate', skillDir])

      recordTiming('validate:invalid', 'skillsmith validate invalid', result.durationMs)

      // Should fail
      expect(result.exitCode).not.toBe(0)

      assertNoHardcoded(
        result,
        'skillsmith validate invalid',
        'validate: invalid skill',
        __filename
      )
    })

    it('should handle missing SKILL.md', async () => {
      const emptyDir = join(TEST_DIR, 'empty-dir')
      mkdirSync(emptyDir, { recursive: true })

      const result = await runCommand(['validate', emptyDir])

      // Should fail with appropriate error
      expect(result.exitCode).not.toBe(0)

      assertNoHardcoded(result, 'skillsmith validate missing', 'validate: missing file', __filename)
    })

    it('should validate current directory by default', async () => {
      // Create skill in test dir root
      writeFileSync(join(TEST_DIR, 'SKILL.md'), VALID_SKILL_MD)

      const result = await runCommand(['validate'], TEST_DIR)

      expect(result.exitCode).toBe(0)

      assertNoHardcoded(result, 'skillsmith validate .', 'validate: current dir', __filename)
    })

    it('should output parsed metadata', async () => {
      const skillDir = join(TEST_DIR, 'metadata-skill')
      mkdirSync(skillDir, { recursive: true })
      writeFileSync(join(skillDir, 'SKILL.md'), VALID_SKILL_MD)

      const result = await runCommand(['validate', skillDir])

      expect(result.exitCode).toBe(0)

      // Should show parsed metadata
      const output = result.stdout
      expect(output).toContain('test-skill')

      assertNoHardcoded(
        result,
        'skillsmith validate metadata',
        'validate: metadata output',
        __filename
      )
    })
  })
})

describe('E2E: skillsmith publish', () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true })
    }
    mkdirSync(TEST_DIR, { recursive: true })
  })

  afterAll(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true })
    }
  })

  describe('Publish Command', () => {
    it('should display help without errors', async () => {
      const result = await runCommand(['publish', '--help'])

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('Prepare')

      assertNoHardcoded(result, 'skillsmith publish --help', 'publish: help', __filename)
    })

    it('should prepare valid skill for publishing', async () => {
      // Create valid skill
      const skillDir = join(TEST_DIR, 'publish-skill')
      mkdirSync(skillDir, { recursive: true })
      writeFileSync(join(skillDir, 'SKILL.md'), VALID_SKILL_MD)

      const result = await runCommand(['publish', skillDir])

      recordTiming('publish:prepare', 'skillsmith publish', result.durationMs)

      expect(result.exitCode).toBe(0)

      // Should create publish manifest
      expect(existsSync(join(skillDir, '.skillsmith-publish.json'))).toBe(true)

      assertNoHardcoded(result, 'skillsmith publish', 'publish: prepare skill', __filename)
    })

    it('should generate checksum', async () => {
      const skillDir = join(TEST_DIR, 'checksum-skill')
      mkdirSync(skillDir, { recursive: true })
      writeFileSync(join(skillDir, 'SKILL.md'), VALID_SKILL_MD)

      const result = await runCommand(['publish', skillDir])

      expect(result.exitCode).toBe(0)

      // Read manifest
      const manifest = JSON.parse(readFileSync(join(skillDir, '.skillsmith-publish.json'), 'utf-8'))

      expect(manifest.checksum).toBeDefined()
      expect(typeof manifest.checksum).toBe('string')

      assertNoHardcoded(result, 'skillsmith publish checksum', 'publish: checksum', __filename)
    })

    it('should reject invalid skill', async () => {
      const skillDir = join(TEST_DIR, 'invalid-publish')
      mkdirSync(skillDir, { recursive: true })
      writeFileSync(join(skillDir, 'SKILL.md'), INVALID_SKILL_MD)

      const result = await runCommand(['publish', skillDir])

      // Should fail validation before publishing
      expect(result.exitCode).not.toBe(0)

      assertNoHardcoded(result, 'skillsmith publish invalid', 'publish: invalid skill', __filename)
    })

    it('should include publishing instructions', async () => {
      const skillDir = join(TEST_DIR, 'instructions-skill')
      mkdirSync(skillDir, { recursive: true })
      writeFileSync(join(skillDir, 'SKILL.md'), VALID_SKILL_MD)

      const result = await runCommand(['publish', skillDir])

      expect(result.exitCode).toBe(0)

      // Output should contain publishing instructions
      const output = result.stdout
      expect(output).toMatch(/github|manual|archive/i)

      assertNoHardcoded(
        result,
        'skillsmith publish instructions',
        'publish: instructions',
        __filename
      )
    })

    it('should not expose local paths in manifest', async () => {
      const skillDir = join(TEST_DIR, 'path-manifest')
      mkdirSync(skillDir, { recursive: true })
      writeFileSync(join(skillDir, 'SKILL.md'), VALID_SKILL_MD)

      const result = await runCommand(['publish', skillDir])

      expect(result.exitCode).toBe(0)

      // Read manifest
      const manifest = readFileSync(join(skillDir, '.skillsmith-publish.json'), 'utf-8')

      // Should not contain local paths
      expect(manifest).not.toMatch(/\/Users\/[a-zA-Z0-9_-]+\//)
      expect(manifest).not.toMatch(/\/home\/[a-zA-Z0-9_-]+\//)
      expect(manifest).not.toContain(TEST_DIR)
    })
  })
})

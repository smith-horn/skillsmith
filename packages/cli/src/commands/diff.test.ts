/**
 * @fileoverview Tests for diff.ts — skillsmith diff CLI command
 * @see SMI-skill-version-tracking Wave 2
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'

// ============================================================================
// Module mocks — must be declared before imports that use them
// ============================================================================

vi.mock('../utils/require-tier.js', () => ({
  requireTier: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../utils/sanitize.js', () => ({
  sanitizeError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}))

const mockLoadManifest = vi.fn()
vi.mock('../utils/manifest.js', () => ({
  loadManifest: () => mockLoadManifest(),
}))

const mockClassifyChange = vi.fn()
vi.mock('@skillsmith/core', () => ({
  classifyChange: (...args: unknown[]) => mockClassifyChange(...args),
}))

// readFile is used for --old-content / --new-content file overrides
const mockReadFile = vi.fn()
vi.mock('fs/promises', () => ({
  readFile: (...args: unknown[]) => mockReadFile(...args),
}))

// fetch is used for remote registry content
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

// ============================================================================
// Import after mocks
// ============================================================================

import { createDiffCommand } from './diff.js'

// ============================================================================
// Fixtures
// ============================================================================

const OLD_CONTENT = `---
name: test-skill
version: 1.0.0
---

## Overview

A test skill.

## Usage

Run with /test.
`

const NEW_CONTENT_MINOR = `---
name: test-skill
version: 1.1.0
---

## Overview

A test skill.

## Usage

Run with /test.

## Examples

Here are examples.
`

const NEW_CONTENT_PATCH = `---
name: test-skill
version: 1.0.1
---

## Overview

An updated test skill.

## Usage

Run with /test now.
`

function buildManifest(sourceUrl = 'https://github.com/anthropic/test-skill') {
  return {
    version: '1.0.0',
    installedSkills: {
      'test-skill': {
        id: 'anthropic/test-skill',
        name: 'test-skill',
        version: '1.0.0',
        source: sourceUrl,
        installPath: '/home/user/.claude/skills/test-skill',
        installedAt: '2024-01-01T00:00:00.000Z',
        lastUpdated: '2024-01-01T00:00:00.000Z',
      },
    },
  }
}

/**
 * Run a commander command programmatically with the given argv.
 * Captures console output and process.exit calls.
 */
async function runCommand(
  cmd: Command,
  argv: string[]
): Promise<{ exitCode: number | null; consoleOutput: string[] }> {
  const output: string[] = []
  const exitCode: { value: number | null } = { value: null }

  const consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
    output.push(args.join(' '))
  })
  const errorSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
    output.push(args.join(' '))
  })
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: number | string | null) => {
    exitCode.value = typeof code === 'number' ? code : null
    throw new Error(`process.exit(${code})`)
  })

  try {
    await cmd.parseAsync(['node', 'test', ...argv])
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (!msg.startsWith('process.exit')) throw e
  } finally {
    consoleSpy.mockRestore()
    errorSpy.mockRestore()
    exitSpy.mockRestore()
  }

  return { exitCode: exitCode.value, consoleOutput: output }
}

// ============================================================================
// Tests
// ============================================================================

describe('createDiffCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockClassifyChange.mockReturnValue('minor')
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('content resolution — remote fetch path', () => {
    it('fetches latest content from registry and displays diff', async () => {
      mockLoadManifest.mockResolvedValue(buildManifest())
      mockReadFile.mockResolvedValue(OLD_CONTENT)
      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(NEW_CONTENT_MINOR),
      })

      const cmd = createDiffCommand()
      const { exitCode, consoleOutput } = await runCommand(cmd, [
        'test-skill',
        '--old-content',
        '/tmp/old-skill.md',
      ])

      expect(exitCode).toBeNull()
      expect(mockFetch).toHaveBeenCalledOnce()
      expect(consoleOutput.join('\n')).toContain('MINOR')
    })

    it('exits with error when installed skill SKILL.md is not found', async () => {
      // No --old-content flag, no installed skill file
      mockLoadManifest.mockResolvedValue(buildManifest())
      // readFile throws (file not found)
      mockReadFile.mockRejectedValue(new Error('ENOENT'))

      const cmd = createDiffCommand()
      const { exitCode } = await runCommand(cmd, ['nonexistent-skill'])
      // readInstalledSkillContent returns null on error, causing exit(1)
      expect(exitCode).toBe(1)
    })

    it('exits with error when remote fetch fails', async () => {
      mockLoadManifest.mockResolvedValue(buildManifest())
      mockReadFile.mockResolvedValue(OLD_CONTENT)
      mockFetch.mockResolvedValue({ ok: false })

      const cmd = createDiffCommand()
      const { exitCode } = await runCommand(cmd, [
        'test-skill',
        '--old-content',
        '/tmp/old-skill.md',
      ])

      expect(exitCode).toBe(1)
    })

    it('exits with error when manifest has no source URL', async () => {
      const manifest = {
        version: '1.0.0',
        installedSkills: {
          'no-source': {
            id: 'test/no-source',
            name: 'no-source',
            version: '1.0.0',
            source: '',
            installPath: '/home/user/.claude/skills/no-source',
            installedAt: '2024-01-01T00:00:00.000Z',
            lastUpdated: '2024-01-01T00:00:00.000Z',
          },
        },
      }
      mockLoadManifest.mockResolvedValue(manifest)
      mockReadFile.mockResolvedValue(OLD_CONTENT)

      const cmd = createDiffCommand()
      const { exitCode } = await runCommand(cmd, [
        'no-source',
        '--old-content',
        '/tmp/old-skill.md',
      ])

      expect(exitCode).toBe(1)
    })
  })

  describe('content resolution — file override path', () => {
    it('uses --old-content and --new-content file overrides when provided', async () => {
      mockReadFile
        .mockResolvedValueOnce(OLD_CONTENT)
        .mockResolvedValueOnce(NEW_CONTENT_PATCH)
      mockClassifyChange.mockReturnValue('patch')

      const cmd = createDiffCommand()
      const { exitCode, consoleOutput } = await runCommand(cmd, [
        'test-skill',
        '--old-content',
        '/tmp/old.md',
        '--new-content',
        '/tmp/new.md',
      ])

      expect(exitCode).toBeNull()
      // fetch should NOT be called when --new-content is provided
      expect(mockFetch).not.toHaveBeenCalled()
      expect(consoleOutput.join('\n')).toContain('PATCH')
    })
  })

  describe('URL conversion — buildRawUrl', () => {
    it('converts github.com URL to raw.githubusercontent.com', async () => {
      mockLoadManifest.mockResolvedValue(
        buildManifest('https://github.com/anthropic/test-skill')
      )
      mockReadFile.mockResolvedValue(OLD_CONTENT)
      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(NEW_CONTENT_MINOR),
      })

      const cmd = createDiffCommand()
      await runCommand(cmd, ['test-skill', '--old-content', '/tmp/old.md'])

      expect(mockFetch).toHaveBeenCalledWith(
        'https://raw.githubusercontent.com/anthropic/test-skill/main/SKILL.md',
        expect.objectContaining({ headers: { Accept: 'text/plain' } })
      )
    })

    it('passes raw.githubusercontent.com URLs through unchanged', async () => {
      const rawUrl =
        'https://raw.githubusercontent.com/anthropic/test-skill/main/SKILL.md'
      mockLoadManifest.mockResolvedValue(buildManifest(rawUrl))
      mockReadFile.mockResolvedValue(OLD_CONTENT)
      mockFetch.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(NEW_CONTENT_MINOR),
      })

      const cmd = createDiffCommand()
      await runCommand(cmd, ['test-skill', '--old-content', '/tmp/old.md'])

      expect(mockFetch).toHaveBeenCalledWith(rawUrl, expect.any(Object))
    })

    it('exits with error for non-GitHub source URLs', async () => {
      mockLoadManifest.mockResolvedValue(
        buildManifest('https://gitlab.com/anthropic/test-skill')
      )
      mockReadFile.mockResolvedValue(OLD_CONTENT)

      const cmd = createDiffCommand()
      const { exitCode } = await runCommand(cmd, [
        'test-skill',
        '--old-content',
        '/tmp/old.md',
      ])

      expect(exitCode).toBe(1)
    })
  })

  describe('output formatting', () => {
    it('includes change type label and skill name in output', async () => {
      mockLoadManifest.mockResolvedValue(buildManifest())
      mockReadFile
        .mockResolvedValueOnce(OLD_CONTENT)
        .mockResolvedValueOnce(NEW_CONTENT_MINOR)
      mockClassifyChange.mockReturnValue('minor')

      const cmd = createDiffCommand()
      const { consoleOutput } = await runCommand(cmd, [
        'test-skill',
        '--old-content',
        '/tmp/old.md',
        '--new-content',
        '/tmp/new.md',
      ])

      const joined = consoleOutput.join('\n')
      expect(joined).toContain('test-skill')
      expect(joined).toContain('MINOR')
    })
  })
})

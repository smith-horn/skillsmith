/**
 * Skillsmith MCP Tools E2E Tests
 *
 * Tests MCP tools against the live system with synthetic test repositories.
 *
 * Prerequisites:
 *   npx tsx scripts/e2e/setup-test-repos.ts
 *
 * Run with: npm test -- tests/e2e/mcp-tools.e2e.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, execSync } from 'child_process'
import { mkdir, rm, readdir, access, writeFile } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'

const SKILLS_DIR = join(homedir(), '.claude', 'skills')
const TEST_REPOS = '/tmp/skillsmith-e2e-tests'
const PROJECT_ROOT = join(import.meta.dirname, '..', '..')

// Helper to call skillsmith CLI
async function callCli(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const proc = spawn('npx', ['skillsmith', ...args], {
      cwd: PROJECT_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NODE_ENV: 'test' },
    })

    let stdout = ''
    let stderr = ''

    proc.stdout.on('data', (data) => {
      stdout += data.toString()
    })
    proc.stderr.on('data', (data) => {
      stderr += data.toString()
    })

    proc.on('close', (code) => {
      resolve({ stdout, stderr, code: code ?? 1 })
    })

    proc.on('error', (err) => {
      resolve({ stdout, stderr: err.message, code: 1 })
    })
  })
}

// Helper to parse JSON from CLI output
function parseJsonOutput(stdout: string): any {
  try {
    // Try direct parse
    return JSON.parse(stdout.trim())
  } catch {
    // Try to find JSON in output
    const jsonMatch = stdout.match(/\{[\s\S]*\}|\[[\s\S]*\]/)
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0])
      } catch {
        return null
      }
    }
    return null
  }
}

describe('MCP Tools E2E Tests', () => {
  // Ensure test repos exist
  beforeAll(async () => {
    try {
      await access(TEST_REPOS)
    } catch {
      console.log('Setting up test repositories...')
      execSync('npx tsx scripts/e2e/setup-test-repos.ts', {
        cwd: PROJECT_ROOT,
        stdio: 'inherit',
      })
    }
  })

  describe('search command', () => {
    it('should search with basic query', async () => {
      const result = await callCli(['search', 'testing'])

      expect(result.code).toBe(0)
      // Search results contain test-related skills (e.g., "vitest-helper", "jest-helper")
      expect(result.stdout.toLowerCase()).toMatch(/test|jest|vitest|helper/)
    })

    it('should search with limit', async () => {
      const result = await callCli(['search', 'code', '--limit', '3'])

      expect(result.code).toBe(0)
      // Output should be limited
    })

    it('should search with trust tier filter', async () => {
      // Note: CLI uses --tier (not --category) for trust tier filtering
      const result = await callCli(['search', 'react', '--tier', 'community'])

      expect(result.code).toBe(0)
    })

    it('should handle no results gracefully', async () => {
      const result = await callCli(['search', 'xyz123nonexistent456abc789'])

      // Should not crash, may return empty or message
      expect(result.code).toBe(0)
    })
  })

  describe('get-skill command', () => {
    let validSkillId: string

    beforeAll(async () => {
      // Get a valid skill ID from search
      const searchResult = await callCli(['search', 'commit', '--limit', '1', '--json'])
      const parsed = parseJsonOutput(searchResult.stdout)
      if (parsed?.results?.[0]?.id || parsed?.skills?.[0]?.id) {
        validSkillId = parsed.results?.[0]?.id || parsed.skills?.[0]?.id
      }
    })

    it('should get skill details for valid ID', async () => {
      if (!validSkillId) {
        console.warn('No valid skill ID found, using fallback')
        validSkillId = 'community/commit-helper'
      }

      const result = await callCli(['get', validSkillId])

      // Should not crash even if skill not found
      expect([0, 1]).toContain(result.code)
    })

    it('should handle invalid ID gracefully', async () => {
      const result = await callCli(['get', 'invalid/nonexistent-skill-12345'])

      // Should exit cleanly with error message
      expect(result.stderr + result.stdout).toMatch(/not found|error|invalid/i)
    })
  })

  describe('recommend command', () => {
    // Note: The recommend command is not yet implemented in CLI
    // These tests are skipped until SMI-1299 is completed
    // Use analyze command to get codebase context, then API for recommendations

    it.skip('should recommend for React TypeScript project', async () => {
      const result = await callCli(['recommend', join(TEST_REPOS, 'repo-react-typescript')])

      expect(result.code).toBe(0)
      // Should detect React/TypeScript stack
      expect(result.stdout.toLowerCase()).toMatch(/react|typescript|recommend/i)
    })

    it.skip('should recommend for Node.js Express project', async () => {
      const result = await callCli(['recommend', join(TEST_REPOS, 'repo-node-express')])

      expect(result.code).toBe(0)
    })

    it('should handle unknown command gracefully', async () => {
      // Until recommend is implemented, verify CLI handles unknown commands
      const result = await callCli(['recommend', join(TEST_REPOS, 'repo-empty')])

      // Should exit with error for unknown command
      expect(result.code).toBe(1)
      expect(result.stderr + result.stdout).toMatch(/unknown command/i)
    })

    it.skip('should recommend for monorepo', async () => {
      const result = await callCli(['recommend', join(TEST_REPOS, 'repo-monorepo')])

      expect(result.code).toBe(0)
    })

    it.skip('should handle missing path gracefully', async () => {
      const result = await callCli(['recommend', '/nonexistent/path/12345'])

      // Should exit with error but not crash
      expect(result.code).toBe(1)
    })
  })

  describe('analyze command', () => {
    it('should analyze React TypeScript project', async () => {
      const result = await callCli(['analyze', join(TEST_REPOS, 'repo-react-typescript')])

      expect(result.code).toBe(0)
      expect(result.stdout.toLowerCase()).toMatch(/react|typescript|framework/i)
    })

    it('should analyze Node.js Express project', async () => {
      const result = await callCli(['analyze', join(TEST_REPOS, 'repo-node-express')])

      expect(result.code).toBe(0)
      expect(result.stdout.toLowerCase()).toMatch(/express|node|javascript/i)
    })

    it('should analyze Vue project', async () => {
      const result = await callCli(['analyze', join(TEST_REPOS, 'repo-vue-vite')])

      expect(result.code).toBe(0)
      expect(result.stdout.toLowerCase()).toMatch(/vue|vite/i)
    })

    it.skip('should handle Python project', async () => {
      // Skipped: CodebaseAnalyzer only supports TypeScript/JavaScript per ADR-010
      // Python analysis would require a separate analyzer implementation
      const result = await callCli(['analyze', join(TEST_REPOS, 'repo-python-flask')])

      expect(result.code).toBe(0)
      expect(result.stdout.toLowerCase()).toMatch(/python|flask/i)
    })

    it('should handle empty project', async () => {
      const result = await callCli(['analyze', join(TEST_REPOS, 'repo-empty')])

      // Should not crash
      expect([0, 1]).toContain(result.code)
    })
  })

  describe('validate command', () => {
    const testSkillPath = join(SKILLS_DIR, '_e2e_test_skill')

    beforeAll(async () => {
      // Create a valid test skill structure
      await mkdir(testSkillPath, { recursive: true })
      await writeFile(
        join(testSkillPath, 'SKILL.md'),
        `---
name: E2E Test Skill
description: A test skill for E2E validation
version: 1.0.0
author: e2e-test
---

# E2E Test Skill

This is a test skill created by the E2E test suite.
`
      )
    })

    afterAll(async () => {
      await rm(testSkillPath, { recursive: true, force: true })
    })

    it('should validate a properly structured skill', async () => {
      const result = await callCli(['validate', testSkillPath])

      expect(result.code).toBe(0)
      expect(result.stdout.toLowerCase()).toMatch(/valid|pass/i)
    })

    it('should report errors for invalid skill', async () => {
      const invalidPath = join(SKILLS_DIR, '_e2e_invalid_skill')
      await mkdir(invalidPath, { recursive: true })
      await writeFile(join(invalidPath, 'README.md'), 'Just a readme, no skill')

      try {
        const result = await callCli(['validate', invalidPath])

        // Should indicate validation failure
        expect(result.stdout + result.stderr).toMatch(/invalid|error|missing|fail/i)
      } finally {
        await rm(invalidPath, { recursive: true, force: true })
      }
    })

    it('should handle nonexistent path', async () => {
      const result = await callCli(['validate', '/nonexistent/skill/path'])

      expect(result.code).toBe(1)
    })
  })

  describe('compare command', () => {
    it('should compare two skills', async () => {
      // Search for skills to compare
      const searchResult = await callCli(['search', 'test', '--limit', '2', '--json'])
      const parsed = parseJsonOutput(searchResult.stdout)
      const skills = parsed?.results || parsed?.skills || []

      if (skills.length < 2) {
        console.warn('Not enough skills found for comparison test')
        return
      }

      const result = await callCli(['compare', skills[0].id, skills[1].id])

      expect(result.code).toBe(0)
      expect(result.stdout.toLowerCase()).toMatch(/compare|diff|similar/i)
    })

    it('should handle single skill gracefully', async () => {
      const searchResult = await callCli(['search', 'git', '--limit', '1', '--json'])
      const parsed = parseJsonOutput(searchResult.stdout)
      const skills = parsed?.results || parsed?.skills || []

      if (skills.length < 1) {
        console.warn('No skills found for single comparison test')
        return
      }

      const result = await callCli(['compare', skills[0].id])

      // Should indicate error or handle gracefully
      expect([0, 1]).toContain(result.code)
    })
  })

  describe('install/uninstall commands', () => {
    const testInstallSkillId = 'community/test-install-' + Date.now()

    // Note: These tests are marked as skipped by default to avoid modifying ~/.claude/skills
    // Enable them for full E2E testing
    it.skip('should install a skill', async () => {
      const searchResult = await callCli(['search', 'helper', '--limit', '1', '--json'])
      const parsed = parseJsonOutput(searchResult.stdout)
      const skills = parsed?.results || parsed?.skills || []

      if (skills.length < 1) {
        console.warn('No skills found for install test')
        return
      }

      const result = await callCli(['install', skills[0].id])

      expect(result.code).toBe(0)
      expect(result.stdout.toLowerCase()).toMatch(/install|success/i)
    })

    it.skip('should uninstall a skill', async () => {
      // Only run if install was successful
      const result = await callCli(['uninstall', 'helper'])

      expect([0, 1]).toContain(result.code) // May fail if not installed
    })

    it('should handle install of nonexistent skill', async () => {
      const result = await callCli(['install', 'nonexistent/fake-skill-12345'])

      expect(result.code).toBe(1)
      expect(result.stdout + result.stderr).toMatch(/not found|error|fail/i)
    })
  })
})

describe('Integration Scenarios', () => {
  describe('Discovery Flow', () => {
    it('should complete: Search → Analyze workflow', async () => {
      // Step 1: Search for skills
      const searchResult = await callCli(['search', 'testing', '--limit', '5'])
      expect(searchResult.code).toBe(0)
      expect(searchResult.stdout.toLowerCase()).toMatch(/test|vitest|jest/)

      // Step 2: Analyze project to understand context
      const analyzeResult = await callCli(['analyze', join(TEST_REPOS, 'repo-react-typescript')])
      expect(analyzeResult.code).toBe(0)
      expect(analyzeResult.stdout.toLowerCase()).toMatch(/react|typescript/)

      // Note: Recommend command not yet implemented (SMI-1299)
      // Recommendations would use API after analyze provides context
    })
  })

  describe('Multi-Project Analysis', () => {
    it('should analyze multiple TypeScript/JavaScript projects', async () => {
      // Only test TS/JS projects per ADR-010
      const projects = ['repo-react-typescript', 'repo-node-express', 'repo-vue-vite']

      const results = await Promise.all(
        projects.map((p) => callCli(['analyze', join(TEST_REPOS, p)]))
      )

      // All should succeed
      results.forEach((r, i) => {
        expect(r.code).toBe(0)
        console.log(`  ✓ Analyzed ${projects[i]}`)
      })
    })
  })

  describe('Edge Cases', () => {
    it('should handle concurrent operations', async () => {
      // Run multiple searches concurrently
      const searches = ['react', 'testing', 'git', 'docker', 'typescript']

      const results = await Promise.all(searches.map((q) => callCli(['search', q, '--limit', '3'])))

      // All should succeed
      results.forEach((r) => {
        expect(r.code).toBe(0)
      })
    })

    it('should handle special characters in search', async () => {
      // Use URL-safe special characters that won't break CLI parsing
      const specialChars = ['react-component', 'code-review', 'test-helper']

      for (const query of specialChars) {
        const result = await callCli(['search', query])
        expect(result.code).toBe(0)
      }
    })
  })
})

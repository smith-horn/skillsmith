/**
 * @fileoverview Unit tests for install dependency intelligence helpers
 * @see SMI-3137: Wave 4 — Surface dependency intelligence
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { extractDepIntel, persistDependencies } from './install.dep-helpers.js'
import type { SkillDependencyRepository } from '@skillsmith/core'

// ============================================================================
// extractDepIntel tests
// ============================================================================

describe('extractDepIntel', () => {
  it('returns empty arrays when no MCP refs exist', () => {
    const result = extractDepIntel('# Simple skill\n\nNo MCP references here.', null)

    expect(result.dep_inferred_servers).toEqual([])
    expect(result.dep_declared).toBeUndefined()
    expect(result.dep_warnings).toEqual([])
  })

  it('detects inferred MCP servers from content', () => {
    const content = `
# My Skill

Use mcp__linear__save_issue to create issues.
Use mcp__slack__send_message for notifications.
`
    const result = extractDepIntel(content, null)

    expect(result.dep_inferred_servers).toContain('linear')
    expect(result.dep_inferred_servers).toContain('slack')
    expect(result.dep_warnings).toHaveLength(2)
    expect(result.dep_warnings[0]).toContain('linear')
    expect(result.dep_warnings[1]).toContain('slack')
  })

  it('passes through declared dependencies from metadata', () => {
    const metadata = {
      dependencies: {
        skills: [{ name: 'other/skill', type: 'hard', version: '^1.0.0' }],
        platform: {
          mcp_servers: [{ name: 'linear', package: '@anthropic/linear-mcp', required: true }],
        },
      },
    }

    const result = extractDepIntel('# Skill\n\nContent.', metadata)

    expect(result.dep_declared).toBeDefined()
    expect(result.dep_declared?.skills).toHaveLength(1)
    expect(result.dep_declared?.platform?.mcp_servers).toHaveLength(1)
  })

  it('returns undefined dep_declared when metadata has no dependencies', () => {
    const metadata = { name: 'test-skill' }
    const result = extractDepIntel('# Skill\n\nContent.', metadata)

    expect(result.dep_declared).toBeUndefined()
  })

  it('handles null metadata gracefully', () => {
    const result = extractDepIntel('# Skill with mcp__github__create_issue ref', null)

    expect(result.dep_declared).toBeUndefined()
    expect(result.dep_inferred_servers).toContain('github')
  })
})

// ============================================================================
// persistDependencies tests
// ============================================================================

describe('persistDependencies', () => {
  let mockRepo: SkillDependencyRepository

  beforeEach(() => {
    mockRepo = {
      setDependencies: vi.fn(),
      getDependencies: vi.fn().mockReturnValue([]),
      getDependenciesBySource: vi.fn().mockReturnValue([]),
      getDependents: vi.fn().mockReturnValue([]),
      clearInferred: vi.fn(),
      clearAll: vi.fn(),
    } as unknown as SkillDependencyRepository
  })

  it('does nothing when no dependencies are found', () => {
    persistDependencies(mockRepo, 'test/skill', '# Simple skill\n\nNo deps.', undefined)

    expect(mockRepo.setDependencies).not.toHaveBeenCalled()
  })

  it('persists inferred MCP dependencies', () => {
    const content = '# Skill\n\nUse mcp__linear__save_issue for issues.'

    persistDependencies(mockRepo, 'test/skill', content, undefined)

    expect(mockRepo.setDependencies).toHaveBeenCalled()
    const callArgs = vi.mocked(mockRepo.setDependencies).mock.calls[0]
    expect(callArgs[0]).toBe('test/skill')
    expect(callArgs[1]).toHaveLength(1)
    expect(callArgs[1][0].dep_target).toBe('linear')
    expect(callArgs[1][0].dep_type).toBe('mcp_server')
    expect(callArgs[2]).toBe('inferred_static')
  })

  it('persists declared dependencies alongside inferred ones', () => {
    const content = '# Skill\n\nUse mcp__slack__send_message for notifs.'
    const declared = {
      skills: [{ name: 'other/skill', type: 'hard' as const, version: '^1.0.0' }],
    }

    persistDependencies(mockRepo, 'test/skill', content, declared)

    // Should be called once for 'declared' source, once for 'inferred_static' source
    expect(mockRepo.setDependencies).toHaveBeenCalledTimes(2)
  })

  it('deduplicates declared MCP servers over inferred', () => {
    const content = '# Skill\n\nUse mcp__linear__save_issue for issues.'
    const declared = {
      platform: {
        mcp_servers: [{ name: 'linear', package: '@a/b', required: true }],
      },
    }

    persistDependencies(mockRepo, 'test/skill', content, declared)

    // Only declared source should be called (linear is deduplicated)
    expect(mockRepo.setDependencies).toHaveBeenCalledTimes(1)
    const callArgs = vi.mocked(mockRepo.setDependencies).mock.calls[0]
    expect(callArgs[2]).toBe('declared')
  })
})

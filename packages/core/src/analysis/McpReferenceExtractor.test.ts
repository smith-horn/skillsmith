import { describe, it, expect } from 'vitest'

import { extractMcpReferences, type McpReference } from './McpReferenceExtractor.js'

describe('McpReferenceExtractor', () => {
  describe('extractMcpReferences', () => {
    it('should extract a basic MCP reference', () => {
      const content = 'Use mcp__linear__save_issue to create issues.'
      const result = extractMcpReferences(content)

      expect(result.references).toHaveLength(1)
      expect(result.references[0]).toEqual<McpReference>({
        server: 'linear',
        tool: 'save_issue',
        line: 1,
        inCodeBlock: false,
      })
      expect(result.servers).toEqual(['linear'])
      expect(result.highConfidenceServers).toEqual(['linear'])
    })

    it('should detect references inside fenced code blocks', () => {
      const content = [
        'Some text',
        '```typescript',
        'await mcp__linear__save_issue({ title: "test" })',
        '```',
        'More text',
      ].join('\n')

      const result = extractMcpReferences(content)

      expect(result.references).toHaveLength(1)
      expect(result.references[0].inCodeBlock).toBe(true)
      expect(result.servers).toEqual(['linear'])
      // Inside code block only -> not high confidence
      expect(result.highConfidenceServers).toEqual([])
    })

    it('should handle multiple servers', () => {
      const content = [
        'Use mcp__linear__save_issue for issues.',
        'Use mcp__claude-flow__agent_spawn for agents.',
        'Use mcp__skillsmith__search for skills.',
      ].join('\n')

      const result = extractMcpReferences(content)

      expect(result.references).toHaveLength(3)
      expect(result.servers).toEqual(['claude-flow', 'linear', 'skillsmith'])
    })

    it('should handle servers with hyphens', () => {
      const content = 'Use mcp__claude-flow__agent_spawn for agents.'
      const result = extractMcpReferences(content)

      expect(result.references).toHaveLength(1)
      expect(result.references[0].server).toBe('claude-flow')
      expect(result.references[0].tool).toBe('agent_spawn')
    })

    it('should return empty result for plain markdown', () => {
      const content = [
        '# My Skill',
        '',
        'This skill does something cool.',
        '',
        '## Usage',
        '',
        'Just install and use it.',
      ].join('\n')

      const result = extractMcpReferences(content)

      expect(result.references).toEqual([])
      expect(result.servers).toEqual([])
      expect(result.highConfidenceServers).toEqual([])
      expect(result.truncated).toBeUndefined()
    })

    it('should handle nested code blocks with tilde fences', () => {
      const content = [
        'Outside text with mcp__linear__get_issue',
        '~~~',
        'Inside tilde block mcp__linear__save_issue',
        '~~~',
        'Outside again mcp__linear__list_issues',
      ].join('\n')

      const result = extractMcpReferences(content)

      expect(result.references).toHaveLength(3)
      expect(result.references[0].inCodeBlock).toBe(false)
      expect(result.references[1].inCodeBlock).toBe(true)
      expect(result.references[2].inCodeBlock).toBe(false)
    })

    it('should require matching fence characters', () => {
      const content = [
        '```',
        'Inside backtick block mcp__linear__save_issue',
        '~~~',
        'Still inside (tilde cannot close backtick) mcp__linear__get_issue',
        '```',
        'Outside mcp__linear__list_issues',
      ].join('\n')

      const result = extractMcpReferences(content)

      expect(result.references[0].inCodeBlock).toBe(true)
      expect(result.references[1].inCodeBlock).toBe(true)
      expect(result.references[2].inCodeBlock).toBe(false)
    })

    it('should truncate input exceeding 100KB', () => {
      // Create content > 100KB: each line ~50 chars, need ~2048 lines for 100KB
      const line = 'x'.repeat(100) + '\n'
      const content = line.repeat(1100) // ~110KB

      const result = extractMcpReferences(content)

      expect(result.truncated).toBe(true)
      expect(result.references).toEqual([])
    })

    it('should not truncate content under 100KB', () => {
      const content = 'mcp__linear__save_issue\n'.repeat(10)
      const result = extractMcpReferences(content)

      expect(result.truncated).toBeUndefined()
      expect(result.references).toHaveLength(10)
    })

    it('should not match partial patterns like mcp__partial', () => {
      const content = 'This has mcp__partial without a second delimiter.'
      const result = extractMcpReferences(content)

      expect(result.references).toEqual([])
    })

    it('should match references embedded in URLs or paths', () => {
      const content = 'See https://example.com/docs/mcp__linear__save_issue for details.'
      const result = extractMcpReferences(content)

      expect(result.references).toHaveLength(1)
      expect(result.references[0].server).toBe('linear')
    })

    it('should extract multiple references on one line', () => {
      const content = 'Use mcp__linear__save_issue and mcp__linear__get_issue together.'
      const result = extractMcpReferences(content)

      expect(result.references).toHaveLength(2)
      expect(result.references[0].tool).toBe('save_issue')
      expect(result.references[1].tool).toBe('get_issue')
      expect(result.references[0].line).toBe(1)
      expect(result.references[1].line).toBe(1)
    })

    it('should populate highConfidenceServers only for outside-code-block refs', () => {
      const content = [
        'Use mcp__linear__save_issue in your workflow.',
        '```',
        'mcp__claude-flow__agent_spawn({ type: "coder" })',
        '```',
      ].join('\n')

      const result = extractMcpReferences(content)

      expect(result.servers).toEqual(['claude-flow', 'linear'])
      expect(result.highConfidenceServers).toEqual(['linear'])
    })

    it('should handle a server appearing both inside and outside code blocks', () => {
      const content = [
        'Call mcp__linear__save_issue to create.',
        '```',
        'mcp__linear__get_issue({ id: "123" })',
        '```',
      ].join('\n')

      const result = extractMcpReferences(content)

      expect(result.references).toHaveLength(2)
      expect(result.servers).toEqual(['linear'])
      // linear appears outside code block, so it's high confidence
      expect(result.highConfidenceServers).toEqual(['linear'])
    })

    it('should handle longer fence sequences', () => {
      const content = [
        '````',
        'mcp__linear__save_issue inside 4-backtick block',
        '```',
        'still inside (3 backticks cannot close 4-backtick fence)',
        'mcp__linear__get_issue',
        '````',
        'mcp__linear__list_issues outside',
      ].join('\n')

      const result = extractMcpReferences(content)

      expect(result.references[0].inCodeBlock).toBe(true)
      expect(result.references[1].inCodeBlock).toBe(true)
      expect(result.references[2].inCodeBlock).toBe(false)
    })

    describe('realistic SKILL.md validation (SMI-3147)', () => {
      it('should correctly extract from a realistic SKILL.md body', () => {
        const realisticSkill = [
          '# Linear Integration Skill',
          '',
          '## Overview',
          '',
          'This skill integrates with Linear project management.',
          'It uses mcp__linear__save_issue for creating issues',
          'and mcp__linear__get_issue for retrieving them.',
          '',
          '## Requirements',
          '',
          'You need the mcp__skillsmith__search tool to find related skills.',
          '',
          '## Usage',
          '',
          '### Creating an issue',
          '',
          '```typescript',
          '// Create a new Linear issue',
          'const result = await mcp__linear__save_issue({',
          '  title: "Fix bug",',
          '  teamId: "team-123",',
          '})',
          '```',
          '',
          '### Spawning agents',
          '',
          '```bash',
          'mcp__claude-flow__agent_spawn --type coder',
          'mcp__claude-flow__task_orchestrate --plan auto',
          '```',
          '',
          '## Notes',
          '',
          'The mcp__linear__list_issues tool is also helpful.',
        ].join('\n')

        const result = extractMcpReferences(realisticSkill)

        // Verify references
        expect(result.references.length).toBeGreaterThanOrEqual(7)

        // Verify servers
        expect(result.servers).toEqual(['claude-flow', 'linear', 'skillsmith'])

        // High-confidence: linear and skillsmith appear outside code blocks
        // claude-flow appears only inside code blocks
        expect(result.highConfidenceServers).toEqual(['linear', 'skillsmith'])

        // Verify code block detection for specific references
        const proseRefs = result.references.filter((r) => !r.inCodeBlock)
        const codeRefs = result.references.filter((r) => r.inCodeBlock)

        // Outside code blocks: save_issue(l6), get_issue(l7),
        //   search(l11), list_issues(l32)
        expect(proseRefs).toHaveLength(4)

        // Inside code blocks: save_issue(l19),
        //   agent_spawn(l26), task_orchestrate(l27)
        expect(codeRefs).toHaveLength(3)

        expect(result.truncated).toBeUndefined()
      })

      it('should handle SKILL.md with no MCP references', () => {
        const plainSkill = [
          '# Simple Skill',
          '',
          '## Overview',
          '',
          'A skill that uses no MCP tools.',
          '',
          '## Usage',
          '',
          '```bash',
          'echo "Hello world"',
          '```',
        ].join('\n')

        const result = extractMcpReferences(plainSkill)

        expect(result.references).toEqual([])
        expect(result.servers).toEqual([])
        expect(result.highConfidenceServers).toEqual([])
      })

      it('should handle SKILL.md with only code block references', () => {
        const codeOnlySkill = [
          '# Agent Skill',
          '',
          'This skill orchestrates agents.',
          '',
          '```javascript',
          'mcp__claude-flow__agent_spawn({ type: "coder" })',
          'mcp__claude-flow__memory_usage({ action: "store" })',
          '```',
        ].join('\n')

        const result = extractMcpReferences(codeOnlySkill)

        expect(result.references).toHaveLength(2)
        expect(result.servers).toEqual(['claude-flow'])
        expect(result.highConfidenceServers).toEqual([])
      })
    })
  })
})

/**
 * @fileoverview Tests for `generateTips`/`generateOptimizedTips` in
 *   install.helpers.ts — SMI-5894 Wave 1 Step 5.
 *
 * Both functions previously hardcoded "Claude Code" / `~/.claude/skills/`
 * regardless of the actual install target. Note: as of this fix, neither
 * function has a live caller in this package (the real MCP install flow's
 * tips come from the shared `@skillsmith/core` `generateTips`, which
 * received the equivalent fix) — these tests exist so the fix here can't
 * silently regress if either function is ever wired back up.
 */
import { describe, expect, it } from 'vitest'
import { generateTips, generateOptimizedTips } from './install.helpers.js'

describe('generateTips (SMI-5894 Wave 1 Step 5)', () => {
  it('defaults to Claude Code wording when client/skillsDir are omitted (backward compatible)', () => {
    const tips = generateTips('my-skill')
    const joined = tips.join('\n')
    expect(joined).toContain('mention it in Claude Code')
    expect(joined).toContain('ls ~/.claude/skills/')
  })

  it('names the actual client and install path when a non-canonical client is resolved', () => {
    const tips = generateTips('my-skill', 'cursor', '/home/user/.cursor/skills')
    const joined = tips.join('\n')
    expect(joined).toContain('mention it in Cursor')
    expect(joined).toContain('ls /home/user/.cursor/skills/')
    expect(joined).not.toContain('Claude Code')
  })
})

describe('generateOptimizedTips (SMI-5894 Wave 1 Step 5)', () => {
  const optimizationInfo = { optimized: false }

  it('defaults to Claude Code wording when client/skillsDir are omitted (backward compatible)', () => {
    const tips = generateOptimizedTips('my-skill', optimizationInfo)
    const joined = tips.join('\n')
    expect(joined).toContain('mention it in Claude Code')
    expect(joined).toContain('ls ~/.claude/skills/')
  })

  it('names the actual client and install path when a non-canonical client is resolved', () => {
    const tips = generateOptimizedTips(
      'my-skill',
      optimizationInfo,
      undefined,
      'cursor',
      '/home/user/.cursor/skills'
    )
    const joined = tips.join('\n')
    expect(joined).toContain('mention it in Cursor')
    expect(joined).toContain('ls /home/user/.cursor/skills/')
    expect(joined).not.toContain('Claude Code')
  })

  it('still renders the CLAUDE.md snippet section regardless of client', () => {
    const tips = generateOptimizedTips(
      'my-skill',
      {
        optimized: true,
        subagentGenerated: true,
        subagentPath: '/home/user/.claude/agents/my-skill.md',
      },
      '# CLAUDE.md snippet\nUse the my-skill subagent.',
      'cursor'
    )
    const joined = tips.join('\n')
    expect(joined).toContain('Add this to your CLAUDE.md for automatic delegation')
    expect(joined).toContain('mention it in Cursor')
  })
})

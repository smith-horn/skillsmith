/**
 * @fileoverview Tests for the relocated curated-agent-tool-profile constants
 *               (SMI-5456 Wave 1 Step 5, QD-1).
 * @module @skillsmith/core/services/agent-tool-profile.test
 */
import { describe, expect, it } from 'vitest'

import {
  AGENT_TOOL_PROFILE_ENV_VAR,
  AGENT_TOOL_PROFILE_NAMES,
  AGENT_TOOL_PROFILE_VALUE,
} from './agent-tool-profile.js'

describe('AGENT_TOOL_PROFILE_NAMES (core, QD-1 relocation)', () => {
  it('has 16 entries', () => {
    expect(AGENT_TOOL_PROFILE_NAMES).toHaveLength(16)
  })

  it('contains undo_apply', () => {
    expect(AGENT_TOOL_PROFILE_NAMES).toContain('undo_apply')
  })

  it('every entry is a non-empty snake_case tool name', () => {
    for (const name of AGENT_TOOL_PROFILE_NAMES) {
      expect(name).toMatch(/^[a-z][a-z_]*[a-z]$/)
    }
  })

  it('has no duplicate entries', () => {
    expect(new Set(AGENT_TOOL_PROFILE_NAMES).size).toBe(AGENT_TOOL_PROFILE_NAMES.length)
  })

  it('env var name + value match the mcp-server ListTools filter contract', () => {
    expect(AGENT_TOOL_PROFILE_ENV_VAR).toBe('SKILLSMITH_TOOL_PROFILE')
    expect(AGENT_TOOL_PROFILE_VALUE).toBe('agent')
  })
})

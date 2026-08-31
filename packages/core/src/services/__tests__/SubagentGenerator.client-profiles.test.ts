/**
 * @fileoverview Tests for SubagentGenerator.client-profiles (SMI-6276)
 */

import { describe, it, expect } from 'vitest'
import { CLIENT_IDS } from '../../install/paths.js'
import {
  SUBAGENT_CLIENT_PROFILES,
  getSubagentGenerationProfile,
  mapToolNames,
} from '../SubagentGenerator.client-profiles.js'

describe('SubagentGenerator.client-profiles', () => {
  describe('SUBAGENT_CLIENT_PROFILES', () => {
    it('has an entry for every ClientId', () => {
      for (const client of CLIENT_IDS) {
        expect(SUBAGENT_CLIENT_PROFILES[client]).toBeDefined()
      }
    })

    it('gives cursor the exact same profile object as claude-code (deliberate reuse)', () => {
      expect(SUBAGENT_CLIENT_PROFILES.cursor).toBe(SUBAGENT_CLIENT_PROFILES['claude-code'])
    })

    it('claude-code accepts Claude-native tools and a Claude model enum', () => {
      const profile = SUBAGENT_CLIENT_PROFILES['claude-code']
      expect(profile.toolsPolicy).toBe('claude-native')
      expect(profile.modelPolicy).toBe('claude-enum')
      expect(profile.includeSkillsField).toBe(true)
    })

    it('antigravity uses a mapped tool array and omits the model field', () => {
      const profile = SUBAGENT_CLIENT_PROFILES.antigravity
      expect(profile.toolsPolicy).toBe('mapped-array')
      expect(profile.modelPolicy).toBe('omit')
      expect(profile.includeSkillsField).toBe(false)
      expect(profile.toolNameMap).toBeDefined()
    })

    it('opencode includes the mode: subagent line but omits tools/model', () => {
      const profile = SUBAGENT_CLIENT_PROFILES.opencode
      expect(profile.toolsPolicy).toBe('omit')
      expect(profile.modelPolicy).toBe('omit')
      expect(profile.extraFrontmatterLines).toContain('mode: subagent')
    })

    it('every unverified-vocabulary client (copilot/windsurf/agents/hermes/grok) omits tools and model', () => {
      for (const client of ['copilot', 'windsurf', 'agents', 'hermes', 'grok'] as const) {
        const profile = SUBAGENT_CLIENT_PROFILES[client]
        expect(profile.toolsPolicy).toBe('omit')
        expect(profile.modelPolicy).toBe('omit')
      }
    })
  })

  describe('getSubagentGenerationProfile', () => {
    it('defaults to the claude-code (canonical) profile when no client is given', () => {
      expect(getSubagentGenerationProfile()).toBe(SUBAGENT_CLIENT_PROFILES['claude-code'])
    })

    it('resolves the antigravity profile by name', () => {
      expect(getSubagentGenerationProfile('antigravity')).toBe(SUBAGENT_CLIENT_PROFILES.antigravity)
    })
  })

  describe('mapToolNames', () => {
    const antigravityProfile = SUBAGENT_CLIENT_PROFILES.antigravity

    it('maps confirmed Skillsmith tool names to AntiGravity-own identifiers', () => {
      const mapped = mapToolNames(['Read', 'Bash', 'Grep'], antigravityProfile)
      expect(mapped).toEqual(['view_file', 'run_command', 'grep_search'])
    })

    it('deduplicates Write and Edit onto the same AntiGravity tool', () => {
      const mapped = mapToolNames(['Write', 'Edit'], antigravityProfile)
      expect(mapped).toEqual(['replace_file_content'])
    })

    it('silently drops internal tool names with no confirmed AntiGravity mapping', () => {
      const mapped = mapToolNames(['Glob', 'WebFetch', 'WebSearch'], antigravityProfile)
      expect(mapped).toEqual([])
    })

    it('returns an empty array for a profile with no toolNameMap', () => {
      const mapped = mapToolNames(['Read', 'Bash'], SUBAGENT_CLIENT_PROFILES['claude-code'])
      expect(mapped).toEqual([])
    })
  })
})

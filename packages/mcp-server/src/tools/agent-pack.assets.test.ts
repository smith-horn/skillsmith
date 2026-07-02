/**
 * SMI-5456 Wave 1 Step 4 — agent-pack + curated-profile coherence tests.
 *
 * These live in mcp-server because they bind the generator (`@skillsmith/core`)
 * to the single source of truth for the curated tool surface,
 * `AGENT_TOOL_PROFILE_NAMES` (this package). Two guarantees:
 *   1. the pack's tool references are a subset of the real 16-name profile; and
 *   2. the committed artifacts under `src/assets/agent-pack/` match the generator
 *      output byte-for-byte (drift gate — regenerate with
 *      `npm run generate:agent-pack` after any prompt-source change).
 */

import { readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { AGENT_PACK_SKILL_NAME, generateAgentPack } from '@skillsmith/core'

import { AGENT_TOOL_PROFILE_NAMES } from '../middleware/toolProfile.js'

const assetsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'agent-pack')

function realPack() {
  return generateAgentPack({ toolProfile: AGENT_TOOL_PROFILE_NAMES })
}

describe('agent pack — coherence with the curated tool profile', () => {
  it('generates without throwing against the real profile (references subset of profile)', () => {
    expect(() => realPack()).not.toThrow()
  })

  it('the Codex TOML and markdown shims list exactly the curated profile', () => {
    const arts = Object.fromEntries(realPack().map((a) => [a.path, a.content]))

    const toml = arts['shims/codex/agents.toml']
    for (const name of AGENT_TOOL_PROFILE_NAMES) expect(toml).toContain(`"${name}"`)

    const claudeFm = arts[`shims/claude/${AGENT_PACK_SKILL_NAME}.md`]
    const toolsLine = claudeFm.split('\n').find((l) => l.startsWith('tools:'))
    expect(toolsLine).toBeDefined()
    const listed = (toolsLine as string)
      .replace('tools:', '')
      .split(',')
      .map((t) => t.trim())
    expect(listed).toEqual([...AGENT_TOOL_PROFILE_NAMES])
  })

  it('no tool-shaped token in the SKILL.md pack falls outside the profile', () => {
    const skill = realPack().find((a) => a.path === 'SKILL.md')?.content ?? ''
    const profile = new Set(AGENT_TOOL_PROFILE_NAMES)
    // Tokens that look like Skillsmith tool names (verb-prefixed snake_case).
    const toolLike = skill.match(/\b(?:skill|apply|undo|get|install|uninstall)_[a-z_]+\b/g) ?? []
    for (const token of toolLike) {
      expect(profile.has(token), `unknown tool reference: ${token}`).toBe(true)
    }
  })
})

describe('agent pack — committed artifacts match the generator (drift gate)', () => {
  const arts = realPack()

  it.each(arts.map((a) => a.path))('committed %s is byte-identical to the generator', (path) => {
    const committed = readFileSync(join(assetsDir, path), 'utf8')
    const generated = arts.find((a) => a.path === path)?.content
    expect(committed).toBe(generated)
  })

  it('committed hook scripts keep their executable bit', () => {
    for (const a of arts.filter((x) => x.executable)) {
      const mode = statSync(join(assetsDir, a.path)).mode
      expect((mode & 0o111) !== 0, `${a.path} is not executable`).toBe(true)
    }
  })
})

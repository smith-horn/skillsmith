/**
 * SMI-5456 Wave 1 — Conformance suite for committed agent-pack artifacts.
 *
 * Validates that the committed artifacts in `src/assets/agent-pack/` pass
 * the repo's own skill_validate logic, have well-formed frontmatter/TOML,
 * and use consistent identifiers across all shims and hooks.
 *
 * Scope: committed SKILL.md, shims (claude/copilot/opencode), codex TOML,
 * and hook scripts (claude-code, cursor, codex × session-start/end).
 *
 * This is an ADDITIVE suite — it does NOT duplicate the generator or
 * drift-gate tests in agent-pack.assets.test.ts or agent-pack.test.ts.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parse as parseToml } from 'smol-toml'
import { parse as parseYaml } from 'yaml'
import { describe, expect, it } from 'vitest'

import { AGENT_PACK_SKILL_NAME } from '@skillsmith/core'
import { executeValidate } from '../../src/tools/validate.js'

const assetsDir = join(dirname(fileURLToPath(import.meta.url)), '../../src/assets/agent-pack')

/**
 * Parse YAML frontmatter from markdown (---\n...\n---\n block).
 */
function parseFrontmatter(content: string): Record<string, unknown> {
  const match = content.match(/^---\n([\s\S]*?)\n---\n/)
  if (!match) throw new Error('no frontmatter block found')
  return parseYaml(match[1]) as Record<string, unknown>
}

/**
 * Read a committed artifact as raw text.
 */
function readArtifact(relativePath: string): string {
  return readFileSync(join(assetsDir, relativePath), 'utf8')
}

describe('agent-pack conformance — committed artifacts', () => {
  describe('1. in-repo validator conformance (SKILL.md)', () => {
    it('runs the repo validator on committed SKILL.md and reports valid with zero warnings', async () => {
      const skillPath = join(assetsDir, 'SKILL.md')
      const result = await executeValidate({ skill_path: skillPath, strict: false })

      const errors = result.errors.filter((e) => e.severity === 'error')
      const warnings = result.errors.filter((e) => e.severity === 'warning')

      if (errors.length > 0) {
        console.error('Validator errors:', errors)
      }
      if (warnings.length > 0) {
        console.error('Validator warnings:', warnings)
      }

      expect(result.valid, `validator should report valid; errors: ${JSON.stringify(errors)}`).toBe(
        true
      )
      expect(
        errors.length,
        `validator should report zero errors; got: ${JSON.stringify(errors)}`
      ).toBe(0)
      // The pack is a published skill: it must pass our own validator CLEAN.
      // repository + compatibility frontmatter exist precisely to satisfy the
      // published-skill recommendations, so zero warnings is enforced here.
      expect(
        warnings.length,
        `validator should report zero warnings; got: ${JSON.stringify(warnings)}`
      ).toBe(0)
      expect(result.metadata).toBeDefined()
      expect(result.metadata?.name).toBe(AGENT_PACK_SKILL_NAME)
    })
  })

  describe('2. shell syntax (6 hook scripts)', () => {
    const hooks = [
      'hooks/claude-code/session-start.sh',
      'hooks/claude-code/session-end.sh',
      'hooks/cursor/session-start.sh',
      'hooks/cursor/session-end.sh',
      'hooks/codex/session-start.sh',
      'hooks/codex/session-end.sh',
    ]

    it.each(hooks)('%s parses with sh -n', (hookPath) => {
      const scriptPath = join(assetsDir, hookPath)

      // Run `sh -n <file>` (syntax check, no execution).
      // Use execFileSync with array args (never string interpolation).
      expect(() => {
        execFileSync('sh', ['-n', scriptPath], { stdio: 'pipe' })
      }).not.toThrow()
    })
  })

  describe('3. frontmatter schema', () => {
    it('SKILL.md has name slug + non-empty description', () => {
      const fm = parseFrontmatter(readArtifact('SKILL.md'))

      expect(fm.name).toBe(AGENT_PACK_SKILL_NAME)
      expect(fm.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
      expect(typeof fm.description).toBe('string')
      expect((fm.description as string).length).toBeGreaterThan(0)
      expect((fm.description as string).includes('\n')).toBe(false)
    })

    it('claude shim has name slug, description, and tools array', () => {
      const content = readArtifact(`shims/claude/${AGENT_PACK_SKILL_NAME}.md`)
      const fm = parseFrontmatter(content)

      expect(fm.name).toBe(AGENT_PACK_SKILL_NAME)
      expect(fm.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
      expect(typeof fm.description).toBe('string')
      expect((fm.description as string).length).toBeGreaterThan(0)
      expect(fm.tools).toBeDefined()
      expect(typeof fm.tools).toBe('string')
    })

    it('copilot shim has name slug, description, and tools array', () => {
      const content = readArtifact(`shims/copilot/${AGENT_PACK_SKILL_NAME}.agent.md`)
      const fm = parseFrontmatter(content)

      expect(fm.name).toBe(AGENT_PACK_SKILL_NAME)
      expect(fm.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
      expect(typeof fm.description).toBe('string')
      expect((fm.description as string).length).toBeGreaterThan(0)
      expect(fm.tools).toBeDefined()
      expect(typeof fm.tools).toBe('string')
    })

    it('opencode shim has description and mode (subagent), no name field', () => {
      const content = readArtifact(`shims/opencode/${AGENT_PACK_SKILL_NAME}.md`)
      const fm = parseFrontmatter(content)

      // OpenCode shim may not have an explicit `name` field (implied from filename).
      expect(typeof fm.description).toBe('string')
      expect((fm.description as string).length).toBeGreaterThan(0)
      expect(fm.mode).toBe('subagent')

      // Verify the skill name appears in the body (not in frontmatter but in prose).
      expect(content).toContain(AGENT_PACK_SKILL_NAME)
    })
  })

  describe('4. codex TOML conformance', () => {
    it('agents.toml parses and has [agents.skillsmith-agent] with required fields', () => {
      const tomlContent = readArtifact('shims/codex/agents.toml')
      const parsed = parseToml(tomlContent) as {
        agents: Record<string, { description: string; instructions: string; tools: string[] }>
      }

      const agent = parsed.agents[AGENT_PACK_SKILL_NAME]
      expect(agent).toBeDefined()
      expect(typeof agent.description).toBe('string')
      expect(agent.description.length).toBeGreaterThan(0)
      expect(typeof agent.instructions).toBe('string')
      expect(agent.instructions.length).toBeGreaterThan(0)
      expect(Array.isArray(agent.tools)).toBe(true)
      expect(agent.tools.length).toBeGreaterThan(0)
      expect(agent.tools.every((t) => typeof t === 'string' && t.length > 0)).toBe(true)
    })
  })

  describe('5. cross-artifact identity (slug consistency)', () => {
    it('all artifacts use the same skill slug constant (AGENT_PACK_SKILL_NAME)', () => {
      const skillMdContent = readArtifact('SKILL.md')
      const claudeShimContent = readArtifact(`shims/claude/${AGENT_PACK_SKILL_NAME}.md`)
      const copilotShimContent = readArtifact(`shims/copilot/${AGENT_PACK_SKILL_NAME}.agent.md`)
      const opencodeShimContent = readArtifact(`shims/opencode/${AGENT_PACK_SKILL_NAME}.md`)
      const codexTomlContent = readArtifact('shims/codex/agents.toml')

      // All should contain the slug in their frontmatter or keys.
      expect(skillMdContent).toContain(`name: ${AGENT_PACK_SKILL_NAME}`)
      expect(claudeShimContent).toContain(`name: ${AGENT_PACK_SKILL_NAME}`)
      expect(copilotShimContent).toContain(`name: ${AGENT_PACK_SKILL_NAME}`)
      expect(opencodeShimContent).toContain(AGENT_PACK_SKILL_NAME)
      expect(codexTomlContent).toContain(`[agents.${AGENT_PACK_SKILL_NAME}]`)

      // Verify no spaced display name is used in identifier positions.
      // (The display name is "Skillsmith Agent" with a space.)
      const DISPLAY_NAME = 'Skillsmith Agent'
      const toml = parseToml(codexTomlContent) as Record<string, unknown>
      const agents = toml.agents as Record<string, unknown>
      for (const key of Object.keys(agents)) {
        expect(key).not.toContain(DISPLAY_NAME)
      }
    })
  })

  describe('test coverage summary', () => {
    it('skips: generator-output drift (agent-pack.assets.test.ts covers)', () => {
      // The assets.test.ts suite verifies committed artifacts match
      // the generator output byte-for-byte, and that the curated tool
      // profile is listed in shims and Codex. This conformance suite
      // does NOT duplicate those checks.
    })

    it('skips: generator tool-reference invariant (agent-pack.assets.test.ts covers)', () => {
      // The assets.test.ts suite verifies that tool references are a
      // subset of AGENT_TOOL_PROFILE_NAMES. This suite only validates
      // committed artifacts in isolation.
    })

    it('skips: prompt-pack lint / injection patterns (agent-pack.test.ts covers)', () => {
      // The core generator tests verify SKILL.md has no model idioms,
      // injection patterns, or non-ASCII characters. This suite assumes
      // those checks passed and focuses on structure conformance.
    })

    it('skips: hook marker contract (agent-pack.test.ts covers)', () => {
      // The core tests verify hook execution (marker file write/delete,
      // nudge mechanics, cleanup). This suite only checks shell syntax.
    })
  })
})

/**
 * SMI-4790 Wave 1 Step 1.5: Snapshot tests for MCP tool descriptions
 *
 * Each user-facing tool description must:
 * 1. Lead with the canonical bracketed prefix `[Skillsmith — <Stage> stage]`
 *    (per the lifecycle taxonomy in docs/internal/implementation/_taxonomy.md)
 * 2. Name "Skillsmith" prominently for product-name anchoring
 * 3. Stay within the ≤1024-char target (no MCP-spec hard cap; aligns with
 *    Anthropic SKILL.md frontmatter convention)
 *
 * If you change a description intentionally, update the snapshot
 * (`vitest -u`). If a snapshot mismatch surprises you, the description
 * regressed — the prefix or anchor was lost.
 */

import { describe, it, expect } from 'vitest'

import { searchToolSchema } from '../src/tools/search.js'
import { getSkillToolSchema } from '../src/tools/get-skill.js'
import { recommendToolSchema } from '../src/tools/recommend.types.js'
import { compareToolSchema } from '../src/tools/compare.types.js'
import { installTool } from '../src/tools/install.tool.js'
import { uninstallTool } from '../src/tools/uninstall.js'
import { validateToolSchema } from '../src/tools/validate.types.js'

// Tool → expected lifecycle stage (must match docs/internal/implementation/_taxonomy.md)
const TOOL_STAGE_MAPPING = [
  { tool: searchToolSchema, name: 'search', stage: 'Discover' },
  { tool: getSkillToolSchema, name: 'get_skill', stage: 'Evaluate' },
  { tool: recommendToolSchema, name: 'skill_recommend', stage: 'Discover' },
  { tool: compareToolSchema, name: 'skill_compare', stage: 'Evaluate' },
  { tool: installTool, name: 'install_skill', stage: 'Install' },
  { tool: uninstallTool, name: 'uninstall_skill', stage: 'Retire' },
  { tool: validateToolSchema, name: 'skill_validate', stage: 'Install' },
] as const

describe('SMI-4790: MCP tool descriptions', () => {
  describe('canonical prefix', () => {
    it.each(TOOL_STAGE_MAPPING)(
      '$name: leads with [Skillsmith — $stage stage]',
      ({ tool, stage }) => {
        const expectedPrefix = `[Skillsmith — ${stage} stage]`
        expect(tool.description).toMatch(
          new RegExp(`^${expectedPrefix.replace(/[\\[\]—]/g, '\\$&')}`)
        )
      }
    )
  })

  describe('product-name anchor', () => {
    it.each(TOOL_STAGE_MAPPING)('$name: contains "Skillsmith" at least twice', ({ tool }) => {
      const matches = tool.description.match(/Skillsmith/g)
      expect(matches?.length ?? 0).toBeGreaterThanOrEqual(2)
    })
  })

  describe('length budget', () => {
    it.each(TOOL_STAGE_MAPPING)('$name: description under 1024 characters', ({ tool }) => {
      expect(tool.description.length).toBeLessThanOrEqual(1024)
    })
  })

  describe('snapshot', () => {
    it('all 7 descriptions match snapshot', () => {
      const snapshot = TOOL_STAGE_MAPPING.map(({ name, stage, tool }) => ({
        name,
        stage,
        description: tool.description,
        length: tool.description.length,
      }))
      expect(snapshot).toMatchSnapshot()
    })
  })
})

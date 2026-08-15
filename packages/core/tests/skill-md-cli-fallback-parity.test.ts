/**
 * SMI-5893 Wave 6 Step 5 — structural parity guard for the "CLI Fallback"
 * section across the three independently-bundled SKILL.md assets:
 *
 *   - packages/cli/assets/skillsmith-skill/SKILL.md (the original pattern —
 *     already had a working "## CLI Fallback" section before this wave)
 *   - packages/mcp-server/src/assets/agent-pack/SKILL.md (ported in this wave)
 *   - packages/mcp-server/src/assets/skills/skillsmith/SKILL.md (ported in
 *     this wave)
 *
 * Per the SMI-5893 plan doc's Wave 6 Step 5 (GPT-5.6-Sol plan review
 * correction): "porting the same pattern by hand risks becoming a fourth
 * independent copy that drifts again" — the exact reinvent-instead-of-reuse
 * pattern this whole plan exists to eliminate. This test is the drift guard:
 * it does NOT require byte-identical prose, only that each file has the same
 * *structural* elements — an explicit "if MCP unavailable, use the CLI"
 * heading, a fenced shell block, and at least one real `skillsmith` command
 * inside it. If a future edit adds a fourth bundled SKILL.md, or an existing
 * one loses its fallback section, this test fails.
 */

import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const SKILL_MD_FILES = [
  {
    label: 'CLI bundled skill (the canonical pattern)',
    path: path.join(__dirname, '../../cli/assets/skillsmith-skill/SKILL.md'),
  },
  {
    label: 'MCP agent-pack SKILL.md',
    path: path.join(__dirname, '../../mcp-server/src/assets/agent-pack/SKILL.md'),
  },
  {
    label: 'MCP master skillsmith SKILL.md',
    path: path.join(__dirname, '../../mcp-server/src/assets/skills/skillsmith/SKILL.md'),
  },
]

/** Matches a "## CLI Fallback" (or similarly-worded) markdown heading. */
const FALLBACK_HEADING = /^#{2,3}\s+.*CLI Fallback.*$/im

/**
 * Extracts the section body between the CLI Fallback heading and the next
 * heading of the same or higher level (or EOF).
 */
function extractFallbackSection(content: string): string {
  const headingMatch = FALLBACK_HEADING.exec(content)
  if (!headingMatch) return ''
  const start = headingMatch.index + headingMatch[0].length
  const rest = content.slice(start)
  // Only #{2,3} (##/###) counts as the "next heading" — a bare single `#`
  // would also match a shell comment like "# Search" inside the fallback
  // section's own fenced code block and truncate extraction prematurely.
  const nextHeading = /^#{2,3}\s+/m.exec(rest)
  return nextHeading ? rest.slice(0, nextHeading.index) : rest
}

describe('SMI-5893 Wave 6 Step 5 — SKILL.md CLI Fallback structural parity', () => {
  for (const { label, path: filePath } of SKILL_MD_FILES) {
    it(`${label} has a CLI Fallback section`, () => {
      expect(fs.existsSync(filePath), `expected file to exist: ${filePath}`).toBe(true)
      const content = fs.readFileSync(filePath, 'utf-8')
      expect(FALLBACK_HEADING.test(content)).toBe(true)
    })

    it(`${label} — CLI Fallback section states MCP unavailability as the trigger`, () => {
      const content = fs.readFileSync(filePath, 'utf-8')
      const section = extractFallbackSection(content)
      expect(section.length, `expected a non-empty section body in ${filePath}`).toBeGreaterThan(0)
      expect(/MCP server is unavailable/i.test(section)).toBe(true)
      expect(/use the CLI/i.test(section)).toBe(true)
    })

    it(`${label} — CLI Fallback section has a fenced shell block with real skillsmith commands`, () => {
      const content = fs.readFileSync(filePath, 'utf-8')
      const section = extractFallbackSection(content)
      const fence = /```(?:bash|sh)?\n([\s\S]*?)```/.exec(section)
      expect(
        fence,
        `expected a fenced code block in the CLI Fallback section of ${filePath}`
      ).not.toBeNull()
      const commandLines = (fence?.[1] ?? '')
        .split('\n')
        .filter((line) => line.trim().startsWith('skillsmith '))
      expect(
        commandLines.length,
        `expected at least one "skillsmith <cmd>" line in ${filePath}`
      ).toBeGreaterThan(0)
    })
  }

  it('all three files agree on the exact heading text ("## CLI Fallback")', () => {
    const headings = SKILL_MD_FILES.map(({ path: filePath }) => {
      const content = fs.readFileSync(filePath, 'utf-8')
      const match = FALLBACK_HEADING.exec(content)
      return match?.[0].replace(/^#{2,3}\s+/, '').trim()
    })
    expect(headings.every((h) => h === 'CLI Fallback')).toBe(true)
  })
})

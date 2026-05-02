/**
 * Frozen-fixture regression test for SMI-4587 NEW-E-2.
 *
 * Asserts `indexLocalSkill` returns deterministic output for known
 * frontmatter shapes. The fixtures live under
 * `packages/core/tests/fixtures/index-local/` and must not be edited
 * without updating these snapshots — that's the regression-detection
 * contract for Wave 2/3/4 callers (audit bootstrap + MCP tool).
 */

import { describe, expect, it } from 'vitest'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { indexLocalSkill } from '../../../src/skills/index-local.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const FIXTURES = path.resolve(__dirname, '../../fixtures/index-local')

describe('indexLocalSkill (NEW-E-2 frozen fixture regression)', () => {
  it('full-fixture/SKILL.md → deterministic IndexLocalSkillResult', () => {
    const skillMdPath = path.join(FIXTURES, 'full-fixture', 'SKILL.md')
    const result = indexLocalSkill(skillMdPath)
    expect(result.id).toBe('local/full-fixture')
    expect(result.name).toBe('full-fixture')
    expect(result.description).toBe('A frozen fixture for SMI-4587 NEW-E-2 regression test')
    expect(result.author).toBe('smith-horn')
    expect(result.tags).toEqual(['audit', 'namespace', 'fixture'])
    expect(result.repository).toBe('https://github.com/smith-horn/skillsmith')
    expect(result.compatibility).toEqual(['claude-code', 'cursor'])
    expect(result.trustTier).toBe('local')
    expect(result.source).toBe('local')
    expect(result.hasSkillMd).toBe(true)
    expect(result.path).toBe(path.join(FIXTURES, 'full-fixture'))
    // Score: hasSkillMd=20 + hasName=10 + hasDescription=20 +
    // descLength≈4 (52/200 ≈ 26% * 15 ≈ 4) + hasTags=15 + tagCount=9
    // (3/5 * 15) + hasAuthor=5 = 83. Allow exact match — snapshot.
    expect(result.qualityScore).toBe(83)
  })

  it('full-fixture works when caller passes the directory (not the SKILL.md path)', () => {
    const dir = path.join(FIXTURES, 'full-fixture')
    const result = indexLocalSkill(dir)
    expect(result.id).toBe('local/full-fixture')
    expect(result.hasSkillMd).toBe(true)
    expect(result.path).toBe(dir)
  })

  it('minimal-fixture: frontmatter with only `name` still indexes', () => {
    const skillMdPath = path.join(FIXTURES, 'minimal-fixture', 'SKILL.md')
    const result = indexLocalSkill(skillMdPath)
    expect(result.name).toBe('minimal-fixture')
    expect(result.id).toBe('local/minimal-fixture')
    expect(result.author).toBe('local')
    expect(result.description).toBeNull()
    expect(result.tags).toEqual([])
    expect(result.compatibility).toBeUndefined()
    expect(result.hasSkillMd).toBe(true)
    // Score: hasSkillMd=20 + hasName=10 = 30
    expect(result.qualityScore).toBe(30)
  })

  it('no-skill-md fixture: directory exists but SKILL.md missing → hasSkillMd=false', () => {
    const dir = path.join(FIXTURES, 'no-skill-md')
    const result = indexLocalSkill(dir)
    expect(result.hasSkillMd).toBe(false)
    expect(result.name).toBe('no-skill-md')
    expect(result.id).toBe('local/no-skill-md')
    expect(result.qualityScore).toBe(0)
    expect(result.lastModified).not.toBeNull()
  })

  it('throws a typed error when the path does not exist (audit bootstrap converts to ScanWarning)', () => {
    const ghost = path.join(FIXTURES, 'does-not-exist', 'SKILL.md')
    expect(() => indexLocalSkill(ghost)).toThrowError(/cannot stat/)
  })

  it('respects a caller-supplied parseFrontmatter override', () => {
    const skillMdPath = path.join(FIXTURES, 'full-fixture', 'SKILL.md')
    const result = indexLocalSkill(skillMdPath, {
      parseFrontmatter: () => ({
        name: 'override-name',
        description: 'override',
        author: 'override-author',
        tags: ['x'],
        version: null,
        repository: null,
        homepage: null,
        compatibility: [],
      }),
    })
    expect(result.name).toBe('override-name')
    expect(result.author).toBe('override-author')
  })
})

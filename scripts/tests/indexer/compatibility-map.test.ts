/**
 * SMI-5177 Phase 2a — skill_path → compatibility derivation.
 * @module scripts/tests/indexer/compatibility-map
 *
 * Single source of truth for both the indexer forward-populate and the migration
 * backfill. `deriveCompatibility` is the TS implementation; `compatibilityCaseSql`
 * generates the SQL CASE the migration embeds — a snapshot assertion (skipped when
 * the migration is git-crypt-encrypted, mirroring parity.test.ts) proves the two
 * cannot drift.
 *
 * Matrix authority: docs/internal/research/cross-ecosystem-skill-index-expansion.md §A.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  deriveCompatibility,
  compatibilityCaseSql,
  COMPATIBILITY_MATRIX,
} from '../../indexer/compatibility-map.ts'

describe('SMI-5177: deriveCompatibility', () => {
  it('maps each convention to its matrix slugs (exact dir)', () => {
    expect(deriveCompatibility('.claude/skills')).toEqual(['claude-code'])
    expect(deriveCompatibility('.github/skills')).toEqual(['copilot'])
    expect(deriveCompatibility('.codex/skills')).toEqual(['codex'])
    expect(deriveCompatibility('.cursor/skills')).toEqual(['cursor'])
    expect(deriveCompatibility('.gemini/skills')).toEqual(['gemini'])
    expect(deriveCompatibility('.windsurf/skills')).toEqual(['windsurf'])
  })

  it('maps a nested skill under a convention (segment prefix)', () => {
    expect(deriveCompatibility('.codex/skills/update-v8-version')).toEqual(['codex'])
    expect(deriveCompatibility('.github/skills/my-skill')).toEqual(['copilot'])
  })

  it('maps the cross-tool .agents/skills to all three readers', () => {
    expect(deriveCompatibility('.agents/skills')).toEqual(['windsurf', 'antigravity', 'codex'])
    expect(deriveCompatibility('.agents/skills/foo')).toEqual(['windsurf', 'antigravity', 'codex'])
  })

  it('keeps .agent/skills (Antigravity) distinct from .agents/skills', () => {
    expect(deriveCompatibility('.agent/skills')).toEqual(['antigravity'])
    expect(deriveCompatibility('.agent/skills/x')).toEqual(['antigravity'])
    // The bug the segment rule prevents: .agents must NOT match the .agent arm.
    expect(deriveCompatibility('.agents/skills')).not.toEqual(['antigravity'])
  })

  it('treats nested plugin paths as unscoped (NOT the readable convention)', () => {
    // `.github/plugins/.../skills/...` is a plugin bundle, not Copilot's `.github/skills/`.
    expect(deriveCompatibility('.github/plugins/azure-sdk-java/skills/x')).toEqual([])
    expect(deriveCompatibility('plugins/python-development/skills/y')).toEqual([])
  })

  it('treats generic skills/, bare names, root, .ai, and unknowns as unscoped', () => {
    expect(deriveCompatibility('skills/test-driven-development')).toEqual([])
    expect(deriveCompatibility('.ai/skills')).toEqual([])
    expect(deriveCompatibility('gpt-image-2')).toEqual([])
    expect(deriveCompatibility('')).toEqual([])
    // null/undefined tolerated (skill_path default is '')
    expect(deriveCompatibility(null as unknown as string)).toEqual([])
    expect(deriveCompatibility(undefined as unknown as string)).toEqual([])
  })

  it('does not partial-match a convention prefix without the segment boundary', () => {
    expect(deriveCompatibility('.githubfoo/skills')).toEqual([])
    expect(deriveCompatibility('.github/skillsfoo')).toEqual([])
  })

  it('returns a fresh array (callers may mutate; matrix stays frozen)', () => {
    const a = deriveCompatibility('.claude/skills')
    a.push('mutated')
    expect(deriveCompatibility('.claude/skills')).toEqual(['claude-code'])
  })
})

describe('SMI-5177: compatibilityCaseSql codegen', () => {
  it('emits one WHEN arm per matrix entry plus an ELSE [] fallback', () => {
    const sql = compatibilityCaseSql()
    for (const [conv, slugs] of COMPATIBILITY_MATRIX) {
      expect(sql).toContain(`skill_path = '${conv}'`)
      expect(sql).toContain(`skill_path LIKE '${conv}/%'`)
      expect(sql).toContain(`'${JSON.stringify(slugs)}'::jsonb`)
    }
    expect(sql).toMatch(/ELSE\s+'\[\]'::jsonb/)
    expect(sql.trim().startsWith('CASE')).toBe(true)
    expect(sql.trim().endsWith('END')).toBe(true)
  })
})

/**
 * Drift guard: the committed migration must embed exactly `compatibilityCaseSql()`.
 * Skipped when the migration is git-crypt-encrypted (key-less CI) or not yet
 * authored (TDD step 1) — enforced in unlocked contexts once the file exists.
 */
describe('SMI-5177: migration backfill matches the generated CASE', () => {
  const __dirname = dirname(fileURLToPath(import.meta.url))
  const migrationsDir = resolve(__dirname, '../../../supabase/migrations')

  function findMigration(): string | null {
    let files: string[]
    try {
      files = readdirSync(migrationsDir)
    } catch {
      return null
    }
    const match = files.find((f) => f.endsWith('_skills_compatibility_column.sql'))
    return match ? resolve(migrationsDir, match) : null
  }

  function isGitCryptEncrypted(p: string): boolean {
    try {
      const head = readFileSync(p).subarray(0, 9)
      return head[0] === 0 && head.toString('utf-8', 1, 9) === 'GITCRYPT'
    } catch {
      return false
    }
  }

  const migrationPath = findMigration()
  const skip = !migrationPath || isGitCryptEncrypted(migrationPath)

  it.skipIf(skip)('migration embeds the generated backfill CASE byte-for-byte', () => {
    const sql = readFileSync(migrationPath as string, 'utf8')
    expect(sql).toContain(compatibilityCaseSql())
  })
})

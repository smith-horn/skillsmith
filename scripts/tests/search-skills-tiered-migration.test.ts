/**
 * SMI-7236: search_skills searches tiered skills only.
 *
 * Prod runs on Micro compute. Ranking every 'unknown'-tier match read ~31K
 * heap pages and blew the anon role's 3 s statement_timeout, so search failed
 * for every user. The fix restricts search_skills to trust_tier <> 'unknown'
 * and adds partial GIN indexes with the same predicate.
 *
 * Static guard over the migration text (no live Postgres in CI; the
 * behavioural proof is the prod EXPLAIN ANALYZE recorded on SMI-7236):
 *  1. The NEWEST migration that defines search_skills keeps the tier filter,
 *     so a later CREATE OR REPLACE cannot silently drop it.
 *  2. Both partial indexes exist with a predicate the function's WHERE
 *     implies, so the planner can use them.
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const DIR = 'supabase/migrations'
// Matches a CREATE of search_skills( but not search_skills_v2(,
// fuzzy_search_skills(, or a GRANT ... ON FUNCTION search_skills(.
const DEFINES_SEARCH_SKILLS =
  /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?search_skills\s*\(/i
const TIER_FILTER = /AND\s+s\.trust_tier\s*<>\s*'unknown'/
const INDEX_PREDICATE = "WHERE trust_tier <> 'unknown' AND NOT quarantined"

function searchSkillsBody(sql: string): string {
  const start = sql.search(DEFINES_SEARCH_SKILLS)
  if (start < 0) return ''
  const end = sql.indexOf('LANGUAGE plpgsql', start)
  return end < 0 ? sql.slice(start) : sql.slice(start, end)
}

function definingMigrations(): string[] {
  return readdirSync(DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .filter((f) => DEFINES_SEARCH_SKILLS.test(readFileSync(join(DIR, f), 'utf8')))
}

describe('SMI-7236: search_skills is tiered-only', () => {
  it('finds the migrations that define search_skills (presence control)', () => {
    const files = definingMigrations()
    // Known earlier definitions must be seen, or the scan is pointed at nothing.
    expect(files).toContain('20260703000002_search_skills_minlen_guard.sql')
    expect(files).toContain('20261118000000_search_skills_tiered_only.sql')
  })

  it('the newest search_skills definition keeps the tier filter', () => {
    const files = definingMigrations()
    const newest = files[files.length - 1]
    const body = searchSkillsBody(readFileSync(join(DIR, newest), 'utf8'))
    expect(body).toMatch(/s\.quarantined\s*=\s*FALSE/)
    expect(body).toMatch(TIER_FILTER)
  })

  it('the pre-fix definition lacks the filter (the regex can tell them apart)', () => {
    const body = searchSkillsBody(
      readFileSync(join(DIR, '20260703000002_search_skills_minlen_guard.sql'), 'utf8')
    )
    expect(body.length).toBeGreaterThan(0)
    expect(body).not.toMatch(TIER_FILTER)
  })

  it('creates both partial indexes with the predicate the WHERE implies', () => {
    const sql = readFileSync(join(DIR, '20261118000000_search_skills_tiered_only.sql'), 'utf8')
    for (const [name, expr] of [
      ['idx_skills_search_tiered', 'USING gin (search_vector)'],
      ['idx_skills_tags_text_trgm_tiered', 'USING gin (tags_to_text(tags) gin_trgm_ops)'],
    ]) {
      const stmt = new RegExp(
        `CREATE INDEX IF NOT EXISTS ${name}\\s+ON public\\.skills ${expr.replace(/[()]/g, '\\$&')}\\s+${INDEX_PREDICATE}`
      )
      expect(sql).toMatch(stmt)
    }
  })
})

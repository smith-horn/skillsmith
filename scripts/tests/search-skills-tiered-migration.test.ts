/**
 * SMI-7236: search ranks inside a compact tiered-only table so it fits Micro.
 *
 * Static guard over migration text (CI has no live Postgres). The behavioural
 * proof is on SMI-7236: a staging dry run inside BEGIN/ROLLBACK (count parity,
 * search parity for three terms, eleven trigger cases, a gate mutation) and
 * prod EXPLAIN ANALYZE timings.
 *
 * SQL comments are stripped before every match, so commenting a line out
 * cannot keep a test green (review finding).
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const DIR = 'supabase/migrations'
const FIX = '20261118000000_search_skills_tiered_only.sql'
const PRE_FIX = '20260703000002_search_skills_minlen_guard.sql'
const ELIGIBLE =
  /trust_tier\s+NOT\s+IN\s*\(\s*'unknown'\s*,\s*'unverified'\s*\)\s+AND\s+NOT\s+\w+\.quarantined/i

/** Remove `-- ...` line comments and C-style block comments. */
function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '')
}

function read(file: string): string {
  return stripComments(readFileSync(join(DIR, file), 'utf8'))
}

// A CREATE of search_skills( in any quoting/schema form, but not
// search_skills_v2(, fuzzy_search_skills(, or GRANT ... ON FUNCTION.
const DEFINES_SEARCH_SKILLS =
  /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:"?public"?\.)?"?search_skills"?\s*\(/i

function searchSkillsBody(sql: string): string {
  const start = sql.search(DEFINES_SEARCH_SKILLS)
  if (start < 0) return ''
  const end = sql.indexOf('LANGUAGE plpgsql', start)
  return end < 0 ? sql.slice(start) : sql.slice(start, end)
}

function migrations(): string[] {
  return readdirSync(DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
}

describe('SMI-7236: compact tiered search', () => {
  it('sees both the pre-fix and the fix definitions (presence control)', () => {
    const defining = migrations().filter((f) => DEFINES_SEARCH_SKILLS.test(read(f)))
    expect(defining).toContain(PRE_FIX)
    expect(defining).toContain(FIX)
  })

  it('the newest search_skills definition ranks inside skills_search_tiered', () => {
    const defining = migrations().filter((f) => DEFINES_SEARCH_SKILLS.test(read(f)))
    const body = searchSkillsBody(read(defining[defining.length - 1]))
    expect(body).toMatch(/FROM\s+skills_search_tiered\s+t\b/)
    expect(body).toMatch(/JOIN\s+skills\s+s\s+ON\s+s\.id\s*=\s*page\.skill_id/)
  })

  it('the pre-fix definition does not (the matcher tells them apart)', () => {
    const body = searchSkillsBody(read(PRE_FIX))
    expect(body.length).toBeGreaterThan(0)
    expect(body).not.toMatch(/skills_search_tiered/)
  })

  it('the trigger and the populate INSERT use the same eligibility rule', () => {
    const sql = read(FIX)
    const fn = sql.slice(sql.indexOf('FUNCTION public.sync_skills_search_tiered'))
    expect(fn).toMatch(
      /NEW\.trust_tier\s+NOT\s+IN\s*\(\s*'unknown'\s*,\s*'unverified'\s*\)\s+AND\s+NOT\s+NEW\.quarantined/
    )
    const populate = sql.slice(sql.indexOf('INSERT INTO public.skills_search_tiered'))
    expect(populate).toMatch(ELIGIBLE)
  })

  it('the update trigger fires on every column the compact row copies or filters on', () => {
    const sql = read(FIX)
    const upd = sql.slice(sql.indexOf('CREATE TRIGGER trg_sync_skills_search_tiered_upd'))
    const when = upd.slice(0, upd.indexOf('EXECUTE FUNCTION'))
    for (const col of [
      'id',
      'search_vector',
      'tags',
      'quality_score',
      'trust_tier',
      'quarantined',
    ]) {
      expect(when).toMatch(new RegExp(`OLD\\.${col}\\s+IS\\s+DISTINCT\\s+FROM\\s+NEW\\.${col}`))
    }
    expect(sql).toMatch(
      /CREATE TRIGGER trg_sync_skills_search_tiered\s+AFTER\s+INSERT\s+OR\s+DELETE\s+ON\s+public\.skills/
    )
  })

  it('the gate checks all three indexes', () => {
    const sql = read(FIX)
    const gate = sql.slice(sql.lastIndexOf('DO $$'))
    for (const idx of [
      'idx_skills_quality_desc_live',
      'idx_skills_search_tiered_vector',
      'idx_skills_search_tiered_tags_trgm',
    ]) {
      expect(gate).toContain(`'${idx}'`)
    }
    expect(gate).toMatch(/indisvalid\s+AND\s+x\.indisready\s+AND\s+x\.indislive/)
    expect(gate).toMatch(/RAISE\s+EXCEPTION/)
  })

  it('no later migration drops the table, trigger, sync function or indexes', () => {
    const later = migrations().filter((f) => f > FIX)
    const DROPS =
      /DROP\s+(?:TABLE|TRIGGER|FUNCTION|INDEX)(?:\s+CONCURRENTLY)?(?:\s+IF\s+EXISTS)?\s+(?:"?public"?\.)?"?(skills_search_tiered|trg_sync_skills_search_tiered(?:_upd)?|sync_skills_search_tiered|idx_skills_quality_desc_live|idx_skills_search_tiered_vector|idx_skills_search_tiered_tags_trgm)\b/i
    const offenders = later.filter((f) => DROPS.test(read(f)))
    expect(offenders).toEqual([])
  })

  it('the trigger removes ineligible rows and refreshes eligible ones (review mutations)', () => {
    const sql = read(FIX)
    const fn = sql.slice(
      sql.indexOf('FUNCTION public.sync_skills_search_tiered'),
      sql.indexOf('REVOKE ALL ON FUNCTION public.sync_skills_search_tiered')
    )
    // ELSE branch: a skill that stops being eligible leaves search.
    expect(fn).toMatch(/ELSE\s+DELETE\s+FROM\s+skills_search_tiered\s+WHERE\s+id\s*=\s*NEW\.id/)
    // Upsert must overwrite every copied column, not DO NOTHING.
    expect(fn).not.toMatch(/DO\s+NOTHING/i)
    expect(fn).toMatch(/search_vector\s*=\s*EXCLUDED\.search_vector/)
    expect(fn).toMatch(/tags_text\s*=\s*EXCLUDED\.tags_text/)
    expect(fn).toMatch(/quality_score\s*=\s*EXCLUDED\.quality_score/)
  })

  it('creates the triggers, then truncates, then populates', () => {
    const sql = read(FIX)
    const trg = sql.indexOf('CREATE TRIGGER trg_sync_skills_search_tiered_upd')
    const trunc = sql.indexOf('TRUNCATE public.skills_search_tiered')
    const populate = sql.indexOf('INSERT INTO public.skills_search_tiered')
    expect(trg).toBeGreaterThan(0)
    expect(trunc).toBeGreaterThan(trg)
    expect(populate).toBeGreaterThan(trunc)
  })

  it('ranks with a deterministic tiebreak and a capped page size', () => {
    const body = searchSkillsBody(read(FIX))
    expect(body).toMatch(/ORDER\s+BY\s+r\s+DESC,\s*q\s+DESC\s+NULLS\s+LAST,\s*t\.id/)
    expect(body).toMatch(/LIMIT\s+LEAST\(GREATEST\(limit_count,\s*0\),\s*250\)/)
    expect(body).toMatch(
      /ORDER\s+BY\s+page\.r\s+DESC,\s*page\.q\s+DESC\s+NULLS\s+LAST,\s*page\.skill_id/
    )
  })

  it('has no FK from the compact table to skills and puts pg_temp last', () => {
    const sql = read(FIX)
    const table = sql.slice(sql.indexOf('CREATE TABLE IF NOT EXISTS public.skills_search_tiered'))
    expect(table.slice(0, table.indexOf(');'))).not.toMatch(/REFERENCES/i)
    expect(sql.match(/SET\s+search_path\s*=\s*public,\s*pg_temp/g)?.length).toBe(2)
  })

  it('enables RLS and states the access model as a policy in the same file (PR-02)', () => {
    const sql = read(FIX)
    expect(sql).toMatch(/ALTER TABLE public\.skills_search_tiered ENABLE ROW LEVEL SECURITY/)
    expect(sql).toMatch(
      /CREATE POLICY\s+\w+\s+ON public\.skills_search_tiered\s+FOR SELECT TO service_role USING \(true\)/
    )
    // Clients get neither a policy nor a grant.
    expect(sql).not.toMatch(
      /CREATE POLICY[^;]*ON public\.skills_search_tiered[^;]*TO\s+(anon|authenticated)/
    )
  })
})

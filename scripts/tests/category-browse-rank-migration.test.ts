/**
 * SMI-7239: category browse pages inside skills_category_rank; fuzzy search
 * reads the tiered-only compact table.
 *
 * Static guard over migration text (CI has no live Postgres). The behavioural
 * proof is the staging rehearsal recorded on SMI-7239. SQL comments are
 * stripped before every match, so commenting a line out cannot keep a test
 * green.
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const DIR = 'supabase/migrations'
const FIX = '20261120000000_category_browse_rank.sql'
const EDGE = 'supabase/functions/skills-search/filter-only-query.ts'

function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '')
}

function read(file: string): string {
  return stripComments(readFileSync(join(DIR, file), 'utf8'))
}

function migrations(): string[] {
  return readdirSync(DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
}

/** The text of one CREATE FUNCTION, from its header to its closing dollar-quote tag. */
function fnBody(sql: string, name: string): string {
  const header = new RegExp(`CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+public\\.${name}\\s*\\(`, 'i')
  const start = sql.search(header)
  if (start < 0) return ''
  const tag = /\bAS\s+(\$\w*\$)/.exec(sql.slice(start))
  if (!tag) return ''
  const open = start + tag.index + tag[0].length
  const close = sql.indexOf(tag[1], open)
  return close < 0 ? '' : sql.slice(start, close + tag[1].length)
}

/** The text of one CREATE TRIGGER statement. */
function triggerStmt(sql: string, name: string): string {
  const start = sql.search(new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?TRIGGER\\s+${name}\\b`, 'i'))
  if (start < 0) return ''
  return sql.slice(start, sql.indexOf(';', start) + 1)
}

const DEFINES_FUZZY =
  /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:"?public"?\.)?"?fuzzy_search_skills"?\s*\(/i

describe('SMI-7239: category browse rank table and tiered fuzzy search', () => {
  it('this migration is the newest fuzzy_search_skills definition (presence control)', () => {
    const defining = migrations().filter((f) => DEFINES_FUZZY.test(read(f)))
    expect(defining.length).toBeGreaterThan(1)
    expect(defining[defining.length - 1]).toBe(FIX)
  })

  it('fuzzy search reads only the tiered table, as definer, with no user schema on its path', () => {
    const body = fnBody(read(FIX), 'fuzzy_search_skills')
    expect(body).toMatch(/SECURITY\s+DEFINER/)
    expect(body).toMatch(/SET\s+search_path\s*=\s*pg_catalog,\s*pg_temp/)
    // Both arms (name, then description) read the compact table...
    expect(body.match(/FROM\s+public\.skills_search_tiered\s+t\b/g)?.length).toBe(2)
    // ...and join back to skills with quarantine excluded.
    expect(
      body.match(
        /JOIN\s+public\.skills\s+s\s+ON\s+s\.id\s*=\s*\w+\.id\s+AND\s+NOT\s+s\.quarantined/g
      )?.length
    ).toBe(2)
    // Never scans skills directly for candidates.
    expect(body).not.toMatch(/FROM\s+public\.skills\s/)
    // Trigram operators are schema-qualified, since extensions is off the path.
    expect(body).toMatch(/OPERATOR\(extensions\.<%\)/)
    expect(body).not.toMatch(/[^(.]<%\s/)
  })

  it('fuzzy search: PUBLIC revoked, then granted to the three API roles', () => {
    const sql = read(FIX)
    const revoke = sql.search(
      /REVOKE\s+ALL\s+ON\s+FUNCTION\s+public\.fuzzy_search_skills\(text, real, integer\)\s+FROM\s+PUBLIC/
    )
    const grant = sql.search(
      /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.fuzzy_search_skills\(text, real, integer\)\s+TO\s+anon,\s*authenticated,\s*service_role/
    )
    expect(revoke).toBeGreaterThan(0)
    expect(grant).toBeGreaterThan(revoke)
  })

  it('the tiered sync keeps its eligibility rule and now copies name and description', () => {
    const body = fnBody(read(FIX), 'sync_skills_search_tiered')
    expect(body).toMatch(
      /NEW\.trust_tier\s+NOT\s+IN\s*\(\s*'unknown'\s*,\s*'unverified'\s*\)\s+AND\s+NOT\s+NEW\.quarantined/
    )
    expect(body).toMatch(
      /ELSE\s+DELETE\s+FROM\s+public\.skills_search_tiered\s+WHERE\s+id\s*=\s*NEW\.id/
    )
    expect(body).toMatch(/name\s*=\s*EXCLUDED\.name/)
    expect(body).toMatch(/description\s*=\s*EXCLUDED\.description/)
  })

  it('the tiered update trigger is replaced in place and fires on name and description', () => {
    const sql = read(FIX)
    expect(sql).not.toMatch(/DROP\s+TRIGGER[^;]*trg_sync_skills_search_tiered_upd/i)
    const trg = triggerStmt(sql, 'trg_sync_skills_search_tiered_upd')
    expect(trg).toMatch(/^CREATE\s+OR\s+REPLACE\s+TRIGGER/)
    for (const col of [
      'id',
      'search_vector',
      'tags',
      'quality_score',
      'trust_tier',
      'quarantined',
      'name',
      'description',
    ]) {
      expect(trg).toMatch(new RegExp(`OLD\\.${col}\\s+IS\\s+DISTINCT\\s+FROM\\s+NEW\\.${col}\\b`))
    }
  })

  it('the skills trigger fires on every column the rank row copies or filters on', () => {
    const trg = triggerStmt(read(FIX), 'trg_sync_skills_category_rank_skill')
    expect(trg).toMatch(/AFTER\s+UPDATE\s+ON\s+public\.skills/)
    for (const col of ['id', 'quality_score', 'trust_tier', 'quarantined', 'security_score']) {
      expect(trg).toMatch(new RegExp(`OLD\\.${col}\\s+IS\\s+DISTINCT\\s+FROM\\s+NEW\\.${col}\\b`))
    }
    expect(trg).toMatch(
      /\(OLD\.last_scanned_at\s+IS\s+NULL\)\s+IS\s+DISTINCT\s+FROM\s+\(NEW\.last_scanned_at\s+IS\s+NULL\)/
    )
  })

  it('link changes of every kind, and truncates of either source, reach the rank table', () => {
    const sql = read(FIX)
    expect(triggerStmt(sql, 'trg_sync_skills_category_rank_link')).toMatch(
      /AFTER\s+INSERT\s+OR\s+UPDATE\s+OR\s+DELETE\s+ON\s+public\.skill_categories/
    )
    expect(triggerStmt(sql, 'trg_truncate_skills_category_rank')).toMatch(
      /AFTER\s+TRUNCATE\s+ON\s+public\.skill_categories\s+FOR\s+EACH\s+STATEMENT/
    )
    expect(triggerStmt(sql, 'trg_truncate_skills_search_tiered')).toMatch(
      /AFTER\s+TRUNCATE\s+ON\s+public\.skills\s+FOR\s+EACH\s+STATEMENT/
    )
  })

  it('every rank writer excludes quarantined skills', () => {
    const sql = read(FIX)
    expect(fnBody(sql, 'sync_skills_category_rank_from_link')).toMatch(/AND\s+NOT\s+s\.quarantined/)
    expect(fnBody(sql, 'sync_skills_category_rank_from_skill')).toMatch(
      /IF\s+NOT\s+NEW\.quarantined\s+THEN/
    )
    expect(fnBody(sql, 'rebuild_skills_category_rank')).toMatch(/WHERE\s+NOT\s+s\.quarantined/)
  })

  it('the rank table is service-role only: RLS on, no client grant or policy', () => {
    const sql = read(FIX)
    expect(sql).toMatch(/ALTER TABLE public\.skills_category_rank ENABLE ROW LEVEL SECURITY/)
    expect(sql).toMatch(/REVOKE ALL ON public\.skills_category_rank FROM anon, authenticated/)
    expect(sql).not.toMatch(
      /GRANT[^;]*ON\s+(?:TABLE\s+)?public\.skills_category_rank[^;]*TO[^;]*(anon|authenticated)/i
    )
    expect(sql).not.toMatch(
      /CREATE POLICY[^;]*ON public\.skills_category_rank[^;]*TO\s+(anon|authenticated)/
    )
  })

  it('browse validates its inputs and its offset cap matches the edge function', () => {
    const body = fnBody(read(FIX), 'browse_category_skills')
    expect(body).toMatch(/SECURITY\s+DEFINER/)
    expect(body).toMatch(/p_limit\s+IS\s+NULL\s+OR\s+p_limit\s*<\s*1\s+OR\s+p_limit\s*>\s*100\b/)
    const cap = body.match(
      /p_offset\s+IS\s+NULL\s+OR\s+p_offset\s*<\s*0\s+OR\s+p_offset\s*>\s*(\d+)/
    )
    expect(cap).not.toBeNull()
    const edge = readFileSync(EDGE, 'utf8').match(/export const CATEGORY_MAX_OFFSET = (\d+)/)
    expect(edge).not.toBeNull()
    expect(Number(cap?.[1])).toBe(Number(edge?.[1]))
    // Independent policy pin (review R1): the two caps agreeing on an unsafe value
    // must still fail. Each call walks up to offset + limit entries per tier, so
    // the cap bounds anon work; raising it needs a measured cold prod plan.
    expect(Number(cap?.[1])).toBeLessThanOrEqual(10000)
    // Tier strings are length-bounded before use.
    expect(body).toMatch(
      /EXISTS\s*\(SELECT 1 FROM unnest\(p_tiers\) AS u\(t\) WHERE length\(u\.t\) > 32\)/
    )
    expect(body).toMatch(/WHERE\s+NOT\s+s\.quarantined/)
  })

  it('browse applies the same predicates and order as the old query in both branches', () => {
    const body = fnBody(read(FIX), 'browse_category_skills')
    for (const pred of [
      /\(p_min_score IS NULL OR r\.quality_score >= p_min_score\)/g,
      /\(p_max_risk IS NULL OR r\.security_score IS NULL OR r\.security_score <= p_max_risk\)/g,
      /\(NOT COALESCE\(p_safe_only, FALSE\) OR \(r\.scanned AND r\.security_score = 0\)\)/g,
      /ORDER BY r\.quality_score DESC NULLS LAST, r\.skill_id\s+LIMIT v_take/g,
    ]) {
      // Once in the unfiltered branch, once in the per-tier branch.
      expect(body.match(pred)?.length).toBe(2)
    }
    expect(body).toMatch(/AND r\.trust_tier = tv\.tier/)
    expect(body).toMatch(
      /ORDER BY cand\.q DESC NULLS LAST, cand\.skill_id\s+LIMIT p_limit OFFSET p_offset/
    )
    expect(body).toMatch(/ORDER BY page\.q DESC NULLS LAST, page\.skill_id;/)
  })

  it('the link trigger locks its skill rows FOR SHARE before writing (review R1 race)', () => {
    const body = fnBody(read(FIX), 'sync_skills_category_rank_from_link')
    const lock = body.search(
      /PERFORM 1\s+FROM public\.skills s[\s\S]*?ORDER BY s\.id\s+FOR SHARE OF s;/
    )
    const firstWrite = body.search(/\b(DELETE FROM|INSERT INTO) public\.skills_category_rank/)
    expect(lock).toBeGreaterThan(0)
    expect(firstWrite).toBeGreaterThan(lock)
    // Both the old and the new skill id are locked.
    expect(body).toMatch(/CASE WHEN TG_OP IN \('DELETE', 'UPDATE'\) THEN OLD\.skill_id END/)
    expect(body).toMatch(/CASE WHEN TG_OP IN \('INSERT', 'UPDATE'\) THEN NEW\.skill_id END/)
  })

  it('fuzzy name arm caps its candidates before scoring', () => {
    const body = fnBody(read(FIX), 'fuzzy_search_skills')
    const nameArm = body.slice(0, body.indexOf('GET DIAGNOSTICS'))
    expect(nameArm).toMatch(
      /SELECT t\.id, t\.name\s+FROM public\.skills_search_tiered t\s+WHERE search_query OPERATOR\(extensions\.<%\) t\.name\s+LIMIT 1000\s+\) c\s+ORDER BY 2 DESC, c\.id/
    )
  })

  it('waits at most 3 s for a lock', () => {
    const sql = read(FIX)
    expect(sql).toMatch(/SET LOCAL lock_timeout = '3s';/)
    expect(sql).not.toMatch(/lock_timeout = '(?!3s')/)
  })

  it('browse: PUBLIC revoked before clients are granted', () => {
    const sql = read(FIX)
    const sig =
      'public\\.browse_category_skills\\(text, text\\[\\], numeric, integer, boolean, integer, integer\\)'
    const revoke = sql.search(
      new RegExp(`REVOKE\\s+ALL\\s+ON\\s+FUNCTION\\s+${sig}\\s+FROM\\s+PUBLIC`)
    )
    const grant = sql.search(
      new RegExp(
        `GRANT\\s+EXECUTE\\s+ON\\s+FUNCTION\\s+${sig}\\s+TO\\s+anon,\\s*authenticated,\\s*service_role`
      )
    )
    expect(revoke).toBeGreaterThan(0)
    expect(grant).toBeGreaterThan(revoke)
  })

  it('the gate checks all five new indexes and the rank row count, with no reconcile inside the lock', () => {
    const sql = read(FIX)
    const gate = sql.slice(sql.lastIndexOf('DO $$'))
    for (const idx of [
      'idx_skills_search_tiered_name_trgm',
      'idx_skills_search_tiered_desc_trgm',
      'idx_skills_category_rank_order',
      'idx_skills_category_rank_tier',
      'idx_skills_category_rank_skill',
    ]) {
      expect(gate).toContain(`'${idx}'`)
    }
    // Row-count check inside the locked window; the full reconcile runs after COMMIT
    // (the in-gate EXCEPT pair took about 2 min on prod and timed out the first apply).
    expect(gate).toMatch(
      /SELECT \(SELECT count\(\*\) FROM public\.skills_category_rank\)\s+- \(SELECT count\(\*\) FROM public\.skill_categories sc JOIN public\.skills s ON s\.id = sc\.skill_id\s+WHERE NOT s\.quarantined\)\s+INTO drift;\s+IF drift <> 0 THEN\s+RAISE EXCEPTION/
    )
    expect(gate).not.toMatch(/\bEXCEPT\b/)
    expect(gate).toMatch(/RAISE\s+EXCEPTION/)
  })

  it('no later migration drops the rank table, its triggers or functions, or browse', () => {
    const later = migrations().filter((f) => f > FIX)
    const DROPS =
      /DROP\s+(?:TABLE|TRIGGER|FUNCTION|INDEX)(?:\s+CONCURRENTLY)?(?:\s+IF\s+EXISTS)?\s+(?:"?public"?\.)?"?(skills_category_rank|trg_sync_skills_category_rank_(?:link|skill)|trg_truncate_skills_(?:category_rank|search_tiered)|sync_skills_category_rank_from_(?:link|skill)|truncate_skills_(?:category_rank|search_tiered)|rebuild_skills_category_rank|browse_category_skills|idx_skills_category_rank_(?:order|tier|skill)|idx_skills_search_tiered_(?:name|desc)_trgm)\b/i
    expect(later.filter((f) => DROPS.test(read(f)))).toEqual([])
  })
})

#!/usr/bin/env npx tsx
/**
 * SMI-6033 Wave 1 (Gap 7): generate the checked-in, build-time typosquat
 * reference-name snapshot consumed by `skill_validate`
 * (`packages/mcp-server/src/tools/validate-typosquat-scan.ts`).
 *
 * `skill_validate` is fully offline by design (no network/DB import — see
 * `validate.ts`'s header) and stays that way; an edge-function cron can't
 * write into an already-published npm package, so this is a release-time
 * generator instead of a live query. Regeneration is intended to become a
 * step in the release-prep checklist (`scripts/prepare-release.ts`, weekly
 * per ADR-114) — days-to-weeks staleness is acceptable for a warn-tier,
 * medium-capped detector whose reference set churns slowly. That checklist
 * wiring is NOT done by this script — see the plan doc's Wave 1 step 8 and
 * this repo's `docs/internal/process/` conventions for where that belongs.
 *
 * Runs the SAME query as the indexer's live reference-list builder
 * (`scripts/indexer/typosquat-reference.ts`) by calling that module's
 * `fetchTyposquatReferenceSet()` directly — one query implementation, two
 * consumers (indexer batch runs vs. this one-shot release-time snapshot).
 *
 * Deviation from the plan doc's literal "Node Postgres client" wording
 * (`docs/internal/implementation/smi-6033-clawhavoc-scanner-gaps.md`, Gap 7 §
 * "Files"): the plan's own `scripts/pooler-psql.sh` reference is a raw
 * `psql`-via-Docker script, and the repo has no *working* Node Postgres
 * client dependency — `scripts/run-sql.ts` imports the `pg` npm package, but
 * `pg` is not actually present in package.json/package-lock.json (verified:
 * zero hits for `"pg"` in either), so that script cannot currently run.
 * Adding a new dependency here would need an `npm install` + lockfile
 * regen this pass cannot perform. `@supabase/supabase-js` (already an
 * installed, working dependency used throughout `scripts/indexer/`) reaches
 * the exact same `skills` table via the existing `SUPABASE_URL` +
 * `SUPABASE_SERVICE_ROLE_KEY` admin-client convention
 * (`scripts/indexer/_shared/supabase.ts`), which every other host-side
 * Supabase script in this repo (`scripts/verify-quality.ts` et al.) already
 * uses instead of a direct Postgres wire-protocol connection.
 *
 * Usage (host tool — requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY via Varlock):
 *   varlock run -- npx tsx scripts/generate-typosquat-snapshot.ts
 */

import { writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { createClient } from '@supabase/supabase-js'
import { fetchTyposquatReferenceSet } from './indexer/typosquat-reference.ts'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

/** Checked-in snapshot consumed by skill_validate's offline typosquat check. */
export const SNAPSHOT_PATH = join(
  __dirname,
  '..',
  'packages',
  'mcp-server',
  'src',
  'assets',
  'typosquat-reference-snapshot.json'
)

export interface TyposquatReferenceSnapshot {
  generatedAt: string
  source: string
  names: string[]
}

async function main(): Promise<void> {
  const supabaseUrl = process.env.SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !serviceRoleKey) {
    console.error(
      'Missing required environment variables: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY. ' +
        'Run via: varlock run -- npx tsx scripts/generate-typosquat-snapshot.ts'
    )
    process.exit(1)
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  })

  const referenceSet = await fetchTyposquatReferenceSet(supabase)
  const names = [...referenceSet].sort()

  const snapshot: TyposquatReferenceSnapshot = {
    generatedAt: new Date().toISOString(),
    source: 'skills.stars+high-trust',
    names,
  }

  writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2) + '\n', 'utf-8')
  console.log(
    `[generate-typosquat-snapshot] wrote ${names.length} reference names to ${SNAPSHOT_PATH}`
  )
}

main().catch((error) => {
  console.error('[generate-typosquat-snapshot] failed:', error)
  process.exit(1)
})

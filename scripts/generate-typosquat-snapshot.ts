#!/usr/bin/env npx tsx
/**
 * SMI-6033 Wave 1 (Gap 7): generate the checked-in, build-time typosquat
 * reference-name snapshot consumed by `skill_validate`
 * (`packages/mcp-server/src/tools/validate-typosquat-scan.ts`).
 *
 * `skill_validate` is fully offline by design (no network/DB import — see
 * `validate.ts`'s header) and stays that way; an edge-function cron can't
 * write into an already-published npm package, so this is a release-time
 * generator instead of a live query. Regeneration is a step in the release-prep
 * flow: `scripts/prepare-release.ts` Step 5.6 calls
 * `ensureTyposquatSnapshot()` (`scripts/lib/release-typosquat-snapshot.ts`),
 * which invokes `generateTyposquatSnapshot()` below when Supabase credentials
 * are present and otherwise HARD-FAILS the release if the checked-in snapshot
 * is empty or stale. Days-to-weeks staleness is acceptable for a warn-tier,
 * medium-capped detector whose reference set churns slowly; a permanently
 * EMPTY snapshot is not — that silently disabled the whole `skill_validate`
 * typosquat check, which is exactly the failure this wiring exists to prevent.
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

/** Env var names the generator requires (surfaced in error messages/callers). */
export const REQUIRED_ENV_VARS = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'] as const

/** The canonical way to run this generator, quoted verbatim in error messages. */
export const GENERATE_COMMAND = 'varlock run -- npx tsx scripts/generate-typosquat-snapshot.ts'

/**
 * Query the live reference set and write the checked-in snapshot.
 *
 * Exported (rather than living only in `main()`) so `prepare-release.ts` can
 * regenerate in-process via `ensureTyposquatSnapshot()` instead of shelling
 * out — see `scripts/lib/release-typosquat-snapshot.ts`.
 *
 * @throws when SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are absent, or the
 *   query fails. Callers decide whether that is fatal.
 */
export async function generateTyposquatSnapshot(): Promise<{
  path: string
  count: number
  generatedAt: string
}> {
  const supabaseUrl = process.env.SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error(
      `Missing required environment variables: ${REQUIRED_ENV_VARS.join(' and ')}. ` +
        `Run via: ${GENERATE_COMMAND}`
    )
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  })

  const referenceSet = await fetchTyposquatReferenceSet(supabase)
  const names = [...referenceSet].sort()

  // Never overwrite a populated snapshot with an empty one: an empty `names`
  // array makes `scanTyposquatName()` a permanent no-op, which is precisely
  // the silent-disable bug this asset shipped with before SMI-6033. A query
  // that legitimately returns nothing is indistinguishable here from one that
  // silently degraded, so fail loudly rather than write the no-op.
  if (names.length === 0) {
    throw new Error(
      'Reference-set query returned ZERO names — refusing to write an empty snapshot ' +
        '(an empty snapshot silently disables the skill_validate typosquat check). ' +
        'Check SUPABASE_URL points at prod and that `skills` has installable, non-quarantined rows.'
    )
  }

  const generatedAt = new Date().toISOString()
  const snapshot: TyposquatReferenceSnapshot = {
    generatedAt,
    source: 'skills.stars+high-trust',
    names,
  }

  writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2) + '\n', 'utf-8')
  return { path: SNAPSHOT_PATH, count: names.length, generatedAt }
}

async function main(): Promise<void> {
  const { path, count } = await generateTyposquatSnapshot()
  console.log(`[generate-typosquat-snapshot] wrote ${count} reference names to ${path}`)
}

// Run only when invoked directly (not when imported by prepare-release/tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('[generate-typosquat-snapshot] failed:', error)
    process.exit(1)
  })
}

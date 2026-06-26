/**
 * Quarantine helper twin parity (SMI-5357)
 * @module scripts/tests/indexer/quarantine-twin-parity
 *
 * The Deno parent `supabase/functions/_shared/quarantine.ts` and the Node port
 * `scripts/indexer/_shared/quarantine.ts` must stay byte-identical (after
 * whitespace normalization) from the shared `export interface QuarantineFinding`
 * to EOF — the interface, both write-path helpers (`quarantineSkill`,
 * `quarantineSkillsBatch`), and the `FINDING_*` constants. The two files differ
 * ONLY in their leading module-doc header + the one import line (Deno esm.sh URL
 * vs Node `@supabase/supabase-js`), which precede the interface.
 *
 * WHY THIS EXISTS: SMI-4431 added a required `reason` parameter to the Node
 * `quarantineSkillsBatch` + the `quarantine_stale_skills` RPC so every stale
 * quarantine records a `quarantine_reason`, but never updated the Deno parent —
 * whose fallback `.update()` omitted `quarantine_reason`. That silent divergence
 * produced 86 prod rows with `quarantined=true, quarantine_reason=NULL`
 * (ADR-112 Contract 4 violation). SMI-5357 restored parity and added this guard
 * so a future one-sided edit fails the build instead of prod.
 *
 * The full-region slice (not per-function extraction) is used deliberately: it is
 * the strongest parity guarantee and avoids the `extractBody` helper's
 * mis-handling of `Promise<{ ... }>` return-type annotations. Whitespace is
 * normalized (deno fmt vs prettier disagree on wrap), so semantic divergence is
 * caught while cosmetic formatting is not. `it.skipIf` when the Deno file is
 * git-crypt-encrypted (a CI lane without the key) so the invariant is enforced
 * wherever the diff actually lands (PR matrix, local Docker).
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import { normalizeWs, isGitCryptEncrypted } from './parity-utils.ts'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const REPO_ROOT = resolve(__dirname, '..', '..', '..')

const DENO_QUARANTINE = resolve(REPO_ROOT, 'supabase/functions/_shared/quarantine.ts')
const NODE_QUARANTINE = resolve(REPO_ROOT, 'scripts/indexer/_shared/quarantine.ts')

const MARKER = 'export interface QuarantineFinding'
const denoEncrypted = isGitCryptEncrypted(DENO_QUARANTINE)

/** Slice from the first shared marker to EOF (skips the differing header/import). */
function sharedRegion(filePath: string): string {
  const source = readFileSync(filePath, 'utf-8')
  const idx = source.indexOf(MARKER)
  if (idx < 0) throw new Error(`'${MARKER}' not found in ${filePath}`)
  return source.slice(idx)
}

describe('quarantine.ts twin parity (SMI-5357)', () => {
  it.skipIf(denoEncrypted)(
    'shared region (interface + helpers + constants) is byte-identical (normalized whitespace)',
    () => {
      const deno = normalizeWs(sharedRegion(DENO_QUARANTINE))
      const node = normalizeWs(sharedRegion(NODE_QUARANTINE))
      expect(node).toBe(deno)
    }
  )

  it.skipIf(denoEncrypted)(
    'quarantine_reason: reason appears exactly twice per twin (the SMI-5357 defect)',
    () => {
      // The exact regression: the fallback direct-update must set quarantine_reason.
      // A plain `toContain` would false-green if it were dropped from ONLY the batch
      // fallback (the single-skill helper still has it). Assert the literal appears
      // EXACTLY twice per twin — quarantineSkill's updateData + quarantineSkillsBatch's
      // fallback `.update()` — so dropping it from either helper fails the test.
      for (const f of [DENO_QUARANTINE, NODE_QUARANTINE]) {
        const count = (sharedRegion(f).match(/quarantine_reason: reason/g) || []).length
        expect(count).toBe(2)
      }
    }
  )

  it.skipIf(denoEncrypted)(
    'quarantineSkillsBatch requires a non-optional reason in both twins',
    () => {
      // Guards against re-introducing the optional `reason?` that let stale
      // quarantines skip recording a reason.
      for (const f of [DENO_QUARANTINE, NODE_QUARANTINE]) {
        const region = sharedRegion(f)
        expect(region).toContain('finding: QuarantineFinding,\n  reason: string,')
        expect(region).not.toContain('reason?: string')
      }
    }
  )

  // The three tests above `skipIf` when the Deno twin is git-crypt-encrypted (a CI
  // lane without the key). The Node twin is NEVER encrypted (only supabase/functions
  // + migrations are), so this unconditional guard catches the regression in EVERY
  // lane — the always-on backstop for the actual defect.
  it('Node twin writes quarantine_reason in both helpers (runs in every CI lane)', () => {
    const region = sharedRegion(NODE_QUARANTINE)
    expect((region.match(/quarantine_reason: reason/g) || []).length).toBe(2)
    expect(region).not.toContain('reason?: string')
  })
})

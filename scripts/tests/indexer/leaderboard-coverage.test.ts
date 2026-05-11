/**
 * SMI-4843 Phase 5 leaderboard-coverage test
 * @module scripts/tests/indexer/leaderboard-coverage
 *
 * Asserts that all 18 publishers accepted in Phase 5 (verified against
 * `docs/internal/research/skills-sh-leaderboard.md` and the candidate
 * verification log) are present in HIGH_TRUST_AUTHORS. This catches
 * accidental removal of Phase 5 entries in future refactors.
 *
 * Coverage list is hard-coded (rather than parsed from the research doc)
 * because the research doc is brittle markdown and may evolve; the
 * post-phase invariant is fixed.
 *
 * The companion research doc lives in the `docs/internal` private submodule.
 * When the submodule is uninitialized (external contributors) the doc is
 * absent — the test soft-skips on that branch but still asserts membership
 * on the hard-coded list.
 */

import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HIGH_TRUST_AUTHORS } from '../../../scripts/indexer/high-trust-authors.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const REPO_ROOT = resolve(__dirname, '..', '..', '..')
const RESEARCH_DOC = resolve(REPO_ROOT, 'docs/internal/research/skills-sh-leaderboard.md')

/**
 * Phase 5 accepted publishers (Waves 1 + 2 from
 * `/tmp/smi-4843-phase5-candidates.md`, 2026-05-11).
 */
const PHASE_5_ACCEPTED: ReadonlyArray<readonly [string, string]> = [
  ['firebase', 'agent-skills'],
  ['supabase', 'agent-skills'],
  ['shadcn-ui', 'ui'],
  ['expo', 'skills'],
  ['obra', 'superpowers'],
  ['getsentry', 'skills'],
  ['neondatabase', 'agent-skills'],
  ['browser-use', 'browser-use'],
  ['microsoft', 'azure-skills'],
  ['larksuite', 'cli'],
  ['microsoft', 'playwright-cli'],
  ['google-labs-code', 'stitch-skills'],
  ['vercel-labs', 'agent-browser'],
  ['wshobson', 'agents'],
  ['coreyhaines31', 'marketingskills'],
  ['pbakaus', 'impeccable'],
  ['xixu-me', 'skills'],
  ['heygen-com', 'hyperframes'],
]

describe('SMI-4843 Phase 5 leaderboard coverage', () => {
  it('Phase 5 accepted list has the expected 18 entries', () => {
    expect(PHASE_5_ACCEPTED).toHaveLength(18)
  })

  it('every Phase 5 accepted publisher is present in HIGH_TRUST_AUTHORS', () => {
    const present = new Set(
      HIGH_TRUST_AUTHORS.map((a) => `${a.owner.toLowerCase()}/${a.repo.toLowerCase()}`)
    )
    const missing: string[] = []
    for (const [owner, repo] of PHASE_5_ACCEPTED) {
      const key = `${owner.toLowerCase()}/${repo.toLowerCase()}`
      if (!present.has(key)) missing.push(key)
    }
    expect(missing).toEqual([])
  })

  const researchDocMissing = !existsSync(RESEARCH_DOC)

  it.skipIf(researchDocMissing)(
    'every Phase 5 publisher appears at least once in the research doc',
    () => {
      const doc = readFileSync(RESEARCH_DOC, 'utf-8')
      const missing: string[] = []
      for (const [owner, repo] of PHASE_5_ACCEPTED) {
        // Loose check — `owner/repo` may appear in tables, links, or prose.
        if (!doc.includes(`${owner}/${repo}`)) missing.push(`${owner}/${repo}`)
      }
      // Slug-correction allowances — see the verification log
      // (`/tmp/smi-4843-phase5-candidates.md` § Corrections / Flags):
      // - shadcn-ui/ui: research doc references it as `shadcn/ui` (the
      //   published slug on skills.sh; actual GitHub org is `shadcn-ui`)
      // - getsentry/skills: research doc references it as `sentry/dev` (a
      //   candidate slug that 404s; correct repo discovered via org search)
      const SLUG_CORRECTIONS: Record<string, string> = {
        'shadcn-ui/ui': 'shadcn/ui',
        'getsentry/skills': 'sentry/dev',
      }
      const filteredMissing = missing.filter((m) => {
        const alt = SLUG_CORRECTIONS[m]
        return alt === undefined || !doc.includes(alt)
      })
      expect(filteredMissing).toEqual([])
    }
  )
})

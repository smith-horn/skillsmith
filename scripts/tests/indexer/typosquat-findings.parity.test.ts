/**
 * SMI-6033 Wave 1 (Gap 7, cross-model review follow-up): executable drift guard
 * between the TWO copies of the core->edge typosquat finding mapping.
 *
 * Copy A: inline inside `scanSkillBundle` (`scripts/indexer/skill-processor.security.ts`) —
 *   the discovery path. That file is pinned byte-identical to its Deno twin by
 *   `parity.test.ts`, so it cannot import a Node-only shared helper.
 * Copy B: `buildTyposquatFindings` (`scripts/indexer/typosquat-findings.ts`) —
 *   used by the stale-quarantine recheck path (`revalidate-stale-quarantines.ts`
 *   -> `runSiblingRescan`), which exists only in the Node tree.
 *
 * A comment saying "keep these in sync" is exactly the kind of guarantee
 * SMI-6033 exists to stop relying on, so this test runs the SAME
 * (candidateName, referenceNames) input through both and asserts the emitted
 * findings are deep-equal. `scanSkillBundle`'s network layers are fully
 * injected via its `deps` seam — no fetch, no DB.
 */
import { describe, it, expect } from 'vitest'
import { scanSkillBundle } from '../../indexer/skill-processor.security.ts'
import { buildTyposquatFindings } from '../../indexer/typosquat-findings.ts'
import { newRateLimitTelemetry } from '../../indexer/_shared/rate-limit.ts'
import { scanSkillContent } from '../../indexer/_shared/security-scanner-edge.ts'
// SMI-6033 Wave 2 (Gap 8): keeps the extended (Trees API) scan surface out of
// this test — see the fixture's own comment.
import { emptyRepoTree } from './scan-skill-bundle.fixtures.ts'

/** Reference set with a well-known brand so an edit-distance-1 candidate fires. */
const REFERENCE_NAMES: ReadonlySet<string> = new Set(['anthropic', 'skillsmith'])

/**
 * Run `scanSkillBundle` with every sibling fetch short-circuited to a 404
 * ("removed"), so the only findings in the merged result are the SKILL.md scan's
 * (none, for the benign content below) plus the typosquat findings under test.
 */
async function typosquatFindingsViaScanSkillBundle(
  candidateName: string
): Promise<unknown[] | undefined> {
  const result = await scanSkillBundle(
    'acme',
    'repo',
    'main',
    'skills/thing',
    '# A perfectly ordinary skill\n\nIt does ordinary things.\n',
    newRateLimitTelemetry(),
    {
      // Every sibling reports a clean 404 → siblingScans stays empty, so the
      // merged result's findings are exactly the typosquat findings.
      fetchSiblingContent: async () => ({ removed: true }),
      scanSkillContent,
      // SMI-6033 Wave 2 (Gap 8): keep the Trees API surface out of this test.
      fetchRepoTreeEntries: emptyRepoTree,
    },
    { candidateName, referenceNames: REFERENCE_NAMES }
  )
  return result.mergedSecurityScan?.findings
}

describe('typosquat finding mapping: scanSkillBundle (discovery) <-> buildTyposquatFindings (recheck)', () => {
  it('a true-positive candidate produces deep-equal findings on both paths', async () => {
    const candidate = 'anthropc' // edit distance 1 from "anthropic"

    const helper = buildTyposquatFindings(candidate, REFERENCE_NAMES)
    expect(helper.length, 'fixture must actually fire the detector').toBeGreaterThan(0)

    const bundle = await typosquatFindingsViaScanSkillBundle(candidate)
    expect(
      bundle,
      'scanSkillBundle must emit a merged scan once typosquat findings exist'
    ).toBeDefined()
    expect(
      bundle,
      'the two typosquat finding mappings have drifted — see typosquat-findings.ts header'
    ).toEqual(helper)
  })

  it('a benign candidate produces no findings on either path', async () => {
    const candidate = 'my-cool-widget-helper'
    expect(buildTyposquatFindings(candidate, REFERENCE_NAMES)).toEqual([])
    // No typosquat findings and no sibling scans → no merged scan at all.
    expect(await typosquatFindingsViaScanSkillBundle(candidate)).toBeUndefined()
  })

  it('an absent or empty reference set is a no-op on both paths', async () => {
    expect(buildTyposquatFindings('anthropc', undefined)).toEqual([])
    expect(buildTyposquatFindings('anthropc', new Set<string>())).toEqual([])
    expect(buildTyposquatFindings('', REFERENCE_NAMES)).toEqual([])
    expect(buildTyposquatFindings('   ', REFERENCE_NAMES)).toEqual([])
  })

  it('emits warn-tier findings only — never above medium, so it can never quarantine alone', () => {
    const findings = buildTyposquatFindings('anthropc', REFERENCE_NAMES)
    for (const f of findings) {
      expect(f.type).toBe('typosquat')
      expect(['low', 'medium'], `warn mode must cap severity: got ${f.severity}`).toContain(
        f.severity
      )
    }
  })
})

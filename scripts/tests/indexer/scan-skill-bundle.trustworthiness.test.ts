/**
 * SMI-5879 PR-2192a: trustworthiness (design §8.2.4), siblingFailures
 * observability (design §8.2.2), and deps? default-fallback coverage for
 * `scanSkillBundle`. Split out of scan-skill-bundle.test.ts to keep each
 * file under the 500-line standard — see that file for SB-1..SB-4 and the
 * shared scope note on adapting design §8.2.5's fixtures to this codebase's
 * current (pre-evidence-tier-port) scanning model.
 */

import { describe, it, expect } from 'vitest'
import { validateSkillMd } from '../../indexer/skill-processor.ts'
import {
  scanSkillBundle,
  enumerateSiblingTargets,
  type FetchSiblingResult,
} from '../../indexer/skill-processor.security.ts'
import { scanSkillContent } from '../../indexer/_shared/security-scanner-edge.ts'
import {
  telemetry,
  CLEAN_SKILL_MD,
  MALICIOUS_SESSION_START_HOOK,
  projectFindings,
} from './scan-skill-bundle.fixtures.ts'

// ---------------------------------------------------------------------------
// Trustworthiness assertion (design 8.2.4): one side is a genuine end-to-end
// call through validateSkillMd (the actual production function — the
// production call site is skill-processor.ts's `const { securityScan,
// mergedSecurityScan } = await scanSkillBundle(...)` inside validateSkillMd),
// driven by a mocked fetch layer that serves BOTH the primary SKILL.md
// content and the malicious sibling. The other side is a direct
// scanSkillBundle call with injected deps mirroring the same mocked data —
// the shape the Wave 3 simulator will use. Because validateSkillMd fetches
// the primary content itself (rather than having it handed in), this proves
// the production wiring end to end: if validateSkillMd stopped calling
// scanSkillBundle, passed it the wrong arguments, or ignored its
// mergedSecurityScan return value, viaValidateSkillMd's verdict would diverge
// from viaScanSkillBundle's and this test would fail.
//
// validateSkillMd's own return type (SkillMdValidation) does not expose
// siblingFailures, so that field is asserted only against the direct
// scanSkillBundle call, per the design note.
// ---------------------------------------------------------------------------
describe('scanSkillBundle — trustworthiness: validateSkillMd (production path) vs direct scanSkillBundle agree (design 8.2.4)', () => {
  const OWNER = 'acme'
  const REPO = 'widget'
  const BRANCH = 'main'
  const SKILL_PATH = 'my-skill'
  const PRIMARY_URL = `https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}/${SKILL_PATH}/SKILL.md`
  const SIBLING_MCP_URL = `https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}/${SKILL_PATH}/.mcp.json`

  function installFetchMock() {
    // @ts-expect-error overriding global for test
    global.fetch = async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === PRIMARY_URL) {
        return new Response(CLEAN_SKILL_MD, { status: 200 })
      }
      if (url === SIBLING_MCP_URL) {
        return new Response(MALICIOUS_SESSION_START_HOOK, { status: 200 })
      }
      return new Response('', { status: 404 })
    }
  }

  it('deep-equal riskScore, quarantine, primary-sibling path, and findings projection between the production call site and a direct call', async () => {
    installFetchMock()

    // Production path: validateSkillMd fetches SKILL.md itself over the
    // mocked fetch above, then internally calls scanSkillBundle with NO deps
    // override (the real production shape) — this is the actual call site
    // named in the code-review finding.
    const viaValidateSkillMd = await validateSkillMd(OWNER, REPO, BRANCH, telemetry, SKILL_PATH)

    // Direct scanSkillBundle call, with injected deps mirroring the exact
    // same mocked fetch data and the exact same primary content — the shape
    // the Wave 3 simulator will use, and the only side that can observe
    // siblingFailures (validateSkillMd's return type doesn't expose it).
    async function explicitFetchStub(
      _owner: string,
      _repo: string,
      _branch: string,
      relPath: string
    ): Promise<FetchSiblingResult> {
      if (relPath === `${SKILL_PATH}/.mcp.json`) {
        return { content: MALICIOUS_SESSION_START_HOOK }
      }
      return { removed: true }
    }

    const viaScanSkillBundle = await scanSkillBundle(
      OWNER,
      REPO,
      BRANCH,
      SKILL_PATH,
      CLEAN_SKILL_MD,
      telemetry,
      { fetchSiblingContent: explicitFetchStub, scanSkillContent }
    )

    // Sanity: the primary content really did reach validateSkillMd's scan
    // (i.e. it did NOT bail out before ever calling scanSkillBundle).
    expect(viaValidateSkillMd.securityScan).toBeDefined()
    expect(viaValidateSkillMd.mergedSecurityScan).toBeDefined()

    // Primary verdict, as exposed by validateSkillMd's own return shape.
    expect(viaValidateSkillMd.securityScan?.riskScore).toBe(
      viaScanSkillBundle.securityScan.riskScore
    )
    expect(projectFindings(viaValidateSkillMd.securityScan?.findings ?? [])).toEqual(
      projectFindings(viaScanSkillBundle.securityScan.findings)
    )

    // Merged verdict.
    expect(viaValidateSkillMd.mergedSecurityScan?.quarantine).toBe(
      viaScanSkillBundle.mergedSecurityScan?.quarantine
    )
    expect(viaValidateSkillMd.mergedSecurityScan?.riskScore).toBe(
      viaScanSkillBundle.mergedSecurityScan?.riskScore
    )
    expect(viaValidateSkillMd.mergedSecurityScan?.siblingRejectable).toBe(
      viaScanSkillBundle.mergedSecurityScan?.siblingRejectable
    )
    expect(viaValidateSkillMd.mergedSecurityScan?.primarySiblingPath).toBe(
      viaScanSkillBundle.mergedSecurityScan?.primarySiblingPath
    )
    expect(projectFindings(viaValidateSkillMd.mergedSecurityScan?.findings ?? [])).toEqual(
      projectFindings(viaScanSkillBundle.mergedSecurityScan?.findings ?? [])
    )

    // siblingFailures: asserted only against the direct scanSkillBundle call
    // (design 8.2.4's note) — every BUNDLED_SCAN_FILES target except
    // .mcp.json is confirmed-absent (404) under the mocked fetch layer.
    const expectedSiblingFailures = enumerateSiblingTargets(SKILL_PATH)
      .filter((relPath) => relPath !== `${SKILL_PATH}/.mcp.json`)
      .map((relPath) => ({ relPath, kind: 'removed' as const }))
      .sort((a, b) => a.relPath.localeCompare(b.relPath))
    expect(
      viaScanSkillBundle.siblingFailures.slice().sort((a, b) => a.relPath.localeCompare(b.relPath))
    ).toEqual(expectedSiblingFailures)
  })
})

// ---------------------------------------------------------------------------
// siblingFailures addition changes no verdict (design 8.2.2), reusing the
// existing skill-processor.security.test.ts fixture corpus (malicious /
// benign / doc-class siblings) routed through scanSkillBundle instead of
// mergeSiblingScans directly — per this task's instruction to reuse an
// existing fixture-corpus mechanism rather than build a new one. The full
// existing security test suite (parity.test.ts, skill-processor.security.
// test.ts, quarantine-twin-parity.test.ts,
// revalidate-stale-quarantines.outcomes.test.ts, security-scanner-edge*.test.ts
// — 100+ tests) was additionally run unmodified before and after this PR's
// changes and is unaffected: scanSkillContent, mergeSiblingScans,
// shouldQuarantine, and QUARANTINE_THRESHOLD are byte-for-byte untouched by
// this extraction (verified — see the PR diff).
// ---------------------------------------------------------------------------
describe('scanSkillBundle — siblingFailures addition changes no verdict (design 8.2.2)', () => {
  it('malicious .mcp.json sibling still quarantines identically with siblingFailures present', async () => {
    async function fetchStub(
      _owner: string,
      _repo: string,
      _branch: string,
      relPath: string
    ): Promise<FetchSiblingResult> {
      if (relPath === '.mcp.json') return { content: MALICIOUS_SESSION_START_HOOK }
      return { removed: true }
    }

    const result = await scanSkillBundle(
      'acme',
      'widget',
      'main',
      undefined,
      CLEAN_SKILL_MD,
      telemetry,
      { fetchSiblingContent: fetchStub }
    )

    expect(result.mergedSecurityScan?.quarantine).toBe(true)
    expect(result.mergedSecurityScan?.siblingRejectable).toBe(true)
    // The new observable is present and correct alongside the unchanged verdict.
    expect(result.siblingFailures.length).toBeGreaterThan(0)
    expect(result.siblingFailures.every((f) => f.kind === 'removed')).toBe(true)
  })

  it('benign chmod sibling: siblingRejectable stays false with siblingFailures present', async () => {
    const benignScript = `#!/bin/bash\nnpm install\nchmod 755 ./bin/cli\n`
    async function fetchStub(
      _owner: string,
      _repo: string,
      _branch: string,
      relPath: string
    ): Promise<FetchSiblingResult> {
      if (relPath === 'package.json') return { content: benignScript }
      return null // transient — simulates the other 6 targets being unreachable
    }

    const result = await scanSkillBundle(
      'acme',
      'widget',
      'main',
      undefined,
      CLEAN_SKILL_MD,
      telemetry,
      { fetchSiblingContent: fetchStub }
    )

    expect(result.mergedSecurityScan?.siblingRejectable).toBe(false)
    expect(result.siblingFailures.every((f) => f.kind === 'transient')).toBe(true)
    expect(result.siblingFailures.length).toBe(6)
  })
})

// ---------------------------------------------------------------------------
// deps? default fallback (design 8.2.1.1 item 3): production callers pass no
// deps and get the real fetch/scan implementations.
// ---------------------------------------------------------------------------

describe('scanSkillBundle — deps? defaults to the real implementations when omitted', () => {
  it('with no deps, siblings are fetched via the real fetchSiblingContent (network attempted)', async () => {
    let sawRealFetch = false
    // @ts-expect-error overriding global for test
    global.fetch = async () => {
      sawRealFetch = true
      return new Response('', { status: 404 })
    }

    await scanSkillBundle('acme', 'widget', 'main', undefined, CLEAN_SKILL_MD, telemetry)

    expect(sawRealFetch).toBe(true)
  })
})

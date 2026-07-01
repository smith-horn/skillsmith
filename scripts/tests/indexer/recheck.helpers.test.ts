/**
 * SMI-5445 Wave 1: Unit tests for recheck.helpers.ts.
 *
 * Covers:
 *   - isSiblingFinding (H4 predicate): filePath != null && !== ''
 *   - getRecheckMaxSiblingClears (C2): default + env override + clamp
 *   - loadPass3Candidates (H1): RPC call, row mapping, empty result, error propagation
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  isSiblingFinding,
  isSiblingQuarantineRow,
  getRecheckMaxSiblingClears,
  loadPass3Candidates,
} from '../../indexer/recheck.helpers.ts'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { StaleQuarantinedRow } from '../../indexer/revalidate-stale-quarantines.ts'

// ---------------------------------------------------------------------------
// isSiblingFinding (H4)
// ---------------------------------------------------------------------------

describe('isSiblingFinding — H4 predicate', () => {
  it('returns true when filePath is a non-empty string', () => {
    expect(isSiblingFinding({ type: 'code_execution', filePath: '.mcp.json' })).toBe(true)
    expect(isSiblingFinding({ type: 'data_exfiltration', filePath: 'package.json' })).toBe(true)
  })

  it('returns false when filePath is null', () => {
    expect(isSiblingFinding({ type: 'code_execution', filePath: null })).toBe(false)
  })

  it('returns false when filePath is undefined (absent from object)', () => {
    expect(isSiblingFinding({ type: 'code_execution' })).toBe(false)
  })

  it('returns false when filePath is the empty string', () => {
    expect(isSiblingFinding({ type: 'code_execution', filePath: '' })).toBe(false)
  })

  it('returns false for null input', () => {
    expect(isSiblingFinding(null)).toBe(false)
  })

  it('returns false for non-object input', () => {
    expect(isSiblingFinding('some-string')).toBe(false)
    expect(isSiblingFinding(42)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// isSiblingQuarantineRow (C2-low: single canonical PASS-3 predicate)
// ---------------------------------------------------------------------------

describe('isSiblingQuarantineRow — canonical PASS-3 predicate', () => {
  function row(overrides: Partial<StaleQuarantinedRow> = {}): StaleQuarantinedRow {
    return {
      id: 'r-1',
      author: 'acme',
      name: 'skill',
      repo_url: 'https://github.com/acme/skill',
      skill_path: null,
      quarantine_reason: 'security: code_execution in .mcp.json',
      security_findings: [{ type: 'code_execution', filePath: '.mcp.json' }],
      quarantined: true,
      last_seen_at: '2025-12-01T00:00:00.000Z',
      ...overrides,
    }
  }

  it('returns true for a quarantined security row with a filePath finding', () => {
    expect(isSiblingQuarantineRow(row())).toBe(true)
  })

  it('returns false when quarantined is false', () => {
    expect(isSiblingQuarantineRow(row({ quarantined: false }))).toBe(false)
  })

  it('returns false for a stale-reason row (PASS 2, not PASS 3)', () => {
    expect(isSiblingQuarantineRow(row({ quarantine_reason: 'stale' }))).toBe(false)
  })

  it('returns false for a null-reason row (PASS 2)', () => {
    expect(isSiblingQuarantineRow(row({ quarantine_reason: null }))).toBe(false)
  })

  it('returns false when a security row has NO filePath finding (the divergence guard)', () => {
    // A security-reason row whose findings carry no filePath (e.g. SKILL.md-only or
    // hand-reviewed) must NOT count as a sibling-quarantine — this is exactly the row
    // shape the old pass3_sibling_recovered predicate over-counted before reconciliation.
    expect(
      isSiblingQuarantineRow(row({ security_findings: [{ type: 'jailbreak', filePath: null }] }))
    ).toBe(false)
  })

  it('returns false when security_findings is not an array', () => {
    expect(isSiblingQuarantineRow(row({ security_findings: undefined }))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// getRecheckMaxSiblingClears (C2)
// ---------------------------------------------------------------------------

describe('getRecheckMaxSiblingClears — C2 cap constant', () => {
  const prev = process.env.RECHECK_MAX_SIBLING_CLEARS

  afterEach(() => {
    if (prev === undefined) delete process.env.RECHECK_MAX_SIBLING_CLEARS
    else process.env.RECHECK_MAX_SIBLING_CLEARS = prev
  })

  it('returns 25 when env is not set', () => {
    delete process.env.RECHECK_MAX_SIBLING_CLEARS
    expect(getRecheckMaxSiblingClears()).toBe(25)
  })

  it('returns the parsed integer when env is a valid positive number', () => {
    process.env.RECHECK_MAX_SIBLING_CLEARS = '10'
    expect(getRecheckMaxSiblingClears()).toBe(10)
  })

  it('clamps to 1 when env is 0', () => {
    process.env.RECHECK_MAX_SIBLING_CLEARS = '0'
    expect(getRecheckMaxSiblingClears()).toBe(1)
  })

  it('clamps to 1 when env is negative', () => {
    process.env.RECHECK_MAX_SIBLING_CLEARS = '-5'
    expect(getRecheckMaxSiblingClears()).toBe(1)
  })

  it('clamps to 500 when env exceeds 500', () => {
    process.env.RECHECK_MAX_SIBLING_CLEARS = '9999'
    expect(getRecheckMaxSiblingClears()).toBe(500)
  })

  it('returns 1 when env is a non-numeric string', () => {
    process.env.RECHECK_MAX_SIBLING_CLEARS = 'banana'
    expect(getRecheckMaxSiblingClears()).toBe(1)
  })

  it('truncates floats', () => {
    process.env.RECHECK_MAX_SIBLING_CLEARS = '7.9'
    expect(getRecheckMaxSiblingClears()).toBe(7)
  })
})

// ---------------------------------------------------------------------------
// loadPass3Candidates (H1)
// ---------------------------------------------------------------------------

describe('loadPass3Candidates — H1 DB-predicate RPC', () => {
  const cutoff = '2026-01-01T00:00:00.000Z'
  const sibling1 = {
    id: 'sib-uuid-1',
    author: 'acme',
    name: 'sib-skill',
    repo_url: 'https://github.com/acme/sib-skill',
    skill_path: null,
    quarantine_reason: 'security: code_execution in .mcp.json',
    security_findings: [{ type: 'code_execution', filePath: '.mcp.json' }],
    quarantined: true,
    last_seen_at: '2025-12-01T00:00:00.000Z',
  }

  function makeRpcDb(rows: unknown[], error: { message: string } | null = null) {
    const rpcMock = vi.fn().mockResolvedValue({ data: error ? null : rows, error })
    const db = { rpc: rpcMock } as unknown as SupabaseClient
    return { db, rpcMock }
  }

  it('calls supabase.rpc with correct function name and params', async () => {
    const { db, rpcMock } = makeRpcDb([sibling1])
    await loadPass3Candidates(db, cutoff, 10)
    expect(rpcMock).toHaveBeenCalledWith('get_recheck_sibling_candidates', {
      cutoff,
      lim: 10,
    })
  })

  it('returns mapped StaleQuarantinedRow array from RPC data', async () => {
    const { db } = makeRpcDb([sibling1])
    const result = await loadPass3Candidates(db, cutoff, 10)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('sib-uuid-1')
    expect(result[0].quarantined).toBe(true)
    expect(result[0].quarantine_reason).toBe('security: code_execution in .mcp.json')
  })

  it('returns empty array when RPC returns no rows', async () => {
    const { db } = makeRpcDb([])
    const result = await loadPass3Candidates(db, cutoff, 10)
    expect(result).toHaveLength(0)
  })

  it('returns empty array immediately when limit <= 0', async () => {
    const { db, rpcMock } = makeRpcDb([sibling1])
    const result = await loadPass3Candidates(db, cutoff, 0)
    expect(result).toHaveLength(0)
    // RPC should NOT be called at all (short-circuit)
    expect(rpcMock).not.toHaveBeenCalled()
  })

  it('throws when the RPC returns an error', async () => {
    const { db } = makeRpcDb([], { message: 'function does not exist' })
    await expect(loadPass3Candidates(db, cutoff, 10)).rejects.toThrow(
      'Failed to load PASS 3 sibling candidates (RPC): function does not exist'
    )
  })

  it('returns null-data as empty array (defensive)', async () => {
    const rpcMock = vi.fn().mockResolvedValue({ data: null, error: null })
    const db = { rpc: rpcMock } as unknown as SupabaseClient
    const result = await loadPass3Candidates(db, cutoff, 10)
    expect(result).toHaveLength(0)
  })
})

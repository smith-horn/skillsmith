/**
 * Unit tests for SMI-4588 Wave 2 Step 6 — install ledger-replay rewriter.
 * PR #3 of the Wave 2 stack.
 *
 * Coverage:
 *   1. Empty ledger → candidate returned unchanged (reference-equal).
 *   2. No matching ledger entry → candidate returned unchanged.
 *   3. Single matching entry → candidate identifier + path rewritten.
 *   4. Multi-pass replay (chained renames) — applies until no more matches.
 */

import { describe, expect, it } from 'vitest'

import type { CandidateSkill } from '../../src/audit/install-preflight.js'
import { applyLedgerReplay } from '../../src/tools/install.ledger-replay.js'
import {
  CURRENT_VERSION,
  type OverrideRecord,
  type OverridesLedger,
} from '../../src/audit/namespace-overrides.types.js'

function emptyLedger(): OverridesLedger {
  return { version: CURRENT_VERSION, overrides: [] }
}

function makeRecord(partial: Partial<OverrideRecord>): OverrideRecord {
  return {
    id: 'ovr_TEST00000000000000000000001',
    skillId: 'anthropic/code-helper',
    kind: 'skill',
    originalIdentifier: 'code-helper',
    renamedTo: 'anthropic-code-helper',
    originalPath: '/home/test/.claude/skills/code-helper',
    renamedPath: '/home/test/.claude/skills/anthropic-code-helper',
    appliedAt: '2026-04-30T15:42:18.331Z',
    auditId: '01HXYAUDIT00000000000000001',
    reason: 'collision with skillsmith/foo',
    ...partial,
  }
}

function candidate(overrides: Partial<CandidateSkill> = {}): CandidateSkill {
  return {
    identifier: 'code-helper',
    projectedSourcePath: '/home/test/.claude/skills/code-helper',
    skillId: 'anthropic/code-helper',
    author: 'anthropic',
    ...overrides,
  }
}

describe('applyLedgerReplay', () => {
  it('returns the candidate unchanged when the ledger is empty (case 1)', () => {
    const c = candidate()
    const result = applyLedgerReplay(c, emptyLedger())
    expect(result.candidate).toBe(c) // reference-equal
    expect(result.applied).toEqual([])
  })

  it('returns the candidate unchanged when no override matches (case 2)', () => {
    const c = candidate({ identifier: 'unrelated', skillId: 'someone/unrelated' })
    const ledger: OverridesLedger = {
      version: CURRENT_VERSION,
      overrides: [makeRecord({})],
    }
    const result = applyLedgerReplay(c, ledger)
    expect(result.candidate).toBe(c)
    expect(result.applied).toEqual([])
  })

  it('rewrites the candidate when a matching override exists (case 3)', () => {
    const c = candidate()
    const record = makeRecord({})
    const ledger: OverridesLedger = {
      version: CURRENT_VERSION,
      overrides: [record],
    }
    const result = applyLedgerReplay(c, ledger)

    expect(result.candidate).not.toBe(c)
    expect(result.candidate.identifier).toBe('anthropic-code-helper')
    expect(result.candidate.projectedSourcePath).toBe(
      '/home/test/.claude/skills/anthropic-code-helper'
    )
    // Identity-bearing fields preserved.
    expect(result.candidate.skillId).toBe('anthropic/code-helper')
    expect(result.candidate.author).toBe('anthropic')
    expect(result.applied).toEqual([record])
  })

  it('applies chained renames across multiple ledger entries (case 4)', () => {
    // User renamed code-helper -> anthropic-code-helper -> ant-helper
    // (e.g. they reverted then re-renamed to a custom name). Ledger
    // contains both. Replay must follow the chain.
    const r1 = makeRecord({
      id: 'ovr_chain1',
      originalIdentifier: 'code-helper',
      renamedTo: 'anthropic-code-helper',
    })
    const r2 = makeRecord({
      id: 'ovr_chain2',
      originalIdentifier: 'anthropic-code-helper',
      renamedTo: 'ant-helper',
    })
    const ledger: OverridesLedger = {
      version: CURRENT_VERSION,
      overrides: [r1, r2],
    }
    const result = applyLedgerReplay(candidate(), ledger)

    expect(result.candidate.identifier).toBe('ant-helper')
    expect(result.candidate.projectedSourcePath).toBe('/home/test/.claude/skills/ant-helper')
    expect(result.applied.map((a) => a.id)).toEqual(['ovr_chain1', 'ovr_chain2'])
  })
})

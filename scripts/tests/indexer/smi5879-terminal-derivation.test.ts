/**
 * SMI-6444 (G-1 bulk disposition producer): tests for the shared
 * `deriveUnfetchableSubtype` function (`smi5879-terminal-derivation.ts`,
 * Item 2/6 of the plan) and for the `unfetchable_subtype` field's round trip
 * through `validateRow` (`smi5879-gate-check.io.ts`) and `mergeRows`
 * (`smi5879-merge-shards.merge-rules.ts`).
 * @module scripts/tests/indexer/smi5879-terminal-derivation
 *
 * Plan: docs/internal/implementation/smi-6444-g1-bulk-disposition-plan.md
 *       Item 2 ("`unfetchable` ground-truth re-derivation"), Item 6
 *       ("`unfetchable` verification: two subtypes, not one uniform
 *       re-check").
 *
 * The Item 9 test list places the round-trip tests below under
 * `smi5879-dispose-terminal.test.ts` — they live here instead, since they
 * cover this file's own shared derivation function and the
 * `unfetchable_subtype` field it's built around, not the producer CLI a
 * separate worker owns. Kept in one file so the two round-trip legs
 * (validateRow, mergeRows) can never silently drift from
 * `deriveUnfetchableSubtype`'s own contract.
 */

import { describe, it, expect } from 'vitest'
import { deriveUnfetchableSubtype } from '../../indexer/smi5879-terminal-derivation.ts'
import { loadSimulatorReport } from '../../indexer/smi5879-gate-check.io.ts'
import { mergeRows } from '../../indexer/smi5879-merge-shards.merge-rules.ts'
import type { ShardReportInput } from '../../indexer/smi5879-merge-shards.merge-rules.ts'
import type { BranchMap, SimSnapshotRow } from '../../indexer/smi5879-simulate-full.types.ts'
import { makeRow } from './smi5879-simulate-full.fixtures.ts'
import {
  makeScratchDir,
  makeSimRow,
  makeSimulatorReportJson,
  writeFixtureFile,
} from './smi5879-gate-check.fixtures.ts'

describe('deriveUnfetchableSubtype', () => {
  it('returns url_parse when parseSkillMdUrl fails (non-github repo_url)', () => {
    const row = makeRow({ repo_url: 'https://gitlab.com/acme/foo', skill_path: null })
    const branchMap: BranchMap = new Map()
    expect(deriveUnfetchableSubtype(row, branchMap)).toBe('url_parse')
  })

  it('returns url_parse when repo_url is null', () => {
    const row = makeRow({ repo_url: null, skill_path: null })
    const branchMap: BranchMap = new Map()
    expect(deriveUnfetchableSubtype(row, branchMap)).toBe('url_parse')
  })

  it('returns branch_resolution when the branchMap resolution is not-found', () => {
    const row = makeRow({ repo_url: 'https://github.com/acme/foo', skill_path: null })
    const branchMap: BranchMap = new Map([
      ['acme/foo', { resolution: 'not-found', default_branch: null }],
    ])
    expect(deriveUnfetchableSubtype(row, branchMap)).toBe('branch_resolution')
  })

  it('returns branch_resolution when the branchMap resolution is unparseable', () => {
    const row = makeRow({ repo_url: 'https://github.com/acme/foo', skill_path: null })
    const branchMap: BranchMap = new Map([
      ['acme/foo', { resolution: 'unparseable', default_branch: null }],
    ])
    expect(deriveUnfetchableSubtype(row, branchMap)).toBe('branch_resolution')
  })

  it('returns null when the row parses fine and the branch resolves', () => {
    const row = makeRow({ repo_url: 'https://github.com/acme/foo/tree/main', skill_path: null })
    const branchMap: BranchMap = new Map([
      ['acme/foo', { resolution: 'resolved', default_branch: 'main' }],
    ])
    expect(deriveUnfetchableSubtype(row, branchMap)).toBeNull()
  })

  it('returns null when the row parses fine and the branchMap has no entry for its (owner, repo)', () => {
    const row = makeRow({ repo_url: 'https://github.com/acme/foo/tree/main', skill_path: null })
    const branchMap: BranchMap = new Map()
    expect(deriveUnfetchableSubtype(row, branchMap)).toBeNull()
  })

  it('returns null (not branch_resolution) when the branchMap resolution is transient', () => {
    // `transient` is a real RepoBranchInfo resolution value, but processRow's
    // own unfetchable branch only checks not-found|unparseable —
    // deriveUnfetchableSubtype mirrors that exactly, so `transient` must not
    // falsely classify a row as unfetchable.
    const row = makeRow({ repo_url: 'https://github.com/acme/foo', skill_path: null })
    const branchMap: BranchMap = new Map([
      ['acme/foo', { resolution: 'transient', default_branch: null }],
    ])
    expect(deriveUnfetchableSubtype(row, branchMap)).toBeNull()
  })

  describe('producer-style vs gate-style fixture inputs give the same answer', () => {
    // Producer-style: built via smi5879-simulate-full.fixtures.ts's makeRow,
    // the same helper the producer's own DB deps (Item 1) exercise.
    // Gate-style: a hand-built SimSnapshotRow literal, matching exactly what
    // gate-check's own loadCohortRows delegation (Item 2) returns — same
    // type, built independently of makeRow, to prove the function doesn't
    // secretly depend on anything makeRow happens to fill in beyond the
    // SimSnapshotRow contract itself.
    it('for the url_parse subtype', () => {
      const producerRow = makeRow({
        id: 'shared-row-url',
        repo_url: 'https://gitlab.com/acme/foo',
        skill_path: null,
      })
      const gateRow: SimSnapshotRow = {
        id: 'shared-row-url',
        cohort: 'C2',
        repo_url: 'https://gitlab.com/acme/foo',
        skill_path: null,
        author: 'acme',
        name: 'shared-row-url',
        content_hash: null,
        snapshot_security_score: null,
        snapshot_quarantined: null,
      }
      const branchMap: BranchMap = new Map()
      const producerResult = deriveUnfetchableSubtype(producerRow, branchMap)
      const gateResult = deriveUnfetchableSubtype(gateRow, branchMap)
      expect(producerResult).toBe(gateResult)
      expect(producerResult).toBe('url_parse')
    })

    it('for the branch_resolution subtype', () => {
      const producerRow = makeRow({
        id: 'shared-row-branch',
        repo_url: 'https://github.com/acme/dead-repo',
        skill_path: null,
      })
      const gateRow: SimSnapshotRow = {
        id: 'shared-row-branch',
        cohort: 'C2',
        repo_url: 'https://github.com/acme/dead-repo',
        skill_path: null,
        author: 'acme',
        name: 'shared-row-branch',
        content_hash: null,
        snapshot_security_score: null,
        snapshot_quarantined: null,
      }
      const branchMap: BranchMap = new Map([
        ['acme/dead-repo', { resolution: 'not-found', default_branch: null }],
      ])
      const producerResult = deriveUnfetchableSubtype(producerRow, branchMap)
      const gateResult = deriveUnfetchableSubtype(gateRow, branchMap)
      expect(producerResult).toBe(gateResult)
      expect(producerResult).toBe('branch_resolution')
    })
  })
})

describe('unfetchable_subtype field round-trip (Item 9)', () => {
  it('round-trips through validateRow/loadSimulatorReport intact for url_parse', () => {
    const dir = makeScratchDir()
    const rows = [
      makeSimRow({
        id: 'r1',
        cohort: 'C3',
        outcome: 'unfetchable',
        unfetchable_subtype: 'url_parse',
      }),
    ]
    const path = writeFixtureFile(dir, 'simulator.json', makeSimulatorReportJson({ rows }))
    const result = loadSimulatorReport(path, 'simulator-report')
    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      expect(result.value.rows[0]?.unfetchable_subtype).toBe('url_parse')
    }
  })

  it('round-trips through validateRow/loadSimulatorReport intact for branch_resolution', () => {
    const dir = makeScratchDir()
    const rows = [
      makeSimRow({
        id: 'r1',
        cohort: 'C3',
        outcome: 'unfetchable',
        unfetchable_subtype: 'branch_resolution',
      }),
    ]
    const path = writeFixtureFile(dir, 'simulator.json', makeSimulatorReportJson({ rows }))
    const result = loadSimulatorReport(path, 'simulator-report')
    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      expect(result.value.rows[0]?.unfetchable_subtype).toBe('branch_resolution')
    }
  })

  it('loads fine with the field absent — an old report predating this field is never a blocker', () => {
    const dir = makeScratchDir()
    const rows = [makeSimRow({ id: 'r1', cohort: 'C3', outcome: 'unfetchable' })]
    const path = writeFixtureFile(dir, 'simulator.json', makeSimulatorReportJson({ rows }))
    const result = loadSimulatorReport(path, 'simulator-report')
    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      expect(result.value.rows[0]?.unfetchable_subtype).toBeUndefined()
    }
  })

  it('an invalid unfetchable_subtype value is malformed, not silently dropped', () => {
    const dir = makeScratchDir()
    const rows = [
      makeSimRow({
        id: 'r1',
        cohort: 'C3',
        outcome: 'unfetchable',
        unfetchable_subtype: 'not-a-real-subtype',
      }),
    ]
    const path = writeFixtureFile(dir, 'simulator.json', makeSimulatorReportJson({ rows }))
    const result = loadSimulatorReport(path, 'simulator-report')
    expect(result.status).toBe('malformed')
    if (result.status === 'malformed') {
      expect(result.reason).toMatch(/unfetchable_subtype/)
    }
  })

  it('round-trips through mergeRows unmodified, for both subtypes, in the same merge', () => {
    const dir = makeScratchDir()
    const rows = [
      makeSimRow({
        id: 'r1',
        cohort: 'C3',
        outcome: 'unfetchable',
        unfetchable_subtype: 'url_parse',
      }),
      makeSimRow({
        id: 'r2',
        cohort: 'C4',
        outcome: 'unfetchable',
        unfetchable_subtype: 'branch_resolution',
      }),
    ]
    const path = writeFixtureFile(dir, 'simulator.json', makeSimulatorReportJson({ rows }))
    const loaded = loadSimulatorReport(path, 'simulator-report')
    expect(loaded.status).toBe('ok')
    if (loaded.status !== 'ok') return

    const input: ShardReportInput = { path, report: loaded.value }
    const merged = mergeRows([input])

    expect(merged).toHaveLength(2)
    expect(merged.find((r) => r.id === 'r1')?.unfetchable_subtype).toBe('url_parse')
    expect(merged.find((r) => r.id === 'r2')?.unfetchable_subtype).toBe('branch_resolution')
  })
})

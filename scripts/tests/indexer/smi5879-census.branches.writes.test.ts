/**
 * SMI-6015 post-merge retro (2026-08-18): fixture-level tests for the
 * batched-write / SQL-builder machinery in `smi5879-census.branches.writes.ts`
 * — split out of `smi5879-census.branches.helpers.test.ts` alongside the
 * source split (see that source file's own module header for why).
 * @module scripts/tests/indexer/smi5879-census.branches.writes
 */

import { describe, it, expect } from 'vitest'
import {
  buildBatchInsertSql,
  buildBatchUpdateSql,
} from '../../indexer/smi5879-census.branches.writes.ts'
import type { ResolutionOutcome } from '../../indexer/smi5879-census.types.ts'

/** Locate the `$tag$...$tag$` literal following `json_to_recordset(` and parse it, tag-suffix-agnostic. */
function extractRecordsetJson(sql: string): unknown {
  const marker = 'json_to_recordset('
  const startIdx = sql.indexOf(marker)
  if (startIdx === -1) throw new Error('json_to_recordset( not found in SQL')
  const rest = sql.slice(startIdx + marker.length)
  const tagMatch = rest.match(/^\$smi5879b\d*\$/)
  if (!tagMatch) throw new Error('no dollar-quote tag found immediately after json_to_recordset(')
  const tag = tagMatch[0]
  const afterTag = rest.slice(tag.length)
  const endIdx = afterTag.indexOf(tag)
  if (endIdx === -1) throw new Error('closing dollar-quote tag not found')
  return JSON.parse(afterTag.slice(0, endIdx))
}

describe('buildBatchInsertSql / buildBatchUpdateSql', () => {
  const outcomes: ResolutionOutcome[] = [
    {
      repo: { owner: 'acme', repo: 'resolved-repo' },
      resolution: 'resolved',
      defaultBranch: 'main',
      httpStatus: 200,
      attempts: 1,
    },
    {
      repo: { owner: 'acme', repo: 'transient-repo' },
      resolution: 'transient',
      defaultBranch: null,
      httpStatus: null,
      attempts: 3,
    },
    {
      repo: { owner: 'acme', repo: 'notfound-repo' },
      resolution: 'not-found',
      defaultBranch: null,
      httpStatus: 404,
      attempts: 1,
    },
  ]

  it('INSERT: embeds real JSON null for default_branch/http_status — no NULLIF sentinel hack', () => {
    const { sql, vars } = buildBatchInsertSql('run-1', 'tok-1', outcomes)
    expect(vars).toEqual({ run_id: 'run-1', token: 'tok-1' })
    expect(sql).toContain('INSERT INTO smi5879_repo_branch')
    expect(sql).not.toContain('NULLIF')

    const parsed = extractRecordsetJson(sql) as Array<Record<string, unknown>>
    expect(parsed).toHaveLength(3)
    expect(parsed[0]).toEqual({
      owner: 'acme',
      repo: 'resolved-repo',
      default_branch: 'main',
      resolution: 'resolved',
      http_status: 200,
      attempts: 1,
    })
    // The exact case the old NULLIF-sentinel existed for — confirm it's a
    // real JSON null, not an empty string.
    expect(parsed[1]?.['default_branch']).toBeNull()
    expect(parsed[1]?.['http_status']).toBeNull()
    expect(parsed[2]?.['default_branch']).toBeNull()
    expect(parsed[2]?.['http_status']).toBe(404)
  })

  it('UPDATE: same JSON-null preservation, plus the additive `attempts = b.attempts + x.attempts` clause', () => {
    const { sql, vars } = buildBatchUpdateSql('run-1', 'tok-1', outcomes)
    expect(vars).toEqual({ run_id: 'run-1', token: 'tok-1' })
    expect(sql).toContain('UPDATE smi5879_repo_branch')
    expect(sql).toContain('attempts       = b.attempts + x.attempts')
    expect(sql).toContain("WHERE b.run_id = :'run_id' AND b.owner = x.owner AND b.repo = x.repo")
    expect(sql).not.toContain('NULLIF')

    const parsed = extractRecordsetJson(sql) as Array<Record<string, unknown>>
    expect(parsed[1]?.['default_branch']).toBeNull()
  })

  it('picks a collision-free dollar-quote tag even when the payload literally contains the default tag text', () => {
    const trickyOutcomes: ResolutionOutcome[] = [
      {
        repo: { owner: 'acme', repo: 'weird' },
        resolution: 'resolved',
        defaultBranch: 'contains-$smi5879b$-literally',
        httpStatus: 200,
        attempts: 1,
      },
    ]
    const { sql } = buildBatchInsertSql('run-1', 'tok-1', trickyOutcomes)
    const parsed = extractRecordsetJson(sql) as Array<Record<string, unknown>>
    expect(parsed[0]?.['default_branch']).toBe('contains-$smi5879b$-literally')
  })

  it('an empty outcomes array still builds valid (if pointless) SQL — callers skip the psql call entirely, not this builder', () => {
    const { sql } = buildBatchInsertSql('run-1', 'tok-1', [])
    expect(extractRecordsetJson(sql)).toEqual([])
  })

  // SMI-5879 checkpoint/resume, cross-model review finding (High): every
  // batch write must be fenced by the CURRENT claim token, evaluated
  // atomically as part of the write statement (verified live against a real
  // Postgres — see the checkpoint-resume integration test for the actual
  // token-mismatch-rejects-the-write behavior this SQL shape produces).
  describe('token fencing (SMI-5879 cross-model review, High)', () => {
    it('INSERT: fences on run_id/status/token via a FOR-UPDATE-locked EXISTS, and returns owner/repo for row-count verification', () => {
      const { sql, vars } = buildBatchInsertSql('run-1', 'tok-1', outcomes)
      expect(vars).toEqual({ run_id: 'run-1', token: 'tok-1' })
      expect(sql).toContain('WHERE EXISTS (')
      expect(sql).toContain("r.run_id = :'run_id'")
      expect(sql).toContain("r.status = 'open'")
      expect(sql).toContain("r.runner_token = :'token'")
      expect(sql).toContain('FOR UPDATE')
      expect(sql).toContain('RETURNING owner, repo')
    })

    it('UPDATE: fences via AND EXISTS (same FOR-UPDATE-locked guard) alongside the existing run_id/owner/repo match, and returns owner/repo', () => {
      const { sql, vars } = buildBatchUpdateSql('run-1', 'tok-1', outcomes)
      expect(vars).toEqual({ run_id: 'run-1', token: 'tok-1' })
      expect(sql).toContain('AND EXISTS (')
      expect(sql).toContain("r.runner_token = :'token'")
      expect(sql).toContain('FOR UPDATE')
      expect(sql).toContain('RETURNING b.owner, b.repo')
    })
  })
})

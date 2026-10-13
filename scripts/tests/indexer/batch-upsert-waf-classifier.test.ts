/**
 * SMI-7113: the upstream-block classifier, its env knobs, the run report, and twin parity.
 * @module scripts/tests/indexer/batch-upsert-waf-classifier
 *
 * The classifier case table below was executed in node against the plan's predicate
 * before the predicate was written down (CLAUDE.md "measure, don't reason"); it is kept
 * here so a later edit has to argue with it. The two marker cases (block sentence only,
 * Ray ID only) are separate rows on purpose: dropping either clause must break its own row.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as nodeMod from '../../indexer/indexer-runners.batch.ts'
import * as denoMod from '../../../supabase/functions/indexer/indexer-runners.batch.ts'
import { runUpsertPhase } from '../../indexer/indexer-runners.ts'
import { applyUpsertResult } from '../../indexer/discovery-orchestrator.phase-split.ts'
import { newRateLimitTelemetry } from '../../indexer/_shared/rate-limit.ts'
import { checkSkillMdExists, type SkillMdValidation } from '../../indexer/skill-processor.ts'
import type { IndexerResult } from '../../indexer/indexer-types.ts'
import {
  CF_HTML,
  ONLY_BLOCKED_HTML,
  ONLY_RAY_HTML,
  urlOf,
  makeItems,
  blocked403,
} from './batch-upsert-waf.test-helpers.ts'

const CLEAN_SKILL_MD =
  '---\nname: skill-0\ndescription: A helpful skill for everyday work in projects.\n---\n\n# Skill\n\nDocumented steps for safe use in projects.\n'

const twins = [
  ['scripts twin', nodeMod],
  ['Deno twin', denoMod],
] as [string, typeof nodeMod][]

describe.each(twins)('isUpstreamBlock case table (%s)', (_label, m) => {
  const cases: [
    string,
    { message?: unknown; code?: unknown } | null,
    number | undefined,
    boolean,
  ][] = [
    ['HTML 403, both markers', { message: CF_HTML }, 403, true],
    [
      'lowercase markers and doctype',
      { message: '<!doctype html><p>YOU HAVE BEEN BLOCKED ray id x' },
      403,
      true,
    ],
    [
      'BOM and whitespace before <html',
      { message: '﻿\n  <html>you have been blocked ray id' },
      403,
      true,
    ],
    ['only the block sentence', { message: ONLY_BLOCKED_HTML }, 403, false],
    ['only the Ray ID', { message: ONLY_RAY_HTML }, 403, false],
    ['no status', { message: CF_HTML }, undefined, false],
    ['status 0 (FetchError)', { message: CF_HTML }, 0, false],
    [
      'JSON 403 code 42501',
      { message: 'permission denied for table skills', code: '42501' },
      403,
      false,
    ],
    ['HTML 403 that also carries a code', { message: CF_HTML, code: '57014' }, 403, false],
    [
      '57014 statement timeout',
      { message: 'canceling statement due to statement timeout', code: '57014' },
      500,
      false,
    ],
    ['23502 not-null', { message: 'null value in column "name"', code: '23502' }, 400, false],
    ['empty 403 body', { message: '' }, 403, false],
    ['non-string message', { message: undefined }, 403, false],
    ['502 with both markers', { message: CF_HTML }, 502, false],
    ['503 Cloudflare-branded', { message: CF_HTML }, 503, false],
    ['520 Cloudflare-branded', { message: CF_HTML }, 520, false],
    [
      'markers inside a JSON body, not an HTML document',
      { message: '{"e":"you have been blocked Ray ID"}' },
      403,
      false,
    ],
    ['null error', null, 403, false],
  ]
  it.each(cases)('%s', (_name, error, status, expected) => {
    expect(m.isUpstreamBlock(error, status)).toBe(expected)
  })
})

describe('resolveWafOptions', () => {
  const read = (env: Record<string, string>) => (k: string) => env[k]
  it.each([
    [{}, false, 64],
    [{ SKILLSMITH_INDEXER_UPSERT_BISECT_DISABLE: '1' }, true, 64],
    [{ SKILLSMITH_INDEXER_UPSERT_BISECT_DISABLE: 'TRUE' }, true, 64],
    [{ SKILLSMITH_INDEXER_UPSERT_BISECT_DISABLE: '0' }, false, 64],
    [{ SKILLSMITH_INDEXER_UPSERT_BISECT_DISABLE: '' }, false, 64],
    [{ INDEXER_UPSERT_BLOCK_BISECT_BUDGET: '10' }, false, 10],
    [{ INDEXER_UPSERT_BLOCK_BISECT_BUDGET: '0' }, false, 64],
    [{ INDEXER_UPSERT_BLOCK_BISECT_BUDGET: 'abc' }, false, 64],
    [{ INDEXER_UPSERT_BLOCK_BISECT_BUDGET: '-5' }, false, 64],
    [{ INDEXER_UPSERT_BLOCK_BISECT_BUDGET: '99999999' }, false, 64],
  ])('%j -> bisectDisabled=%s budget=%s', (env, disabled, budget) => {
    for (const [, m] of twins) {
      expect(m.resolveWafOptions(read(env))).toEqual({ bisectDisabled: disabled, budget })
    }
  })
})

describe('toBlockReport / emptyBlockReport', () => {
  it('caps the listed rows at 20 but counts them all; the empty report has every field', () => {
    const row = (i: number) => ({
      repoUrl: urlOf(i),
      fullName: `acme/skill-${i}`,
      payloadBytes: 10,
      fieldLengths: {},
      rayId: null,
    })
    const blocked = Array.from({ length: 25 }, (_, i) => row(i))
    for (const [, m] of twins) {
      const rep = m.toBlockReport({
        blocked,
        newlyBlocked: blocked,
        deferredCount: 3,
        blockBudgetExhausted: true,
        bisectDisabled: false,
      })
      expect(rep.upsert_blocked_count).toBe(25)
      expect(rep.upsert_blocked).toHaveLength(20)
      expect(rep.upsert_newly_blocked).toHaveLength(20)
      expect(rep).toMatchObject({ upsert_deferred_count: 3, upsert_block_budget_exhausted: true })
      expect(Object.keys(m.emptyBlockReport()).sort()).toEqual(Object.keys(rep).sort())
    }
  })
})

describe('call-site plumbing', () => {
  afterEach(() => vi.restoreAllMocks())

  it('runUpsertPhase carries the blocked row into its result', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const [item] = makeItems(1)
    const skills = {
      select: () => ({
        in: () => {
          const res = { data: [], error: null }
          return Object.assign(Promise.resolve(res), { eq: () => Promise.resolve(res) })
        },
      }),
      upsert: () => ({ select: () => Promise.resolve(blocked403) }),
      update: () => ({ eq: () => Promise.resolve({ error: null }) }),
    }
    const audit = {
      insert: () => Promise.resolve({ error: null }),
      select: () => {
        const q = {
          eq: () => q,
          gte: () => q,
          order: () => q,
          limit: () => Promise.resolve({ data: [], error: null }),
        }
        return q
      },
    }
    const db = { from: (t: string) => (t === 'audit_logs' ? audit : skills) }
    const repo = {
      ...item.repo,
      description: 'A widget',
      url: urlOf(0),
      stars: 10,
      forks: 2,
      topics: ['claude-code-skill'],
      updatedAt: '2026-06-25T00:00:00.000Z',
      defaultBranch: 'main',
      installable: true,
      repoName: 'skill-0',
      skillPath: '',
      discoveryPath: 'high_trust:acme',
    }
    const author = {
      owner: 'acme',
      repo: 'skill-0',
      license: 'MIT',
      baseQualityScore: 0.9,
      trustTier: 'verified',
      description: 't',
    }
    // Seed the validation cache the way Phase 1 does: the REAL checkSkillMdExists on a stubbed fetch.
    const cache = new Map<string, SkillMdValidation>()
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(CLEAN_SKILL_MD, { status: 200 }))
    expect(
      await checkSkillMdExists('acme', 'skill-0', 'main', cache, newRateLimitTelemetry(), undefined)
    ).toBe(true)
    fetchSpy.mockRestore()
    const dryRun = await runUpsertPhase(
      db as never,
      [],
      new Map(),
      new Map(),
      true,
      newRateLimitTelemetry()
    )
    expect(dryRun).toMatchObject({
      upsert_blocked_count: 0,
      upsert_newly_blocked: [],
      upsert_bisect_disabled: false,
    })

    const live = await runUpsertPhase(
      db as never,
      [repo as never],
      new Map([[urlOf(0), author as never]]),
      cache,
      false,
      newRateLimitTelemetry()
    )
    expect(live.upsert_blocked_count).toBe(1)
    expect(live.upsert_newly_blocked.map((b) => b.repoUrl)).toEqual([urlOf(0)])
    expect(live.failed).toBe(1)
  })

  it('applyUpsertResult copies every upsert_* field onto the run result', () => {
    const report = {
      upsert_blocked_count: 2,
      upsert_blocked: [],
      upsert_newly_blocked: [
        { repoUrl: urlOf(1), fullName: 'a/b', payloadBytes: 1, fieldLengths: {}, rayId: null },
      ],
      upsert_deferred_count: 4,
      upsert_block_budget_exhausted: true,
      upsert_bisect_disabled: true,
    }
    const result = { errors: [] as string[] } as unknown as IndexerResult
    applyUpsertResult(result, {
      indexed: 0,
      updated: 0,
      failed: 0,
      quarantined: 0,
      unchanged: 0,
      quality_gate_filtered: 0,
      meta_list_filtered: 0,
      multiline_truncated: 0,
      errors: ['e'],
      ...report,
    } as never)
    expect(result).toMatchObject(report)
    expect(result.errors).toEqual(['e'])
  })
})

describe('twin parity (drift detector only)', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const root = resolve(here, '..', '..', '..')
  /** Body after the header comment, minus the SupabaseClient import, whitespace-insensitive. */
  const body = (rel: string) => {
    const src = readFileSync(join(root, rel), 'utf8')
    const afterHeader = src.slice(src.indexOf('*/') + 2)
    return afterHeader
      .replace(/^import type \{ SupabaseClient \} from .*$/m, '')
      .replace(/\s+/g, '')
  }
  it.each(['indexer-runners.batch.ts', 'indexer-runners.waf.ts'])('%s bodies match', (file) => {
    const a = body(`scripts/indexer/${file}`)
    const b = body(`supabase/functions/indexer/${file}`)
    expect(a.length).toBeGreaterThan(1000)
    expect(b).toBe(a)
  })
})

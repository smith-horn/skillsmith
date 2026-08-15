/**
 * Batch Categorization Integration Tests (Node twin)
 * @module scripts/tests/indexer/indexer-runners.categorization
 *
 * SMI-6047: the Node twin (scripts/indexer/indexer-runners.ts) never received
 * SMI-5209 Wave 2's batch-upsert fix for runCategorization -- it kept a bare
 * per-skill insert, which raised 23505 duplicate-key errors on
 * skill_categories_pkey whenever two phase-3 categorization runs (backfill+
 * backfill, backfill+cron, or cron+cron) drew the same unscoped "never
 * categorized" pool and raced on the same skill. This ported the Deno twin's
 * existing test suite (supabase/functions/indexer/categorization.batch.test.ts)
 * to prove the Node twin now matches: a single batched upsert call with
 * ignoreDuplicates, not N per-skill calls.
 */

import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { CATEGORY_IDS } from '../../indexer/categorization.ts'
import { runCategorization } from '../../indexer/indexer-runners.ts'

function buildMockSupabase(
  opts: {
    skillsData?: Array<{ id: string; tags: string[]; description: string; repo_url: string }>
    upsertError?: { message: string }
    rpcError?: { message: string }
  } = {}
): {
  supabase: SupabaseClient
  upsertCalls: Array<Array<{ skill_id: string; category_id: string }>>
  deleteCalls: Array<string[]>
} {
  const skillsData = opts.skillsData ?? []
  const upsertCalls: Array<Array<{ skill_id: string; category_id: string }>> = []
  const deleteCalls: Array<string[]> = []

  const supabase = {
    from: (table: string) => {
      if (table === 'skills') {
        return {
          select: () => ({
            in: () =>
              Promise.resolve({
                data: skillsData,
                error: null,
              }),
          }),
        }
      }
      if (table === 'skill_categories') {
        return {
          delete: () => ({
            in: (_col: string, ids: string[]) => {
              deleteCalls.push(ids)
              return Promise.resolve({ error: null })
            },
          }),
          upsert: (rows: Array<{ skill_id: string; category_id: string }>) => {
            upsertCalls.push(rows)
            return Promise.resolve({
              error: opts.upsertError || null,
            })
          },
          select: () => ({
            eq: () => ({
              count: 'exact',
              head: true,
            }),
          }),
        }
      }
      if (table === 'categories') {
        return {
          update: () => ({
            eq: () => ({
              neq: () => Promise.resolve({ error: null }),
            }),
          }),
        }
      }
      return {}
    },
    rpc: () =>
      Promise.resolve({
        error: opts.rpcError || null,
      }),
  } as unknown as SupabaseClient

  return { supabase, upsertCalls, deleteCalls }
}

describe('SMI-6047: Batch Categorization (runCategorization, Node twin)', () => {
  describe('batch upsert behavior', () => {
    it('should call upsert ONCE with all category rows regardless of skill count', async () => {
      const { supabase, upsertCalls } = buildMockSupabase({
        skillsData: [
          {
            id: 'skill-1',
            repo_url: 'https://github.com/acme/skill-1',
            tags: ['mcp-server', 'claude'],
            description: 'An MCP server for Claude',
          },
          {
            id: 'skill-2',
            repo_url: 'https://github.com/acme/skill-2',
            tags: ['testing', 'jest'],
            description: 'Test utilities',
          },
          {
            id: 'skill-3',
            repo_url: 'https://github.com/acme/skill-3',
            tags: ['security', 'pentesting'],
            description: 'Security audit tools',
          },
        ],
      })

      const result = await runCategorization(supabase, [
        'https://github.com/acme/skill-1',
        'https://github.com/acme/skill-2',
        'https://github.com/acme/skill-3',
      ])

      // skill-1: integrations+development=2, skill-2: testing=1, skill-3: security=1 → 4 total
      expect(upsertCalls).toHaveLength(1)
      expect(result.categorizedCount).toBe(3)
      expect(result.categoryAssignments).toBe(4)
      expect(result.errors).toEqual([])
    })

    it('should collect all rows before upsert (batch semantics, not N per-skill calls)', async () => {
      const { supabase, upsertCalls } = buildMockSupabase({
        skillsData: [
          {
            id: 'skill-a',
            repo_url: 'https://github.com/test/skill-a',
            tags: ['mcp-server'],
            description: null as unknown as string,
          },
          {
            id: 'skill-b',
            repo_url: 'https://github.com/test/skill-b',
            tags: ['security', 'testing'],
            description: null as unknown as string,
          },
        ],
      })

      await runCategorization(supabase, [
        'https://github.com/test/skill-a',
        'https://github.com/test/skill-b',
      ])

      expect(upsertCalls).toHaveLength(1)
      const allCategoryRows = upsertCalls[0]
      expect(allCategoryRows).toHaveLength(3)
      expect(allCategoryRows).toEqual(
        expect.arrayContaining([
          { skill_id: 'skill-a', category_id: CATEGORY_IDS.integrations },
          { skill_id: 'skill-b', category_id: CATEGORY_IDS.security },
          { skill_id: 'skill-b', category_id: CATEGORY_IDS.testing },
        ])
      )
    })

    it('should not error when the mocked upsert simulates a concurrent-run 23505 conflict', async () => {
      // The whole point of SMI-6047: ignoreDuplicates gives ON CONFLICT DO
      // NOTHING semantics, so a sibling run's already-inserted row is a
      // silent no-op here, not a thrown 23505.
      const { supabase, upsertCalls } = buildMockSupabase({
        skillsData: [
          {
            id: 'skill-race',
            repo_url: 'https://github.com/test/skill-race',
            tags: ['mcp-server'],
            description: null as unknown as string,
          },
        ],
        // upsertError intentionally omitted -- ignoreDuplicates means the
        // mocked PostgREST layer would return no error for a duplicate key,
        // exactly like the real ON CONFLICT DO NOTHING behavior.
      })

      const result = await runCategorization(supabase, ['https://github.com/test/skill-race'])

      expect(upsertCalls).toHaveLength(1)
      expect(result.errors).toEqual([])
    })

    it('should reset counts to 0 on batch upsert failure', async () => {
      const { supabase } = buildMockSupabase({
        skillsData: [
          {
            id: 'skill-fail-1',
            repo_url: 'https://github.com/test/skill-fail-1',
            tags: ['mcp-server'],
            description: null as unknown as string,
          },
          {
            id: 'skill-fail-2',
            repo_url: 'https://github.com/test/skill-fail-2',
            tags: ['testing'],
            description: null as unknown as string,
          },
        ],
        upsertError: {
          message: 'Unique constraint violation on skill_categories',
        },
      })

      const result = await runCategorization(supabase, [
        'https://github.com/test/skill-fail-1',
        'https://github.com/test/skill-fail-2',
      ])

      expect(result.categorizedCount).toBe(0)
      expect(result.categoryAssignments).toBe(0)
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]).toContain('batch insert failed')
      expect(result.errors[0]).toContain('2 skills')
    })
  })

  describe('deletion of stale categories before upsert', () => {
    it('should delete existing category assignments for the skills', async () => {
      const { supabase, deleteCalls } = buildMockSupabase({
        skillsData: [
          {
            id: 'skill-del-1',
            repo_url: 'https://github.com/test/skill-del-1',
            tags: ['mcp-server'],
            description: null as unknown as string,
          },
          {
            id: 'skill-del-2',
            repo_url: 'https://github.com/test/skill-del-2',
            tags: ['testing'],
            description: null as unknown as string,
          },
        ],
      })

      await runCategorization(supabase, [
        'https://github.com/test/skill-del-1',
        'https://github.com/test/skill-del-2',
      ])

      expect(deleteCalls).toHaveLength(1)
      expect(deleteCalls[0]).toEqual(['skill-del-1', 'skill-del-2'])
    })

    it('should skip deletion if no skills to check', async () => {
      const { supabase, deleteCalls } = buildMockSupabase({
        skillsData: [],
      })

      await runCategorization(supabase, ['https://github.com/test/nonexistent'])

      expect(deleteCalls).toHaveLength(0)
    })

    it('should surface a delete failure in errors[] instead of only logging it', async () => {
      const deleteError = { message: 'connection reset' }
      const supabase = {
        from: (table: string) => {
          if (table === 'skills') {
            return {
              select: () => ({
                in: () =>
                  Promise.resolve({
                    data: [
                      {
                        id: 'skill-del-err',
                        tags: ['mcp-server'],
                        description: null,
                      },
                    ],
                    error: null,
                  }),
              }),
            }
          }
          if (table === 'skill_categories') {
            return {
              delete: () => ({
                in: () => Promise.resolve({ error: deleteError }),
              }),
              upsert: () => Promise.resolve({ error: null }),
            }
          }
          if (table === 'categories') {
            return {}
          }
          return {}
        },
        rpc: () => Promise.resolve({ error: null }),
      } as unknown as SupabaseClient

      const result = await runCategorization(supabase, ['https://github.com/test/skill-del-err'])

      expect(result.errors.some((e) => e.includes('failed to clear stale categories'))).toBe(true)
      expect(result.errors.some((e) => e.includes(deleteError.message))).toBe(true)
    })
  })

  describe('empty and edge cases', () => {
    it('should handle empty repoUrls list gracefully', async () => {
      const { supabase, upsertCalls } = buildMockSupabase({
        skillsData: [],
      })

      const result = await runCategorization(supabase, [])

      expect(upsertCalls).toHaveLength(0)
      expect(result.categorizedCount).toBe(0)
      expect(result.categoryAssignments).toBe(0)
      expect(result.errors).toEqual([])
    })

    it('should handle skills with null tags gracefully (no upsert call issued)', async () => {
      const { supabase, upsertCalls } = buildMockSupabase({
        skillsData: [
          {
            id: 'skill-null-tags',
            repo_url: 'https://github.com/test/skill-null-tags',
            tags: null as unknown as string[],
            description: 'A skill with null tags',
          },
        ],
      })

      const result = await runCategorization(supabase, ['https://github.com/test/skill-null-tags'])

      // No category rows collected → upsert guard (allCategoryRows.length > 0) skips the call
      expect(upsertCalls).toHaveLength(0)
      expect(result.categorizedCount).toBe(0)
      expect(result.categoryAssignments).toBe(0)
    })

    it('should handle skills with no matching categories (no upsert call issued)', async () => {
      const { supabase, upsertCalls } = buildMockSupabase({
        skillsData: [
          {
            id: 'skill-no-cat',
            repo_url: 'https://github.com/test/skill-no-cat',
            tags: ['xyz-unknown', 'abc-random'],
            description: 'A skill that does not match any category',
          },
        ],
      })

      const result = await runCategorization(supabase, ['https://github.com/test/skill-no-cat'])

      expect(upsertCalls).toHaveLength(0)
      expect(result.categorizedCount).toBe(0)
      expect(result.categoryAssignments).toBe(0)
    })
  })
})

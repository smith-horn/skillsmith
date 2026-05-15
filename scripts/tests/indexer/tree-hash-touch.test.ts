// Tree-hash touch helper tests (SMI-4861 cache-refresh-on-hit)
//
// Regression context: post-Wave-1 telemetry (2026-05-14) showed steady-state
// cache hit ratio plateaued at ~50% because hits don't refresh
// last_tree_hash_check — rows oscillate hit→miss as they age past the 24h
// TTL. Fix: on each cache hit, append a touch entry; batch-UPDATE
// last_tree_hash_check after Phase 1.

import { describe, it, expect } from 'vitest'
import { applyTreeHashTouches, type TreeHashTouchEntry } from '../../indexer/tree-hash-touch.ts'
import type { SupabaseClient } from '@supabase/supabase-js'

function makeFakeSupabase(): {
  client: SupabaseClient
  calls: Array<{ patch: Record<string, unknown>; eqs: Array<[string, string]> }>
  errorMode?: { fail: boolean; message?: string }
} {
  const state = {
    client: null as unknown as SupabaseClient,
    calls: [] as Array<{ patch: Record<string, unknown>; eqs: Array<[string, string]> }>,
    errorMode: undefined as { fail: boolean; message?: string } | undefined,
  }

  const client = {
    from: () => ({
      update: (patch: Record<string, unknown>) => {
        const call = { patch, eqs: [] as Array<[string, string]> }
        state.calls.push(call)
        const chain = {
          eq: (col: string, val: string) => {
            call.eqs.push([col, val])
            // First .eq() returns chain; second .eq() returns the promise.
            if (call.eqs.length < 2) return chain
            if (state.errorMode?.fail) {
              return Promise.resolve({
                error: { message: state.errorMode.message ?? 'fake error' },
              })
            }
            return Promise.resolve({ error: null })
          },
        }
        return chain
      },
    }),
  } as unknown as SupabaseClient

  state.client = client
  return state
}

describe('applyTreeHashTouches — cache hit refresh batch (SMI-4861)', () => {
  it('no-ops on empty input', async () => {
    const fake = makeFakeSupabase()
    const result = await applyTreeHashTouches(fake.client, [])
    expect(result).toEqual({ ok: 0, errors: [] })
    expect(fake.calls).toHaveLength(0)
  })

  it('issues one UPDATE per touch entry with last_tree_hash_check timestamp', async () => {
    const fake = makeFakeSupabase()
    const touches: TreeHashTouchEntry[] = [
      {
        repo_url: 'https://github.com/anthropics/skills/tree/main/skills/web-search',
        skill_path: 'skills/web-search',
      },
      {
        repo_url: 'https://github.com/wshobson/agents/tree/main/plugins/ship-mate/skills/scan',
        skill_path: 'plugins/ship-mate/skills/scan',
      },
    ]

    const before = Date.now()
    const result = await applyTreeHashTouches(fake.client, touches)
    const after = Date.now()

    expect(result.ok).toBe(2)
    expect(result.errors).toEqual([])
    expect(fake.calls).toHaveLength(2)

    for (const call of fake.calls) {
      expect(call.patch).toHaveProperty('last_tree_hash_check')
      const ts = Date.parse(call.patch.last_tree_hash_check as string)
      expect(ts).toBeGreaterThanOrEqual(before)
      expect(ts).toBeLessThanOrEqual(after)
      // Patch is narrow — only the one column.
      expect(Object.keys(call.patch)).toEqual(['last_tree_hash_check'])
      // Filter uses both repo_url AND skill_path (composite identity).
      expect(call.eqs).toHaveLength(2)
      const eqMap = Object.fromEntries(call.eqs)
      expect(eqMap.repo_url).toMatch(/^https:\/\/github\.com\//)
      expect(eqMap.skill_path).toMatch(/skills\//)
    }
  })

  it('non-fatal on per-row error — collects messages and continues', async () => {
    const fake = makeFakeSupabase()
    fake.errorMode = { fail: true, message: 'connection lost' }

    const result = await applyTreeHashTouches(fake.client, [
      { repo_url: 'https://github.com/x/y/tree/main/a', skill_path: 'a' },
      { repo_url: 'https://github.com/x/y/tree/main/b', skill_path: 'b' },
    ])

    expect(result.ok).toBe(0)
    expect(result.errors).toHaveLength(2)
    expect(result.errors[0]).toContain('tree_hash touch failed')
    expect(result.errors[0]).toContain('connection lost')
  })

  it('promise.all parallelism — wall clock independent of touch count', async () => {
    // Sanity: 100 touches should not serialize (would take 100 * ~5ms = 500ms).
    // Promise.all should keep total under ~50ms even with simulated latency.
    const slowClient = {
      from: () => ({
        update: () => ({
          eq: () => ({
            eq: () => new Promise((resolve) => setTimeout(() => resolve({ error: null }), 5)),
          }),
        }),
      }),
    } as unknown as SupabaseClient

    const touches: TreeHashTouchEntry[] = Array.from({ length: 100 }, (_, i) => ({
      repo_url: `https://github.com/x/y/tree/main/skill-${i}`,
      skill_path: `skill-${i}`,
    }))

    const t0 = Date.now()
    const result = await applyTreeHashTouches(slowClient, touches)
    const elapsed = Date.now() - t0

    expect(result.ok).toBe(100)
    // Serial would be ~500ms; parallel should be ~5-20ms in practice.
    expect(elapsed).toBeLessThan(200)
  })

  it('preserves entry identity: skill_path uses the column-stored shape', async () => {
    // Regression guard: the WHERE clause must filter on BOTH repo_url AND
    // skill_path because two skills can share the bare repo prefix (multi-skill
    // wildcard repos) and we want to touch only the specific row.
    const fake = makeFakeSupabase()
    await applyTreeHashTouches(fake.client, [
      {
        repo_url: 'https://github.com/microsoft/copilot-chat/tree/main/skills/code-review',
        skill_path: 'skills/code-review',
      },
    ])
    expect(fake.calls[0].eqs).toEqual([
      ['repo_url', 'https://github.com/microsoft/copilot-chat/tree/main/skills/code-review'],
      ['skill_path', 'skills/code-review'],
    ])
  })
})

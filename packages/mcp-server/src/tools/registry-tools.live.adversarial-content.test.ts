/**
 * @fileoverview Adversarial `content` payload tests for the live Supabase-backed
 * PrivateRegistryService's app-layer content validation (registry-tools.live.ts's
 * prepareContent()).
 * @see SMI-5882 — red-team pass on the private registry
 * @see docs/internal/implementation/smi-5882-redteam-private-registry-privacy-assessment.md
 *   Wave 2 Step 3 ("Adversarial `content` payloads (#7)")
 *
 * Sibling to registry-tools.live.test.ts / registry-tools.live.malformed-input.test.ts, split
 * out to keep those files under CLAUDE.md's <500-line guidance rather than growing either
 * further.
 *
 * **Why this calls `createLiveRegistryService().publish()` directly**, bypassing the Zod
 * schema at the tool layer (`registry-tools.ts`'s `skillContentSchema =
 * z.record(z.string(), z.string())`) — same technique as the malformed-input sibling file.
 * Several payloads below (content as an array, as a bare string, `SKILL.md` as a number) would
 * never survive Zod validation on the real MCP tool path, so routing through
 * `executePrivateRegistryPublish` would only prove Zod rejects them, not that `prepareContent()`
 * — the layer this suite targets — does. That distinction matters because the plan's What
 * Changes §11 finding is that the authenticated direct-PostgREST INSERT path bypasses Zod
 * *and* `prepareContent()` entirely; `prepareContent()` is the reference behavior any future
 * DB-boundary hardening (moving these invariants into a CHECK/trigger) would need to mirror.
 *
 * **Three things this file proves or documents** (plan doc Wave 2 Step 3):
 *   1. A highly-compressible payload sized to exceed the 2 MB RAW cap — compressible enough
 *      that a TOAST-compressed `pg_column_size` check (the DB's own backstop,
 *      `20260724000000:52-54`) would very likely pass it — is still rejected by
 *      `prepareContent()`'s raw `Buffer.byteLength` check, and rejected BEFORE any insert is
 *      attempted. This is an ordering/correctness proof of an *existing* guard, not a new one.
 *   2. Path-traversal-shaped content keys (`../../etc/passwd`, absolute paths, `..\` variants)
 *      are accepted as opaque JSONB map keys — not because path validation was overlooked, but
 *      because `registry-tools.live.ts` has no filesystem read/write/extraction code path at
 *      all (grep-verified below, at test time, not just read once at authoring time). This
 *      documents an ABSENCE of a vulnerability at this specific layer, per the plan's
 *      Sol-reviewed finding (What Changes §7) — it makes no claim about a future consumer that
 *      *does* extract this content to disk; per the plan doc's Wave 2 Step 3 results, no such
 *      consumer exists anywhere in this repo as of this writing.
 *   3. Missing/non-string `SKILL.md`, and `content` as an array/scalar instead of an object,
 *      are all rejected — regression-proofing `prepareContent()`'s existing behavior
 *      (registry-tools.live.test.ts already covers two of these cases; this file enumerates
 *      the fuller matrix the plan calls for).
 *
 * AIDefence prompt-injection/secret scanning of adversarial `SKILL.md` bodies (Wave 2 Step 3,
 * item 4) is a CLI-only, one-time scan (`ruflo@3.14.2 security defend -f <file> -o json`), not
 * a regression test — its output and the open policy question it raises are recorded in the
 * plan doc's Wave 2 Step 3 results, not here.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, it, expect, vi } from 'vitest'
import { createLiveRegistryService } from './registry-tools.live.js'
import type { SkillContent } from './registry-tools.js'

vi.mock('../supabase-client.js', () => ({
  isSupabaseConfigured: vi.fn(() => true),
  getSupabaseClient: vi.fn(),
  getSupabaseAdminClient: vi.fn(),
  resetSupabaseClients: vi.fn(),
}))

const TEAM_ID = 'team-alpha'

// ============================================================================
// Fake Supabase client (recorder) — same shape as the sibling test files. Fixed,
// always-succeeding responders: these tests are about whether/what reaches the query
// builder, not about response-handling branches (already covered in registry-tools.live.test.ts).
// ============================================================================

interface Recorded {
  table: string
  op: 'select' | 'insert' | 'update' | 'delete'
  payload?: Record<string, unknown>
}

function publishedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'row-1',
    team_id: TEAM_ID,
    skill_id: 'myteam/skill-a',
    version: '1.0.0',
    description: null,
    content_hash: 'hash',
    deprecated: false,
    published_by: null,
    published_at: '2026-07-24T00:00:00Z',
    ...overrides,
  }
}

function createRecordingClient(): { client: unknown; calls: Recorded[] } {
  const calls: Recorded[] = []

  function makeQuery(table: string) {
    const record: Recorded = { table, op: 'select' }
    calls.push(record)
    const chain: Record<string, unknown> = {
      select: (_columns?: string) => chain,
      eq: (_column: string, _value: unknown) => chain,
      insert: (row: Record<string, unknown>) => {
        record.op = 'insert'
        record.payload = row
        return chain
      },
      update: (row: Record<string, unknown>) => {
        record.op = 'update'
        record.payload = row
        return chain
      },
      single: async () => ({ data: publishedRow(), error: null }),
      then: (onFulfilled: (v: { data: unknown[] | null; error: unknown }) => unknown) =>
        Promise.resolve(onFulfilled({ data: [], error: null })),
    }
    return chain
  }

  return { client: { from: (table: string) => makeQuery(table) }, calls }
}

async function mockClient(client: unknown): Promise<void> {
  const { getSupabaseAdminClient } = await import('../supabase-client.js')
  vi.mocked(getSupabaseAdminClient).mockResolvedValue(client)
}

describe('createLiveRegistryService().publish() — adversarial content payloads — SMI-5882 Wave 2 Step 3', () => {
  // ==========================================================================
  // 1. Highly-compressible payload over the 2 MB RAW cap
  // ==========================================================================
  describe('highly-compressible over-raw-cap payload', () => {
    it('rejects a payload whose RAW byte length exceeds 2 MB even though it would compress to almost nothing, BEFORE any insert is attempted', async () => {
      const { client, calls } = createRecordingClient()
      await mockClient(client)
      const service = createLiveRegistryService()

      // Maximally compressible: a single repeated character run. LZ-family compression
      // (what TOAST uses) approaches its best case on input like this — the DB's own
      // pg_column_size CHECK (a *compressed*-size backstop, 20260724000000:52-54) would very
      // likely pass a payload this compressible even well over 2 MB raw. The point of this
      // test is that prepareContent() never gets a chance to find out: it measures raw
      // Buffer.byteLength BEFORE compression is a factor at all, so ordering — not just
      // presence — of the app-layer guard is what's under test.
      const raw = 'a'.repeat(3 * 1024 * 1024) // 3 MB raw, over the 2 MB cap
      const content: SkillContent = { 'SKILL.md': raw }

      await expect(service.publish(TEAM_ID, 'myteam/big-skill', '1.0.0', content)).rejects.toThrow(
        /2 MB|limit/i
      )

      // No partial write: the size guard runs before any insert is attempted.
      expect(calls.find((c) => c.op === 'insert')).toBeUndefined()
    })

    it('also rejects when the over-cap size is spread across many small, still-highly-compressible entries', async () => {
      const { client, calls } = createRecordingClient()
      await mockClient(client)
      const service = createLiveRegistryService()

      const content: SkillContent = { 'SKILL.md': '# ok' }
      for (let i = 0; i < 4000; i++) {
        content[`assets/padding-${i}.txt`] = 'x'.repeat(600) // 4000 * 600 = 2.4 MB raw
      }

      await expect(
        service.publish(TEAM_ID, 'myteam/big-skill-multikey', '1.0.0', content)
      ).rejects.toThrow(/2 MB|limit/i)
      expect(calls.find((c) => c.op === 'insert')).toBeUndefined()
    })
  })

  // ==========================================================================
  // 2. Path-traversal-shaped content keys — documents ABSENCE of a vulnerability at this layer
  // ==========================================================================
  describe('path-traversal-shaped content keys — documents absence of a vulnerability at this layer', () => {
    it('confirms registry-tools.live.ts has no filesystem import at all — the reason traversal-shaped keys are inert here', () => {
      // Read the module's own source rather than only asserting behavior indirectly. This is
      // the exact boundary claim the plan's Sol-reviewed finding rests on (What Changes §7):
      // "registry-tools.live.ts is not [the extraction consumer]: it never retrieves or
      // extracts content (it has no download/install method at all)." If a future edit adds
      // an `fs`/`path` import to this file, this assertion is what should fail first — the
      // traversal tests below would then need to change from "documents absence" to "proves a
      // real gap that must be closed here", not silently keep passing as if nothing changed.
      const sourcePath = join(dirname(fileURLToPath(import.meta.url)), 'registry-tools.live.ts')
      const source = readFileSync(sourcePath, 'utf8')
      expect(source).not.toMatch(/from ['"](?:node:)?fs(?:\/promises)?['"]/)
      expect(source).not.toMatch(/from ['"](?:node:)?path['"]/)
      expect(source).not.toMatch(/require\(\s*['"](?:node:)?fs['"]\s*\)/)
    })

    const TRAVERSAL_KEYS = [
      '../../etc/passwd',
      '/etc/passwd',
      '..\\..\\windows\\system32\\config\\sam',
      '....//....//etc/passwd',
      './../SKILL.md',
    ]

    it.each(TRAVERSAL_KEYS.map((key) => ({ key })))(
      'accepts "$key" as an opaque content map key — stored verbatim, never interpreted as a filesystem path',
      async ({ key }) => {
        const { client, calls } = createRecordingClient()
        await mockClient(client)
        const service = createLiveRegistryService()

        const content: SkillContent = { 'SKILL.md': '# ok', [key]: 'payload' }
        await service.publish(TEAM_ID, 'myteam/traversal-probe', '1.0.0', content)

        const insertCall = calls.find((c) => c.op === 'insert')
        expect(insertCall).toBeDefined()
        // The traversal-shaped key reaches the insert payload completely unmodified — no
        // normalization, no rejection, no special-casing. That is the EXPECTED and CORRECT
        // behavior given `content` is stored and read exclusively as an opaque JSONB
        // { path: text } map on this path (bound insert value, never interpolated — What
        // Changes §7); it becomes a live concern only once some OTHER component materializes
        // this map onto a filesystem, which the test above confirms this file does not do.
        const insertedContent = insertCall!.payload?.content as SkillContent
        expect(insertedContent[key]).toBe('payload')
      }
    )
  })

  // ==========================================================================
  // 3. Missing/non-string SKILL.md, and non-object content — regression-proofing
  // ==========================================================================
  describe('missing/non-string SKILL.md, and non-object content — regression-proofing existing prepareContent() validation', () => {
    const MALFORMED_CONTENT_CASES: Array<{ label: string; content: unknown }> = [
      { label: 'content is an array', content: ['SKILL.md content as an array element'] },
      { label: 'content is a bare string', content: 'not an object at all' },
      { label: 'content is a number', content: 42 },
      { label: 'content is null', content: null },
      { label: 'content is missing SKILL.md entirely', content: { 'other.txt': 'x' } },
      { label: 'SKILL.md is a number', content: { 'SKILL.md': 12345 } },
      { label: 'SKILL.md is an object', content: { 'SKILL.md': { nested: true } } },
      { label: 'SKILL.md is an array', content: { 'SKILL.md': ['not', 'a', 'string'] } },
      { label: 'SKILL.md is an empty string', content: { 'SKILL.md': '' } },
    ]

    it.each(MALFORMED_CONTENT_CASES)(
      'rejects publish() when $label, before any insert',
      async ({ content }) => {
        const { client, calls } = createRecordingClient()
        await mockClient(client)
        const service = createLiveRegistryService()

        await expect(
          service.publish(
            TEAM_ID,
            'myteam/malformed-probe',
            '1.0.0',
            content as unknown as SkillContent
          )
        ).rejects.toThrow()

        expect(calls.find((c) => c.op === 'insert')).toBeUndefined()
      }
    )
  })
})

/**
 * SMI-4291: Tests for WebhookDeadLetterRepository
 *
 * Exercises the insert / list / markRetried paths against an in-memory fake
 * that mirrors the Supabase PostgREST client surface we actually use.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  WebhookDeadLetterRepository,
  type DeadLetterRow,
  type SupabaseLikeClient,
} from '../src/webhooks/WebhookDeadLetterRepository.js'
import type { WebhookQueueItem } from '../src/webhooks/WebhookQueue.types.js'

// ---------------------------------------------------------------------------
// Fake Supabase client — captures writes and models the query surface
// ---------------------------------------------------------------------------

interface FakeState {
  rows: DeadLetterRow[]
  insertError: string | null
  updateError: string | null
  selectError: string | null
}

function createFake(): { client: SupabaseLikeClient; state: FakeState } {
  const state: FakeState = {
    rows: [],
    insertError: null,
    updateError: null,
    selectError: null,
  }

  const client: SupabaseLikeClient = {
    from(table) {
      if (table !== 'webhook_dead_letters') {
        throw new Error(`Unexpected table: ${table}`)
      }
      return {
        insert: async (row) => {
          if (state.insertError) return { error: { message: state.insertError } }
          const newRow: DeadLetterRow = {
            id: `row-${state.rows.length + 1}`,
            retried_at: null,
            retry_success: null,
            created_at: new Date().toISOString(),
            ...(row as Omit<DeadLetterRow, 'id' | 'retried_at' | 'retry_success' | 'created_at'>),
          }
          state.rows.push(newRow)
          return { error: null }
        },
        select: () => ({
          eq: (_col, value) => ({
            order: async () => {
              if (state.selectError) {
                return { data: null, error: { message: state.selectError } }
              }
              const filtered = state.rows
                .filter((r) => r.team_id === value)
                .sort((a, b) => (a.last_failed_at < b.last_failed_at ? 1 : -1))
              return { data: filtered, error: null }
            },
          }),
        }),
        update: (patch) => ({
          eq: async (_col, id) => {
            if (state.updateError) {
              return { data: null, error: { message: state.updateError } }
            }
            const idx = state.rows.findIndex((r) => r.id === id)
            if (idx === -1) return { data: null, error: null }
            state.rows[idx] = { ...state.rows[idx], ...(patch as Partial<DeadLetterRow>) }
            return { data: state.rows[idx], error: null }
          },
        }),
      }
    },
  }

  return { client, state }
}

// ---------------------------------------------------------------------------
// insertDeadLetter
// ---------------------------------------------------------------------------

describe('WebhookDeadLetterRepository.insertDeadLetter', () => {
  let fake: ReturnType<typeof createFake>
  let repo: WebhookDeadLetterRepository

  beforeEach(() => {
    fake = createFake()
    repo = new WebhookDeadLetterRepository(fake.client)
  })

  it('persists a row with normalized timestamps', async () => {
    const firstFailed = new Date('2026-04-18T00:00:00Z')
    await repo.insertDeadLetter({
      originalEventId: 'evt-1',
      endpointUrl: 'https://example.com/hook',
      payload: { foo: 'bar' },
      failureReason: 'HTTP 500',
      attemptCount: 3,
      firstFailedAt: firstFailed,
      teamId: 'team-a',
    })

    expect(fake.state.rows).toHaveLength(1)
    const row = fake.state.rows[0]
    expect(row.original_event_id).toBe('evt-1')
    expect(row.team_id).toBe('team-a')
    expect(row.first_failed_at).toBe(firstFailed.toISOString())
    expect(row.attempt_count).toBe(3)
    expect(row.retried_at).toBeNull()
    expect(row.retry_success).toBeNull()
  })

  it('rejects empty endpoint_url', async () => {
    await expect(
      repo.insertDeadLetter({
        originalEventId: 'evt-2',
        endpointUrl: '',
        payload: {},
        failureReason: 'nope',
        attemptCount: 1,
        firstFailedAt: new Date(),
        teamId: 'team-a',
      })
    ).rejects.toThrow(/endpoint_url length/)
    expect(fake.state.rows).toHaveLength(0)
  })

  it('rejects endpoint_url longer than 2048 chars', async () => {
    await expect(
      repo.insertDeadLetter({
        originalEventId: 'evt-3',
        endpointUrl: 'https://example.com/' + 'a'.repeat(2050),
        payload: {},
        failureReason: 'nope',
        attemptCount: 1,
        firstFailedAt: new Date(),
        teamId: 'team-a',
      })
    ).rejects.toThrow(/endpoint_url length/)
  })

  it('rejects non-positive attempt_count', async () => {
    await expect(
      repo.insertDeadLetter({
        originalEventId: 'evt-4',
        endpointUrl: 'https://example.com/h',
        payload: {},
        failureReason: 'nope',
        attemptCount: 0,
        firstFailedAt: new Date(),
        teamId: 'team-a',
      })
    ).rejects.toThrow(/positive integer/)
  })

  it('surfaces Supabase errors with a sanitized message', async () => {
    fake.state.insertError = 'insert denied by RLS'
    await expect(
      repo.insertDeadLetter({
        originalEventId: 'evt-5',
        endpointUrl: 'https://example.com/h',
        payload: {},
        failureReason: 'nope',
        attemptCount: 1,
        firstFailedAt: new Date(),
        teamId: 'team-a',
      })
    ).rejects.toThrow(/insert failed: insert denied by RLS/)
  })
})

// ---------------------------------------------------------------------------
// listUnretried
// ---------------------------------------------------------------------------

describe('WebhookDeadLetterRepository.listUnretried', () => {
  let fake: ReturnType<typeof createFake>
  let repo: WebhookDeadLetterRepository

  beforeEach(async () => {
    fake = createFake()
    repo = new WebhookDeadLetterRepository(fake.client)

    // seed: two unretried, one retried, one for different team
    const base = {
      payload: {},
      failureReason: 'r',
      attemptCount: 1,
      endpointUrl: 'https://example.com/h',
    }
    await repo.insertDeadLetter({
      ...base,
      originalEventId: 'e1',
      firstFailedAt: '2026-04-18T00:00:00Z',
      lastFailedAt: '2026-04-18T00:00:00Z',
      teamId: 'team-a',
    })
    await repo.insertDeadLetter({
      ...base,
      originalEventId: 'e2',
      firstFailedAt: '2026-04-18T01:00:00Z',
      lastFailedAt: '2026-04-18T01:00:00Z',
      teamId: 'team-a',
    })
    await repo.insertDeadLetter({
      ...base,
      originalEventId: 'e3-team-b',
      firstFailedAt: '2026-04-18T02:00:00Z',
      lastFailedAt: '2026-04-18T02:00:00Z',
      teamId: 'team-b',
    })
    // mark one as retried
    fake.state.rows[0].retried_at = '2026-04-18T03:00:00Z'
    fake.state.rows[0].retry_success = true
  })

  it('returns only unretried rows for the given team', async () => {
    const rows = await repo.listUnretried('team-a')
    expect(rows).toHaveLength(1)
    expect(rows[0].original_event_id).toBe('e2')
  })

  it('isolates teams (2-team test, finding from SMI-4292)', async () => {
    const a = await repo.listUnretried('team-a')
    const b = await repo.listUnretried('team-b')
    const aIds = a.map((r) => r.original_event_id)
    const bIds = b.map((r) => r.original_event_id)
    expect(aIds).not.toContain('e3-team-b')
    expect(bIds).toEqual(['e3-team-b'])
  })

  it('returns empty array when no rows match', async () => {
    const rows = await repo.listUnretried('team-nonexistent')
    expect(rows).toEqual([])
  })

  it('surfaces select errors', async () => {
    fake.state.selectError = 'query timeout'
    await expect(repo.listUnretried('team-a')).rejects.toThrow(/list failed: query timeout/)
  })
})

// ---------------------------------------------------------------------------
// markRetried
// ---------------------------------------------------------------------------

describe('WebhookDeadLetterRepository.markRetried', () => {
  let fake: ReturnType<typeof createFake>
  let repo: WebhookDeadLetterRepository

  beforeEach(async () => {
    fake = createFake()
    repo = new WebhookDeadLetterRepository(fake.client)
    await repo.insertDeadLetter({
      originalEventId: 'e1',
      endpointUrl: 'https://example.com/h',
      payload: {},
      failureReason: 'r',
      attemptCount: 1,
      firstFailedAt: new Date(),
      teamId: 'team-a',
    })
  })

  it('sets retried_at + retry_success=true on success', async () => {
    await repo.markRetried('row-1', true)
    const row = fake.state.rows[0]
    expect(row.retried_at).not.toBeNull()
    expect(row.retry_success).toBe(true)
  })

  it('sets retry_success=false on failure', async () => {
    await repo.markRetried('row-1', false)
    expect(fake.state.rows[0].retry_success).toBe(false)
  })

  it('surfaces update errors', async () => {
    fake.state.updateError = 'update denied'
    await expect(repo.markRetried('row-1', true)).rejects.toThrow(
      /markRetried failed: update denied/
    )
  })
})

// ---------------------------------------------------------------------------
// makeSink — integrates with WebhookQueue's deadLetterSink option
// ---------------------------------------------------------------------------

describe('WebhookDeadLetterRepository.makeSink', () => {
  it('produces a sink that writes rows with extracted endpoint + payload', async () => {
    const fake = createFake()
    const repo = new WebhookDeadLetterRepository(fake.client)
    const sink = repo.makeSink({
      teamId: 'team-a',
      extractEndpointUrl: (item) => `https://example.com/hooks/${item.repoFullName}`,
    })

    const item: WebhookQueueItem = {
      id: 'evt-123',
      type: 'index',
      repoUrl: 'https://github.com/org/repo',
      repoFullName: 'org/repo',
      filePath: 'SKILL.md',
      commitSha: 'abc',
      timestamp: Date.parse('2026-04-18T00:00:00Z'),
      priority: 'medium',
      retries: 3,
    }

    await sink(item, 'HTTP 500')

    expect(fake.state.rows).toHaveLength(1)
    const row = fake.state.rows[0]
    expect(row.original_event_id).toBe('evt-123')
    expect(row.endpoint_url).toBe('https://example.com/hooks/org/repo')
    expect(row.failure_reason).toBe('HTTP 500')
    expect(row.attempt_count).toBe(4) // retries + 1
    expect(row.team_id).toBe('team-a')
  })
})

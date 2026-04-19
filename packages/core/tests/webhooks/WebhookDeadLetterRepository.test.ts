/**
 * SMI-4307: Tests for WebhookDeadLetterRepository null-team guard
 *
 * F-03/F-02: `insertDeadLetter` must short-circuit when `input.teamId` is
 * empty or null so Individual-tier users (and users whose team has not been
 * provisioned yet) don't hit the NOT NULL / team-scoped RLS on
 * `webhook_dead_letters`.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import {
  WebhookDeadLetterRepository,
  type SupabaseLikeClient,
  type InsertDeadLetterInput,
} from '../../src/webhooks/WebhookDeadLetterRepository.js'

function buildInsertInput(overrides: Partial<InsertDeadLetterInput> = {}): InsertDeadLetterInput {
  return {
    originalEventId: 'evt_123',
    endpointUrl: 'https://example.com/hook',
    payload: { k: 'v' },
    failureReason: 'http_5xx',
    attemptCount: 3,
    firstFailedAt: new Date('2026-04-19T10:00:00Z'),
    lastFailedAt: new Date('2026-04-19T10:05:00Z'),
    teamId: 'team_abc',
    ...overrides,
  }
}

function buildClient(insertResult: { error: { message: string } | null } = { error: null }) {
  const insertFn = vi.fn<
    (row: Record<string, unknown>) => Promise<{ error: { message: string } | null }>
  >(async () => insertResult)
  const client: SupabaseLikeClient = {
    from: vi.fn(
      () =>
        ({
          insert: insertFn,
          // Unused methods — sufficient for insertDeadLetter() tests.
          select: () => ({
            eq: () => ({
              order: () => Promise.resolve({ data: [], error: null }),
            }),
          }),
          update: () => ({
            eq: () => Promise.resolve({ data: null, error: null }),
          }),
        }) as unknown as ReturnType<SupabaseLikeClient['from']>
    ),
  }
  return { client, insertFn }
}

describe('WebhookDeadLetterRepository.insertDeadLetter — SMI-4307 null-team guard', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('inserts normally when teamId is present', async () => {
    const { client, insertFn } = buildClient()
    const repo = new WebhookDeadLetterRepository(client)

    await repo.insertDeadLetter(buildInsertInput({ teamId: 'team_abc' }))

    expect(insertFn).toHaveBeenCalledTimes(1)
    const firstCall = insertFn.mock.calls[0] as unknown as [Record<string, unknown>]
    const row = firstCall[0]
    expect(row.team_id).toBe('team_abc')
    expect(row.original_event_id).toBe('evt_123')
  })

  it('SHORT-CIRCUITS (no insert) when teamId is empty string', async () => {
    const { client, insertFn } = buildClient()
    const repo = new WebhookDeadLetterRepository(client)

    await repo.insertDeadLetter(buildInsertInput({ teamId: '' }))

    expect(insertFn).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalledWith(
      'webhook-dlq: skipping DLQ insert — no teamId (orphan event)',
      expect.objectContaining({
        originalEventId: 'evt_123',
        failureReason: 'http_5xx',
      })
    )
  })

  it('SHORT-CIRCUITS (no insert) when teamId is null-ish', async () => {
    const { client, insertFn } = buildClient()
    const repo = new WebhookDeadLetterRepository(client)

    // Cast the null through unknown — InsertDeadLetterInput.teamId is string,
    // but runtime callers have been observed to pass null via Supabase shape
    // coercion. The guard must treat any falsy value as orphan.
    await repo.insertDeadLetter(buildInsertInput({ teamId: null as unknown as string }))

    expect(insertFn).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalled()
  })

  it('SHORT-CIRCUITS (no insert) when teamId is undefined', async () => {
    const { client, insertFn } = buildClient()
    const repo = new WebhookDeadLetterRepository(client)

    await repo.insertDeadLetter(buildInsertInput({ teamId: undefined as unknown as string }))

    expect(insertFn).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalled()
  })

  it('guard runs BEFORE endpoint_url validation (orphan event with bad URL is still skipped silently)', async () => {
    const { client, insertFn } = buildClient()
    const repo = new WebhookDeadLetterRepository(client)

    // If the guard ran AFTER endpoint_url validation, this would throw.
    // The guard running first means an Individual-tier user with a bad URL
    // gets a clean skip rather than a noisy error.
    await expect(
      repo.insertDeadLetter(buildInsertInput({ teamId: '', endpointUrl: '' }))
    ).resolves.toBeUndefined()

    expect(insertFn).not.toHaveBeenCalled()
  })

  it('still throws on endpoint_url validation when teamId is present (guard does not mask real errors)', async () => {
    const { client, insertFn } = buildClient()
    const repo = new WebhookDeadLetterRepository(client)

    await expect(
      repo.insertDeadLetter(buildInsertInput({ teamId: 'team_abc', endpointUrl: '' }))
    ).rejects.toThrow(/endpoint_url length/)

    expect(insertFn).not.toHaveBeenCalled()
  })

  it('still throws on attempt_count validation when teamId is present', async () => {
    const { client, insertFn } = buildClient()
    const repo = new WebhookDeadLetterRepository(client)

    await expect(
      repo.insertDeadLetter(buildInsertInput({ teamId: 'team_abc', attemptCount: 0 }))
    ).rejects.toThrow(/attempt_count must be a positive integer/)

    expect(insertFn).not.toHaveBeenCalled()
  })
})

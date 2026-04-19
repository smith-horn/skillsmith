/**
 * SMI-4291: WebhookDeadLetterRepository
 *
 * Thin persistence layer over the `webhook_dead_letters` table (migration 070).
 * Used by the WebhookQueue deadLetterSink wiring and by the `webhook-dlq`
 * edge function.
 *
 * Plan: docs/internal/implementation/github-wave-4-webhook-dlq.md
 *
 * The repository is intentionally minimal — three operations cover all
 * current call sites:
 *  - insertDeadLetter(item, reason, teamId)           — sink path
 *  - listUnretried(teamId)                            — edge fn GET
 *  - markRetried(id, success)                         — edge fn POST /retry
 *
 * No `audit_logs` emission is performed (plan-review finding C2: cross-tenant
 * exposure risk on the global-read RLS of `audit_logs`).
 */

import type { WebhookQueueItem } from './WebhookQueue.types.js'

/**
 * Minimal Supabase-client shape this repository depends on. We avoid
 * importing `@supabase/supabase-js` directly so the module stays usable
 * from Deno edge functions, Node services, and tests with a fake client.
 */
export interface SupabaseLikeClient {
  from(table: string): {
    insert(row: Record<string, unknown>): Promise<{ error: { message: string } | null }>
    select(columns: string): {
      eq(
        column: string,
        value: string
      ): {
        order(
          column: string,
          opts?: { ascending?: boolean }
        ): Promise<{ data: DeadLetterRow[] | null; error: { message: string } | null }>
      }
      single?: () => Promise<{ data: DeadLetterRow | null; error: { message: string } | null }>
    }
    update(row: Record<string, unknown>): {
      eq(
        column: string,
        value: string
      ): Promise<{ data: DeadLetterRow | null; error: { message: string } | null }>
    }
  }
}

export interface DeadLetterRow {
  id: string
  original_event_id: string
  endpoint_url: string
  payload: Record<string, unknown>
  failure_reason: string
  attempt_count: number
  first_failed_at: string
  last_failed_at: string
  retried_at: string | null
  retry_success: boolean | null
  team_id: string
  created_at: string
}

export interface InsertDeadLetterInput {
  originalEventId: string
  endpointUrl: string
  payload: Record<string, unknown>
  failureReason: string
  attemptCount: number
  firstFailedAt: Date | string
  lastFailedAt?: Date | string
  teamId: string
}

/**
 * Coerce a Date|string to an ISO string suitable for TIMESTAMPTZ columns.
 */
function toIso(value: Date | string | undefined): string {
  if (!value) return new Date().toISOString()
  return value instanceof Date ? value.toISOString() : value
}

/**
 * WebhookDeadLetterRepository — single-table CRUD wrapper.
 *
 * Instances are stateless beyond the client reference; construct freely per
 * request in edge functions and once per process in long-lived services.
 */
export class WebhookDeadLetterRepository {
  constructor(private readonly client: SupabaseLikeClient) {}

  /**
   * Persist a dead-letter row for an exhausted queue item.
   *
   * Validates `endpoint_url` length at the application layer so the DB
   * CHECK constraint is never hit in practice; a row that would violate the
   * check throws a sanitized error without the payload.
   */
  async insertDeadLetter(input: InsertDeadLetterInput): Promise<void> {
    const endpointUrl = input.endpointUrl ?? ''
    if (endpointUrl.length === 0 || endpointUrl.length > 2048) {
      throw new Error(`webhook-dlq: endpoint_url length ${endpointUrl.length} outside [1, 2048]`)
    }
    if (input.attemptCount < 1 || !Number.isInteger(input.attemptCount)) {
      throw new Error(
        `webhook-dlq: attempt_count must be a positive integer (got ${input.attemptCount})`
      )
    }

    const row = {
      original_event_id: input.originalEventId,
      endpoint_url: endpointUrl,
      payload: input.payload,
      failure_reason: input.failureReason,
      attempt_count: input.attemptCount,
      first_failed_at: toIso(input.firstFailedAt),
      last_failed_at: toIso(input.lastFailedAt),
      team_id: input.teamId,
    }

    const { error } = await this.client.from('webhook_dead_letters').insert(row)

    if (error) {
      throw new Error(`webhook-dlq: insert failed: ${error.message}`)
    }
  }

  /**
   * List DLQ rows for a team that have not yet been retried.
   * Ordered by `last_failed_at` descending so fresh failures surface first.
   *
   * RLS guarantees cross-team isolation; this filter is a belt-and-braces
   * server-side refinement for the service-role code path.
   */
  async listUnretried(teamId: string): Promise<DeadLetterRow[]> {
    const { data, error } = await this.client
      .from('webhook_dead_letters')
      .select('*')
      .eq('team_id', teamId)
      .order('last_failed_at', { ascending: false })

    if (error) {
      throw new Error(`webhook-dlq: list failed: ${error.message}`)
    }

    return (data ?? []).filter((row) => row.retried_at === null)
  }

  /**
   * Mark a DLQ row as retried. Three-state `retry_success` semantics:
   *  - true  — retry succeeded (item re-entered the queue and drained)
   *  - false — retry failed (item re-entered the queue and was re-deadlettered)
   *
   * NULL is reserved for rows that have never been retried; this method
   * never writes NULL.
   */
  async markRetried(id: string, success: boolean): Promise<void> {
    const { error } = await this.client
      .from('webhook_dead_letters')
      .update({
        retried_at: new Date().toISOString(),
        retry_success: success,
      })
      .eq('id', id)

    if (error) {
      throw new Error(`webhook-dlq: markRetried failed: ${error.message}`)
    }
  }

  /**
   * Build a sink function compatible with `WebhookQueueOptions.deadLetterSink`.
   *
   * The sink captures `teamId` and a payload-extraction strategy so the
   * WebhookQueue stays decoupled from Supabase.
   */
  makeSink(opts: {
    teamId: string
    extractEndpointUrl: (item: WebhookQueueItem) => string
    extractPayload?: (item: WebhookQueueItem) => Record<string, unknown>
  }): (item: WebhookQueueItem, reason: string) => Promise<void> {
    return async (item, reason) => {
      await this.insertDeadLetter({
        originalEventId: item.id,
        endpointUrl: opts.extractEndpointUrl(item),
        payload: opts.extractPayload
          ? opts.extractPayload(item)
          : { repoFullName: item.repoFullName, filePath: item.filePath, commitSha: item.commitSha },
        failureReason: reason,
        attemptCount: Math.max(1, (item.retries ?? 0) + 1),
        firstFailedAt: new Date(item.timestamp),
        lastFailedAt: new Date(),
        teamId: opts.teamId,
      })
    }
  }
}

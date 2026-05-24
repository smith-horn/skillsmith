/**
 * SMI-5166: Shared test harness for recheck.test.ts.
 *
 * Extracted from recheck.test.ts to keep that test file under the 500-line gate.
 * Holds the row/content fixtures, the GitHub `fetch` stubs, and the chainable
 * Supabase double that serves BOTH loadRecheckCandidates (two PostgREST select
 * passes) and processRow (skills UPDATE + audit_logs INSERT). Not a `*.test.ts`
 * file, so vitest does not collect it as a suite.
 */

import { vi, type MockInstance } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { StaleQuarantinedRow } from '../../indexer/revalidate-stale-quarantines.ts'

/** A recheck candidate row (loadRecheckCandidates selects quarantined + last_seen_at). */
export function makeRow(overrides: Partial<StaleQuarantinedRow> = {}): StaleQuarantinedRow {
  return {
    id: 'skill-uuid-1',
    author: 'acme',
    name: 'my-skill',
    repo_url: 'https://github.com/acme/my-skill',
    skill_path: null,
    quarantine_reason: null,
    security_findings: [],
    quarantined: false,
    last_seen_at: '2020-01-01T00:00:00.000Z',
    ...overrides,
  }
}

/** SKILL.md content that the fixed scanner passes (riskScore < 40). */
export const CLEAN_CONTENT = `---
name: my-skill
description: A helpful skill.
---

# My Skill

Run the following to use this skill:

\`\`\`bash
/my-skill --help
\`\`\`
`

/** Encode content as the GitHub Contents API would return it. */
function encodeAsGitHubResponse(content: string): string {
  const b64 = Buffer.from(content, 'utf-8').toString('base64')
  return b64.match(/.{1,60}/g)?.join('\n') ?? b64
}

/** Stub every GitHub Contents fetch as a clean 200 (riskScore < 40). */
export function stubFetchCleanAlways(): MockInstance {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ content: encodeAsGitHubResponse(CLEAN_CONTENT), encoding: 'base64' }),
  } as unknown as Response)
}

/** Stub every GitHub Contents fetch as a persistent transient 403 (rate limit). */
export function stubFetchTransientAlways(status = 403): MockInstance {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: false,
    status,
    headers: { get: () => null },
  } as unknown as Response)
}

export interface LoadDbState {
  pass1: StaleQuarantinedRow[]
  pass2: StaleQuarantinedRow[]
  /** Rows returned by the CAS `.select('id')` after a skills UPDATE. */
  casReturns: { id: string }[]
  casError: { message: string } | null
}

export interface RunDbHandle {
  db: SupabaseClient
  /** All `.eq(col, val)` calls observed, in order, across every chain. */
  eqCalls: [string, unknown][]
  /** All `.lt(col, val)` calls observed. */
  ltCalls: [string, unknown][]
  /** All `.ilike(col, val)` calls observed. */
  ilikeCalls: [string, unknown][]
  /** All `.order(col, opts)` calls observed. */
  orderCalls: [string, unknown][]
  /** All `.update(payload)` payloads sent to `skills`. */
  updatePayloads: Record<string, unknown>[]
  /** All `.insert(payload)` payloads sent to `audit_logs`. */
  auditInserts: Record<string, unknown>[]
  /** Counter of how many times pass 2's discriminator (`.or(...)`) ran. */
  pass2Issued: number
}

/**
 * Build a Supabase double. `loadRecheckCandidates` runs two PostgREST chains
 * against `skills` (pass 1: eq/lt/ilike/order/range; pass 2 adds `.or(...)`).
 * `processRow` runs an UPDATE chain against `skills` and an INSERT against
 * `audit_logs`. The double dispatches by the table name passed to `.from()` and,
 * for `skills`, by whether `.select(...)` (load) or `.update(...)` (write) was
 * the first verb.
 */
export function makeRunDb(state: LoadDbState): RunDbHandle {
  const handle: RunDbHandle = {
    db: null as unknown as SupabaseClient,
    eqCalls: [],
    ltCalls: [],
    ilikeCalls: [],
    orderCalls: [],
    updatePayloads: [],
    auditInserts: [],
    pass2Issued: 0,
  }

  // A select chain (load). `usedOr` flips pass2 detection so range() returns the
  // right slice. range() is terminal (returns a Promise).
  function makeSelectChain() {
    let usedOr = false
    const chain = {
      eq(col: string, val: unknown) {
        handle.eqCalls.push([col, val])
        return chain
      },
      lt(col: string, val: unknown) {
        handle.ltCalls.push([col, val])
        return chain
      },
      ilike(col: string, val: unknown) {
        handle.ilikeCalls.push([col, val])
        return chain
      },
      or() {
        usedOr = true
        handle.pass2Issued++
        return chain
      },
      order(col: string, opts: unknown) {
        handle.orderCalls.push([col, opts])
        return chain
      },
      range(from: number, to: number) {
        const rows = usedOr ? state.pass2 : state.pass1
        return Promise.resolve({ data: rows.slice(from, to + 1), error: null })
      },
    }
    return chain
  }

  // An update chain (write). Terminal `.select('id')` returns the CAS rows.
  function makeUpdateChain(payload: Record<string, unknown>) {
    handle.updatePayloads.push(payload)
    const chain = {
      eq(col: string, val: unknown) {
        handle.eqCalls.push([col, val])
        return chain
      },
      select() {
        return Promise.resolve({
          data: state.casError ? null : state.casReturns,
          error: state.casError,
        })
      },
    }
    return chain
  }

  const db = {
    from(table: string) {
      if (table === 'audit_logs') {
        return {
          insert(payload: Record<string, unknown>) {
            handle.auditInserts.push(payload)
            return Promise.resolve({ error: null })
          },
        }
      }
      // skills: distinguish load (select-first) from write (update-first).
      return {
        select() {
          return makeSelectChain()
        },
        update(payload: Record<string, unknown>) {
          return makeUpdateChain(payload)
        },
      }
    },
  }

  handle.db = db as unknown as SupabaseClient
  return handle
}

/** A load-only db double for direct loadRecheckCandidates tests (no writes). */
export function makeLoadDb(
  pass1: StaleQuarantinedRow[],
  pass2: StaleQuarantinedRow[]
): RunDbHandle {
  return makeRunDb({ pass1, pass2, casReturns: [], casError: null })
}

/** Shared runRecheck opts for the happy-path tests. */
export const BASE_OPTS = {
  requestId: 'req-test',
  apply: true,
  thresholdDays: 5,
  cap: 100,
  batch: 5,
}

/**
 * Shared low-level Linear GraphQL client (SMI-5858).
 *
 * Extracted from `scripts/linear-api.mjs`'s transport/retry/lookup code,
 * which four different scripts had each independently hand-rolled with
 * subtly different retry policies: `scripts/linear-api.mjs` (the canonical
 * CLI), `scripts/linear-upsert-drift-issue.mjs`, `scripts/lint-linear-issues.mjs`,
 * and `scripts/e2e/create-linear-issues.linear-client.ts` (a near-verbatim TS
 * port). This module is the single source of truth for the transport
 * (`graphql`), the retry primitives (`isRetryable`/`withRetry`/`retryQuery`),
 * and the team/issue/label lookups every one of those scripts needs.
 *
 * `getTeamId()`/`getIssueId()` are deliberately SINGLE-ATTEMPT — no retry
 * logic inside either function. Three different callers apply three
 * different retry policies to team/issue lookups today: `linear-api.mjs`
 * wraps `getTeamId` externally with `retryQuery` at some call sites but not
 * others (`getStates()` calls it unwrapped); `linear-upsert-drift-issue.mjs`
 * wraps its whole multi-step operation — including team/issue lookups — in
 * one catch-all `withRetry` that retries almost anything, including
 * mutations; the e2e client's `getTeamId` used to retry INSIDE itself. If
 * this shared function retried internally, any caller that ALSO wraps it
 * externally would get nested retries (up to 4x4=16 real attempts), and any
 * caller that then stopped wrapping externally would silently lose whatever
 * policy it had. Pushing 100% of retry policy to call sites is the only way
 * to keep every caller's existing behavior exactly intact. See each
 * consumer's own call site for how it composes retry around these.
 *
 * `resolveLabelIds` is the one deliberate exception: it retries internally
 * via its own `retryQuery()` calls, because it has exactly one consumer
 * today (`linear-api.mjs`'s `createIssue`) — no cross-caller policy
 * conflict to resolve.
 */

export const API_URL = 'https://api.linear.app/graphql'
export const TEAM_KEY = 'SMI'

// SMI-5854: retry policy for idempotent READ queries only (team/label/
// parent lookups). Never used for mutations.
export const RETRY_DELAYS_MS = [1000, 2000, 4000]
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// Exact-name filter returns <= 1 label per team; a full page means the
// name is ambiguous, not that pagination is needed.
export const LABEL_PAGE_SIZE = 50

/**
 * Execute a GraphQL query against the Linear API.
 *
 * On a GraphQL `errors` response this throws an `Error` with two additive
 * flags: `graphqlError = true` (existing convention — `isRetryable()` uses
 * it to never retry a deterministic application-level error) and
 * `graphqlErrors` (the raw `errors` array, SMI-5858 — lets
 * `scripts/lint-linear-issues.mjs` reproduce its exact current stderr
 * message without re-deriving it from `err.message`).
 *
 * `err.message`'s `errors` dump is pretty-printed (`JSON.stringify(..., null, 2)`),
 * matching `scripts/linear-api.mjs`'s pre-SMI-5858 canonical format, which this
 * function is moved from verbatim. `scripts/linear-upsert-drift-issue.mjs` and
 * `scripts/e2e/create-linear-issues.linear-client.ts` each independently
 * hand-rolled a compact (non-pretty-printed) version before this extraction —
 * a second, named exception to this refactor's no-behavior-change goal (GPT-5.6-Sol
 * code review on commit 64a78d38), alongside the team-query field-selection
 * reduction in the plan doc's Design Question 5. Verified no test or caller in
 * either script depends on the exact compact format; `err.message` is not
 * asserted anywhere, and the one place both scripts DO construct their own
 * "GraphQL errors: ..." string outside this shared function (e.g.
 * `create-linear-issues.linear-client.ts`'s `createLinearIssue()` failure
 * `reason` text, built from a mutation response's `errors` field rather than
 * from this function's thrown error) is untouched by this change.
 *
 * `options.signal` (SMI-5860) is additive — an optional `AbortSignal` passed
 * straight through to the underlying `fetch()` call. Every caller that
 * predates SMI-5860 omits it (defaults to `undefined`, identical to not
 * passing the key at all). It exists for
 * `scripts/session-priming-query.helpers.ts`'s `buildSignal2()`, which runs
 * inside a `SessionStart` hook and must not let a slow Linear response block
 * Claude Code startup — timeout/timer policy stays local to that one caller;
 * this module only forwards the signal.
 *
 * @param {string} query
 * @param {Record<string, unknown>} [variables]
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<any>}
 */
export async function graphql(query, variables = {}, options = {}) {
  const apiKey = process.env.LINEAR_API_KEY

  if (!apiKey) {
    throw new Error('LINEAR_API_KEY environment variable is not set')
  }

  const response = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: apiKey,
    },
    body: JSON.stringify({ query, variables }),
    signal: options.signal,
  })

  if (!response.ok) {
    const text = await response.text()
    const err = new Error(`Linear API error: ${response.status} ${text}`)
    err.status = response.status
    throw err
  }

  const json = await response.json()

  if (json.errors) {
    const err = new Error(`GraphQL errors: ${JSON.stringify(json.errors, null, 2)}`)
    err.graphqlError = true
    err.graphqlErrors = json.errors
    throw err
  }

  return json.data
}

/**
 * Whether a graphql() error is safe to retry. Deterministic
 * application-level errors (json.errors) are never retryable; transport
 * errors (no status) and HTTP 429/5xx are.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
export function isRetryable(err) {
  if (err?.graphqlError) return false
  if (err?.status === undefined) return true
  return err.status === 429 || (err.status >= 500 && err.status < 600)
}

/**
 * Retry an async function with exponential backoff, using a
 * caller-supplied predicate to decide whether a given failure is
 * retryable. Generalizes `retryQuery()` below so different callers can
 * plug in different retry policies against the same backoff-loop shape
 * (SMI-5858) — e.g. `scripts/lint-linear-issues.mjs` retries any HTTP
 * status but never a deterministic GraphQL error, while
 * `linear-upsert-drift-issue.mjs` retries almost anything including
 * mutations.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @param {number[]} [delays]
 * @param {(err: unknown) => boolean} [isRetryableFn]
 * @returns {Promise<T>}
 */
export async function withRetry(fn, delays = RETRY_DELAYS_MS, isRetryableFn = () => true) {
  let lastErr
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      return await fn()
    } catch (e) {
      lastErr = e
      if (!isRetryableFn(e) || attempt === delays.length) throw e
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]))
    }
  }
  throw lastErr
}

/**
 * Retry an idempotent READ query. Never used for mutations. This is the
 * classified retry convention every read-only caller in `linear-api.mjs`
 * already uses — `withRetry(fn, delays, isRetryable)`.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @param {number[]} [delays]
 * @returns {Promise<T>}
 */
export async function retryQuery(fn, delays = RETRY_DELAYS_MS) {
  return withRetry(fn, delays, isRetryable)
}

/**
 * Get a team's UUID by key. SINGLE-ATTEMPT — do NOT wrap this function's
 * body in `retryQuery()`/`withRetry()`; see this module's header for why.
 * Callers that want retry apply it externally at their own call site.
 * No caching here either — caching (where wanted) happens at the call
 * site (see `scripts/linear-api.mjs`'s local `getTeamId` wrapper).
 *
 * Only selects the `id` field — nothing in the codebase reads `key`/`name`
 * back off this query (a deliberate, plan-approved field-selection
 * reduction, not an oversight).
 *
 * @param {string} [teamKey]
 * @returns {Promise<string>}
 */
export async function getTeamId(teamKey = TEAM_KEY) {
  const data = await graphql(
    `
      query GetTeam($key: String!) {
        teams(filter: { key: { eq: $key } }) {
          nodes {
            id
          }
        }
      }
    `,
    { key: teamKey }
  )

  const team = data.teams.nodes[0]
  if (!team) {
    throw new Error(`Team with key "${teamKey}" not found`)
  }

  return team.id
}

/**
 * Resolve an issue identifier (e.g. SMI-123) to its UUID. UUID input
 * passes through unqueried with zero fetch calls. Returns null ONLY when
 * the API successfully answered and no such issue exists — transport/5xx/
 * 429 failures propagate instead of masquerading as "not found".
 * SINGLE-ATTEMPT — do NOT wrap this function's body in
 * `retryQuery()`/`withRetry()`; see this module's header for why. Callers
 * that want retry apply it externally at their own call site.
 *
 * @param {string} identifier
 * @returns {Promise<string | null>}
 */
export async function getIssueId(identifier) {
  if (UUID_RE.test(identifier)) return identifier

  const data = await graphql(
    `
      query ($id: String!) {
        issue(id: $id) {
          id
        }
      }
    `,
    { id: identifier }
  )

  return data.issue ? data.issue.id : null
}

/**
 * Trim, drop blanks, dedupe preserving first-seen order.
 *
 * @param {Iterable<unknown>} entries
 * @returns {string[]}
 */
export function normalizeLabelEntries(entries) {
  const seen = new Set()
  const out = []
  for (const raw of entries) {
    const entry = String(raw).trim()
    if (entry === '' || seen.has(entry)) continue
    seen.add(entry)
    out.push(entry)
  }
  return out
}

/**
 * Resolve label names to UUIDs. UUID entries pass through unqueried.
 * Exact-case team match, then exact-case workspace match; refuses to
 * guess when more than one eligible node survives. Unresolvable/ambiguous
 * entries are skipped with a warning and reported back to the caller via
 * `omitted` rather than blocking issue creation.
 *
 * Deliberately exempt from the single-attempt rule above (see this
 * module's header) — it has exactly one consumer today
 * (`linear-api.mjs`'s `createIssue`), so there is no cross-caller retry
 * policy conflict to resolve. Retries internally via `retryQuery()`.
 *
 * `resolveTeamId` (SMI-5858) defaults to this module's own, uncached
 * `getTeamId` — but a caller that maintains its OWN cached team-lookup
 * wrapper (e.g. `linear-api.mjs`'s local `getTeamId`, which checks
 * `teamCache` first) should pass that wrapper through instead. Without
 * this, a caller that already resolved `teamId` moments earlier via its
 * own cached wrapper (as `createIssue()` does, to build the mutation
 * input) would silently pay for a SECOND, redundant team-lookup fetch
 * here — a real regression this extraction would otherwise introduce,
 * since pre-extraction both call sites shared one module-scope cache and
 * this function's internal lookup was a guaranteed cache hit.
 *
 * NOT wrapped in try/catch: an infrastructure failure must fail the
 * creation, never masquerade as "label absent".
 *
 * @param {Iterable<unknown>} labels
 * @param {string} [teamKey]
 * @param {(teamKey: string) => Promise<string>} [resolveTeamId]
 * @returns {Promise<{ labelIds: string[]; omitted: string[] }>}
 */
export async function resolveLabelIds(labels, teamKey = TEAM_KEY, resolveTeamId = getTeamId) {
  const entries = normalizeLabelEntries(labels)
  if (entries.length === 0) return { labelIds: [], omitted: [] }

  const teamId = await retryQuery(() => resolveTeamId(teamKey))
  const labelIds = []
  const omitted = []

  for (const entry of entries) {
    if (UUID_RE.test(entry)) {
      labelIds.push(entry)
      continue
    }

    const data = await retryQuery(() =>
      graphql(
        `
          query ($name: String!, $first: Int!) {
            issueLabels(filter: { name: { eq: $name } }, first: $first) {
              nodes {
                id
                name
                team {
                  id
                }
              }
            }
          }
        `,
        { name: entry, first: LABEL_PAGE_SIZE }
      )
    )
    const nodes = data.issueLabels.nodes

    // A full page means we cannot be confident we saw every candidate.
    if (nodes.length >= LABEL_PAGE_SIZE) {
      console.warn(
        `[linear-api] label "${entry}" matched ${nodes.length}+ labels — omitting it from this issue`
      )
      omitted.push(entry)
      continue
    }

    const teamMatches = nodes.filter((n) => n.team?.id === teamId)
    const workspaceMatches = nodes.filter((n) => !n.team)
    const eligible = teamMatches.length > 0 ? teamMatches : workspaceMatches

    if (eligible.length === 0) {
      // Zero nodes, or only other-team nodes — both are "not this team's label".
      console.warn(`[linear-api] label "${entry}" not found — omitting it from this issue`)
      omitted.push(entry)
      continue
    }
    if (eligible.length > 1) {
      console.warn(
        `[linear-api] label "${entry}" matched ${eligible.length} labels, none unambiguously — omitting it from this issue`
      )
      omitted.push(entry)
      continue
    }
    labelIds.push(eligible[0].id)
  }

  return { labelIds, omitted }
}

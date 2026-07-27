/**
 * SMI-5858 — type declarations for scripts/lib/linear-client.mjs.
 *
 * Lets scripts/e2e/create-linear-issues.linear-client.ts (a .ts file)
 * import the shared Linear GraphQL client cleanly under NodeNext module
 * resolution without @ts-expect-error suppression. The .d.mts extension is
 * the correct pairing for a .mjs module under NodeNext — mirrors
 * scripts/lib/project-dir.d.mts's role for project-dir.mjs.
 *
 * `graphql()`'s return type is `Promise<any>` deliberately, not a lint
 * oversight: it mirrors the pre-extraction local implementations (none of
 * which annotated a return type — `response.json()` itself resolves to
 * `any`, so every caller already read arbitrary GraphQL response shapes
 * off it via duck typing). Typing it narrower here would force every call
 * site to re-cast, for no safety gain.
 */

export interface GraphqlError extends Error {
  status?: number
  graphqlError?: boolean
  graphqlErrors?: unknown
}

export const API_URL: string
export const TEAM_KEY: string
export const RETRY_DELAYS_MS: number[]
export const UUID_RE: RegExp
export const LABEL_PAGE_SIZE: number

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see header
export function graphql(query: string, variables?: Record<string, unknown>): Promise<any>
export function isRetryable(err: unknown): boolean
export function withRetry<T>(
  fn: () => Promise<T>,
  delays?: number[],
  isRetryableFn?: (err: unknown) => boolean
): Promise<T>
export function retryQuery<T>(fn: () => Promise<T>, delays?: number[]): Promise<T>
export function getTeamId(teamKey?: string): Promise<string>
export function getIssueId(identifier: string): Promise<string | null>
export function normalizeLabelEntries(entries: Iterable<unknown>): string[]
export function resolveLabelIds(
  labels: Iterable<unknown>,
  teamKey?: string,
  resolveTeamId?: (teamKey: string) => Promise<string>
): Promise<{ labelIds: string[]; omitted: string[] }>

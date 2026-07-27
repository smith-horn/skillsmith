/**
 * Linear API client for scripts/e2e/create-linear-issues.ts (SMI-5855).
 *
 * Split out to keep create-linear-issues.ts under the repo's 500-line
 * file-length gate. Deliberately self-contained (Q4 in the plan doc
 * docs/internal/implementation/smi-5854-5855-linear-issue-label-parent-resolution.md)
 * rather than delegating to scripts/linear-api.mjs's createIssue() — this
 * mirrors scripts/linear-upsert-drift-issue.mjs's team/label resolution
 * pattern (getOrCreateAutoLabelId, retry-on-idempotent-reads) rather than
 * importing it, matching that script's own accepted duplication.
 */
import type {
  CreateIssueOutcome,
  GqlLabelNode,
  LinearIssueInput,
} from './create-linear-issues.types.js'

export const LINEAR_API_URL = 'https://api.linear.app/graphql'
export const TEAM_KEY = 'SMI'
export const RETRY_DELAYS_MS = [1000, 2000, 4000]

// `Bug` is workspace-level (team: null) and already exists — resolve-only,
// NEVER get-or-create it (issueLabelCreate({ teamId, ... }) would mint a
// team-scoped near-duplicate that permanently splits the taxonomy).
export const BUG_LABEL_NAME = 'Bug'
// The `BOT_LABELS` anchor in scripts/lint-linear-issues.mjs. Provisioned
// deliberately during implementation; get-or-create kept as a self-healing
// backstop in case it's ever deleted.
export const AUTO_LABEL_NAME = 'e2e-failure-auto'
export const AUTO_LABEL_COLOR = '#eb5757'

/**
 * Execute a GraphQL query/mutation against the Linear API. Throws on
 * transport failure, a non-2xx HTTP response, or a GraphQL `errors` array —
 * callers must NOT wrap this in a catch-all that degrades an infrastructure
 * failure into "not found" (mirrors the SMI-5854 design constraint).
 */
export async function graphql(query: string, variables: Record<string, unknown> = {}) {
  const apiKey = process.env.LINEAR_API_KEY
  if (!apiKey) {
    throw new Error('LINEAR_API_KEY environment variable is not set')
  }

  const response = await fetch(LINEAR_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: apiKey,
    },
    body: JSON.stringify({ query, variables }),
  })

  if (!response.ok) {
    const text = await response.text()
    const err = new Error(`Linear API error: ${response.status} ${text}`) as Error & {
      status?: number
    }
    err.status = response.status
    throw err
  }

  const json = await response.json()

  if (json.errors) {
    const err = new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`) as Error & {
      graphqlError?: boolean
    }
    err.graphqlError = true
    throw err
  }

  return json.data
}

function isRetryable(err: unknown): boolean {
  const e = err as { graphqlError?: boolean; status?: number } | undefined
  if (e?.graphqlError) return false // deterministic, application-level — retrying re-fails
  if (e?.status === undefined) return true // transport/network throw from fetch itself
  return e.status === 429 || (e.status >= 500 && e.status < 600)
}

/**
 * Retry an idempotent READ query with exponential backoff. Never used for
 * `issueCreate`/`issueLabelCreate` mutations — a retried mutation after
 * Linear already committed the write would risk a duplicate.
 */
export async function retryQuery<T>(
  fn: () => Promise<T>,
  delays: number[] = RETRY_DELAYS_MS
): Promise<T> {
  let lastErr: unknown
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      return await fn()
    } catch (e) {
      lastErr = e
      if (!isRetryable(e) || attempt === delays.length) throw e
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]))
    }
  }
  throw lastErr
}

/** Resolve the SMI team's UUID (retried read). */
export async function getTeamId(): Promise<string> {
  const data = await retryQuery(() =>
    graphql(
      `
        query ($key: String!) {
          teams(filter: { key: { eq: $key } }) {
            nodes {
              id
            }
          }
        }
      `,
      {
        key: TEAM_KEY,
      }
    )
  )
  const team = data.teams.nodes[0]
  if (!team) throw new Error(`Team "${TEAM_KEY}" not found`)
  return team.id
}

/**
 * Resolve a label name to its UUID: exact-case team-SMI match preferred,
 * else exact-case workspace (`team: null`) match. Returns `null` when
 * neither exists — never mutates. Not wrapped in try/catch by its caller:
 * an infrastructure failure must propagate, not masquerade as "not found".
 */
export async function resolveLabelId(teamId: string, name: string): Promise<string | null> {
  const data = await retryQuery(() =>
    graphql(
      `
        query ($name: String!) {
          issueLabels(filter: { name: { eq: $name } }) {
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
      { name }
    )
  )
  const nodes: GqlLabelNode[] = data.issueLabels.nodes
  const teamMatch = nodes.find((n) => n.team?.id === teamId)
  if (teamMatch) return teamMatch.id
  const workspaceMatch = nodes.find((n) => !n.team)
  if (workspaceMatch) return workspaceMatch.id
  return null
}

/**
 * Resolve the `e2e-failure-auto` label, creating it (team-scoped) if it does
 * not exist yet. The ONLY label this script ever creates — mirrors
 * `scripts/linear-upsert-drift-issue.mjs`'s `getOrCreateAutoLabelId()`. The
 * create mutation is never retried.
 */
export async function getOrCreateAutoLabelId(teamId: string): Promise<string> {
  const existing = await resolveLabelId(teamId, AUTO_LABEL_NAME)
  if (existing) return existing

  const created = await graphql(
    `
      mutation ($input: IssueLabelCreateInput!) {
        issueLabelCreate(input: $input) {
          success
          issueLabel {
            id
          }
        }
      }
    `,
    { input: { teamId, name: AUTO_LABEL_NAME, color: AUTO_LABEL_COLOR } }
  )
  if (!created.issueLabelCreate.success) {
    throw new Error(`Failed to create label "${AUTO_LABEL_NAME}"`)
  }
  return created.issueLabelCreate.issueLabel.id
}

/**
 * Titles of currently-open issues carrying the `e2e-failure-auto` label —
 * used to dedup against issues filed by earlier runs. Mirrors
 * `.github/workflows/coverage-report.yml`'s existing dedup-by-stable-title
 * precedent (`list-issues` + title match before filing).
 */
export async function fetchOpenE2eIssueTitles(teamId: string): Promise<Set<string>> {
  const titles = new Set<string>()
  let after: string | null = null

  // Paginated (not just a large first:) so dedup can't silently miss a
  // later page once open e2e-failure-auto issues exceed one page — a
  // missed page here means a duplicate issue gets created, not just a
  // missed read.
  for (;;) {
    const data: {
      issues: {
        nodes: Array<{ title: string }>
        pageInfo: { hasNextPage: boolean; endCursor: string | null }
      }
    } = await retryQuery(() =>
      graphql(
        `
          query ($teamId: ID!, $labelName: String!, $after: String) {
            issues(
              filter: {
                team: { id: { eq: $teamId } }
                labels: { name: { eq: $labelName } }
                state: { type: { in: ["backlog", "unstarted", "started"] } }
              }
              first: 250
              after: $after
            ) {
              nodes {
                title
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
        `,
        { teamId, labelName: AUTO_LABEL_NAME, after }
      )
    )
    for (const node of data.issues.nodes) titles.add(node.title)
    if (!data.issues.pageInfo.hasNextPage) break
    after = data.issues.pageInfo.endCursor
  }

  return titles
}

/**
 * Create a Linear issue via GraphQL API. Returns a discriminated outcome
 * (never `string | null`) so every failure branch — transport error, a
 * non-2xx response, a GraphQL `errors` array, or `issueCreate.success ===
 * false` — is reported to the caller instead of silently swallowed. Not
 * retried: `issueCreate` may already have committed on a transient failure.
 */
export async function createLinearIssue(
  input: LinearIssueInput,
  teamId: string,
  labelIds: string[]
): Promise<CreateIssueOutcome> {
  const mutation = `
    mutation CreateIssue($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        success
        issue {
          id
          identifier
          url
        }
      }
    }
  `

  const variables = {
    input: {
      teamId,
      title: input.title,
      description: input.description,
      priority: input.priority,
      ...(labelIds.length > 0 ? { labelIds } : {}),
    },
  }

  let response: Response
  try {
    response = await fetch(LINEAR_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: process.env.LINEAR_API_KEY ?? '',
      },
      body: JSON.stringify({ query: mutation, variables }),
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    console.error(`Error creating Linear issue: ${reason}`)
    return { status: 'failed', reason }
  }

  if (!response.ok) {
    const reason = `Linear API error: ${response.status}`
    console.error(reason)
    return { status: 'failed', reason }
  }

  let result: {
    data?: {
      issueCreate?: { success?: boolean; issue?: { identifier?: string; url?: string } | null }
    }
    errors?: unknown
  }
  try {
    result = await response.json()
  } catch (error) {
    const reason = `Invalid JSON response: ${error instanceof Error ? error.message : String(error)}`
    console.error(reason)
    return { status: 'failed', reason }
  }

  if (result.errors) {
    const reason = `GraphQL errors: ${JSON.stringify(result.errors)}`
    console.error('Failed to create issue:', result.errors)
    return { status: 'failed', reason }
  }

  if (!result.data?.issueCreate?.success) {
    const reason = 'issueCreate returned success=false'
    console.error(reason)
    return { status: 'failed', reason }
  }

  const issue = result.data.issueCreate.issue
  if (!issue?.identifier) {
    const reason = 'issueCreate returned success=true but no issue'
    console.error(reason)
    return { status: 'failed', reason }
  }

  console.log(`Created issue: ${issue.identifier} - ${issue.url}`)
  return { status: 'created', identifier: issue.identifier }
}

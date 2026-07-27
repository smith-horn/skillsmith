/**
 * Linear API client for scripts/e2e/create-linear-issues.ts (SMI-5855).
 *
 * Split out to keep create-linear-issues.ts under the repo's 500-line
 * file-length gate. SMI-5858 extracted this file's transport/retry
 * primitives (`graphql`/`isRetryable`/`retryQuery`) plus `getTeamId`'s
 * underlying lookup into the shared `scripts/lib/linear-client.mjs` — four
 * different Linear scripts had each independently hand-rolled a
 * near-verbatim copy of that code, this one included. Label/issue
 * resolution below (`resolveLabelId`, `getOrCreateAutoLabelId`,
 * `fetchOpenE2eIssueTitles`, `createLinearIssue`) remains local and
 * deliberately self-contained (Q4 in the plan doc
 * docs/internal/implementation/smi-5854-5855-linear-issue-label-parent-resolution.md)
 * rather than delegating to scripts/linear-api.mjs's createIssue() — this
 * mirrors scripts/linear-upsert-drift-issue.mjs's team/label resolution
 * pattern rather than importing it, matching that script's own accepted
 * duplication.
 */
import type {
  CreateIssueOutcome,
  GqlLabelNode,
  LinearIssueInput,
} from './create-linear-issues.types.js'
import {
  API_URL,
  getTeamId as sharedGetTeamId,
  graphql,
  retryQuery,
} from '../lib/linear-client.mjs'

export const TEAM_KEY = 'SMI'

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
 * Resolve the SMI team's UUID (retried read). Thin wrapper around the
 * shared, single-attempt scripts/lib/linear-client.mjs#getTeamId
 * (SMI-5858) — this function retried INSIDE itself pre-extraction, so the
 * retry moves to this one line above the shared (single-attempt) call,
 * preserving identical behavior: same 4 attempts, same delays, same
 * classification, same not-found error, same zero-argument exported
 * signature create-linear-issues.ts already calls it with.
 */
export async function getTeamId(): Promise<string> {
  return retryQuery(() => sharedGetTeamId(TEAM_KEY))
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
    response = await fetch(API_URL, {
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

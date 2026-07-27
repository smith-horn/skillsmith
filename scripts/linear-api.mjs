#!/usr/bin/env node
/**
 * SMI-686: Linear API Wrapper Script
 *
 * Provides reliable Linear API operations with proper JSON escaping
 * and error handling. Replaces fragile curl-based scripts.
 *
 * `create-issue` validates its description against the shared
 * Acceptance-Criteria contract (`scripts/lib/linear-issue-validation.mjs`,
 * SMI-5841/5846) before calling the mutation (SMI-5853). Ships
 * shadow-first, matching that same convention: a non-compliant
 * description warns and still creates the issue by default; set
 * SKILLSMITH_LINEAR_API_ISSUE_VALIDATION_SHADOW=0 to block instead.
 * --force (or SKILLSMITH_LINEAR_API_ISSUE_VALIDATION_DISABLE=1) always
 * bypasses regardless of shadow state. See `help()` below for the full
 * flag/env-var reference.
 *
 * `create-issue` also resolves `--parent`/`--labels` to real UUIDs
 * (SMI-5854) instead of passing raw CLI values through to the mutation.
 * `--parent` accepts an issue identifier (e.g. SMI-123) or an ID; an
 * unresolvable parent throws (no silent orphan). `--labels` accepts
 * comma-separated label names (matched exact-case) or IDs; an
 * unresolvable/ambiguous label name is dropped with a warning and the
 * issue is still created with whatever labels did resolve. Idempotent
 * read queries (team/label/parent lookups) retry on transport failure or
 * HTTP 429/5xx; the `issueCreate` mutation itself is never retried. Use
 * `--dry-run` to resolve everything and print the mutation input without
 * creating the issue.
 *
 * Usage:
 *   node scripts/linear-api.mjs create-issue --title "Title" --description "Desc"
 *   node scripts/linear-api.mjs update-status --issue SMI-123 --status done
 *   node scripts/linear-api.mjs add-comment --issue SMI-123 --body "Comment"
 *   node scripts/linear-api.mjs add-project-update --project PROJECT_ID --body "Update"
 *
 * Environment:
 *   LINEAR_API_KEY - Required API key for authentication
 *   SKILLSMITH_LINEAR_API_ISSUE_VALIDATION_DISABLE - '1' to bypass
 *     create-issue description validation entirely, regardless of shadow
 *     state (SMI-5853)
 *   SKILLSMITH_LINEAR_API_ISSUE_VALIDATION_SHADOW - default on (warn-only,
 *     issue still created); set to '0' to make a non-compliant
 *     create-issue description block instead of warn (SMI-5853)
 */
import { validateIssueDescription } from './lib/linear-issue-validation.mjs'

const TEAM_KEY = 'SMI'
const API_URL = 'https://api.linear.app/graphql'

const VALIDATION_DISABLE_ENV_VAR = 'SKILLSMITH_LINEAR_API_ISSUE_VALIDATION_DISABLE'
const VALIDATION_SHADOW_ENV_VAR = 'SKILLSMITH_LINEAR_API_ISSUE_VALIDATION_SHADOW'
// Aligned to SMI-5846's LINEAR_ISSUE_GUARD_SHADOW_END_DATE so all three
// Linear-issue-creation enforcement layers (SMI-5841 CI lint, SMI-5846
// MCP hook, this create-issue gate) flip to blocking together in one
// dated follow-up review, not three staggered ones.
export const VALIDATION_SHADOW_END_DATE = '2026-08-09'

// SMI-5854: retry policy for idempotent READ queries only (team/label/
// parent lookups). Never used for the issueCreate mutation.
const RETRY_DELAYS_MS = [1000, 2000, 4000]
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// Exact-name filter returns <= 1 label per team; a full page means the
// name is ambiguous, not that pagination is needed.
const LABEL_PAGE_SIZE = 50

// SMI-5859: page size for getLabels()' full-listing query. Named for its one
// call site rather than `LABELS_*` so it cannot be confused — by a reader or
// by autocomplete — with LABEL_PAGE_SIZE above, whose 50 is an
// ambiguity-detection threshold for the exact-name filter, not a paging size.
// 250 is Linear's max `first`.
const GET_LABELS_PAGE_SIZE = 250

// State IDs for common workflow states (cached on first query)
let stateCache = null
let teamCache = null

/**
 * Execute a GraphQL query against Linear API
 */
async function graphql(query, variables = {}) {
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
    throw err
  }

  return json.data
}

/**
 * Whether a graphql() error is safe to retry. Deterministic
 * application-level errors (json.errors) are never retryable; transport
 * errors (no status) and HTTP 429/5xx are.
 */
function isRetryable(err) {
  if (err?.graphqlError) return false
  if (err?.status === undefined) return true
  return err.status === 429 || (err.status >= 500 && err.status < 600)
}

/** Retry an idempotent READ query. Never used for mutations. */
async function retryQuery(fn, delays = RETRY_DELAYS_MS) {
  let lastErr
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

/**
 * Get team ID by key
 */
async function getTeamId(teamKey = TEAM_KEY) {
  if (teamCache?.key === teamKey) {
    return teamCache.id
  }

  const data = await graphql(
    `
      query GetTeam($key: String!) {
        teams(filter: { key: { eq: $key } }) {
          nodes {
            id
            key
            name
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

  teamCache = { key: teamKey, id: team.id, name: team.name }
  return team.id
}

/**
 * Get workflow states for team
 */
async function getStates(teamKey = TEAM_KEY) {
  if (stateCache?.teamKey === teamKey) {
    return stateCache.states
  }

  const teamId = await getTeamId(teamKey)

  const data = await graphql(
    `
      query GetStates($teamId: ID!) {
        workflowStates(filter: { team: { id: { eq: $teamId } } }) {
          nodes {
            id
            name
            type
          }
        }
      }
    `,
    { teamId }
  )

  const states = {}
  for (const state of data.workflowStates.nodes) {
    states[state.name.toLowerCase()] = state
    states[state.type.toLowerCase()] = state
  }

  stateCache = { teamKey, states }
  return states
}

/**
 * Resolve an issue identifier (e.g. SMI-123) to its UUID. UUID input
 * passes through unqueried. Returns null ONLY when the API successfully
 * answered and no such issue exists — transport/5xx/429 failures
 * propagate instead of masquerading as "not found".
 */
async function getIssueId(identifier) {
  if (UUID_RE.test(identifier)) return identifier

  const data = await retryQuery(() =>
    graphql(
      `
        query ($id: String!) {
          issue(id: $id) {
            id
          }
        }
      `,
      { id: identifier }
    )
  )

  return data.issue ? data.issue.id : null
}

/** Trim, drop blanks, dedupe preserving first-seen order. */
function normalizeLabelEntries(entries) {
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
 * NOT wrapped in try/catch: an infrastructure failure must fail the
 * creation, never masquerade as "label absent".
 */
async function resolveLabelIds(labels, teamKey = TEAM_KEY) {
  const entries = normalizeLabelEntries(labels)
  if (entries.length === 0) return { labelIds: [], omitted: [] }

  const teamId = await retryQuery(() => getTeamId(teamKey))
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
      console.warn(`[linear-api] label "${entry}" matched ${nodes.length}+ labels — omitting it from this issue`)
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

/**
 * Create a new issue
 */
async function createIssue(options) {
  const {
    title,
    description = '',
    priority = 2,
    labels = [],
    parentId = null,
    teamKey = TEAM_KEY,
    force = false,
    dryRun = false,
  } = options

  const descriptionText = typeof description === 'string' ? description : ''
  const validationErrors = validateIssueDescription(descriptionText)
  if (validationErrors.length > 0) {
    const bypassed =
      force === true ||
      force === 'true' ||
      force === '1' ||
      process.env[VALIDATION_DISABLE_ENV_VAR] === '1'
    const inShadow = process.env[VALIDATION_SHADOW_ENV_VAR] !== '0'
    const reason =
      validationErrors.join('; ') +
      ' — see .claude/templates/linear-issue-template.md for the required format.'

    if (!bypassed && !inShadow) {
      throw new Error(
        `[linear-api] description failed Acceptance-Criteria validation: ${reason} ` +
          `Pass --force to create anyway, or set ${VALIDATION_DISABLE_ENV_VAR}=1.`
      )
    }
    if (bypassed) {
      console.warn(
        `[linear-api] description failed Acceptance-Criteria validation (bypassed): ${reason}`
      )
    } else {
      console.warn(
        `[linear-api] description failed Acceptance-Criteria validation (shadow mode, proceeding): ${reason}`
      )
    }
  }

  const teamId = await retryQuery(() => getTeamId(teamKey))

  let resolvedParentId = null
  if (parentId) {
    resolvedParentId = await getIssueId(parentId)
    if (!resolvedParentId) {
      // No opt-out here: a silent orphan defeats the whole point of --parent.
      throw new Error(`[linear-api] parent issue "${parentId}" not found — refusing to create an orphaned issue.`)
    }
  }

  const { labelIds, omitted } = await resolveLabelIds(labels, teamKey)

  const input = {
    teamId,
    title,
    description,
    priority,
  }

  if (resolvedParentId) {
    input.parentId = resolvedParentId
  }

  if (labelIds.length > 0) {
    input.labelIds = labelIds
  }

  if (dryRun) {
    console.log(JSON.stringify({ input }, null, 2))
    return { dryRun: true, input }
  }

  const data = await graphql(
    `
      mutation CreateIssue($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          success
          issue {
            id
            identifier
            title
            url
          }
        }
      }
    `,
    { input }
  )

  if (!data.issueCreate.success) {
    throw new Error('Failed to create issue')
  }

  if (omitted.length > 0) {
    console.warn(
      `[linear-api] created ${data.issueCreate.issue.identifier} without requested label(s): ${omitted.join(', ')}`
    )
  }

  return data.issueCreate.issue
}

/**
 * Update issue status
 */
async function updateIssueStatus(issueIdentifier, statusName) {
  // Get issue ID from identifier
  const issueData = await graphql(
    `
      query GetIssue($identifier: String!) {
        issue(id: $identifier) {
          id
          identifier
          team {
            key
          }
        }
      }
    `,
    { identifier: issueIdentifier }
  )

  if (!issueData.issue) {
    throw new Error(`Issue "${issueIdentifier}" not found`)
  }

  const states = await getStates(issueData.issue.team.key)
  const state = states[statusName.toLowerCase()]

  if (!state) {
    const available = Object.keys(states)
      .filter((k) => !k.includes('_'))
      .join(', ')
    throw new Error(`State "${statusName}" not found. Available: ${available}`)
  }

  const data = await graphql(
    `
      mutation UpdateIssue($id: String!, $stateId: String!) {
        issueUpdate(id: $id, input: { stateId: $stateId }) {
          success
          issue {
            id
            identifier
            state {
              name
            }
          }
        }
      }
    `,
    { id: issueData.issue.id, stateId: state.id }
  )

  if (!data.issueUpdate.success) {
    throw new Error('Failed to update issue status')
  }

  return data.issueUpdate.issue
}

/**
 * Add comment to issue
 */
async function addComment(issueIdentifier, body) {
  // Get issue ID from identifier
  const issueData = await graphql(
    `
      query GetIssue($identifier: String!) {
        issue(id: $identifier) {
          id
          identifier
        }
      }
    `,
    { identifier: issueIdentifier }
  )

  if (!issueData.issue) {
    throw new Error(`Issue "${issueIdentifier}" not found`)
  }

  const data = await graphql(
    `
      mutation CreateComment($issueId: String!, $body: String!) {
        commentCreate(input: { issueId: $issueId, body: $body }) {
          success
          comment {
            id
            body
          }
        }
      }
    `,
    { issueId: issueData.issue.id, body }
  )

  if (!data.commentCreate.success) {
    throw new Error('Failed to create comment')
  }

  return data.commentCreate.comment
}

/**
 * Add project update
 */
async function addProjectUpdate(projectId, body) {
  const data = await graphql(
    `
      mutation CreateProjectUpdate($projectId: String!, $body: String!) {
        projectUpdateCreate(input: { projectId: $projectId, body: $body }) {
          success
          projectUpdate {
            id
            body
          }
        }
      }
    `,
    { projectId, body }
  )

  if (!data.projectUpdateCreate.success) {
    throw new Error('Failed to create project update')
  }

  return data.projectUpdateCreate.projectUpdate
}

/**
 * List issues with optional filters
 */
async function listIssues(options = {}) {
  const { teamKey = TEAM_KEY, status, limit = 50 } = options

  const teamId = await getTeamId(teamKey)

  let filter = `team: { id: { eq: "${teamId}" } }`
  if (status) {
    const states = await getStates(teamKey)
    const state = states[status.toLowerCase()]
    if (state) {
      filter += `, state: { id: { eq: "${state.id}" } }`
    }
  }

  const data = await graphql(
    `
    query ListIssues($first: Int!) {
      issues(filter: { ${filter} }, first: $first, orderBy: updatedAt) {
        nodes {
          id
          identifier
          title
          state { name }
          priority
          updatedAt
        }
      }
    }
  `,
    { first: limit }
  )

  return data.issues.nodes
}

/**
 * Get available labels. Paginated (first/after + pageInfo, SMI-5859):
 * the workspace has more labels than Linear's default page size (50),
 * which this query previously relied on silently. Mirrors
 * fetchOpenE2eIssueTitles() in scripts/e2e/create-linear-issues.linear-client.ts
 * until SMI-5858 extracts the shared client.
 *
 * Throws rather than returning a partial list when the API reports another
 * page but gives no usable way to reach it — see the invariant below.
 */
async function getLabels(teamKey = TEAM_KEY) {
  const teamId = await retryQuery(() => getTeamId(teamKey))
  const labels = []
  let after = null

  for (;;) {
    const data = await retryQuery(() =>
      graphql(
        `
          query GetLabels($teamId: ID!, $first: Int!, $after: String) {
            issueLabels(
              filter: { team: { id: { eq: $teamId } } }
              first: $first
              after: $after
            ) {
              nodes {
                id
                name
                color
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
        `,
        { teamId, first: GET_LABELS_PAGE_SIZE, after }
      )
    )
    labels.push(...data.issueLabels.nodes)

    const { hasNextPage, endCursor } = data.issueLabels.pageInfo
    if (!hasNextPage) break

    // Cursor-progress invariant (SMI-5859). A page claiming hasNextPage but
    // carrying no cursor, or repeating the cursor we just sent, cannot be
    // advanced past. Throw instead of breaking: returning what we have would
    // be a silent partial result indistinguishable from success — the exact
    // failure class this function is being fixed to eliminate.
    //
    // Deliberately OUTSIDE the retryQuery() callback above. isRetryable()
    // treats a status-less Error as retryable, so throwing from inside would
    // spend 1s+2s+4s re-issuing the same request against a deterministic fault.
    if (!endCursor || endCursor === after) {
      throw new Error(
        `Linear issueLabels pagination did not advance ` +
          `(hasNextPage: true, endCursor: ${JSON.stringify(endCursor)}, ` +
          `after: ${JSON.stringify(after)}); refusing to return ` +
          `${labels.length} possibly-partial labels`
      )
    }

    after = endCursor
  }

  return labels
}

// CLI Argument Parsing
function parseArgs(args) {
  const result = { _: [] }
  let currentKey = null

  for (const arg of args) {
    if (arg.startsWith('--')) {
      currentKey = arg.slice(2)
      result[currentKey] = true
    } else if (currentKey) {
      result[currentKey] = arg
      currentKey = null
    } else {
      result._.push(arg)
    }
  }

  return result
}

// CLI Commands
const commands = {
  async 'create-issue'(args) {
    const { title, description, priority, labels, parent, force } = args
    const dryRun = args['dry-run'] === true

    if (!title) {
      console.error('Error: --title is required')
      process.exit(1)
    }

    const issue = await createIssue({
      title,
      description: description || '',
      priority: priority ? parseInt(priority, 10) : 2,
      labels: labels ? labels.split(',') : [],
      parentId: parent || null,
      force,
      dryRun,
    })

    if (dryRun) {
      return issue
    }

    console.log(`Created: ${issue.identifier} - ${issue.title}`)
    console.log(`URL: ${issue.url}`)
    return issue
  },

  async 'update-status'(args) {
    const issue = args.issue || args._[1]
    const { status } = args

    if (!issue || !status) {
      console.error('Error: issue (positional or --issue) and --status are required')
      console.error('Example: linear-api.mjs update-status SMI-123 --status done')
      process.exit(1)
    }

    const updated = await updateIssueStatus(issue, status)
    console.log(`Updated: ${updated.identifier} -> ${updated.state.name}`)
    return updated
  },

  async 'add-comment'(args) {
    const issue = args.issue || args._[1]
    const body = args.body || args._[2]

    if (!issue || !body) {
      console.error('Error: issue (positional or --issue) and body (positional or --body) are required')
      console.error('Example: linear-api.mjs add-comment SMI-123 "Progress update"')
      process.exit(1)
    }

    const comment = await addComment(issue, body)
    console.log(`Comment added to ${issue}`)
    return comment
  },

  async 'add-project-update'(args) {
    const { project, body } = args

    if (!project || !body) {
      console.error('Error: --project and --body are required')
      process.exit(1)
    }

    const update = await addProjectUpdate(project, body)
    console.log('Project update added')
    return update
  },

  async 'list-issues'(args) {
    const { status, limit } = args

    const issues = await listIssues({
      status,
      limit: limit ? parseInt(limit, 10) : 50,
    })

    for (const issue of issues) {
      console.log(`${issue.identifier}\t${issue.state.name}\t${issue.title}`)
    }
    return issues
  },

  async 'list-labels'(_args) {
    const labels = await getLabels()

    for (const label of labels) {
      console.log(`${label.id}\t${label.name}\t${label.color}`)
    }
    return labels
  },

  async help() {
    console.log(`
Linear API Wrapper - SMI-686

Usage:
  node scripts/linear-api.mjs <command> [options]

Commands:
  create-issue      Create a new issue
    --title         Issue title (required)
    --description   Issue description (validated against the shared
                    Acceptance-Criteria contract before the mutation,
                    SMI-5853 - see Environment below)
    --priority      Priority (1=urgent, 2=high, 3=medium, 4=low)
    --labels        Comma-separated label names (exact case) or IDs
    --parent        Parent issue identifier (e.g. SMI-123) or ID
    --force         Bypass Acceptance-Criteria description validation,
                    regardless of shadow state (SMI-5853)
    --dry-run       Resolve everything and print the mutation input
                    without creating the issue

  update-status     Update issue status
    --issue         Issue identifier (e.g., SMI-123) (required)
    --status        New status name (e.g., done, in_progress) (required)

  add-comment       Add comment to issue
    --issue         Issue identifier (required)
    --body          Comment body (required)

  add-project-update  Add project update
    --project       Project ID (required)
    --body          Update body (required)

  list-issues       List issues
    --status        Filter by status
    --limit         Max results (default: 50)

  list-labels       List available labels

Environment:
  LINEAR_API_KEY    API key for authentication (required)
  SKILLSMITH_LINEAR_API_ISSUE_VALIDATION_DISABLE
                    '1' to bypass create-issue description validation
                    entirely, regardless of shadow state (SMI-5853)
  SKILLSMITH_LINEAR_API_ISSUE_VALIDATION_SHADOW
                    Default on (warn-only, issue still created). Set to
                    '0' to make a non-compliant create-issue description
                    block instead of warn (SMI-5853)

Examples:
  node scripts/linear-api.mjs create-issue --title "New feature" --priority 2
  node scripts/linear-api.mjs update-status --issue SMI-123 --status done
  node scripts/linear-api.mjs list-issues --status "In Progress"
`)
  },
}

// Main execution
async function main() {
  const args = parseArgs(process.argv.slice(2))
  const command = args._[0] || 'help'

  if (!commands[command]) {
    console.error(`Unknown command: ${command}`)
    console.error('Run with "help" for usage information')
    process.exit(1)
  }

  try {
    await commands[command](args)
  } catch (error) {
    console.error(`Error: ${error.message}`)
    process.exit(1)
  }
}

// Only run main() when executed directly, not when imported
import { fileURLToPath } from 'node:url'
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
}

// Export for use as module
export {
  createIssue,
  updateIssueStatus,
  addComment,
  addProjectUpdate,
  listIssues,
  getLabels,
  getTeamId,
  getStates,
  graphql,
  getIssueId,
  resolveLabelIds,
  normalizeLabelEntries,
  commands,
}

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
import {
  TEAM_KEY,
  graphql,
  retryQuery,
  getTeamId as sharedGetTeamId,
  getIssueId as sharedGetIssueId,
  normalizeLabelEntries,
  resolveLabelIds,
} from './lib/linear-client.mjs'

const VALIDATION_DISABLE_ENV_VAR = 'SKILLSMITH_LINEAR_API_ISSUE_VALIDATION_DISABLE'
const VALIDATION_SHADOW_ENV_VAR = 'SKILLSMITH_LINEAR_API_ISSUE_VALIDATION_SHADOW'
// Aligned to SMI-5846's LINEAR_ISSUE_GUARD_SHADOW_END_DATE so all three
// Linear-issue-creation enforcement layers (SMI-5841 CI lint, SMI-5846
// MCP hook, this create-issue gate) flip to blocking together in one
// dated follow-up review, not three staggered ones.
export const VALIDATION_SHADOW_END_DATE = '2026-08-09'

// SMI-5859: page size for getLabels()' full-listing query. Named for its one
// call site rather than `LABELS_*` so it cannot be confused — by a reader or
// by autocomplete — with LABEL_PAGE_SIZE (scripts/lib/linear-client.mjs),
// whose 50 is an ambiguity-detection threshold for the exact-name filter,
// not a paging size. 250 is Linear's max `first`.
const GET_LABELS_PAGE_SIZE = 250

// State IDs for common workflow states (cached on first query)
let stateCache = null
let teamCache = null

/**
 * Get team ID by key. Local cache wrapper around the shared, single-attempt
 * scripts/lib/linear-client.mjs#getTeamId (SMI-5858) — this function itself
 * has no retry logic (matches pre-extraction behavior: it never had any);
 * callers that want retry apply `retryQuery(() => getTeamId(teamKey))`
 * explicitly at their own call site, same as before extraction.
 */
async function getTeamId(teamKey = TEAM_KEY) {
  if (teamCache?.key === teamKey) {
    return teamCache.id
  }

  const id = await sharedGetTeamId(teamKey)
  teamCache = { key: teamKey, id }
  return id
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
 * Resolve an issue identifier (e.g. SMI-123) to its UUID. Thin retry
 * wrapper around the shared, single-attempt
 * scripts/lib/linear-client.mjs#getIssueId (SMI-5858) — this file's
 * `getIssueId` retried internally pre-extraction, so this wrapper
 * preserves that exported 4-attempt classified-retry behavior (skipping
 * it would silently regress the `--parent` resolution path to zero
 * retries).
 */
const getIssueId = (identifier) => retryQuery(() => sharedGetIssueId(identifier))

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

  // Passes this file's own CACHED getTeamId wrapper (SMI-5858) — teamId was
  // just resolved above via the same wrapper, so resolveLabelIds's internal
  // lookup hits that cache instead of firing a second, redundant fetch.
  const { labelIds, omitted } = await resolveLabelIds(labels, teamKey, getTeamId)

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
 * fetchOpenE2eIssueTitles() in scripts/e2e/create-linear-issues.linear-client.ts.
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

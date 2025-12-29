#!/usr/bin/env node
/**
 * SMI-686: Linear API Wrapper Script
 *
 * Provides reliable Linear API operations with proper JSON escaping
 * and error handling. Replaces fragile curl-based scripts.
 *
 * Usage:
 *   node scripts/linear-api.mjs create-issue --title "Title" --description "Desc"
 *   node scripts/linear-api.mjs update-status --issue SMI-123 --status done
 *   node scripts/linear-api.mjs add-comment --issue SMI-123 --body "Comment"
 *   node scripts/linear-api.mjs add-project-update --project PROJECT_ID --body "Update"
 *
 * Environment:
 *   LINEAR_API_KEY - Required API key for authentication
 */

const TEAM_KEY = 'SMI'
const API_URL = 'https://api.linear.app/graphql'

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
    throw new Error(`Linear API error: ${response.status} ${text}`)
  }

  const json = await response.json()

  if (json.errors) {
    throw new Error(`GraphQL errors: ${JSON.stringify(json.errors, null, 2)}`)
  }

  return json.data
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
  } = options

  const teamId = await getTeamId(teamKey)

  const input = {
    teamId,
    title,
    description,
    priority,
  }

  if (parentId) {
    input.parentId = parentId
  }

  if (labels.length > 0) {
    input.labelIds = labels
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
 * Get available labels
 */
async function getLabels(teamKey = TEAM_KEY) {
  const teamId = await getTeamId(teamKey)

  const data = await graphql(
    `
      query GetLabels($teamId: ID!) {
        issueLabels(filter: { team: { id: { eq: $teamId } } }) {
          nodes {
            id
            name
            color
          }
        }
      }
    `,
    { teamId }
  )

  return data.issueLabels.nodes
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
    const { title, description, priority, labels, parent } = args

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
    })

    console.log(`Created: ${issue.identifier} - ${issue.title}`)
    console.log(`URL: ${issue.url}`)
    return issue
  },

  async 'update-status'(args) {
    const { issue, status } = args

    if (!issue || !status) {
      console.error('Error: --issue and --status are required')
      process.exit(1)
    }

    const updated = await updateIssueStatus(issue, status)
    console.log(`Updated: ${updated.identifier} -> ${updated.state.name}`)
    return updated
  },

  async 'add-comment'(args) {
    const { issue, body } = args

    if (!issue || !body) {
      console.error('Error: --issue and --body are required')
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
    --description   Issue description
    --priority      Priority (1=urgent, 2=high, 3=medium, 4=low)
    --labels        Comma-separated label IDs
    --parent        Parent issue ID

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
}

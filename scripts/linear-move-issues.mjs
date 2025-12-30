#!/usr/bin/env node
/**
 * Move issues between Linear projects
 */

import { graphql } from './linear-api.mjs'

async function moveIssueToProject(issueIdentifier, projectId) {
  // Get issue ID from identifier
  const issueData = await graphql(`
    query GetIssue($identifier: String!) {
      issue(id: $identifier) {
        id
        identifier
        title
        project { id name }
      }
    }
  `, { identifier: issueIdentifier })

  if (!issueData.issue) {
    throw new Error(`Issue "${issueIdentifier}" not found`)
  }

  const issue = issueData.issue
  console.log(`Found: ${issue.identifier} - ${issue.title}`)
  console.log(`  Current project: ${issue.project?.name || 'None'}`)

  // Move to new project
  const updateData = await graphql(`
    mutation UpdateIssueProject($id: String!, $projectId: String!) {
      issueUpdate(id: $id, input: { projectId: $projectId }) {
        success
        issue {
          id
          identifier
          project { id name }
        }
      }
    }
  `, { id: issue.id, projectId })

  if (!updateData.issueUpdate.success) {
    throw new Error('Failed to move issue')
  }

  console.log(`  → Moved to: ${updateData.issueUpdate.issue.project?.name || 'None'}`)
  return updateData.issueUpdate.issue
}

async function removeIssueFromProject(issueIdentifier) {
  const issueData = await graphql(`
    query GetIssue($identifier: String!) {
      issue(id: $identifier) {
        id
        identifier
        title
        project { id name }
      }
    }
  `, { identifier: issueIdentifier })

  if (!issueData.issue) {
    throw new Error(`Issue "${issueIdentifier}" not found`)
  }

  const issue = issueData.issue
  console.log(`Found: ${issue.identifier} - ${issue.title}`)
  console.log(`  Current project: ${issue.project?.name || 'None'}`)

  // Remove from project (set projectId to null)
  const updateData = await graphql(`
    mutation RemoveIssueFromProject($id: String!) {
      issueUpdate(id: $id, input: { projectId: null }) {
        success
        issue {
          id
          identifier
          project { id name }
        }
      }
    }
  `, { id: issue.id })

  if (!updateData.issueUpdate.success) {
    throw new Error('Failed to remove issue from project')
  }

  console.log(`  → Removed from project`)
  return updateData.issueUpdate.issue
}

async function createProject(name, teamKey = 'SMI') {
  // Get team ID first
  const teamData = await graphql(`
    query GetTeam($key: String!) {
      teams(filter: { key: { eq: $key } }) {
        nodes { id key name }
      }
    }
  `, { key: teamKey })

  const team = teamData.teams.nodes[0]
  if (!team) {
    throw new Error(`Team "${teamKey}" not found`)
  }

  const createData = await graphql(`
    mutation CreateProject($name: String!, $teamIds: [String!]!) {
      projectCreate(input: { name: $name, teamIds: $teamIds }) {
        success
        project {
          id
          name
          state
        }
      }
    }
  `, { name, teamIds: [team.id] })

  if (!createData.projectCreate.success) {
    throw new Error('Failed to create project')
  }

  console.log(`Created project: ${createData.projectCreate.project.name}`)
  console.log(`  ID: ${createData.projectCreate.project.id}`)
  return createData.projectCreate.project
}

async function listProjects() {
  const data = await graphql(`
    query GetProjects {
      projects(first: 50) {
        nodes {
          id
          name
          state
        }
      }
    }
  `)

  for (const project of data.projects.nodes) {
    console.log(`${project.name} (${project.state})`)
    console.log(`  ID: ${project.id}`)
  }
  return data.projects.nodes
}

// CLI
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

const commands = {
  async 'move'(args) {
    const { issue, project } = args

    if (!issue || !project) {
      console.error('Error: --issue and --project are required')
      process.exit(1)
    }

    await moveIssueToProject(issue, project)
  },

  async 'remove'(args) {
    const { issue } = args

    if (!issue) {
      console.error('Error: --issue is required')
      process.exit(1)
    }

    await removeIssueFromProject(issue)
  },

  async 'create-project'(args) {
    const { name } = args

    if (!name) {
      console.error('Error: --name is required')
      process.exit(1)
    }

    await createProject(name)
  },

  async 'list-projects'(_args) {
    await listProjects()
  },

  async 'batch-move'(args) {
    const { issues, project } = args

    if (!issues || !project) {
      console.error('Error: --issues (comma-separated) and --project are required')
      process.exit(1)
    }

    const issueList = issues.split(',').map(i => i.trim())
    for (const issue of issueList) {
      try {
        await moveIssueToProject(issue, project)
      } catch (err) {
        console.error(`Error moving ${issue}: ${err.message}`)
      }
    }
  },

  async help() {
    console.log(`
Linear Issue Mover

Usage:
  node scripts/linear-move-issues.mjs <command> [options]

Commands:
  move              Move issue to project
    --issue         Issue identifier (e.g., SMI-123)
    --project       Project ID

  batch-move        Move multiple issues to project
    --issues        Comma-separated issue identifiers
    --project       Project ID

  remove            Remove issue from project
    --issue         Issue identifier

  create-project    Create a new project
    --name          Project name

  list-projects     List all projects

Environment:
  LINEAR_API_KEY    API key for authentication
`)
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const command = args._[0] || 'help'

  if (!commands[command]) {
    console.error(`Unknown command: ${command}`)
    process.exit(1)
  }

  try {
    await commands[command](args)
  } catch (error) {
    console.error(`Error: ${error.message}`)
    process.exit(1)
  }
}

main()

#!/bin/bash
# Update Linear issues for Phase 1 start

# Get the "In Progress" state ID
echo "Fetching workflow states..."
IN_PROGRESS_STATE=$(curl -s -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: $LINEAR_API_KEY" \
  -d '{"query": "query { workflowStates { nodes { id name } } }"}' | \
  jq -r '.data.workflowStates.nodes[] | select(.name == "In Progress") | .id' | head -1)

echo "In Progress State ID: $IN_PROGRESS_STATE"

# Find SMI team and issues 614, 615, 616
echo "Finding Phase 1 issues..."
ISSUES=$(curl -s -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: $LINEAR_API_KEY" \
  -d '{"query": "query { issues(filter: { number: { in: [614, 615, 616] } }) { nodes { id identifier title number } } }"}')

echo "Found issues:"
echo "$ISSUES" | jq -r '.data.issues.nodes[] | "\(.identifier): \(.title)"'

# Extract issue IDs
ISSUE_614=$(echo "$ISSUES" | jq -r '.data.issues.nodes[] | select(.number == 614) | .id')
ISSUE_615=$(echo "$ISSUES" | jq -r '.data.issues.nodes[] | select(.number == 615) | .id')
ISSUE_616=$(echo "$ISSUES" | jq -r '.data.issues.nodes[] | select(.number == 616) | .id')

echo ""
echo "Updating issues to In Progress..."

# Update each issue to In Progress
for ISSUE_ID in "$ISSUE_614" "$ISSUE_615" "$ISSUE_616"; do
  if [ -n "$ISSUE_ID" ]; then
    RESULT=$(curl -s -X POST https://api.linear.app/graphql \
      -H "Content-Type: application/json" \
      -H "Authorization: $LINEAR_API_KEY" \
      -d "{\"query\": \"mutation { issueUpdate(id: \\\"$ISSUE_ID\\\", input: { stateId: \\\"$IN_PROGRESS_STATE\\\" }) { success issue { identifier title } } }\"}")
    echo "$RESULT" | jq -r '.data.issueUpdate.issue | "\(.identifier) -> In Progress"'
  fi
done

# Add project update
echo ""
echo "Adding project update..."
PROJECT_ID=$(curl -s -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: $LINEAR_API_KEY" \
  -d '{"query": "query { projects(filter: { name: { contains: \"Skillsmith\" } }) { nodes { id name } } }"}' | \
  jq -r '.data.projects.nodes[0].id')

TODAY=$(date +%Y-%m-%d)
BODY="## Phase 1 Started\n\n**Date**: ${TODAY}\n\n### Setup Complete\n- Git worktree created: skillsmith-phase1\n- Docker container: skillsmith-phase1-dev-1 (port 3002)\n- Dependencies installed\n- Phase 0 committed to main (74 files, 16,636 lines)\n\n### Phase 1 Goals\n- SMI-614: Pre-commit hooks with husky\n- SMI-615: GitHub Actions CI/CD pipeline\n- SMI-616: Integration test suite\n\n### Approach\nUsing claude-flow hierarchical swarm for parallel development across all three tasks."

RESULT=$(curl -s -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: $LINEAR_API_KEY" \
  -d "{\"query\": \"mutation { projectUpdateCreate(input: { projectId: \\\"$PROJECT_ID\\\", body: \\\"$BODY\\\" }) { success projectUpdate { id } } }\"}")

echo "$RESULT" | jq -r 'if .data.projectUpdateCreate.success then "Project update created successfully" else "Error: \(.)" end'

echo ""
echo "Done!"

#!/bin/bash
# Update Phase 2a issues in Linear - SMI-628 Complete

set -e

echo "=== Linear Phase 2a Update ==="

# Get team ID
echo "Fetching team..."
TEAM_ID=$(curl -s -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: $LINEAR_API_KEY" \
  -d '{"query": "query { teams { nodes { id name } } }"}' | \
  jq -r '.data.teams.nodes[0].id')

echo "Team ID: $TEAM_ID"

# Get workflow states
echo "Fetching workflow states..."
STATES=$(curl -s -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: $LINEAR_API_KEY" \
  -d '{"query": "query { workflowStates { nodes { id name } } }"}')

DONE_STATE=$(echo "$STATES" | jq -r '.data.workflowStates.nodes[] | select(.name == "Done") | .id' | head -1)
IN_PROGRESS_STATE=$(echo "$STATES" | jq -r '.data.workflowStates.nodes[] | select(.name == "In Progress") | .id' | head -1)

echo "Done State ID: $DONE_STATE"
echo "In Progress State ID: $IN_PROGRESS_STATE"

# Get Phase 2 project ID
PHASE2_PROJECT=$(curl -s -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: $LINEAR_API_KEY" \
  -d '{"query": "query { projects(filter: { name: { contains: \"Phase 2\" } }) { nodes { id name } } }"}' | \
  jq -r '.data.projects.nodes[0].id')

echo "Phase 2 Project ID: $PHASE2_PROJECT"

# Find SMI-628 issue
echo ""
echo "Finding SMI-628..."
SMI628=$(curl -s -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: $LINEAR_API_KEY" \
  -d '{"query": "query { issues(filter: { identifier: { eq: \"SMI-628\" } }) { nodes { id identifier title state { name } } } }"}')

SMI628_ID=$(echo "$SMI628" | jq -r '.data.issues.nodes[0].id')
SMI628_TITLE=$(echo "$SMI628" | jq -r '.data.issues.nodes[0].title')
SMI628_STATE=$(echo "$SMI628" | jq -r '.data.issues.nodes[0].state.name')

echo "SMI-628: $SMI628_TITLE"
echo "Current State: $SMI628_STATE"

# Update SMI-628 to Done
echo ""
echo "Updating SMI-628 to Done..."
curl -s -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: $LINEAR_API_KEY" \
  -d '{
    "query": "mutation { issueUpdate(id: \"'"$SMI628_ID"'\", input: { stateId: \"'"$DONE_STATE"'\" }) { success issue { identifier title state { name } } } }"
  }' | jq -r '.data.issueUpdate.issue | "Updated: \(.identifier) - \(.title) -> \(.state.name)"'

# Add comment to SMI-628
echo ""
echo "Adding completion comment to SMI-628..."
curl -s -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: $LINEAR_API_KEY" \
  -d '{
    "query": "mutation { commentCreate(input: { issueId: \"'"$SMI628_ID"'\", body: \"## Implementation Complete\n\n**Date**: 2025-12-27\n\n### Files Created\n- `packages/core/src/indexer/SkillParser.ts` - YAML frontmatter parsing\n- `packages/core/src/indexer/GitHubIndexer.ts` - GitHub skill discovery with rate limiting\n- `packages/core/src/indexer/index.ts` - Module exports\n- `packages/core/src/repositories/IndexerRepository.ts` - Database operations\n- `packages/core/tests/GitHubIndexer.test.ts` - 33 tests\n\n### Features Implemented\n- Parse SKILL.md files with YAML frontmatter\n- Discover skills from GitHub repositories\n- Rate-aware fetching with exponential backoff (150ms delay)\n- Database upsert with conflict resolution on repo_url\n- Incremental updates based on last_indexed_at\n- Quality score calculation\n- Trust tier inference\n\n### Verification\n- TypeScript typecheck: PASSED\n- Tests: 33 passed (139 total)\n\n### Notes\n- Session initially stalled during verification step\n- Recovery agent completed verification successfully\" }) { success } }"
  }' | jq -r 'if .data.commentCreate.success then "Comment added successfully" else "Failed to add comment" end'

# Find SMI-627 and check status
echo ""
echo "Checking SMI-627 status..."
SMI627=$(curl -s -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: $LINEAR_API_KEY" \
  -d '{"query": "query { issues(filter: { identifier: { eq: \"SMI-627\" } }) { nodes { id identifier title state { name } } } }"}')

SMI627_ID=$(echo "$SMI627" | jq -r '.data.issues.nodes[0].id')
SMI627_TITLE=$(echo "$SMI627" | jq -r '.data.issues.nodes[0].title')
SMI627_STATE=$(echo "$SMI627" | jq -r '.data.issues.nodes[0].state.name')

echo "SMI-627: $SMI627_TITLE"
echo "Current State: $SMI627_STATE"

# Add project update
echo ""
echo "Adding Phase 2 project update..."
curl -s -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: $LINEAR_API_KEY" \
  -d '{
    "query": "mutation { projectUpdateCreate(input: { projectId: \"'"$PHASE2_PROJECT"'\", body: \"## Phase 2a Complete: GitHub Skill Indexing\n\n**Date**: 2025-12-28\n\n### SMI-628 Completed\n- SkillParser for YAML frontmatter\n- GitHubIndexer with rate limiting\n- IndexerRepository for database ops\n- 33 new tests (all passing)\n\n### Key Decisions\n- 150ms minimum delay between API calls\n- Exponential backoff for rate limit handling\n- SHA-based change detection for incremental updates\n- Quality score 0-1 based on metadata completeness\n\n### Next Steps\n- SMI-627: Core search implementation (In Progress)\n- SMI-629: Ranking algorithm\n- SMI-630: Cache invalidation\n\n### Retrospective\nSee docs/retros/phase-2a-github-indexing.md\" }) { success } }"
  }' | jq -r 'if .data.projectUpdateCreate.success then "Project update: Success" else "Project update: Failed" end'

echo ""
echo "=== Phase 2a Update Complete ==="

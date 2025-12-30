#!/bin/bash
# Add project updates to Phase 1 and Phase 2

# Validate required environment variables
if [ -z "$LINEAR_API_KEY" ]; then
  echo "Error: LINEAR_API_KEY environment variable is required"
  exit 1
fi

if [ -z "$LINEAR_PROJECT_PHASE1" ] || [ -z "$LINEAR_PROJECT_PHASE2" ]; then
  echo "Error: LINEAR_PROJECT_PHASE1 and LINEAR_PROJECT_PHASE2 environment variables are required"
  echo "Set them in .env or export them"
  exit 1
fi

PHASE1_PROJECT="$LINEAR_PROJECT_PHASE1"
PHASE2_PROJECT="$LINEAR_PROJECT_PHASE2"

echo "Adding Phase 1 project update..."
curl -s -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: $LINEAR_API_KEY" \
  -d '{
    "query": "mutation { projectUpdateCreate(input: { projectId: \"'"$PHASE1_PROJECT"'\", body: \"## Phase 1 Cleanup Issues Created\\n\\n**Date**: 2025-12-27\\n\\n### New Issues (Actionable Now)\\n- SMI-624: Add JSDoc documentation to MCP tools\\n- SMI-625: Configure claude-flow memory persistence\\n- SMI-626: Formalize Linear update scripts\\n\\n### Purpose\\nPrepare codebase for Phase 2 with better documentation and tooling.\" }) { success } }"
  }' | jq -r 'if .data.projectUpdateCreate.success then "Phase 1 update: Success" else "Phase 1 update: \(.)" end'

echo "Adding Phase 2 project update..."
curl -s -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: $LINEAR_API_KEY" \
  -d '{
    "query": "mutation { projectUpdateCreate(input: { projectId: \"'"$PHASE2_PROJECT"'\", body: \"## Phase 2 Project Initialized\\n\\n**Date**: 2025-12-27\\n\\n### P0 - Critical\\n- SMI-627: Core search implementation\\n- SMI-628: GitHub skill indexing\\n\\n### P1 - Important\\n- SMI-629: Ranking algorithm\\n- SMI-630: Cache invalidation\\n- SMI-631: E2E tests\\n\\n### P2 - Nice to Have\\n- SMI-632: Performance benchmarks\\n- SMI-633: VS Code extension\\n\\n### Process\\n- SMI-634: Swarm coordination improvements\\n\\n### Prerequisites\\nComplete Phase 1 cleanup issues first.\" }) { success } }"
  }' | jq -r 'if .data.projectUpdateCreate.success then "Phase 2 update: Success" else "Phase 2 update: \(.)" end'

echo "Done!"

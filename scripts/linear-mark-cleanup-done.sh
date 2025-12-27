#!/bin/bash
# Mark Phase 1 cleanup issues as Done

echo "=== Marking Phase 1 Cleanup Issues as Done ==="

# Get Done state ID
DONE_STATE=$(curl -s -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: $LINEAR_API_KEY" \
  -d '{"query": "query { workflowStates { nodes { id name } } }"}' | \
  jq -r '.data.workflowStates.nodes[] | select(.name == "Done") | .id' | head -1)

echo "Done State ID: $DONE_STATE"

# Find cleanup issues 624, 625, 626
ISSUES=$(curl -s -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: $LINEAR_API_KEY" \
  -d '{"query": "query { issues(filter: { number: { in: [624, 625, 626] } }) { nodes { id identifier title number } } }"}')

echo "Found issues:"
echo "$ISSUES" | jq -r '.data.issues.nodes[] | "\(.identifier): \(.title)"'

# Extract issue IDs
ISSUE_624=$(echo "$ISSUES" | jq -r '.data.issues.nodes[] | select(.number == 624) | .id')
ISSUE_625=$(echo "$ISSUES" | jq -r '.data.issues.nodes[] | select(.number == 625) | .id')
ISSUE_626=$(echo "$ISSUES" | jq -r '.data.issues.nodes[] | select(.number == 626) | .id')

echo ""
echo "Marking issues as Done..."

# Update each issue
for ISSUE_ID in "$ISSUE_624" "$ISSUE_625" "$ISSUE_626"; do
  if [ -n "$ISSUE_ID" ]; then
    RESULT=$(curl -s -X POST https://api.linear.app/graphql \
      -H "Content-Type: application/json" \
      -H "Authorization: $LINEAR_API_KEY" \
      -d "{\"query\": \"mutation { issueUpdate(id: \\\"$ISSUE_ID\\\", input: { stateId: \\\"$DONE_STATE\\\" }) { success issue { identifier title } } }\"}")
    echo "$RESULT" | jq -r '.data.issueUpdate.issue | "\(.identifier) -> Done"'
  fi
done

# Add project update
echo ""
echo "Adding completion update..."
PHASE1_PROJECT="b6135515-89c9-4ad7-b32c-613933508067"

curl -s -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: $LINEAR_API_KEY" \
  -d '{
    "query": "mutation { projectUpdateCreate(input: { projectId: \"b6135515-89c9-4ad7-b32c-613933508067\", body: \"## Phase 1 Cleanup Complete\\n\\n**Date**: 2025-12-27\\n\\n### Completed Issues\\n- SMI-624: JSDoc documentation added to all 4 MCP tools\\n- SMI-625: claude-flow memory persistence configured (5 entries in skillsmith namespace)\\n- SMI-626: Scripts README added with documentation\\n\\n### Ready for Phase 2\\nAll cleanup tasks complete. Phase 2 can begin.\" }) { success } }"
  }' | jq -r 'if .data.projectUpdateCreate.success then "Project update: Success" else "Project update: Failed" end'

echo ""
echo "Done!"

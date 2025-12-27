#!/bin/bash
# Create Phase 2 project and issues in Linear

set -e

echo "=== Linear Phase 2 Setup ==="

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

TODO_STATE=$(echo "$STATES" | jq -r '.data.workflowStates.nodes[] | select(.name == "Todo") | .id' | head -1)
echo "Todo State ID: $TODO_STATE"

# Get Phase 1 project ID (existing)
PHASE1_PROJECT="b6135515-89c9-4ad7-b32c-613933508067"
echo "Phase 1 Project ID: $PHASE1_PROJECT"

# Create Phase 2 project
echo ""
echo "Creating Phase 2 project..."
PHASE2_RESULT=$(curl -s -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: $LINEAR_API_KEY" \
  -d '{
    "query": "mutation { projectCreate(input: { name: \"Skillsmith Phase 2: Core Features\", teamIds: [\"'"$TEAM_ID"'\"], description: \"Core MCP tools and skill discovery implementation\" }) { success project { id name } } }"
  }')

PHASE2_PROJECT=$(echo "$PHASE2_RESULT" | jq -r '.data.projectCreate.project.id')
echo "Phase 2 Project ID: $PHASE2_PROJECT"

# ============================================
# PHASE 1 CLEANUP ISSUES (Actionable Now)
# ============================================
echo ""
echo "=== Creating Phase 1 Cleanup Issues ==="

# Issue 1: Document MCP tools
echo "Creating: Document MCP tools..."
curl -s -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: $LINEAR_API_KEY" \
  -d '{
    "query": "mutation { issueCreate(input: { teamId: \"'"$TEAM_ID"'\", title: \"Add JSDoc documentation to MCP tools\", description: \"Add comprehensive JSDoc documentation with examples to all 4 MCP tools:\\n- search_skills\\n- get_skill\\n- install_skill\\n- uninstall_skill\\n\\nInclude parameter descriptions, return types, and usage examples.\", stateId: \"'"$TODO_STATE"'\", priority: 2, projectId: \"'"$PHASE1_PROJECT"'\" }) { success issue { identifier title } } }"
  }' | jq -r '.data.issueCreate.issue | "\(.identifier): \(.title)"'

# Issue 2: Configure memory persistence
echo "Creating: Configure memory persistence..."
curl -s -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: $LINEAR_API_KEY" \
  -d '{
    "query": "mutation { issueCreate(input: { teamId: \"'"$TEAM_ID"'\", title: \"Configure claude-flow memory persistence for session continuity\", description: \"Set up claude-flow memory persistence to maintain context across sessions:\\n- Configure memory namespace for skillsmith\\n- Store architecture decisions\\n- Enable session restore for Phase 2\", stateId: \"'"$TODO_STATE"'\", priority: 3, projectId: \"'"$PHASE1_PROJECT"'\" }) { success issue { identifier title } } }"
  }' | jq -r '.data.issueCreate.issue | "\(.identifier): \(.title)"'

# Issue 3: Formalize Linear scripts
echo "Creating: Formalize Linear scripts..."
curl -s -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: $LINEAR_API_KEY" \
  -d '{
    "query": "mutation { issueCreate(input: { teamId: \"'"$TEAM_ID"'\", title: \"Formalize Linear update scripts in /scripts\", description: \"Organize and document Linear API scripts:\\n- linear-phase1-update.sh\\n- linear-phase1-complete.sh\\n- linear-phase2-setup.sh\\n\\nAdd README for script usage.\", stateId: \"'"$TODO_STATE"'\", priority: 4, projectId: \"'"$PHASE1_PROJECT"'\" }) { success issue { identifier title } } }"
  }' | jq -r '.data.issueCreate.issue | "\(.identifier): \(.title)"'

# ============================================
# PHASE 2 ISSUES (Actionable when starting)
# ============================================
echo ""
echo "=== Creating Phase 2 Issues ==="

# P0: Core search implementation
echo "Creating: Core search implementation..."
curl -s -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: $LINEAR_API_KEY" \
  -d '{
    "query": "mutation { issueCreate(input: { teamId: \"'"$TEAM_ID"'\", title: \"[P0] Implement core search functionality\", description: \"Implement the core search engine for skill discovery:\\n- Full-text search with SQLite FTS5\\n- Vector similarity search with embeddings\\n- Hybrid ranking combining both approaches\\n- Filter by category, trust tier, popularity\\n\\nThis is the foundation for all skill discovery.\", stateId: \"'"$TODO_STATE"'\", priority: 1, projectId: \"'"$PHASE2_PROJECT"'\" }) { success issue { identifier title } } }"
  }' | jq -r '.data.issueCreate.issue | "\(.identifier): \(.title)"'

# P0: GitHub skill indexing
echo "Creating: GitHub skill indexing..."
curl -s -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: $LINEAR_API_KEY" \
  -d '{
    "query": "mutation { issueCreate(input: { teamId: \"'"$TEAM_ID"'\", title: \"[P0] Implement GitHub skill indexing\", description: \"Index skills from GitHub repositories:\\n- Discover repos with SKILL.md files\\n- Parse skill metadata from frontmatter\\n- Extract README content for search\\n- Store in SQLite with embeddings\\n- Incremental updates via GitHub API\\n\\nPrimary source for skill discovery.\", stateId: \"'"$TODO_STATE"'\", priority: 1, projectId: \"'"$PHASE2_PROJECT"'\" }) { success issue { identifier title } } }"
  }' | jq -r '.data.issueCreate.issue | "\(.identifier): \(.title)"'

# P1: Ranking algorithm
echo "Creating: Ranking algorithm..."
curl -s -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: $LINEAR_API_KEY" \
  -d '{
    "query": "mutation { issueCreate(input: { teamId: \"'"$TEAM_ID"'\", title: \"[P1] Implement skill ranking algorithm\", description: \"Develop ranking algorithm for search results:\\n- GitHub stars and forks\\n- Last updated recency\\n- Trust tier weighting\\n- Semantic relevance score\\n- User install/usage signals\\n\\nQuality over quantity in results.\", stateId: \"'"$TODO_STATE"'\", priority: 2, projectId: \"'"$PHASE2_PROJECT"'\" }) { success issue { identifier title } } }"
  }' | jq -r '.data.issueCreate.issue | "\(.identifier): \(.title)"'

# P1: Cache invalidation
echo "Creating: Cache invalidation..."
curl -s -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: $LINEAR_API_KEY" \
  -d '{
    "query": "mutation { issueCreate(input: { teamId: \"'"$TEAM_ID"'\", title: \"[P1] Implement cache invalidation strategy\", description: \"Implement smart cache invalidation:\\n- TTL-based expiration for search results\\n- Event-driven invalidation on skill updates\\n- Background refresh for popular queries\\n- LRU eviction for memory management\\n\\nEnsure fresh search results.\", stateId: \"'"$TODO_STATE"'\", priority: 2, projectId: \"'"$PHASE2_PROJECT"'\" }) { success issue { identifier title } } }"
  }' | jq -r '.data.issueCreate.issue | "\(.identifier): \(.title)"'

# P1: E2E tests
echo "Creating: E2E tests..."
curl -s -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: $LINEAR_API_KEY" \
  -d '{
    "query": "mutation { issueCreate(input: { teamId: \"'"$TEAM_ID"'\", title: \"[P1] Add E2E tests with Claude Code integration\", description: \"Create end-to-end tests with real Claude Code:\\n- Test MCP tool registration\\n- Test skill search flow\\n- Test install/uninstall lifecycle\\n- Validate ~/.claude/skills integration\\n\\nRequires Claude Code test harness.\", stateId: \"'"$TODO_STATE"'\", priority: 2, projectId: \"'"$PHASE2_PROJECT"'\" }) { success issue { identifier title } } }"
  }' | jq -r '.data.issueCreate.issue | "\(.identifier): \(.title)"'

# P2: Performance benchmarks
echo "Creating: Performance benchmarks..."
curl -s -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: $LINEAR_API_KEY" \
  -d '{
    "query": "mutation { issueCreate(input: { teamId: \"'"$TEAM_ID"'\", title: \"[P2] Add performance benchmarks for search latency\", description: \"Implement performance benchmarking:\\n- Search latency targets (<100ms p50, <500ms p99)\\n- Indexing throughput\\n- Memory usage profiling\\n- Database query optimization\\n\\nEstablish baseline before optimization.\", stateId: \"'"$TODO_STATE"'\", priority: 3, projectId: \"'"$PHASE2_PROJECT"'\" }) { success issue { identifier title } } }"
  }' | jq -r '.data.issueCreate.issue | "\(.identifier): \(.title)"'

# P2: VS Code extension
echo "Creating: VS Code extension..."
curl -s -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: $LINEAR_API_KEY" \
  -d '{
    "query": "mutation { issueCreate(input: { teamId: \"'"$TEAM_ID"'\", title: \"[P2] Create VS Code extension for skill discovery\", description: \"Build VS Code extension:\\n- Skill search sidebar\\n- One-click install\\n- Skill recommendations based on open files\\n- Integration with Claude Code extension\\n\\nEnhanced developer experience.\", stateId: \"'"$TODO_STATE"'\", priority: 3, projectId: \"'"$PHASE2_PROJECT"'\" }) { success issue { identifier title } } }"
  }' | jq -r '.data.issueCreate.issue | "\(.identifier): \(.title)"'

# Swarm process improvements
echo "Creating: Swarm process improvements..."
curl -s -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: $LINEAR_API_KEY" \
  -d '{
    "query": "mutation { issueCreate(input: { teamId: \"'"$TEAM_ID"'\", title: \"[Process] Implement swarm coordination improvements\", description: \"Apply learnings from Phase 1 retro:\\n- Use mesh topology for interconnected tasks\\n- Initialize swarm before coding\\n- Add session checkpointing\\n- More granular task decomposition\\n- Commit after each file completion\", stateId: \"'"$TODO_STATE"'\", priority: 2, projectId: \"'"$PHASE2_PROJECT"'\" }) { success issue { identifier title } } }"
  }' | jq -r '.data.issueCreate.issue | "\(.identifier): \(.title)"'

# ============================================
# PROJECT UPDATES
# ============================================
echo ""
echo "=== Adding Project Updates ==="

# Phase 1 update
echo "Adding Phase 1 project update..."
curl -s -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: $LINEAR_API_KEY" \
  -d '{
    "query": "mutation { projectUpdateCreate(input: { projectId: \"'"$PHASE1_PROJECT"'\", body: \"## Phase 1 Cleanup Issues Created\n\n**Date**: 2025-12-27\n\n### New Issues (Actionable Now)\n1. Add JSDoc documentation to MCP tools\n2. Configure claude-flow memory persistence\n3. Formalize Linear update scripts\n\n### Purpose\nThese cleanup tasks prepare the codebase for Phase 2 by:\n- Improving code documentation\n- Enabling session continuity\n- Standardizing project management scripts\n\n### Next Steps\nComplete cleanup issues before starting Phase 2 development.\" }) { success } }"
  }' | jq -r 'if .data.projectUpdateCreate.success then "Phase 1 update: Success" else "Phase 1 update: Failed" end'

# Phase 2 update
echo "Adding Phase 2 project update..."
curl -s -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: $LINEAR_API_KEY" \
  -d '{
    "query": "mutation { projectUpdateCreate(input: { projectId: \"'"$PHASE2_PROJECT"'\", body: \"## Phase 2 Project Created\n\n**Date**: 2025-12-27\n\n### Issues Created\n\n**P0 - Critical**\n- Core search implementation\n- GitHub skill indexing\n\n**P1 - Important**\n- Ranking algorithm\n- Cache invalidation\n- E2E tests with Claude Code\n\n**P2 - Nice to Have**\n- Performance benchmarks\n- VS Code extension\n\n**Process**\n- Swarm coordination improvements\n\n### Approach\n- Use git worktree for isolation\n- Initialize mesh swarm for interconnected tasks\n- Commit frequently, push after milestones\n\n### Prerequisites\nComplete Phase 1 cleanup issues first.\" }) { success } }"
  }' | jq -r 'if .data.projectUpdateCreate.success then "Phase 2 update: Success" else "Phase 2 update: Failed" end'

echo ""
echo "=== Setup Complete ==="
echo "Phase 2 Project ID: $PHASE2_PROJECT"

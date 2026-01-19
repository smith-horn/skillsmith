#!/bin/bash
# Launch script for Workstream 4: CLI/DevOps
cd "$(dirname "$0")/../.."
cd ../worktrees/live-svc-cli-devops 2>/dev/null || { echo "ERROR: Worktree not found. Run worktree creation first."; exit 1; }

git fetch origin main && git rebase origin/main

cat << 'PROMPT'
================================================================================
WORKSTREAM 4: CLI/DevOps (SMI-1449, SMI-1450, SMI-1455, SMI-1556)
================================================================================

## Issues
- SMI-1449: Add sqlite3 CLI to Docker container (Low)
- SMI-1450: Fix duplicate console output in import script (Low)
- SMI-1455: Create CLI command for safe skill merging (Low) - depends on WS3/SMI-1448
- SMI-1556: Upgrade Supabase CLI (Low)

## Key Files
- Dockerfile
- packages/cli/src/import.ts
- packages/cli/src/commands/merge.ts (new)
- .github/workflows/*.yml

## Coordination
- SMI-1455 depends on WS3/SMI-1448 (cross-stream dependency)
- Complete SMI-1449, SMI-1450, SMI-1556 first (no dependencies)
- Wait for WS3 to complete SMI-1448 before starting SMI-1455

## When Complete
1. Run: docker exec skillsmith-dev-1 npm run preflight
2. Commit with conventional format
3. Push and create PR
4. Notify queen coordinator
================================================================================
PROMPT

claude

#!/bin/bash
# Launch script for Workstream 3: Database
cd "$(dirname "$0")/../.."
cd ../worktrees/live-svc-database 2>/dev/null || { echo "ERROR: Worktree not found. Run worktree creation first."; exit 1; }

git fetch origin main && git rebase origin/main

cat << 'PROMPT'
================================================================================
WORKSTREAM 3: Database (SMI-1446, SMI-1448, SMI-1452)
================================================================================

## Issues
- SMI-1446: Database schema version mismatch blocks imports (Medium)
- SMI-1448: Create database merge tooling (Medium) - depends on SMI-1446
- SMI-1452: Sync local database with Supabase production (Medium) - depends on SMI-1448

## Key Files
- packages/core/src/database/schema.ts
- packages/core/src/database/migration.ts
- packages/cli/src/commands/db-merge.ts (new)
- packages/cli/src/commands/db-sync.ts (new)

## Coordination
- SMI-1448 depends on SMI-1446
- SMI-1452 depends on SMI-1448
- WS4 (SMI-1455) depends on SMI-1448 (cross-stream)
- Uncomment export in packages/core/src/index.ts when ready:
  // export * from './database/migration.js'

## When Complete
1. Run: docker exec skillsmith-dev-1 npm run preflight
2. Commit with conventional format
3. Push and create PR
4. Notify queen coordinator
================================================================================
PROMPT

claude

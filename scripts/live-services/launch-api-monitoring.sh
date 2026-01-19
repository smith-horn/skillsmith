#!/bin/bash
# Launch script for Workstream 5: API/Monitoring
cd "$(dirname "$0")/../.."
cd ../worktrees/live-svc-api-monitoring 2>/dev/null || { echo "ERROR: Worktree not found. Run worktree creation first."; exit 1; }

git fetch origin main && git rebase origin/main

cat << 'PROMPT'
================================================================================
WORKSTREAM 5: API/Monitoring (SMI-1447, SMI-1453)
================================================================================

## Issues
- SMI-1447: Add live API health verification endpoint (Medium)
- SMI-1453: Add rate limit monitoring and alerting (Medium) - depends on SMI-1447

## Key Files
- supabase/functions/health/index.ts (new)
- packages/core/src/monitoring/rate-limiter.ts
- supabase/functions/_shared/monitoring.ts (new)

## Coordination
- SMI-1453 depends on SMI-1447
- Uncomment export in packages/core/src/index.ts when ready:
  // export * from './monitoring/index.js'

## When Complete
1. Run: docker exec skillsmith-dev-1 npm run preflight
2. Commit with conventional format
3. Push and create PR
4. Notify queen coordinator
================================================================================
PROMPT

claude

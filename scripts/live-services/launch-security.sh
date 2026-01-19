#!/bin/bash
# Launch script for Workstream 2: Security
cd "$(dirname "$0")/../.."
cd ../worktrees/live-svc-security 2>/dev/null || { echo "ERROR: Worktree not found. Run worktree creation first."; exit 1; }

git fetch origin main && git rebase origin/main

cat << 'PROMPT'
================================================================================
WORKSTREAM 2: Security (SMI-1454, SMI-1456, SMI-1457)
================================================================================

## Issues
- SMI-1454: Security scanner outputs minimal refs (Medium)
- SMI-1456: Weekly automated security scan workflow (Medium) - depends on SMI-1454
- SMI-1457: Create Security project for quarantine tracking (Medium) - depends on SMI-1456

## Key Files
- packages/core/src/security/scanner.ts
- .github/workflows/security-scan.yml (new)
- Linear project creation (external)

## Coordination
- SMI-1456 depends on SMI-1454
- SMI-1457 depends on SMI-1456
- Uncomment export in packages/core/src/index.ts when ready:
  // export * from './security/scanner-enhanced.js'

## When Complete
1. Run: docker exec skillsmith-dev-1 npm run preflight
2. Commit with conventional format
3. Push and create PR
4. Notify queen coordinator
================================================================================
PROMPT

claude

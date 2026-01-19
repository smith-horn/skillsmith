#!/bin/bash
# Launch script for Workstream 6: Documentation & DX
cd "$(dirname "$0")/../.."
cd ../worktrees/live-svc-docs 2>/dev/null || { echo "ERROR: Worktree not found. Run worktree creation first."; exit 1; }

git fetch origin main && git rebase origin/main

cat << 'PROMPT'
================================================================================
WORKSTREAM 6: Documentation & DX (SMI-1451, SMI-1585, SMI-1588, SMI-1589)
================================================================================

## Issues
- SMI-1451: Document GitHub App authentication flow (Medium)
- SMI-1585: Document version governance policy (P2)
- SMI-1588: Investigate Supabase Edge Function log API access (Low)
- SMI-1589: Add is:inline directive to Astro scripts (Low)

## Key Files
- docs/architecture/github-app-auth.md (new)
- docs/architecture/versioning-policy.md (new)
- docs/adr/index.md
- CONTRIBUTING.md
- packages/website/src/**/*.astro (inline directive updates)
- docs/infrastructure/supabase-logs.md (new, if API available)

## Coordination
- No cross-stream dependencies
- All issues can be worked in parallel

## When Complete
1. Run: docker exec skillsmith-dev-1 npm run preflight
2. Commit with conventional format
3. Push and create PR
4. Notify queen coordinator
================================================================================
PROMPT

claude

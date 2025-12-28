Implement SMI-634: Swarm Coordination Improvements

## Context
Working in: /Users/williamsmith/Documents/GitHub/Claude-Skill-Discovery/worktrees/phase-2b-swarm
Branch: phase-2b-swarm

Improve multi-agent swarm coordination for parallel development sessions.

## Deliverables

Create these files IN ORDER:

1. `packages/core/src/swarm/SwarmCoordinator.ts`
   - Agent registration and discovery
   - Task assignment and load balancing
   - Progress aggregation across agents
   - Conflict detection (same file edits)

2. `packages/core/src/swarm/AgentState.ts`
   - Track agent status (idle, working, blocked)
   - Current task assignment
   - Files being modified
   - Last heartbeat timestamp

3. `packages/core/src/swarm/TaskQueue.ts`
   - Priority queue for tasks
   - Dependency tracking
   - Assignment to available agents
   - Completion callbacks

4. `packages/core/src/swarm/index.ts`
   - Module exports

5. `packages/core/tests/SwarmCoordinator.test.ts`
   - Agent registration tests
   - Task assignment tests
   - Conflict detection tests
   - Load balancing tests

## CRITICAL: After EACH file

```bash
docker exec skillsmith-dev-1 npm run typecheck
npx claude-flow@alpha hooks post-edit --file "<filename>" --memory-key "smi634/files"
echo "$(date): Completed <filename>" >> /tmp/smi634-progress.log
```

## Constraints
- Maximum 45 minutes
- Focus ONLY on coordination
- Use existing claude-flow patterns where applicable
- Keep state minimal for cross-session persistence

Begin by checking if any swarm patterns exist in the codebase.

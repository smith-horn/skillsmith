Implement SMI-638: Session Checkpointing to Claude-Flow Memory

## Context
Working in: /Users/williamsmith/Documents/GitHub/Claude-Skill-Discovery/worktrees/phase-2b-process
Branch: phase-2b-process

This is a process improvement to prevent context loss during long sessions.

## Deliverables

Create these files IN ORDER:

1. `packages/core/src/session/SessionCheckpoint.ts`
   - Checkpoint data structure (timestamp, files modified, tests run, todos)
   - Serialize/deserialize to JSON
   - Integration with claude-flow memory hooks

2. `packages/core/src/session/CheckpointManager.ts`
   - Auto-checkpoint every N minutes or after file saves
   - Store to claude-flow memory: `npx claude-flow@alpha hooks post-edit --memory-key "session/checkpoint"`
   - Restore from memory on session start

3. `packages/core/src/session/index.ts`
   - Module exports

4. `packages/core/tests/SessionCheckpoint.test.ts`
   - Checkpoint creation tests
   - Serialization tests
   - Restore tests

5. Create hook integration script `scripts/session-checkpoint.sh`
   - Called by claude-flow hooks
   - Stores checkpoint data

## CRITICAL: After EACH file

```bash
docker exec skillsmith-dev-1 npm run typecheck
npx claude-flow@alpha hooks post-edit --file "<filename>" --memory-key "smi638/files"
echo "$(date): Completed <filename>" >> /tmp/smi638-progress.log
```

## Constraints
- Maximum 45 minutes
- Focus ONLY on checkpointing
- Use claude-flow memory for storage
- Keep checkpoint data minimal (< 10KB)

Begin by reading existing session patterns in the codebase.

# Swarm Recovery Procedures

> SMI-762: Documentation for detecting and recovering from stuck swarm sessions

## Overview

When running multi-agent swarms with Claude-Flow, sessions can sometimes become stuck due to:
- Agent timeouts
- Memory coordination failures
- Unexpected disconnections
- Resource exhaustion

This guide covers detection, diagnosis, and recovery procedures.

## Detecting a Stuck Session

### Signs of a Stuck Session

1. **No progress for extended periods** - Agents not producing output
2. **Memory not updating** - `npx claude-flow memory list` shows stale data
3. **Agent status stuck** - `npx claude-flow status` shows idle agents with pending tasks
4. **Terminal unresponsive** - No output even after pressing Enter

### Quick Health Check

```bash
# Check if any agents are active
npx claude-flow status

# Check memory for recent updates
npx claude-flow memory list --namespace swarm

# Check for running background processes
ps aux | grep claude
```

## Memory Retrieval

### Listing All Memory Keys

```bash
# List all memory entries
npx claude-flow memory list

# List entries in a specific namespace
npx claude-flow memory list --namespace swarm

# Search for specific patterns
npx claude-flow memory search "phase-2e"
```

### Retrieving Specific Memory

```bash
# Get a specific key
npx claude-flow memory get swarm/phase-2e/context

# Get batch progress
npx claude-flow memory get swarm/batch1/status

# Get agent state
npx claude-flow memory get swarm/agent/coder/state
```

### Exporting Memory for Analysis

```bash
# Export all memory to JSON
npx claude-flow memory export swarm-backup.json

# Export specific namespace
npx claude-flow memory export --namespace swarm swarm-only.json
```

## Agent Restart Procedures

### Soft Restart (Preferred)

1. **Check current state**
   ```bash
   npx claude-flow status
   npx claude-flow memory list
   ```

2. **Store recovery checkpoint**
   ```bash
   npx claude-flow memory store recovery/checkpoint "$(date +%s)"
   ```

3. **Gracefully stop agents**
   ```bash
   npx claude-flow agent stop --all
   ```

4. **Restart with previous context**
   ```bash
   npx claude-flow swarm resume --from-memory
   ```

### Hard Restart (When Soft Fails)

1. **Kill all Claude processes**
   ```bash
   pkill -f "claude"
   pkill -f "claude-flow"
   ```

2. **Clear stuck state**
   ```bash
   npx claude-flow memory delete swarm/locks/*
   ```

3. **Start fresh with memory context**
   ```bash
   # Get last known good state
   npx claude-flow memory get swarm/last-checkpoint

   # Start new session referencing previous work
   claude -p "Resume swarm work. Previous context in memory at swarm/last-checkpoint"
   ```

### Recovery from Git State

If memory is corrupted, recover from git:

```bash
# Check what was committed
git log --oneline -10

# See what files changed
git diff HEAD~1

# Restore to last known good commit
git stash
git reset --hard HEAD~1
```

## Troubleshooting FAQ

### Q: Session hangs after starting swarm

**A:** Check if Docker container is running (required for tests):
```bash
docker ps | grep skillsmith
docker compose --profile dev up -d
```

### Q: Memory commands fail with connection error

**A:** The memory database may be locked. Try:
```bash
# Remove stale lock
rm -f .swarm/memory.db-lock

# Or restart the memory service
npx claude-flow memory reset
```

### Q: Agent spawns but doesn't execute tasks

**A:** Check for missing dependencies or environment variables:
```bash
# Verify environment
npx claude-flow config validate

# Check agent logs
npx claude-flow agent logs <agent-id>
```

### Q: Swarm runs but produces no output

**A:** Verify the MCP server connection:
```bash
# Check MCP status
npx claude-flow mcp status

# Restart MCP server
npx claude-flow mcp restart
```

### Q: Out of memory or token limit errors

**A:** The context window may be exhausted. Try:
```bash
# Commit current progress
git add . && git commit -m "WIP: checkpoint before context reset"

# Store memory state
npx claude-flow memory store checkpoint/pre-reset "$(git rev-parse HEAD)"

# Start fresh session
claude -p "Continue work. Last commit: $(git rev-parse HEAD)"
```

## Prevention Best Practices

1. **Commit frequently** - Save progress to git after each major step
2. **Use memory checkpoints** - Store state before risky operations
3. **Monitor token usage** - Watch for context window limits
4. **Batch operations** - Don't spawn too many agents at once
5. **Set timeouts** - Use `--timeout` flags on long-running operations

## Related Documentation

- [CLAUDE.md](../../CLAUDE.md) - Main project configuration
- [Swarm Execution Plan](../../scripts/swarm-phase-2e-followup.md) - Batch execution prompts
- [Claude-Flow Commands](../../CLAUDE.md#claude-flow-complete-command-reference) - Full command reference

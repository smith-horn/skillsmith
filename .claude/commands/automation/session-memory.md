# Cross-Session Memory

## Purpose
Maintain context and learnings across Claude Code sessions for continuous improvement.

## Memory Features

### 1. Automatic State Persistence
At session end, automatically saves:
- Active agents and specializations
- Task history and patterns
- Performance metrics
- Neural network weights
- Knowledge base updates

### 2. Session Restoration
```javascript
// Illustrative only; not runnable here: `session-state` is a placeholder key that
// nothing in this repo writes (SMI-6744 A6.1 governs writes). One discrete tool per action.
mcp__ruflo__memory_retrieve({
  "key": "session-state",
  "namespace": "sessions"
})

// Restore swarm state (no mcp__ruflo__context_restore — use session_restore)
mcp__ruflo__session_restore({
  "sessionId": "sess-123"
})
```

There is no CLI fallback here: the host ruflo CLI is denied, and the served store is separate from the host's.

### 3. Memory Types

**Project Memory:**
- File relationships
- Common edit patterns
- Testing approaches
- Build configurations

**Agent Memory:**
- Specialization levels
- Task success rates
- Optimization strategies
- Error patterns

**Performance Memory:**
- Bottleneck history
- Optimization results
- Token usage patterns
- Efficiency trends

### 4. Privacy & Control
```javascript
// Illustrative only; not runnable here: `session-state` is a placeholder key that
// nothing in this repo writes. Both tools need an exact key.
// (memory_list is denied, SMI-7184; see claude-flow-guide.md.)
mcp__ruflo__memory_retrieve({
  "key": "session-state",
  "namespace": "sessions"
})

// Delete specific memory
mcp__ruflo__memory_delete({
  "key": "session-state",
  "namespace": "sessions"
})

// Backup memory (no mcp__ruflo__memory_backup — use memory_export)
mcp__ruflo__memory_export({
  "outputPath": "./backups/memory-backup.json"
})
```

**Manual control:** none documented here. The store lives inside the `skillsmith-ruflo-1` service, not in this checkout, and no verified switch disables persistence.

## Benefits
- 🧠 Contextual awareness
- 📈 Cumulative learning
- ⚡ Faster task completion
- 🎯 Personalized optimization
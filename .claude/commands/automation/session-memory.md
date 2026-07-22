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
// Using MCP tools for memory operations (memory_usage has no action-dispatch form in v3 —
// use the discrete tool for each action)
mcp__ruflo__memory_retrieve({
  "key": "session-state",
  "namespace": "sessions"
})

// Restore swarm state (no mcp__ruflo__context_restore — use session_restore)
mcp__ruflo__session_restore({
  "sessionId": "sess-123"
})
```

**Fallback with npx:**
```bash
npx -y ruflo@3.14.2 hooks session-restore --session-id "sess-123"
```

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
// List memory contents (no action-dispatch form in v3 — discrete tool per action)
mcp__ruflo__memory_list({
  "namespace": "sessions"
})

// Delete specific memory
mcp__ruflo__memory_delete({
  "key": "session-123",
  "namespace": "sessions"
})

// Backup memory (no mcp__ruflo__memory_backup — use memory_export)
mcp__ruflo__memory_export({
  "outputPath": "./backups/memory-backup.json"
})
```

**Manual control:**
```bash
# View stored memory
ls .ruflo/memory/

# Disable memory persistence — env var not verified in v3, do not rely on this
```

## Benefits
- 🧠 Contextual awareness
- 📈 Cumulative learning
- ⚡ Faster task completion
- 🎯 Personalized optimization
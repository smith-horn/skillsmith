# Self-Healing Workflows

## Purpose
Automatically detect and recover from errors without interrupting your flow.

## Self-Healing Features

### 1. Error Detection
Monitors for:
- Failed commands
- Syntax errors
- Missing dependencies
- Broken tests

### 2. Automatic Recovery

**Missing Dependencies:**
```
Error: Cannot find module 'express'
→ Automatically runs: npm install express
→ Retries original command
```

**Syntax Errors:**
```
Error: Unexpected token
→ Analyzes error location
→ Suggests fix through analyzer agent
→ Applies fix with confirmation
```

**Test Failures:**
```
Test failed: "user authentication"
→ Spawns debugger agent
→ Analyzes failure cause
→ Implements fix
→ Re-runs tests
```

### 3. Learning from Failures
Each recovery improves future prevention:
- Patterns saved to knowledge base
- Similar errors prevented proactively
- Recovery strategies optimized

**Pattern Storage:**
```bash
# Store error patterns — CLI path is the documented default for memory-store
# writes (see docs/internal/implementation/smi-5777-wave-b-cli-judgment-calls.md
# § H-4: memory_store exists and works via `mcp exec`, but is not exposed in
# every connected session's MCP tool discovery, so the CLI form is the safe default)
npx -y ruflo@3.14.2 memory store -k "error-pattern-<timestamp>" --value '<errorData JSON>' -n "error-patterns" --ttl 2592000

# Equivalent MCP-exec form:
npx -y ruflo@3.14.2 mcp exec -t memory_store -p '{"key":"error-pattern-<timestamp>","value":"<errorData JSON>","namespace":"error-patterns","ttl":2592000}'
```

```javascript
// Analyze patterns
mcp__ruflo__neural_patterns({
  "action": "analyze",
  "operation": "error-recovery",
  "outcome": "success"
})
```

## Self-Healing Integration

### MCP Tool Coordination
```javascript
// Initialize self-healing swarm
mcp__ruflo__swarm_init({
  "topology": "star",
  "maxAgents": 4,
  "strategy": "adaptive"
})

// Spawn recovery agents
mcp__ruflo__agent_spawn({
  "agentType": "monitor",
  "name": "Error Monitor",
  "capabilities": ["error-detection", "recovery"]
})

// Orchestrate recovery
mcp__ruflo__coordination_orchestrate({
  "task": "recover from error",
  "strategy": "sequential",
  "priority": "critical"
})
```

### Fallback Hook Configuration
`post-bash` is an alias for `post-command` in v3; `--auto-recover` no longer exists — v3 only records the outcome for learning, it does not itself recover:
```json
{
  "PostToolUse": [{
    "matcher": "^Bash$",
    "command": "npx -y ruflo@3.14.2 hooks post-command -c '${tool.params.command}' --exit-code '${tool.result.exitCode}'"
  }]
}
```

## Benefits
- 🛡️ Resilient workflows
- 🔄 Automatic recovery
- 📚 Learns from errors
- ⏱️ Saves debugging time
# Session Hooks

Manage session state, restoration, and notifications.

---

## session-start

Initialize new session.

```bash
npx claude-flow hook session-start --session-id <id>

Options:
  --session-id, -s <id>     Session identifier
  --load-context            Load context from previous session
  --init-agents             Initialize required agents

Features:
- Create session directory
- Initialize metrics tracking
- Load previous context
- Set up coordination namespace
```

---

## session-restore

Load previous session state.

```bash
npx claude-flow hook session-restore --session-id <id>

Options:
  --session-id, -s <id>     Session to restore
  --restore-memory          Restore memory state (default: true)
  --restore-agents          Restore agent configurations

Examples:
  npx claude-flow hook session-restore --session-id "swarm-20241019"
  npx claude-flow hook session-restore -s "feature-auth" --restore-memory
```

**Features:**
- Load previous session context
- Restore memory state and decisions
- Reconfigure agents to previous state
- Resume in-progress tasks

---

## session-end

Cleanup and persist session state.

```bash
npx claude-flow hook session-end [options]

Options:
  --session-id, -s <id>     Session identifier to end
  --save-state              Save current session state (default: true)
  --export-metrics          Export session metrics
  --generate-summary        Create session summary
  --cleanup-temp            Remove temporary files

Examples:
  npx claude-flow hook session-end --session-id "dev-session-2024"
  npx claude-flow hook session-end -s "feature-auth" --export-metrics --generate-summary
  npx claude-flow hook session-end -s "quick-fix" --cleanup-temp
```

**Features:**
- Save current context and progress
- Export session metrics (duration, commands, tokens, files)
- Generate work summary with decisions and next steps
- Cleanup temporary files and optimize storage

---

## notify

Custom notifications with swarm status.

```bash
npx claude-flow hook notify --message <msg>

Options:
  --message, -m <text>      Notification message
  --level <level>           Notification level (info|warning|error)
  --swarm-status            Include swarm status (default: true)
  --broadcast               Send to all agents

Examples:
  npx claude-flow hook notify -m "Task completed" --level info
  npx claude-flow hook notify -m "Critical error" --level error --broadcast
```

**Features:**
- Send notifications to coordination system
- Include swarm status and metrics
- Broadcast to all agents
- Log important events

---

## Configuration

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "npx claude-flow hook session-start --session-id '${session.id}' --load-context"
          }
        ]
      }
    ],

    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "npx claude-flow hook session-end --session-id '${session.id}' --export-metrics --generate-summary --cleanup-temp"
          }
        ]
      }
    ]
  }
}
```

---

## Real-World Examples

### Full-Stack Development Workflow

```bash
# Session start - initialize coordination
npx claude-flow hook session-start --session-id "fullstack-feature"

# Pre-task planning
npx claude-flow hook pre-task \
  --description "Build user profile feature - frontend + backend + tests" \
  --auto-spawn-agents \
  --optimize-topology

# Backend work
npx claude-flow hook pre-edit --file "api/profile.js"
# ... implement backend ...
npx claude-flow hook post-edit \
  --file "api/profile.js" \
  --memory-key "profile/backend" \
  --train-patterns

# Frontend work (reads backend details from memory)
npx claude-flow hook pre-edit --file "components/Profile.jsx"
# ... implement frontend ...
npx claude-flow hook post-edit \
  --file "components/Profile.jsx" \
  --memory-key "profile/frontend" \
  --train-patterns

# Session end - export everything
npx claude-flow hook session-end \
  --session-id "fullstack-feature" \
  --export-metrics \
  --generate-summary
```

### Debugging with Hooks

```bash
# Start debugging session
npx claude-flow hook session-start --session-id "debug-memory-leak"

# Pre-task: analyze issue
npx claude-flow hook pre-task \
  --description "Debug memory leak in event handlers" \
  --load-memory \
  --estimate-complexity

# Search for event emitters
npx claude-flow hook pre-search --query "EventEmitter"
# ... search executes ...
npx claude-flow hook post-search \
  --query "EventEmitter" \
  --cache-results

# Fix the issue
npx claude-flow hook pre-edit \
  --file "services/events.js" \
  --backup-file
# ... fix code ...
npx claude-flow hook post-edit \
  --file "services/events.js" \
  --memory-key "debug/memory-leak-fix" \
  --validate-output

# End session
npx claude-flow hook session-end \
  --session-id "debug-memory-leak" \
  --export-metrics
```

### Multi-Agent Refactoring

```bash
# Initialize swarm for refactoring
npx claude-flow hook pre-task \
  --description "Refactor legacy codebase to modern patterns" \
  --auto-spawn-agents \
  --optimize-topology

# Agent 1: Code Analyzer
npx claude-flow hook pre-task --description "Analyze code complexity"
# ... analysis ...
npx claude-flow hook post-task \
  --task-id "analysis" \
  --store-decisions

# Agent 2: Refactoring (reads analysis from memory)
npx claude-flow hook session-restore \
  --session-id "swarm-refactor" \
  --restore-memory

for file in src/**/*.js; do
  npx claude-flow hook pre-edit --file "$file" --backup-file
  # ... refactor ...
  npx claude-flow hook post-edit \
    --file "$file" \
    --memory-key "refactor/$file" \
    --auto-format \
    --train-patterns
done

# Broadcast completion
npx claude-flow hook notify \
  --message "Refactoring complete - all tests passing" \
  --broadcast
```

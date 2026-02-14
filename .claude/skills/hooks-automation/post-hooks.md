# Post-Operation Hooks

Hooks that execute AFTER operations to process and learn.

---

## post-edit

Auto-format, validate, and update memory.

```bash
npx claude-flow hook post-edit [options]

Options:
  --file, -f <path>         File path that was edited
  --auto-format             Automatically format code (default: true)
  --memory-key, -m <key>    Store edit context in memory
  --train-patterns          Train neural patterns from edit
  --validate-output         Validate edited file

Examples:
  npx claude-flow hook post-edit --file "src/components/Button.jsx"
  npx claude-flow hook post-edit -f "api/auth.js" --memory-key "auth/login"
  npx claude-flow hook post-edit -f "utils/helpers.ts" --train-patterns
```

**Features:**
- Language-specific auto-formatting (Prettier, Black, gofmt)
- Memory storage for edit context and decisions
- Neural pattern training for continuous improvement
- Output validation with linting

### Formatters by Language

| Language | Formatter |
|----------|-----------|
| JavaScript/TypeScript | Prettier |
| Python | Black |
| Go | gofmt |
| Rust | rustfmt |
| Java | google-java-format |

---

## post-bash

Log execution and update metrics.

```bash
npx claude-flow hook post-bash --command <cmd>

Options:
  --command, -c <cmd>       Command that was executed
  --log-output              Log command output (default: true)
  --update-metrics          Update performance metrics
  --store-result            Store result in memory

Examples:
  npx claude-flow hook post-bash -c "npm test" --update-metrics
```

**Features:**
- Command execution logging
- Performance metric tracking
- Result storage for analysis
- Error pattern detection

---

## post-task

Performance analysis and decision storage.

```bash
npx claude-flow hook post-task [options]

Options:
  --task-id, -t <id>        Task identifier for tracking
  --analyze-performance     Generate performance metrics (default: true)
  --store-decisions         Save task decisions to memory
  --export-learnings        Export neural pattern learnings
  --generate-report         Create task completion report

Examples:
  npx claude-flow hook post-task --task-id "auth-implementation"
  npx claude-flow hook post-task -t "api-refactor" --analyze-performance
  npx claude-flow hook post-task -t "bug-fix-123" --store-decisions
```

**Features:**
- Execution time and token usage measurement
- Decision and implementation choice recording
- Neural learning pattern export
- Completion report generation

---

## post-search

Cache results and improve patterns.

```bash
npx claude-flow hook post-search --query <query> --results <path>

Options:
  --query, -q <text>        Original search query
  --results, -r <path>      Results file path
  --cache-results           Cache for future use (default: true)
  --train-patterns          Improve search patterns

Examples:
  npx claude-flow hook post-search -q "auth" -r "results.json" --train-patterns
```

**Features:**
- Result caching for faster subsequent searches
- Search pattern improvement
- Relevance scoring

---

## MCP Integration

Post-edit hook with memory storage internally calls:

```javascript
// Hook command
npx claude-flow hook post-edit --file "api/auth.js"

// Internally calls MCP tools:
mcp__claude-flow__memory_usage {
  action: "store",
  key: "swarm/edits/api/auth.js",
  namespace: "coordination",
  value: JSON.stringify({
    file: "api/auth.js",
    timestamp: Date.now(),
    changes: { added: 45, removed: 12 },
    formatted: true,
    linted: true
  })
}

mcp__claude-flow__neural_train {
  pattern_type: "coordination",
  training_data: { /* edit patterns */ }
}
```

---

## Configuration

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "^(Write|Edit|MultiEdit)$",
        "hooks": [{
          "type": "command",
          "command": "npx claude-flow hook post-edit --file '${tool.params.file_path}' --memory-key 'edits/${tool.params.file_path}' --auto-format --train-patterns",
          "async": true
        }]
      },
      {
        "matcher": "^Bash$",
        "hooks": [{
          "type": "command",
          "command": "npx claude-flow hook post-bash --command '${tool.params.command}' --update-metrics"
        }]
      },
      {
        "matcher": "^Task$",
        "hooks": [{
          "type": "command",
          "command": "npx claude-flow hook post-task --task-id '${result.task_id}' --analyze-performance --store-decisions --export-learnings",
          "async": true
        }]
      },
      {
        "matcher": "^Grep$",
        "hooks": [{
          "type": "command",
          "command": "npx claude-flow hook post-search --query '${tool.params.pattern}' --cache-results --train-patterns"
        }]
      }
    ]
  }
}
```

---

## Automatic Testing

Run tests after file modifications:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "^Write$",
        "hooks": [
          {
            "type": "command",
            "command": "test -f '${tool.params.file_path%.js}.test.js' && npm test '${tool.params.file_path%.js}.test.js'",
            "continueOnError": true
          }
        ]
      }
    ]
  }
}
```

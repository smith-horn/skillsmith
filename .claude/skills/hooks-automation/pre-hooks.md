# Pre-Operation Hooks

Hooks that execute BEFORE operations to prepare and validate.

---

## pre-edit

Validate and assign agents before file modifications.

```bash
npx claude-flow hook pre-edit [options]

Options:
  --file, -f <path>         File path to be edited
  --auto-assign-agent       Automatically assign best agent (default: true)
  --validate-syntax         Pre-validate syntax before edit
  --check-conflicts         Check for merge conflicts
  --backup-file             Create backup before editing

Examples:
  npx claude-flow hook pre-edit --file "src/auth/login.js"
  npx claude-flow hook pre-edit -f "config/db.js" --validate-syntax
  npx claude-flow hook pre-edit -f "production.env" --backup-file --check-conflicts
```

**Features:**
- Auto agent assignment based on file type
- Syntax validation to prevent broken code
- Conflict detection for concurrent edits
- Automatic file backups for safety

---

## pre-bash

Check command safety and resource requirements.

```bash
npx claude-flow hook pre-bash --command <cmd>

Options:
  --command, -c <cmd>       Command to validate
  --check-safety            Verify command safety (default: true)
  --estimate-resources      Estimate resource usage
  --require-confirmation    Request user confirmation for risky commands

Examples:
  npx claude-flow hook pre-bash -c "rm -rf /tmp/cache"
  npx claude-flow hook pre-bash --command "docker build ." --estimate-resources
```

**Features:**
- Command safety validation
- Resource requirement estimation
- Destructive command confirmation
- Permission checks

---

## pre-task

Auto-spawn agents and prepare for complex tasks.

```bash
npx claude-flow hook pre-task [options]

Options:
  --description, -d <text>  Task description for context
  --auto-spawn-agents       Automatically spawn required agents (default: true)
  --load-memory             Load relevant memory from previous sessions
  --optimize-topology       Select optimal swarm topology
  --estimate-complexity     Analyze task complexity

Examples:
  npx claude-flow hook pre-task --description "Implement user authentication"
  npx claude-flow hook pre-task -d "Continue API dev" --load-memory
  npx claude-flow hook pre-task -d "Refactor codebase" --optimize-topology
```

**Features:**
- Automatic agent spawning based on task analysis
- Memory loading for context continuity
- Topology optimization for task structure
- Complexity estimation and time prediction

---

## pre-search

Prepare and optimize search operations.

```bash
npx claude-flow hook pre-search --query <query>

Options:
  --query, -q <text>        Search query
  --check-cache             Check cache first (default: true)
  --optimize-query          Optimize search pattern

Examples:
  npx claude-flow hook pre-search -q "authentication middleware"
```

**Features:**
- Cache checking for faster results
- Query optimization
- Search pattern improvement

---

## Agent Assignment Logic

When `--auto-assign-agent` is enabled, agents are selected based on file type:

| File Pattern | Assigned Agent |
|--------------|----------------|
| `*.js`, `*.ts` | frontend-dev or backend-dev |
| `*.py` | python-dev |
| `*.jsx`, `*.tsx` | frontend-dev |
| `*.go` | backend-dev |
| `*.sql` | database-dev |
| `*.md` | documenter |
| `*.test.*` | tester |
| `Dockerfile`, `*.yaml` | devops |

---

## Validation Examples

### Syntax Validation Response

```json
{
  "continue": true,
  "reason": "Syntax valid",
  "metadata": {
    "file": "src/auth.js",
    "syntax_valid": true,
    "agent_assigned": "backend-dev"
  }
}
```

### Conflict Detection Response

```json
{
  "continue": false,
  "reason": "Merge conflicts detected",
  "metadata": {
    "file": "src/auth.js",
    "conflicts": ["lines 45-52", "lines 78-85"],
    "requires": "manual_resolution"
  }
}
```

---

## Configuration

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "^(Write|Edit|MultiEdit)$",
        "hooks": [{
          "type": "command",
          "command": "npx claude-flow hook pre-edit --file '${tool.params.file_path}' --auto-assign-agent --validate-syntax",
          "timeout": 3000,
          "continueOnError": true
        }]
      },
      {
        "matcher": "^Bash$",
        "hooks": [{
          "type": "command",
          "command": "npx claude-flow hook pre-bash --command '${tool.params.command}'"
        }]
      },
      {
        "matcher": "^Task$",
        "hooks": [{
          "type": "command",
          "command": "npx claude-flow hook pre-task --description '${tool.params.task}' --auto-spawn-agents --load-memory",
          "async": true
        }]
      }
    ]
  }
}
```

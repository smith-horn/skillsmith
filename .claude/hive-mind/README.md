# Hive Mind Orchestration

Multi-agent task orchestration for complex development workflows.

## Overview

Hive mind configs coordinate multiple AI agents working on related tasks with:
- **Hierarchical topology**: Queen agent coordinates worker agents
- **Memory sharing**: Agents share context via SQLite-backed memory
- **Quality gates**: Automated typecheck, lint, and test verification
- **Linear integration**: Auto-update issue status on start/complete

## Configuration Format

```yaml
name: my-workflow
description: What this workflow accomplishes

# Resource settings
topology: hierarchical
queen_model: sonnet      # Orchestrator model
worker_model: haiku      # Worker model (faster, cheaper)
max_concurrent_agents: 2 # Limit for laptop resources
resource_profile: laptop # laptop | workstation | server

# Memory coordination
memory:
  backend: sqlite
  persistence: true
  namespace: my-workflow

# Task waves (sequential groups of parallel tasks)
waves:
  - name: foundation
    description: 'First wave tasks'
    priority: 1
    max_agents: 2
    sequential: false  # Tasks within wave can parallelize
    issues:
      - id: SMI-1234
        title: 'Task title'
        files:
          - path/to/file.ts
        tasks:
          - First subtask
          - Second subtask

  - name: dependent-work
    depends_on: [foundation]  # Wait for foundation wave
    # ...

# Automation hooks
hooks:
  on_issue_start:
    - linear issues update ${issue_id} -s "In Progress"
  on_issue_complete:
    - linear issues update ${issue_id} -s "Done"
  on_wave_complete:
    - git add -A && git commit -m "feat: complete ${wave_name}"

# Quality gates
quality:
  require_typecheck: true
  require_lint: true
  run_tests: true
  code_review: false  # Enable for larger changes
```

## Resource Profiles

| Profile | Max Agents | Memory | Use Case |
|---------|------------|--------|----------|
| `laptop` | 2 | 8GB | M1/M4 MacBook local dev |
| `workstation` | 4 | 16GB | Desktop development |
| `server` | 8+ | 32GB+ | CI/CD, cloud execution |

## Usage

### Launch Script Pattern

Create a `start-hive-mind.sh` in your worktree:

```bash
#!/bin/bash
cd "$(dirname "$0")"
claude --print "Execute workflow from .claude/hive-mind/config.yaml..."
```

### Direct Execution

```bash
npx claude-flow swarm --config .claude/hive-mind/your-config.yaml
```

## Best Practices

1. **Use worktrees**: Create isolated git worktrees for hive mind execution
2. **Wave dependencies**: Group related tasks, declare dependencies between waves
3. **Quality gates**: Always enable typecheck/lint for code changes
4. **Resource limits**: Match `max_concurrent_agents` to your hardware
5. **Linear integration**: Use hooks to auto-update issue status

## When to Version

| Version (commit) | Gitignore |
|------------------|-----------|
| Team workflows | Personal experiments |
| Release processes | One-time tasks |
| Reusable templates | Local preferences |

## Example Configs

See existing configs in this directory for patterns:
- `phase6-config.yaml` - Multi-wave website completion
- `retro-followup-config.yaml` - Simple parallel tasks

# hooks post-task

Execute post-task cleanup, performance analysis, and memory storage.

## Usage

```bash
npx -y ruflo@3.14.2 hooks post-task [options]
```

## Options

- `--task-id, -i <id>` - Task identifier for tracking (short flag changed from `-t` to `-i`)
- `--success, -s` - Whether the task succeeded
- `--quality, -q <score>` - Quality score for the task
- `--agent, -a <name>` - Agent that performed the task
- `--parent-agent-id <id>` - Parent agent identifier
- `--depth <n>` - Coordination depth

Performance metrics (previously `--analyze-performance`, `--store-decisions`, `--export-learnings`, `--generate-report`) are now viewed via `hooks metrics`.

## Examples

### Basic post-task hook

```bash
hooks post-task --task-id "auth-implementation"
```

### Success tracking

```bash
hooks post-task -i "api-refactor" --success true
```

View performance metrics separately via `hooks metrics`.

### Quality score

```bash
hooks post-task -i "bug-fix-123" --success true -q 0.9
```

### Quick cleanup

```bash
hooks post-task --task-id "minor-update" --success true
```

## Features

### Performance Analysis

- Measures execution time
- Tracks token usage
- Identifies bottlenecks
- Suggests optimizations

### Decision Storage

- Saves key decisions made
- Records implementation choices
- Stores error resolutions
- Maintains knowledge base

### Neural Learning

- Exports successful patterns
- Updates coordination models
- Improves future performance
- Trains on task outcomes

### Report Generation

- Creates completion summary
- Documents changes made
- Lists files modified
- Tracks metrics achieved

## Integration

This hook is automatically called by Claude Code when:

- Completing a task
- Switching to a new task
- Ending a work session
- After major milestones

Manual usage in agents:

```bash
# In agent coordination
hooks post-task --task-id "your-task-id" --success true
```

## Output

Returns JSON with:

```json
{
  "taskId": "auth-implementation",
  "duration": 1800000,
  "tokensUsed": 45000,
  "filesModified": 12,
  "performanceScore": 0.92,
  "learningsExported": true,
  "reportPath": "/reports/task-auth-implementation.md"
}
```

## See Also

- `hooks pre-task` - Pre-task setup
- `performance report` - Detailed metrics
- `memory usage` - Memory management
- `neural patterns` - Pattern analysis

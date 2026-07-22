# hooks session-end

Cleanup and persist session state before ending work.

## Usage

```bash
npx -y ruflo@3.14.2 hooks session-end [options]
```

## Options

- `--save-state, -s` - Save current session state (default: true)

v3 `session-end` takes no session-id argument (**`-s` now means `--save-state`, not session-id**). Session metrics are viewed via `hooks metrics`.

## Examples

### Basic session end

```bash
hooks session-end
```

### With metrics export

```bash
hooks session-end
```

View exported metrics separately via `hooks metrics`.

### Quick close

```bash
hooks session-end --save-state false
```

### Complete persistence

```bash
hooks session-end --save-state true
```

## Features

### State Persistence

- Saves current context
- Stores open files
- Preserves task progress
- Maintains decisions

### Metric Export

- Session duration
- Commands executed
- Files modified
- Tokens consumed
- Performance data

### Summary Generation

- Work accomplished
- Key decisions made
- Problems solved
- Next steps identified

### Cleanup Operations

- Removes temp files
- Clears caches
- Frees resources
- Optimizes storage

## Integration

This hook is automatically called by Claude Code when:

- Ending a conversation
- Closing work session
- Before shutdown
- Switching contexts

Manual usage in agents:

```bash
# At session end
hooks session-end
```

## Output

Returns JSON with:

```json
{
  "sessionId": "dev-session-2024",
  "duration": 7200000,
  "saved": true,
  "metrics": {
    "commandsRun": 145,
    "filesModified": 23,
    "tokensUsed": 85000,
    "tasksCompleted": 8
  },
  "summaryPath": "/sessions/dev-session-2024-summary.md",
  "cleanedUp": true,
  "nextSession": "dev-session-2025"
}
```

## See Also

- `hooks session-restore` - Session initialization/restoration (`session-start` is a deprecated alias for the same command)
- `performance report` - Detailed metrics
- `memory backup` - State backup

# hooks session-end

> The Stop hook that ran this on every session end was removed 2026-09-21 (SMI-6744 A1.9b).
> Running `hooks session-end` on the host writes macOS rows into the store that ADR-170 has a
> Linux container serve; do not run it on the host until A5.5.6 decides re-introduction.

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
# do not run on the host -- see the note at the top of this file (SMI-6744 A1.9b)
hooks session-end
```

### With metrics export

```bash
# do not run on the host -- see the note at the top of this file (SMI-6744 A1.9b)
hooks session-end
```

View exported metrics separately via `hooks metrics`.

### Quick close

```bash
# do not run on the host -- see the note at the top of this file (SMI-6744 A1.9b)
hooks session-end --save-state false
```

### Complete persistence

```bash
# do not run on the host -- see the note at the top of this file (SMI-6744 A1.9b)
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

Nothing in this repo calls this automatically. The Stop hook that did was removed
2026-09-21 (SMI-6744 A1.9b) — see the note at the top of this file. Upstream ruflo
documents it as Claude-Code-invoked at conversation end; that is the wiring this repo
deliberately does not have, and re-introduction is A5.5.6's to propose.

Manual usage in agents:

```bash
# At session end
# do not run on the host -- see the note at the top of this file (SMI-6744 A1.9b)
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

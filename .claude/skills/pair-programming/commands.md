# Pair Programming Commands

Complete reference for all in-session commands.

---

## Code Commands

```
/explain [--level basic|detailed|expert]
  Explain the current code or selection

/suggest [--type refactor|optimize|security|style]
  Get improvement suggestions

/implement <description>
  Request implementation (navigator mode)

/refactor [--pattern <pattern>] [--scope function|file|module]
  Refactor selected code

/optimize [--target speed|memory|both]
  Optimize code for performance

/document [--format jsdoc|markdown|inline]
  Add documentation to code

/comment [--verbose]
  Add inline comments

/pattern <pattern-name> [--example]
  Apply a design pattern
```

---

## Testing Commands

```
/test [--watch] [--coverage] [--only <pattern>]
  Run test suite

/test-gen [--type unit|integration|e2e]
  Generate tests for current code

/coverage [--report html|json|terminal]
  Check test coverage

/mock <target> [--realistic]
  Generate mock data or functions

/test-watch [--on-save]
  Enable test watching

/snapshot [--update]
  Create test snapshots
```

---

## Review Commands

```
/review [--scope current|file|changes] [--strict]
  Perform code review

/security [--deep] [--fix]
  Security analysis

/perf [--profile] [--suggestions]
  Performance analysis

/quality [--detailed]
  Check code quality metrics

/lint [--fix] [--config <config>]
  Run linters

/complexity [--threshold <value>]
  Analyze code complexity
```

---

## Navigation Commands

```
/goto <file>[:line[:column]]
  Navigate to file or location

/find <pattern> [--regex] [--case-sensitive]
  Search in project

/recent [--limit <n>]
  Show recent files

/bookmark [add|list|goto|remove] [<name>]
  Manage bookmarks

/history [--limit <n>] [--filter <pattern>]
  Show command history

/tree [--depth <n>] [--filter <pattern>]
  Show project structure
```

---

## Git Commands

```
/diff [--staged] [--file <file>]
  Show git diff

/commit [--message <msg>] [--amend]
  Commit with verification

/branch [create|switch|delete|list] [<name>]
  Branch operations

/stash [save|pop|list|apply] [<message>]
  Stash operations

/log [--oneline] [--limit <n>]
  View git log

/blame [<file>]
  Show git blame
```

---

## AI Partner Commands

```
/agent [switch|info|config] [<agent-name>]
  Manage AI agent

/teach <preference>
  Teach the AI your preferences

/feedback [positive|negative] <message>
  Provide feedback to AI

/personality [professional|friendly|concise|verbose]
  Adjust AI personality

/expertise [add|remove|list] [<domain>]
  Set AI expertise focus
```

---

## Metrics Commands

```
/metrics [--period today|session|week|all]
  Show session metrics

/score [--breakdown]
  Show quality scores

/productivity [--chart]
  Show productivity metrics

/leaderboard [--personal|team]
  Show improvement leaderboard
```

---

## Role & Mode Commands

```
/switch [--immediate]
  Switch driver/navigator roles

/mode <type>
  Change mode (driver|navigator|switch|tdd|review|mentor|debug)

/role
  Show current role

/handoff
  Prepare role handoff
```

---

## Session Commands

```
/status
  Show session status

/pause [--reason <reason>]
  Pause the session

/resume
  Resume paused session

/save [--name <name>]
  Save session state

/export [--format json|md]
  Export session

/help [<command>]
  Show help
```

---

## Command Shortcuts

| Alias | Full Command |
|-------|-------------|
| `/s` | `/suggest` |
| `/e` | `/explain` |
| `/t` | `/test` |
| `/r` | `/review` |
| `/c` | `/commit` |
| `/g` | `/goto` |
| `/f` | `/find` |
| `/h` | `/help` |
| `/sw` | `/switch` |
| `/st` | `/status` |

---

## Command Chaining

Chain multiple commands with `&&`:

```
/test && /commit && /push
/lint --fix && /test && /review --strict
/test-gen && /test --watch
```

---

## Custom Commands

Define custom commands in configuration:

```json
{
  "customCommands": {
    "tdd": "/test-gen && /test --watch",
    "full-review": "/lint --fix && /test && /review --strict",
    "quick-fix": "/suggest --type fix && /implement && /test"
  }
}
```

Use custom commands:
```
/custom tdd
/custom full-review
/custom quick-fix
```

---

## Keyboard Navigation

Navigate command history:
- `↑/↓` - Navigate through command history
- `Ctrl+R` - Search command history
- `!!` - Repeat last command
- `!<n>` - Run command n from history

---

## Keyboard Shortcuts (Configurable)

Default shortcuts:
```json
{
  "shortcuts": {
    "switch": "ctrl+shift+s",
    "suggest": "ctrl+space",
    "review": "ctrl+r",
    "test": "ctrl+t"
  }
}
```

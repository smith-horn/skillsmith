# hooks pre-edit

Execute pre-edit validations and agent assignment before file modifications.

## Usage

```bash
npx -y ruflo@3.14.2 hooks pre-edit [options]
```

## Options

- `--file, -f <path>` - File path to be edited
- `--operation, -o <type>` - Operation type: create, update, delete, refactor (default: update)
- `--context, -c <text>` - Additional context for the edit

v3 `pre-edit` returns context and agent *suggestions* only — it does not auto-assign agents, validate syntax, check conflicts, or create backups.

## Examples

### Basic pre-edit hook

```bash
hooks pre-edit --file "src/auth/login.js"
```

### With validation

```bash
hooks pre-edit -f "config/database.js"
```

Syntax validation is not a v3 hook capability.

### Manual agent assignment

```bash
hooks pre-edit -f "api/users.ts"
```

### Safe editing with context

```bash
hooks pre-edit -f "production.env" -c "high-risk production config edit"
```

## Features

### Auto Agent Assignment

- Analyzes file type and content
- Assigns specialist agents
- TypeScript → TypeScript expert
- Database → Data specialist
- Tests → QA engineer

### Syntax Validation

- Pre-checks syntax validity
- Identifies potential errors
- Suggests corrections
- Prevents broken code

### Conflict Detection

- Checks for git conflicts
- Identifies concurrent edits
- Warns about stale files
- Suggests merge strategies

### File Backup

- Creates safety backups
- Enables quick rollback
- Tracks edit history
- Preserves originals

## Integration

This hook is automatically called by Claude Code when:

- Using Edit or MultiEdit tools
- Before file modifications
- During refactoring operations
- When updating critical files

Manual usage in agents:

```bash
# Before editing files
hooks pre-edit --file "path/to/file.js"
```

## Output

Returns JSON with:

```json
{
  "continue": true,
  "file": "src/auth/login.js",
  "assignedAgent": "auth-specialist",
  "syntaxValid": true,
  "conflicts": false,
  "backupPath": ".backups/login.js.bak",
  "warnings": []
}
```

## See Also

- `hooks post-edit` - Post-edit processing
- `Edit` - File editing tool
- `MultiEdit` - Multiple edits tool
- `agent spawn` - Manual agent creation

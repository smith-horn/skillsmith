# pattern-learn

Learn patterns from successful operations.

## Usage
```bash
npx -y ruflo@3.14.2 neural patterns --action learn [options]
```

## Options
- `--action, -a <mode>` - Pattern operation: `analyze`, `learn`, `predict`, `list` (default: `list`)
- `--query, -q <text>` - Query to scope the pattern operation
- `--limit, -l <n>` - Maximum number of patterns to return

## Examples
```bash
# Learn patterns from recent operations
npx -y ruflo@3.14.2 neural patterns --action learn

# Learn patterns scoped to a query
npx -y ruflo@3.14.2 neural patterns --action learn --query "successful task completions"

# Limit results
npx -y ruflo@3.14.2 neural patterns --action learn --limit 10
```

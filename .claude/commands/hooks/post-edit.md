# hooks post-edit

Execute post-edit processing including formatting, validation, and memory updates.

## Usage

```bash
npx -y ruflo@3.14.2 hooks post-edit [options]
```

## Options

- `--file, -f <path>` - File path that was edited
- `--success, -s` - Whether the edit succeeded
- `--outcome, -o <text>` - Outcome description for the edit
- `--metrics, -m <text>` - Metrics for the edit (**`-m` now means metrics, not memory-key**)

Explicit memory storage moved to the `memory` family / MCP memory tools.

## Examples

### Basic post-edit hook

```bash
hooks post-edit --file "src/components/Button.jsx"
```

### With outcome

```bash
hooks post-edit -f "api/auth.js" --success true -o "implemented login flow"
```

### Success with metrics

```bash
hooks post-edit -f "config/webpack.js" --success true -m "time:500ms,quality:0.95"
```

### Basic success

```bash
hooks post-edit -f "utils/helpers.ts" --success true
```

Pattern training is implicit in v3 `post-edit` — no separate flag needed.

## Features

### Auto Formatting

- Language-specific formatters
- Prettier for JS/TS/JSON
- Black for Python
- gofmt for Go
- Maintains consistency

### Memory Storage

- Saves edit context
- Records decisions made
- Tracks implementation details
- Enables knowledge sharing

### Pattern Training

- Learns from successful edits
- Improves future suggestions
- Adapts to coding style
- Enhances coordination

### Output Validation

- Checks syntax correctness
- Runs linting rules
- Validates formatting
- Ensures quality

## Integration

This hook is automatically called by Claude Code when:

- After Edit tool completes
- Following MultiEdit operations
- During file saves
- After code generation

Manual usage in agents:

```bash
# After editing files
hooks post-edit --file "path/to/edited.js" --success true -o "feature/step1"
```

## Output

Returns JSON with:

```json
{
  "file": "src/components/Button.jsx",
  "formatted": true,
  "formatterUsed": "prettier",
  "lintPassed": true,
  "memorySaved": "component/button-refactor",
  "patternsTrained": 3,
  "warnings": [],
  "stats": {
    "linesChanged": 45,
    "charactersAdded": 234
  }
}
```

## See Also

- `hooks pre-edit` - Pre-edit preparation
- `Edit` - File editing tool
- `memory usage` - Memory management
- `neural train` - Pattern training

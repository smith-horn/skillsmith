# @skillsmith/cli

Command-line interface for Skillsmith - discover, manage, and author Claude Code skills.

## Installation

```bash
npm install -g @skillsmith/cli
```

Or use directly with npx:

```bash
npx @skillsmith/cli search "testing"
```

## Command Alias

The CLI provides two command names:
- `skillsmith` - Full command name
- `sklx` - Short alias for faster typing

Both commands are identical:

```bash
# These are equivalent
skillsmith search "testing"
sklx search "testing"
```

## Commands

### search

Search for skills with optional interactive mode.

```bash
# Basic search
skillsmith search "git commit"

# With filters
skillsmith search "testing" --category testing --trust verified

# Interactive mode
skillsmith search --interactive
```

**Options:**
- `-c, --category <category>` - Filter by category
- `-t, --trust <tier>` - Filter by trust tier (verified, community, experimental)
- `-l, --limit <n>` - Maximum results (default: 10)
- `-i, --interactive` - Interactive selection mode

### list

List installed skills.

```bash
skillsmith list

# With details
skillsmith list --verbose
```

**Options:**
- `-v, --verbose` - Show detailed information

### install

Install a skill (alias for MCP server's install_skill).

```bash
skillsmith install author/skill-name
```

### remove

Remove an installed skill.

```bash
skillsmith remove author/skill-name

# Skip confirmation
skillsmith remove author/skill-name --force
```

**Options:**
- `-f, --force` - Skip confirmation prompt

### update

Update installed skills.

```bash
# Update all skills
skillsmith update

# Update specific skill
skillsmith update author/skill-name
```

### init

Initialize a new skill project.

```bash
# Interactive mode
skillsmith init

# With name
skillsmith init my-skill

# In specific directory
skillsmith init my-skill --path ./skills/my-skill
```

**Options:**
- `-p, --path <path>` - Directory to create skill in
- `--template <template>` - Skill template (basic, advanced)

### validate

Validate a skill's SKILL.md file.

```bash
# Validate current directory
skillsmith validate

# Validate specific path
skillsmith validate ./path/to/skill

# Strict mode (warnings as errors)
skillsmith validate --strict
```

**Options:**
- `-s, --strict` - Treat warnings as errors

### publish

Prepare a skill for publishing/sharing.

```bash
skillsmith publish

# Dry run (no changes)
skillsmith publish --dry-run
```

**Options:**
- `-d, --dry-run` - Preview without making changes

### import

Import skills from GitHub (for populating local database).

```bash
# Import from default topic
skillsmith import

# Custom topic and limits
skillsmith import --topic claude-skill --max 500
```

**Options:**
- `-t, --topic <topic>` - GitHub topic to search (default: claude-skill)
- `-m, --max <n>` - Maximum skills to import
- `-d, --db <path>` - Database path
- `-v, --verbose` - Verbose output

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `SKILLSMITH_DB_PATH` | Database file location | `~/.skillsmith/skills.db` |
| `GITHUB_TOKEN` | GitHub token for imports | - |

### Database Location

By default, the CLI uses `~/.skillsmith/skills.db`. Override with:

```bash
SKILLSMITH_DB_PATH=/custom/path/skills.db skillsmith search "testing"
```

## Examples

### Discover and Install Skills

```bash
# Search for testing-related skills
skillsmith search "jest testing" --category testing

# Get more details on a skill
skillsmith search "jest-helper" --verbose

# Install a skill
skillsmith install community/jest-helper

# List installed skills
skillsmith list
```

### Author a New Skill

```bash
# Initialize new skill
skillsmith init my-awesome-skill

# Edit the generated SKILL.md...

# Validate your skill
skillsmith validate ./my-awesome-skill

# Prepare for publishing
skillsmith publish ./my-awesome-skill
```

### Manage Skills

```bash
# Update all installed skills
skillsmith update

# Remove a skill
skillsmith remove community/old-skill

# Interactive search and install
skillsmith search --interactive
```

## License

Apache-2.0

## Links

- [GitHub](https://github.com/smith-horn-group/skillsmith)
- [Issues](https://github.com/smith-horn-group/skillsmith/issues)

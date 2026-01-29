# @skillsmith/cli

Command-line interface for Skillsmith - discover, manage, and author Claude Code skills.

## What's New in v0.3.1

- **Database Fix**: Fixed "no such table: skills" error on fresh installations
- **API Resilience**: Improved handling of partial API responses
- **Import Improvements**: Better rate limiting (150ms default, configurable via `SKILLSMITH_IMPORT_DELAY_MS`)
- **Python Support**: Added Python file detection (`.py`, `.pyi`, `.pyw`) to `analyze` command

## What's New in v0.3.0

- **Registry Sync**: Keep your local skill database up-to-date with `sync` command
- **Auto-Sync**: Configurable daily/weekly background sync during MCP sessions
- **Sync History**: Track sync operations with `sync history`

## What's New in v0.2.7

- **MCP Server Scaffolding**: Generate TypeScript MCP servers with `author mcp-init`
- **Custom Tool Generation**: Auto-generates stub implementations for specified tools
- **Decision Helper Integration**: Seamless flow from evaluation to scaffolding
- **Subagent Generation**: Generate companion specialist agents for parallel execution (37-97% token savings)
- **Skill Transform**: Upgrade existing skills with subagent configuration
- **Dynamic Version**: Version now reads from package.json automatically
- **Tool Detection**: Automatic analysis of required tools from skill content
- **Live Skills**: Search and install from 14,000+ real skills
- **Faster Search**: Full-text search with quality ranking
- **Privacy First**: Opt-out telemetry, no PII collected

## Installation

```bash
npm install -g @skillsmith/cli
```

Or use directly with npx:

```bash
npx @skillsmith/cli search "testing"
```

## Updating the CLI

Check your current version:

```bash
skillsmith --version
```

Update to the latest version:

```bash
# If installed globally
npm update -g @skillsmith/cli

# Or reinstall to specific version
npm install -g @skillsmith/cli@latest

# Using npx always gets the latest
npx @skillsmith/cli@latest sync
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

### author subagent

Generate a companion specialist agent for parallel skill execution.

```bash
# Generate subagent for current directory
skillsmith author subagent

# Generate for specific skill
skillsmith author subagent ./my-skill

# Override detected tools
skillsmith author subagent --tools "Read,Write,Bash"

# Use different model
skillsmith author subagent --model haiku
```

**Options:**
- `-o, --output <path>` - Output directory (default: ~/.claude/agents)
- `--tools <tools>` - Override detected tools (comma-separated)
- `--model <model>` - Model: sonnet, opus, haiku (default: sonnet)
- `--skip-claude-md` - Skip CLAUDE.md snippet generation
- `--force` - Overwrite existing subagent

**Output:**
- Creates `~/.claude/agents/[skill-name]-specialist.md`
- Displays CLAUDE.md integration snippet

### author transform

Upgrade existing skills with subagent configuration (non-destructive).

```bash
# Preview what would be generated
skillsmith author transform ./my-skill --dry-run

# Generate subagent for existing skill
skillsmith author transform ./my-skill

# Process multiple skills at once
skillsmith author transform ~/.claude/skills --batch
```

**Options:**
- `--dry-run` - Preview without creating files
- `--force` - Overwrite existing subagent
- `--batch` - Process directory of skills
- `--tools <tools>` - Override detected tools
- `--model <model>` - Model: sonnet, opus, haiku (default: sonnet)

### author mcp-init

Scaffold a new MCP server project with TypeScript and stdio transport.

```bash
# Interactive mode
skillsmith author mcp-init

# With name
skillsmith author mcp-init my-mcp-server

# With pre-defined tools
skillsmith author mcp-init my-server --tools "greet,search,process"

# Custom output directory
skillsmith author mcp-init my-server --output ./servers
```

**Options:**
- `-o, --output <path>` - Output directory (default: current directory)
- `--tools <tools>` - Initial tool names (comma-separated)
- `--force` - Overwrite existing directory

**Generated Structure:**
```
my-mcp-server/
├── package.json         # npm package with MCP SDK
├── tsconfig.json        # TypeScript configuration
├── src/
│   ├── index.ts         # Entry point (npx-ready)
│   ├── server.ts        # MCP server setup
│   └── tools/
│       ├── index.ts     # Tool definitions
│       └── example.ts   # Example tool implementation
├── README.md            # Usage documentation
└── .gitignore
```

**After Generation:**
```bash
cd my-mcp-server
npm install
npm run dev  # Start in development mode
```

**Configure in Claude Code** (`~/.claude/settings.json`):
```json
{
  "mcpServers": {
    "my-mcp-server": {
      "command": "npx",
      "args": ["tsx", "/path/to/my-mcp-server/src/index.ts"]
    }
  }
}
```

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

### sync

Synchronize your local skill database with the live Skillsmith registry.

```bash
# Sync skills from registry (differential - only changes)
skillsmith sync

# Force full sync (ignore last sync time)
skillsmith sync --force

# Preview what would be synced
skillsmith sync --dry-run
```

**Options:**
- `-f, --force` - Force full sync, ignore last sync timestamp
- `--dry-run` - Preview changes without writing to database
- `-d, --db <path>` - Database path
- `--json` - Output results as JSON

#### sync status

Show sync status and statistics.

```bash
skillsmith sync status
```

**Output includes:**
- Auto-sync enabled/disabled
- Sync frequency (daily/weekly)
- Last sync time
- Next scheduled sync
- Last run statistics

#### sync history

View sync operation history.

```bash
# Show recent sync history
skillsmith sync history

# Show more entries
skillsmith sync history --limit 20
```

**Options:**
- `-l, --limit <n>` - Number of history entries (default: 10)

#### sync config

Configure automatic sync settings.

```bash
# Show current configuration
skillsmith sync config --show

# Enable automatic background sync
skillsmith sync config --enable

# Disable automatic sync
skillsmith sync config --disable

# Set sync frequency
skillsmith sync config --frequency daily
skillsmith sync config --frequency weekly

# Combine options
skillsmith sync config --enable --frequency weekly
```

**Options:**
- `--show` - Display current configuration
- `--enable` - Enable automatic background sync
- `--disable` - Disable automatic sync
- `--frequency <freq>` - Set frequency: `daily` or `weekly`

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `SKILLSMITH_DB_PATH` | Database file location | `~/.skillsmith/skills.db` |
| `SKILLSMITH_IMPORT_DELAY_MS` | Delay between GitHub API calls during import | `150` |
| `GITHUB_TOKEN` | GitHub token for imports | - |

### Database Location

By default, the CLI uses `~/.skillsmith/skills.db`. Override with:

```bash
SKILLSMITH_DB_PATH=/custom/path/skills.db skillsmith search "testing"
```

## Privacy & Data Handling

Skillsmith is designed with privacy as a core principle.

### What Stays on Your Computer (Never Transmitted)

| Data | Location | Purpose |
|------|----------|---------|
| Skill usage history | `~/.skillsmith/analytics.db` | Personal ROI tracking |
| Time saved metrics | `~/.skillsmith/analytics.db` | Your productivity insights |
| Value calculations | Computed locally | ROI dashboard |
| Project context | Hashed locally | Anonymous grouping |

**The ROI Dashboard feature is 100% local.** Your usage patterns, time saved, and value metrics never leave your computer. This data exists solely for your benefit.

### What Is Transmitted (Required for Functionality)

| Data | When | Why |
|------|------|-----|
| Search queries | When you search | To return matching skills |
| Skill IDs | When viewing/installing | To fetch skill details |

### Optional Telemetry (Opt-In)

Anonymous product analytics (search counts, feature usage) are **opt-in only**. Telemetry is disabled by default and requires explicit configuration (`SKILLSMITH_TELEMETRY_ENABLED=true`).

To run fully offline: Set `SKILLSMITH_OFFLINE_MODE=true` to disable all network calls.

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

# Generate companion subagent for parallel execution
skillsmith author subagent ./my-awesome-skill

# Prepare for publishing
skillsmith publish ./my-awesome-skill
```

### Upgrade Existing Skills with Subagents

```bash
# Preview subagent generation (dry run)
skillsmith author transform ~/.claude/skills/docker --dry-run

# Generate subagent for a skill
skillsmith author transform ~/.claude/skills/docker

# Batch upgrade all skills
skillsmith author transform ~/.claude/skills --batch --force
```

### Create an MCP Server

```bash
# Scaffold a new MCP server
skillsmith author mcp-init my-slack-integration --tools "send_message,list_channels"

# Navigate and install dependencies
cd my-slack-integration
npm install

# Start development server
npm run dev

# Add to Claude Code settings
# Edit ~/.claude/settings.json to include the server
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

### Keep Skills Up-to-Date

```bash
# Sync with the live registry
skillsmith sync

# Check sync status
skillsmith sync status

# Enable daily auto-sync
skillsmith sync config --enable --frequency daily

# View sync history
skillsmith sync history
```

## License

[Elastic License 2.0](https://www.elastic.co/licensing/elastic-license)

## Links

- [GitHub](https://github.com/smith-horn/skillsmith)
- [Issues](https://github.com/smith-horn/skillsmith/issues)

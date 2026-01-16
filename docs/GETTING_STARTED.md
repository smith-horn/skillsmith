# Getting Started with Skillsmith

This guide walks you through setting up Skillsmith for skill discovery in Claude Code.

## Prerequisites

- **Node.js** >= 20.0.0
- **Claude Code** installed and configured
- **Docker** (optional, but recommended for development)

## Installation Options

### Option 1: Use as MCP Server (Recommended)

Add Skillsmith directly to your Claude Code MCP configuration:

```bash
# Edit your Claude Code settings
open ~/.claude/settings.json
```

Add the Skillsmith MCP server:

```json
{
  "mcpServers": {
    "skillsmith": {
      "command": "npx",
      "args": ["-y", "@skillsmith/mcp-server"]
    }
  }
}
```

Restart Claude Code to load the new MCP server.

### Option 2: Install CLI Globally

Install the CLI for command-line access:

```bash
npm install -g @skillsmith/cli
```

The CLI provides two command names:
- `skillsmith` - Full command name
- `sklx` - Short alias for faster typing

```bash
# Both commands are equivalent
skillsmith search "testing"
sklx search "testing"

# Other examples
sklx list
sklx install community/jest-helper
```

### Option 3: Development Setup

For contributing to Skillsmith:

```bash
# Clone and build
git clone https://github.com/smith-horn/skillsmith.git
cd skillsmith
npm install
npm run build

# Run CLI commands locally
node packages/cli/dist/index.js search "testing"
```

## Verifying Installation

### Test MCP Connection

In Claude Code, ask:

```
"Search for commit skills"
```

Claude should use the Skillsmith `search` tool and return results.

### Test CLI (Development)

```bash
# From the repository root, after building
node packages/cli/dist/index.js search "git" --limit 5
```

The search will return matching skills from the database.

## Using Skillsmith

### Search for Skills

Search by keyword, category, or description.

In Claude Code:
```
"Find testing skills"
"Find verified testing skills with a quality score above 80"
"Search for skills in the devops category"
```

Or using the CLI (development):
```bash
node packages/cli/dist/index.js search "testing"
node packages/cli/dist/index.js search "testing" --tier verified
node packages/cli/dist/index.js search "testing" --min-score 80
```

### Get Skill Details

View full skill information.

In Claude Code:
```
"Show details for community/jest-helper"
"Get information about the commit skill"
```

The response includes:
- Name and description
- Trust tier and quality score
- Category and tags
- Repository URL
- Install command

### Install a Skill

In Claude Code:
```
"Install the jest-helper skill"
"Install community/jest-helper"
```

This will:
1. Download the skill to `~/.claude/skills/jest-helper/`
2. Validate the skill structure
3. Make it available for Claude Code to use

### Compare Skills

Compare multiple skills side-by-side.

In Claude Code:
```
"Compare jest-helper and vitest-helper"
"Compare the commit and review-pr skills"
```

### Get Recommendations

Get contextual skill recommendations.

In Claude Code:
```
"Recommend skills for React TypeScript development"
"What skills would help with testing?"
```

## Trust Tiers

Skills are organized by trust level:

| Tier | Description | Verification |
|------|-------------|--------------|
| **verified** | Official Anthropic skills | Full review by Anthropic |
| **community** | Established community skills | Community review + quality checks |
| **experimental** | New or beta skills | Basic structure validation |
| **unknown** | Unverified skills | No verification |

### Filtering by Trust

In Claude Code:
```
"Find verified git skills"
"Search for community testing skills"
```

## Quality Scores

Quality scores (0-100) are based on:

- **Documentation** (30%) - README, usage examples, API docs
- **Testing** (25%) - Test coverage, test quality
- **Maintenance** (25%) - Recent updates, issue response time
- **Security** (20%) - No vulnerable dependencies, safe patterns

### Filtering by Score

In Claude Code:
```
"Find high-quality API skills with score above 80"
"Search for skills with minimum score 90"
```

## Categories

Skills are categorized for easy discovery:

| Category | Description |
|----------|-------------|
| `development` | Code generation, refactoring |
| `testing` | Test generation, coverage tools |
| `documentation` | API docs, README generation |
| `devops` | CI/CD, Docker, deployment |
| `database` | Schema, migrations, queries |
| `security` | Scanning, auditing |
| `productivity` | Workflow automation |
| `integration` | API integration, webhooks |
| `ai-ml` | LLM tools, prompt engineering |

### Filtering by Category

In Claude Code:
```
"Find testing tools"
"Search for devops skills"
```

## Development Setup

For contributing to Skillsmith:

### Clone the Repository

```bash
git clone https://github.com/smith-horn/skillsmith.git
cd skillsmith
```

### Docker Development (Recommended)

```bash
# Start development container
docker compose --profile dev up -d

# Install dependencies (inside container)
docker exec skillsmith-dev-1 npm install

# Build all packages
docker exec skillsmith-dev-1 npm run build

# Run tests
docker exec skillsmith-dev-1 npm test
```

### Local Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Test
npm test
```

### Load Seed Data (Development Only)

> ⚠️ **Important**: Seed data is for **local development and testing only**. It is NOT the production registry. Production users connecting via `npx @skillsmith/mcp-server` use the live Supabase registry automatically.

For development, load sample skills to your local SQLite database:

```bash
npm run seed
```

This loads ~27 sample skills covering different categories and trust tiers, including:
- **Verified**: Anthropic, Hugging Face, Vercel official skills
- **Community**: Popular community-contributed skills
- **Experimental**: Beta/testing skills

**Production vs Development Data Sources:**

| Environment | Data Source | Skills |
|-------------|-------------|--------|
| Production (npx) | Supabase Registry | Live indexed skills |
| Development | Local SQLite | Seed data only |

See [ADR-018: Registry Sync System](adr/018-registry-sync-system.md) for details on how the live registry is populated.

## Troubleshooting

### MCP Server Not Connecting

1. Check your settings file:
   ```bash
   cat ~/.claude/settings.json
   ```

2. Verify the server can start:
   ```bash
   npx @skillsmith/mcp-server
   ```

3. Restart Claude Code

### Skills Database Not Found

The database is created automatically at `~/.skillsmith/skills.db`. If missing:

```bash
# Create the directory
mkdir -p ~/.skillsmith

# Run seed to initialize
npm run seed
```

### Native Module Errors

If you see `ERR_DLOPEN_FAILED`:

```bash
# Use Docker for development
docker compose --profile dev up -d
docker exec skillsmith-dev-1 npm rebuild
```

### Search Returns No Results

1. Verify the database has skills:
   ```bash
   npm run seed
   ```

2. Check your query (minimum 2 characters):
   ```bash
   sklx search "test"  # OK
   sklx search "t"     # Too short
   ```

## Next Steps

- Explore the [MCP Tools Reference](../README.md#mcp-tools)
- Read the [Architecture Standards](architecture/standards.md)
- Check out [Architecture Decision Records](adr/index.md)
- Browse the [Security Checklist](security/checklists/code-review.md)

## Getting Help

- [GitHub Issues](https://github.com/smith-horn/skillsmith/issues) - Report bugs
- [Discussions](https://github.com/smith-horn/skillsmith/discussions) - Ask questions
- [CLAUDE.md](../CLAUDE.md) - AI development context

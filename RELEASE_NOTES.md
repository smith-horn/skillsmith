# Release Notes - January 16, 2026

## Package Versions

| Package | Version | Changes |
|---------|---------|---------|
| `@skillsmith/core` | 2.1.0 | Registry Sync System |
| `@skillsmith/cli` | 0.3.0 | Sync command, subagent generation, init improvements |
| `@skillsmith/mcp-server` | 0.3.2 | Documentation delivery, first-run experience |

---

## @skillsmith/mcp-server v0.3.0 → v0.3.2

### Documentation Delivery on First Run

The MCP server now automatically installs Claude-friendly documentation when first launched:

```
[skillsmith] First run detected, installing essentials...
[skillsmith] Installed bundled skill: skillsmith
[skillsmith] Installed user documentation to ~/.skillsmith/docs/
[skillsmith] Installed: varlock
[skillsmith] Installed: commit
[skillsmith] Installed: skill-builder
[skillsmith] Installed: governance

Welcome to Skillsmith!
```

**What Gets Installed:**

| Asset | Location | Purpose |
|-------|----------|---------|
| Skillsmith skill | `~/.claude/skills/skillsmith/SKILL.md` | Claude-readable guide with MCP tool reference |
| Security docs | `~/.claude/skills/skillsmith/docs/SECURITY.md` | Validation patterns, threat model |
| Trust tiers | `~/.claude/skills/skillsmith/docs/TRUST_TIERS.md` | Tier criteria and verification |
| Quotas | `~/.claude/skills/skillsmith/docs/QUOTAS.md` | Usage limits by tier |
| User guide | `~/.skillsmith/docs/USER_GUIDE.md` | Human-readable quick start |

**Trigger Phrases for Claude:**
```
"find skill", "search skills", "install skill", "trust tier",
"create skill", "skill quality", "skill quota"
```

### Skill-Builder Added to Tier 1

The `skill-builder` skill is now auto-installed alongside `varlock`, `commit`, and `governance`, enabling users to create custom skills immediately.

### CLI Enhancement

```bash
npx @skillsmith/mcp-server --docs  # Opens local documentation
```

### Bug Fix (v0.3.2)

- Added missing shebang (`#!/usr/bin/env node`) for proper npx execution

---

## @skillsmith/cli v0.3.0

### New: Registry Sync System (PR #5)

Keep your local skill database synchronized with the live Skillsmith registry.

**Commands:**

```bash
# Differential sync (only new/updated skills)
skillsmith sync

# Full sync (re-fetch everything)
skillsmith sync --force

# Preview without changes
skillsmith sync --dry-run

# View sync status
skillsmith sync status

# View sync history
skillsmith sync history

# Configure auto-sync frequency
skillsmith sync config --frequency weekly
```

**Features:**
- Differential sync - only fetches skills updated since last sync
- Configurable auto-sync (daily or weekly)
- Background sync during MCP sessions
- Full sync history and statistics

### New: Subagent Pair Generation (PR #3)

Generate companion specialist agents for skills with 37-97% token savings.

**Commands:**

```bash
# Generate subagent for a skill
skillsmith author subagent ./my-skill

# Upgrade existing skill with subagent config
skillsmith author transform ./my-skill

# Preview changes without creating files
skillsmith author transform ./my-skill --dry-run

# Batch transform multiple skills
skillsmith author transform ./skills --batch

# Specify model
skillsmith author subagent ./my-skill --model haiku
```

**Token Savings:**

| Scenario | Before | After | Savings |
|----------|--------|-------|---------|
| Single task | 43,588 tokens | 27,297 tokens | 37% |
| Multi-worker | 50,000 tokens | 1,500 tokens | 97% |

### New: Non-Interactive Init Flags (PR #8)

Initialize skills without interactive prompts for CI/CD and scripting:

```bash
skillsmith init my-skill \
  --description "My skill description" \
  --author "author-name" \
  --category development \
  --yes  # Auto-confirm overwrites
```

**Available Categories:** `development`, `productivity`, `communication`, `data`, `security`, `other`

### Bug Fixes (PR #9)

- Fixed 5 E2E test failures in author transform/subagent commands
- Added proper error handling for missing SKILL.md files
- Support comma-separated paths in `--batch` mode
- Fixed output label consistency ("Required Tools:")

---

## @skillsmith/core v2.1.0

### Registry Sync System

New modules for local-to-live database synchronization:

| Component | Purpose |
|-----------|---------|
| `SyncEngine` | Core sync logic with pagination and progress tracking |
| `SyncConfigRepository` | Manages sync configuration singleton |
| `SyncHistoryRepository` | Tracks sync run history and statistics |
| `BackgroundSyncService` | Session-based automatic sync |

### Schema Updates

New tables for sync tracking:
- `sync_config` - Stores sync configuration
- `sync_history` - Records sync run history

---

## Documentation

### New: Skill Security Guide (PR #6)

Comprehensive user-facing security documentation at `docs/security/skill-security-guide.md`:

- Trust tier explanations with visual diagrams
- Security risks in plain language (prompt injection, data exfiltration)
- Skillsmith's 8-category security scanner
- Safe skill installation workflow

### New: ADR-018 Registry Sync System

Architecture decision record documenting the sync system design at `docs/adr/018-registry-sync-system.md`.

---

## Security Fixes

- **devalue** - DoS vulnerability (npm audit fix)
- **h3** - Request Smuggling vulnerability (npm audit fix)
- **diff** - DoS vulnerability (package.json override)

---

## Upgrade Guide

```bash
# Update MCP server configuration (add to ~/.claude/settings.json)
{
  "mcpServers": {
    "skillsmith": {
      "command": "npx",
      "args": ["-y", "@skillsmith/mcp-server@0.3.2"]
    }
  }
}

# Or install CLI globally
npm install -g @skillsmith/cli@0.3.0

# Sync your local database
skillsmith sync
```

---

## Contributors

- Claude Opus 4.5 (Co-Author)

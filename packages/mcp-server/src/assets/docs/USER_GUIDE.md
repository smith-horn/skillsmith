# Skillsmith User Guide

Welcome to Skillsmith, the skill discovery and management system for Claude Code.

## Quick Start

### 1. Configure MCP Server

Add to `~/.claude/settings.json`:

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

### 2. Restart Claude Code

Close and reopen your Claude Code session.

### 3. Start Using

Ask Claude:
- "Search for testing skills"
- "Install the commit skill"
- "What skills do I have installed?"

## What Gets Installed

On first run, Skillsmith automatically installs essential skills:

| Skill | Purpose |
|-------|---------|
| **varlock** | Secure environment variable management |
| **commit** | Git commit message generation |
| **governance** | Code quality enforcement |
| **skill-builder** | Create custom skills |
| **skillsmith** | This documentation |

## Trust Tiers

Always check the trust tier before installing skills:

| Tier | Safety | Action |
|------|--------|--------|
| **Official** (Green) | Highest | Install freely |
| **Verified** (Blue) | High | Install freely |
| **Community** (Yellow) | Medium | Review first |
| **Unverified** (Red) | Unknown | Careful review |

### Quick Trust Check

```
"Show details for community/some-skill"
```

Look for:
- Trust tier badge
- Quality score (aim for 70+)
- Number of stars
- Days since published

## Common Tasks

### Search for Skills

```
"Find testing skills"
"Search for devops skills with score above 80"
"Find verified git workflow skills"
```

### Install a Skill

```
"Install community/jest-helper"
"Install the commit skill"
```

### Compare Skills

```
"Compare jest-helper and vitest-helper"
```

### Get Recommendations

```
"Recommend skills for my React project"
"What skills would help with this codebase?"
```

### Create a Custom Skill

```
"Create a skill for generating changelogs"
```

## Quota Limits

| Tier | API Calls/Month | Price |
|------|-----------------|-------|
| Community | 1,000 | Free |
| Individual | 10,000 | $9.99/mo |
| Team | 100,000 | $25/user/mo |
| Enterprise | Unlimited | $55/user/mo |

Check your usage:
```
"What's my Skillsmith quota?"
```

Upgrade at: https://skillsmith.app/upgrade

## Security Best Practices

1. **Prefer Verified or Official skills** for important projects
2. **Review Community skills** before installing
3. **Never install Unverified skills** without manual review
4. **Check the quality score** - aim for 70+
5. **Report suspicious skills** to security@skillsmith.app

## Where Skills Are Installed

Skills install to: `~/.claude/skills/<skill-name>/`

Each skill contains:
- `SKILL.md` - Main skill file (Claude reads this)
- Optional: `docs/`, `scripts/`, `templates/`

## Troubleshooting

### "Skill not found"

The skill may not exist in the registry. Try:
```
"Search for similar-name"
```

### "Installation failed"

Check:
1. Internet connection
2. Quota remaining
3. Skill hasn't been blocklisted

### "Security scan failed"

The skill was blocked for security reasons. Try a different skill or contact support if you believe this is an error.

### Quota Exceeded

You've hit your monthly limit. Options:
1. Wait until quota resets (1st of month)
2. Upgrade your tier

## Offline Usage

Installed skills work offline. Only these operations require internet:
- Searching for new skills
- Installing skills
- Getting recommendations

## Updating Skillsmith

```bash
npx @skillsmith/mcp-server@latest
```

Or let it auto-update via npx.

## Getting Help

- **Documentation**: `npx @skillsmith/mcp-server --docs`
- **Issues**: https://github.com/smith-horn/skillsmith/issues
- **Support**: support@skillsmith.app
- **Security**: security@skillsmith.app

## License

Skillsmith is licensed under **Elastic License 2.0**:
- Self-hosting for internal use: Allowed
- Modification for own use: Allowed
- Offering as managed service: Not allowed
- Circumventing license keys: Not allowed

Full license: https://www.elastic.co/licensing/elastic-license

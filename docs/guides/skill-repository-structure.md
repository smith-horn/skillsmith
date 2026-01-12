# Skill Repository Structure Guide

> **Reference**: This guide documents the required structure for skills to be installable via the Skillsmith MCP server.

## Overview

Skills published to GitHub can be discovered through Skillsmith's search functionality. However, to be **installable** via the `install_skill` tool, repositories must follow a specific structure.

## Required Structure

```
your-skill-repo/
├── SKILL.md          # REQUIRED - Skill definition file
├── README.md         # Recommended - General documentation
├── scripts/          # Optional - Helper scripts
│   └── setup.sh
└── examples/         # Optional - Usage examples
    └── example.md
```

## SKILL.md Requirements

The `SKILL.md` file is the entry point for skill installation. It must include:

### 1. YAML Frontmatter (Required)

```yaml
---
name: "My Skill Name"
description: "Brief description of what the skill does (max 200 chars)"
version: "1.0.0"           # Optional but recommended
author: "Your Name"        # Optional but recommended
---
```

### 2. Minimum Content Length

- SKILL.md must be at least **100 characters** (excluding frontmatter)
- This ensures meaningful documentation exists

### 3. Skill Instructions

After the frontmatter, include:

```markdown
# My Skill Name

## What This Skill Does

[Explain the skill's purpose and capabilities]

## Usage

[How to invoke and use the skill]

## Examples

[Concrete examples of skill usage]
```

## Complete Example

```markdown
---
name: "Git Commit Helper"
description: "Helps create well-formatted git commits with conventional commit messages"
version: "1.0.0"
author: "Your Name"
---

# Git Commit Helper

## What This Skill Does

This skill assists with creating git commits that follow the conventional commit specification.

## Trigger Phrases

- "commit my changes"
- "create a commit"
- "help me commit"

## Usage

When triggered, the skill will:
1. Analyze staged changes
2. Suggest a commit type (feat, fix, docs, etc.)
3. Generate a descriptive commit message
4. Optionally include breaking change notes

## Examples

### Simple Feature Commit
User: "commit my changes"
Result: `feat(auth): add password reset functionality`

### Bug Fix with Scope
User: "commit this bug fix for the login page"
Result: `fix(login): resolve session timeout issue`
```

## Validation Rules

The `install_skill` tool validates:

| Rule | Requirement |
|------|-------------|
| SKILL.md exists | File must be at repository root |
| Frontmatter present | YAML frontmatter with `---` delimiters |
| Name field | Required in frontmatter |
| Description field | Required in frontmatter |
| Minimum length | At least 100 characters of content |

## Common Issues

### "Could not find SKILL.md"

**Cause**: Repository doesn't have a SKILL.md file at the root level.

**Solution**: Create a SKILL.md file following the structure above.

### "SKILL.md is too short"

**Cause**: Content is less than 100 characters.

**Solution**: Add meaningful documentation about your skill's purpose and usage.

### "Missing required frontmatter"

**Cause**: YAML frontmatter is missing or malformed.

**Solution**: Ensure your file starts with:
```yaml
---
name: "Your Skill Name"
description: "Brief description"
---
```

## Installable vs Browse-Only Skills

Skills in the Skillsmith index are marked as either:

| Status | Meaning |
|--------|---------|
| **Installable** | Has valid SKILL.md, can be installed via `install_skill` |
| **Browse-only** | Indexed for search but cannot be auto-installed |

Browse-only skills can still be manually installed by:
1. Cloning the repository
2. Creating a SKILL.md file
3. Copying to `~/.claude/skills/`

## Testing Your Skill

Before publishing, validate your skill locally:

```bash
# Using Skillsmith CLI
skillsmith validate ./path/to/your-skill

# Or via MCP
# In Claude Code: "validate skill at ./my-skill"
```

## Publishing Checklist

- [ ] SKILL.md exists at repository root
- [ ] YAML frontmatter includes `name` and `description`
- [ ] Content is at least 100 characters
- [ ] Repository is public on GitHub
- [ ] Repository has `claude-code-skill` topic (for discovery)

## Related Documentation

- [Skill Validation Tool](../architecture/mcp-tools.md#skill_validate)
- [Install Tool Reference](../architecture/mcp-tools.md#install_skill)
- [Skill Template](../templates/skill-template.md)

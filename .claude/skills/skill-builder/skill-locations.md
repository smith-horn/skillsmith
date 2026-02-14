# Skill Locations: User vs Project Skills

Understanding where to place skills and the differences between user-level and project-level skills.

---

## Overview

Claude Code discovers skills from two locations:

| Location | Scope | Visibility | Version Controlled |
|----------|-------|------------|-------------------|
| `~/.claude/skills/` | User (personal) | Only you | Usually no |
| `.claude/skills/` | Project (team) | All team members | Yes (committed to git) |

---

## User-Level Skills (`~/.claude/skills/`)

### Characteristics

- **Location**: `~/.claude/skills/[skill-name]/SKILL.md`
- **Scope**: Available in ALL projects on your machine
- **Visibility**: Only visible to you
- **Git**: Not version-controlled (outside any repo)
- **Use case**: Personal productivity tools, cross-project utilities

### When to Use User-Level Skills

| Use Case | Example |
|----------|---------|
| Personal workflow tools | Custom commit message generator |
| Cross-project utilities | Universal testing patterns |
| Experimental skills | Skills you're developing before sharing |
| Personal preferences | IDE shortcuts, personal aliases |
| Sensitive workflows | Skills with personal API keys or paths |

### Example User Skill

```bash
# Create a personal skill
mkdir -p ~/.claude/skills/my-commit-helper
cat > ~/.claude/skills/my-commit-helper/SKILL.md << 'EOF'
---
name: "My Commit Helper"
description: "Generate commit messages following my personal style. Use when committing changes."
---

# My Commit Helper

[Personal commit message preferences...]
EOF
```

### User Skills: Pros and Cons

**Pros**:
- Available everywhere without setup
- No impact on team repositories
- Good for personal experimentation
- Can contain personal paths/tokens

**Cons**:
- Not shared with team
- Not version-controlled
- Easy to lose if machine is wiped
- No code review process

---

## Project-Level Skills (`.claude/skills/`)

### Characteristics

- **Location**: `[project-root]/.claude/skills/[skill-name]/SKILL.md`
- **Scope**: Available only in this project
- **Visibility**: All team members (committed to git)
- **Git**: Version-controlled with the project
- **Use case**: Team standards, project-specific workflows

### When to Use Project-Level Skills

| Use Case | Example |
|----------|---------|
| Team coding standards | Style guide enforcement |
| Project-specific workflows | Release process, deployment |
| Shared documentation | Architecture patterns |
| CI/CD integration | Build and test scripts |
| Onboarding | New team member guides |

### Example Project Skill

```bash
# Create a project skill (committed to git)
mkdir -p .claude/skills/deployment-guide
cat > .claude/skills/deployment-guide/SKILL.md << 'EOF'
---
name: "Deployment Guide"
description: "Deploy to staging and production environments. Use when releasing new versions."
---

# Deployment Guide

## Prerequisites
- AWS credentials configured
- Docker installed

[Team deployment process...]
EOF

# Commit to share with team
git add .claude/skills/deployment-guide/
git commit -m "feat(skills): add deployment guide skill"
```

### Project Skills: Pros and Cons

**Pros**:
- Shared with entire team
- Version-controlled
- Code review process
- Backed up with project

**Cons**:
- Only available in this project
- Requires git commit to update
- Need to be careful with sensitive data
- Must follow project's quality standards

---

## Precedence Rules

When a skill with the same name exists in both locations:

```
1. Project skills (.claude/skills/) take precedence
2. User skills (~/.claude/skills/) are fallback
```

This allows:
- Projects to override user preferences with team standards
- Users to have defaults that projects can customize

### Example

```
~/.claude/skills/testing/SKILL.md     # User default
.claude/skills/testing/SKILL.md       # Project override (wins)
```

---

## Git-Crypt Considerations

If your project uses git-crypt for encrypted files:

### For Project Skills

```bash
# Add to .gitattributes if skills contain sensitive patterns
.claude/skills/** filter=git-crypt diff=git-crypt

# Or exclude specific skills
.claude/skills/public-skill/** !filter !diff
```

### For User Skills

User skills at `~/.claude/skills/` are **not** subject to git-crypt since they're outside any repository.

**Security Tip**: Put skills with sensitive data (API keys, internal URLs) in user-level location, not project-level.

---

## Validation Differences

When validating skills, consider the location:

```bash
# Validate project skills only
npm run validate:skills -- --project-only

# Validate user skills only
npm run validate:skills -- --user-only

# Validate both
npm run validate:skills
```

### Common Issues by Location

| Location | Common Issue | Cause |
|----------|--------------|-------|
| User | Missing frontmatter | Created manually without template |
| User | Different format | Created before standards established |
| Project | Git-crypt encrypted | Forgot to unlock before reading |
| Project | Merge conflicts | Multiple team members editing |

---

## Migration Between Locations

### User → Project (Sharing with Team)

```bash
# Copy from user to project
cp -r ~/.claude/skills/my-skill .claude/skills/

# Remove any personal paths or tokens
# Update paths to be relative or configurable

# Commit to project
git add .claude/skills/my-skill/
git commit -m "feat(skills): add my-skill to project"
```

### Project → User (Personal Copy)

```bash
# Copy from project to user
cp -r .claude/skills/team-skill ~/.claude/skills/my-team-skill

# Customize for personal preferences
# This won't affect the team version
```

---

## Best Practices

### For User Skills

1. **Backup periodically** - User skills aren't version-controlled
2. **Use for experimentation** - Test new ideas before sharing
3. **Keep sensitive data here** - Personal API keys, local paths
4. **Document for yourself** - You're the only audience

### For Project Skills

1. **Follow team standards** - Consistent formatting, validation
2. **Code review skills** - Treat like any other code
3. **No sensitive data** - Use environment variables instead
4. **Document for team** - Clear instructions for all skill levels
5. **Test before committing** - Use `npm run validate:skills`

### General

1. **Always include frontmatter** - Required for skill discovery
2. **Use progressive disclosure** - Keep SKILL.md under 500 lines
3. **Test after creation** - Verify Claude can find and use the skill
4. **Update version numbers** - Track changes in `version` field

---

## Quick Reference

| Question | User Skills | Project Skills |
|----------|-------------|----------------|
| Where? | `~/.claude/skills/` | `.claude/skills/` |
| Who sees it? | Only you | Whole team |
| Git tracked? | No | Yes |
| Precedence? | Lower | Higher |
| Sensitive data OK? | Yes | No (use env vars) |
| Code review? | No | Yes |
| Backup? | Manual | Git |

---

## Related Documentation

- [Specification](./specification.md) - YAML frontmatter and structure
- [Best Practices](./best-practices.md) - Content writing guidelines
- [Templates](./templates.md) - Skill templates

---

**Created**: January 2026
**Issue**: SMI-1776

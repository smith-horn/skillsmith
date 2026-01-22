---
name: "skillsmith"
description: "Discover, install, compare, and manage Claude Code skills. Search the registry, get recommendations, validate skill quality, and manage your installed skills."
version: "0.1.0"
category: "productivity"
tags:
  - skills
  - discovery
  - registry
  - mcp
  - installation
author: "Skillsmith"
allowed-tools:
  - mcp__skillsmith
  - Bash
---

# Skillsmith Skill

Discover, install, compare, and manage Claude Code skills through natural language.

## Trigger Phrases

- "search for skills", "find skills", "discover skills"
- "install skill", "add skill"
- "recommend skills", "suggest skills"
- "compare skills"
- "validate skill", "check skill"
- "list installed skills", "show my skills"
- "uninstall skill", "remove skill"
- "skill details", "get skill"
- "browse skills", "explore skills"
- "high quality skills", "verified skills"

## Slash Commands

| Command | Description | Example |
|---------|-------------|---------|
| `/skillsmith search` | Search for skills by query or filters | `/skillsmith search testing` |
| `/skillsmith install` | Install a skill from the registry | `/skillsmith install community/jest-helper` |
| `/skillsmith recommend` | Get contextual skill recommendations | `/skillsmith recommend` |
| `/skillsmith compare` | Compare multiple skills side-by-side | `/skillsmith compare jest-helper vitest-helper` |
| `/skillsmith validate` | Validate a skill's structure | `/skillsmith validate ./my-skill` |
| `/skillsmith list` | List all installed skills | `/skillsmith list` |
| `/skillsmith uninstall` | Remove an installed skill | `/skillsmith uninstall jest-helper` |
| `/skillsmith get` | Get detailed skill information | `/skillsmith get community/jest-helper` |

## MCP Tool Delegation

This skill delegates to the `mcp__skillsmith` MCP server for all operations. When the user requests skill-related actions, use the appropriate MCP tool:

### Search for Skills

```
mcp__skillsmith__search({
  query: "testing",           // Optional search term
  category: "development",    // Optional: development, testing, devops, etc.
  trust_tier: "verified",     // Optional: verified, community, experimental
  min_score: 70,              // Optional: minimum quality score (0-100)
  limit: 10                   // Optional: max results (default 10)
})
```

**Note:** Either `query` OR at least one filter (`category`, `trust_tier`, `min_score`) must be provided.

### Get Skill Details

```
mcp__skillsmith__get_skill({
  id: "community/jest-helper"  // Required: skill ID in format author/name
})
```

### Install a Skill

```
mcp__skillsmith__install_skill({
  id: "community/jest-helper",  // Required: skill ID
  force: false                  // Optional: overwrite if exists
})
```

### Uninstall a Skill

```
mcp__skillsmith__uninstall_skill({
  id: "jest-helper"  // Required: skill name
})
```

### Get Recommendations

```
mcp__skillsmith__recommend({
  context: "React TypeScript project",  // Optional: project context
  limit: 5                              // Optional: max recommendations
})
```

### Compare Skills

```
mcp__skillsmith__compare({
  skill_ids: ["community/jest-helper", "community/vitest-helper"]  // Required: 2-5 skill IDs
})
```

### Validate a Skill

```
mcp__skillsmith__validate({
  path: "./my-skill"  // Required: path to skill directory
})
```

## Usage Examples

### Example 1: Search and Install

User: "Find testing skills for React"

1. Search for skills:
   ```
   mcp__skillsmith__search({ query: "testing React" })
   ```

2. Present results to user with quality scores and trust tiers

3. If user selects one:
   ```
   mcp__skillsmith__install_skill({ id: "community/react-testing-library-helper" })
   ```

### Example 2: Get Recommendations

User: "What skills would help with this codebase?"

1. Analyze current project context (package.json, file types, etc.)

2. Get recommendations:
   ```
   mcp__skillsmith__recommend({ context: "Node.js TypeScript API with Express" })
   ```

3. Present recommendations with explanations

### Example 3: Compare Options

User: "Compare jest-helper and vitest-helper"

```
mcp__skillsmith__compare({
  skill_ids: ["community/jest-helper", "community/vitest-helper"]
})
```

Present comparison table showing features, quality scores, trust tiers, etc.

### Example 4: Browse by Category

User: "Show me verified security skills"

```
mcp__skillsmith__search({
  category: "security",
  trust_tier: "verified"
})
```

### Example 5: Quality-Based Search

User: "Find high-quality DevOps skills"

```
mcp__skillsmith__search({
  category: "devops",
  min_score: 80
})
```

## Trust Tiers

| Tier | Description | Badge |
|------|-------------|-------|
| `verified` | Official Anthropic or partner skills | Green |
| `community` | Community-reviewed and approved | Yellow |
| `experimental` | New or beta skills, use with caution | Red |

## Quality Scores

Quality scores (0-100) reflect skill quality based on:

- Repository health (stars, forks, activity)
- Documentation completeness
- Code quality indicators
- Community engagement

Recommended minimum scores:
- Production use: 70+
- General use: 50+
- Experimental: Any

## CLI Fallback

If the MCP server is unavailable, use the CLI directly:

```bash
# Search
skillsmith search "testing" --tier verified

# Install
skillsmith install community/jest-helper

# List installed
skillsmith list

# Remove
skillsmith remove jest-helper
```

## Related Commands

- `skillsmith analyze` - Analyze codebase for skill recommendations
- `skillsmith sync` - Sync skills from registry
- `skillsmith author init` - Create a new skill
- `skillsmith author validate` - Validate skill structure

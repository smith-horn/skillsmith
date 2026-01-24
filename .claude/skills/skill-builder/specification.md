# Skill Builder Specification

Complete technical specification for Claude Code Skills.

---

## YAML Frontmatter (REQUIRED)

Every SKILL.md **must** start with YAML frontmatter containing exactly two required fields:

```yaml
---
name: "Skill Name"                    # REQUIRED: Max 64 chars
description: "What this skill does    # REQUIRED: Max 1024 chars
and when Claude should use it."       # Include BOTH what & when
---
```

### Field Requirements

**`name`** (REQUIRED):
- **Type**: String
- **Max Length**: 64 characters
- **Format**: Human-friendly display name
- **Usage**: Shown in skill lists, UI, and loaded into Claude's system prompt
- **Best Practice**: Use Title Case, be concise and descriptive
- **Examples**:
  - ✅ "API Documentation Generator"
  - ✅ "React Component Builder"
  - ✅ "Database Schema Designer"
  - ❌ "skill-1" (not descriptive)
  - ❌ "This is a very long skill name that exceeds sixty-four characters" (too long)

**`description`** (REQUIRED):
- **Type**: String
- **Max Length**: 1024 characters
- **Format**: Plain text or minimal markdown
- **Content**: MUST include:
  1. **What** the skill does (functionality)
  2. **When** Claude should invoke it (trigger conditions)
- **Usage**: Loaded into Claude's system prompt for autonomous matching
- **Best Practice**: Front-load key trigger words, be specific about use cases
- **Examples**:
  - ✅ "Generate OpenAPI 3.0 documentation from Express.js routes. Use when creating API docs, documenting endpoints, or building API specifications."
  - ✅ "Create React functional components with TypeScript, hooks, and tests. Use when scaffolding new components or converting class components."
  - ❌ "A comprehensive guide to API documentation" (no "when" clause)
  - ❌ "Documentation tool" (too vague)

### YAML Formatting Rules

```yaml
---
# ✅ CORRECT: Simple string
name: "API Builder"
description: "Creates REST APIs with Express and TypeScript."

# ✅ CORRECT: Multi-line description
name: "Full-Stack Generator"
description: "Generates full-stack applications with React frontend and Node.js backend. Use when starting new projects or scaffolding applications."

# ✅ CORRECT: Special characters quoted
name: "JSON:API Builder"
description: "Creates JSON:API compliant endpoints: pagination, filtering, relationships."

# ❌ WRONG: Missing quotes with special chars
name: API:Builder  # YAML parse error!

# ❌ WRONG: Extra fields (ignored but discouraged)
name: "My Skill"
description: "My description"
version: "1.0.0"       # NOT part of spec
author: "Me"           # NOT part of spec
tags: ["dev", "api"]   # NOT part of spec
---
```

**Critical**: Only `name` and `description` are used by Claude. Additional fields are ignored.

---

## Directory Structure

### Minimal Skill (Required)

```
~/.claude/skills/                    # Personal skills location
└── my-skill/                        # Skill directory (MUST be at top level!)
    └── SKILL.md                     # REQUIRED: Main skill file
```

**IMPORTANT**: Skills MUST be directly under `~/.claude/skills/[skill-name]/`.
Claude Code does NOT support nested subdirectories or namespaces!

### Full-Featured Skill (Recommended)

```
~/.claude/skills/
└── my-skill/                        # Top-level skill directory
        ├── SKILL.md                 # REQUIRED: Main skill file
        ├── README.md                # Optional: Human-readable docs
        ├── scripts/                 # Optional: Executable scripts
        │   ├── setup.sh
        │   ├── validate.js
        │   └── deploy.py
        ├── resources/               # Optional: Supporting files
        │   ├── templates/
        │   │   ├── api-template.js
        │   │   └── component.tsx
        │   ├── examples/
        │   │   └── sample-output.json
        │   └── schemas/
        │       └── config-schema.json
        └── docs/                    # Optional: Additional documentation
            ├── ADVANCED.md
            ├── TROUBLESHOOTING.md
            └── API_REFERENCE.md
```

### Skills Locations

**Personal Skills** (available across all projects):
```
~/.claude/skills/
└── [your-skills]/
```
- **Path**: `~/.claude/skills/` or `$HOME/.claude/skills/`
- **Scope**: Available in all projects for this user
- **Version Control**: NOT committed to git (outside repo)
- **Use Case**: Personal productivity tools, custom workflows

**Project Skills** (team-shared, version controlled):
```
<project-root>/.claude/skills/
└── [team-skills]/
```
- **Path**: `.claude/skills/` in project root
- **Scope**: Available only in this project
- **Version Control**: SHOULD be committed to git
- **Use Case**: Team workflows, project-specific tools, shared knowledge

---

## Progressive Disclosure Architecture

Claude Code uses a **3-level progressive disclosure system** to scale to 100+ skills without context penalty:

### Level 1: Metadata (Name + Description)

**Loaded**: At Claude Code startup, always
**Size**: ~200 chars per skill
**Purpose**: Enable autonomous skill matching
**Context**: Loaded into system prompt for ALL skills

```yaml
---
name: "API Builder"                   # 11 chars
description: "Creates REST APIs..."   # ~50 chars
---
# Total: ~61 chars per skill
# 100 skills = ~6KB context (minimal!)
```

### Level 2: SKILL.md Body

**Loaded**: When skill is triggered/matched
**Size**: ~1-10KB typically
**Purpose**: Main instructions and procedures
**Context**: Only loaded for ACTIVE skills

```markdown
# API Builder

## What This Skill Does
[Main instructions - loaded only when skill is active]

## Quick Start
[Basic procedures]

## Step-by-Step Guide
[Detailed instructions]
```

### Level 3+: Referenced Files

**Loaded**: On-demand as Claude navigates
**Size**: Variable (KB to MB)
**Purpose**: Deep reference, examples, schemas
**Context**: Loaded only when Claude accesses specific files

```markdown
# In SKILL.md
See [Advanced Configuration](docs/ADVANCED.md) for complex scenarios.
See [API Reference](docs/API_REFERENCE.md) for complete documentation.
Use template: `resources/templates/api-template.js`

# Claude will load these files ONLY if needed
```

**Benefit**: Install 100+ skills with ~6KB context. Only active skill content (1-10KB) enters context.

---

## SKILL.md Content Structure

### Recommended 4-Level Structure

```markdown
---
name: "Your Skill Name"
description: "What it does and when to use it"
---

# Your Skill Name

## Level 1: Overview (Always Read First)
Brief 2-3 sentence description of the skill.

## Prerequisites
- Requirement 1
- Requirement 2

## What This Skill Does
1. Primary function
2. Secondary function
3. Key benefit

---

## Level 2: Quick Start (For Fast Onboarding)

### Basic Usage
```bash
# Simplest use case
command --option value
```

### Common Scenarios
1. **Scenario 1**: How to...
2. **Scenario 2**: How to...

---

## Level 3: Detailed Instructions (For Deep Work)

### Step-by-Step Guide

#### Step 1: Initial Setup
```bash
# Commands
```
Expected output:
```
Success message
```

#### Step 2: Configuration
- Configuration option 1
- Configuration option 2

#### Step 3: Execution
- Run the main command
- Verify results

### Advanced Options

#### Option 1: Custom Configuration
```bash
# Advanced usage
```

#### Option 2: Integration
```bash
# Integration steps
```

---

## Level 4: Reference (Rarely Needed)

### Troubleshooting

#### Issue: Common Problem
**Symptoms**: What you see
**Cause**: Why it happens
**Solution**: How to fix
```bash
# Fix command
```

### Complete API Reference
See [API_REFERENCE.md](docs/API_REFERENCE.md)

### Examples
See [examples/](resources/examples/)

### Related Skills
- [Related Skill 1](#)
- [Related Skill 2](#)

### Resources
- [External Link 1](https://example.com)
- [Documentation](https://docs.example.com)
```

---

## Adding Scripts and Resources

### Scripts Directory

**Purpose**: Executable scripts that Claude can run
**Location**: `scripts/` in skill directory
**Usage**: Referenced from SKILL.md

#### When to Extract to Scripts

**Extract deterministic operations** to `scripts/` when:

| Criteria | Example | Why |
|----------|---------|-----|
| **Repeatable command sequences** | Setup, validation, deployment | Eliminates manual command entry errors |
| **Complex GraphQL/API calls** | Linear issue updates, Supabase queries | Proper escaping, error handling |
| **Multi-step workflows** | Build → test → deploy | Ensures consistent execution order |
| **Operations needing proper types** | SDK operations with type hints | IDE support, compile-time checks |

**Keep inline** when:
- One-liner commands
- Ad-hoc exploration
- Commands requiring interactive input

#### Reference Implementation: Linear Skill

The linear skill demonstrates the scripts pattern:

```bash
~/.claude/skills/linear/
├── SKILL.md                    # Main skill (<500 lines)
├── scripts/
│   ├── linear-ops.ts           # High-level operations
│   ├── linear-api.mjs          # Direct GraphQL wrapper
│   ├── linear-helpers.mjs      # Bulk update helpers
│   ├── query.ts                # Ad-hoc GraphQL queries
│   ├── setup.ts                # Setup verification
│   └── sync.ts                 # Bulk sync operations
└── ...
```

**Key patterns:**
1. **Operations script** (`linear-ops.ts`) - User-friendly CLI for common tasks
2. **API wrapper** (`linear-api.mjs`) - Handles JSON escaping, error handling
3. **Helpers** (`linear-helpers.mjs`) - Bulk operations, batch updates
4. **Query runner** (`query.ts`) - Ad-hoc GraphQL for exploration

#### Script Design Guidelines

```bash
# Good: Self-documenting with help
npx tsx scripts/linear-ops.ts help
npx tsx scripts/linear-ops.ts create-issue --help

# Good: Accepts arguments, provides feedback
npx tsx scripts/linear-ops.ts status Done SMI-123 SMI-124
# Output: ✅ Updated SMI-123 to Done
#         ✅ Updated SMI-124 to Done

# Bad: No feedback, silent failures
./scripts/update.sh  # Did it work? Who knows.
```

Reference from SKILL.md:
```markdown
## Quick Operations
```bash
# Use the operations script
npx tsx scripts/linear-ops.ts create-issue "Project" "Title"
npx tsx scripts/linear-ops.ts status Done SMI-123

# Show all commands
npx tsx scripts/linear-ops.ts help
```
```

### Resources Directory

**Purpose**: Templates, examples, schemas, static files
**Location**: `resources/` in skill directory
**Usage**: Referenced or copied by scripts

Example:
```bash
resources/
├── templates/
│   ├── component.tsx.template
│   ├── test.spec.ts.template
│   └── story.stories.tsx.template
├── examples/
│   ├── basic-example/
│   ├── advanced-example/
│   └── integration-example/
└── schemas/
    ├── config.schema.json
    └── output.schema.json
```

Reference from SKILL.md:
```markdown
## Templates
Use the component template:
```bash
cp resources/templates/component.tsx.template src/components/MyComponent.tsx
```

## Examples
See working examples in `resources/examples/`:
- `basic-example/` - Simple component
- `advanced-example/` - With hooks and context
```

---

## File References and Navigation

Claude can navigate to referenced files automatically. Use these patterns:

### Markdown Links
```markdown
See [Advanced Configuration](docs/ADVANCED.md) for complex scenarios.
See [Troubleshooting Guide](docs/TROUBLESHOOTING.md) if you encounter errors.
```

### Relative File Paths
```markdown
Use the template located at `resources/templates/api-template.js`
See examples in `resources/examples/basic-usage/`
```

### Inline File Content
```markdown
## Example Configuration
See `resources/examples/config.json`:
```json
{
  "option": "value"
}
```
```

**Best Practice**: Keep SKILL.md lean (~2-5KB). Move lengthy content to separate files and reference them. Claude will load only what's needed.

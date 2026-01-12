# Subagent Pair Generation Architecture

## Overview

This architecture enables automatic generation of companion specialist agents for every skill, providing 37-97% token savings through context isolation.

## Problem Statement

When skills execute in the main conversation context:
- Full SKILL.md loads into orchestrator context (~500-2,000 tokens)
- Intermediate outputs accumulate without containment
- Context pollution degrades performance
- Token usage scales linearly with task complexity

**Measured Impact:**
- Without isolation: 43,588 tokens (average task)
- With subagent isolation: 27,297 tokens (37% reduction)
- Multi-worker scenario: 50,000 → 1,500 tokens (97% reduction)

## Solution Architecture

### Three-Tier Implementation

```
┌─────────────────────────────────────────────────────────────┐
│               SUBAGENT PAIR GENERATION SYSTEM                │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌─────────────────────────────────────────────────────────┐│
│  │  TIER 1: Skill Builder Skill (Guidance)                 ││
│  │  Location: ~/.claude/skills/skill-builder/              ││
│  │                                                         ││
│  │  - Patterns for subagent creation                       ││
│  │  - Template reference documentation                     ││
│  │  - Best practices for context isolation                 ││
│  │  - Manual workflow instructions                         ││
│  └─────────────────────────────────────────────────────────┘│
│                                                              │
│  ┌─────────────────────────────────────────────────────────┐│
│  │  TIER 2: CLI Generation Command                         ││
│  │  Command: skillsmith author subagent                    ││
│  │                                                         ││
│  │  - Parses existing SKILL.md                             ││
│  │  - Generates companion subagent .md file                ││
│  │  - Generates CLAUDE.md integration snippet              ││
│  │  - Validates output structure                           ││
│  └─────────────────────────────────────────────────────────┘│
│                                                              │
│  ┌─────────────────────────────────────────────────────────┐│
│  │  TIER 3: CLI Transform Command                          ││
│  │  Command: skillsmith author transform                   ││
│  │                                                         ││
│  │  - Analyzes existing skill for subagent potential       ││
│  │  - Generates subagent without modifying SKILL.md        ││
│  │  - Supports dry-run mode                                ││
│  │  - Upgrades existing skills retroactively               ││
│  └─────────────────────────────────────────────────────────┘│
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### Subagent Definition Structure

```yaml
---
name: [skill-name]-specialist
description: [Skill purpose]. Use when [trigger conditions].
skills: [skill-name]
tools: [minimal tool set]
model: sonnet
---

## Operating Protocol

1. Execute the [skill-name] skill for the delegated task
2. Process all intermediate results internally
3. Return ONLY a structured summary to the orchestrator

## Output Format

- **Task:** [what was requested]
- **Actions:** [what you did]
- **Results:** [key outcomes, max 3-5 bullet points]
- **Artifacts:** [file paths or outputs created]

Keep response under 500 tokens unless explicitly requested otherwise.
```

### Generation Flow

```
┌──────────────────┐
│ Input: SKILL.md  │
└────────┬─────────┘
         │
         ▼
┌──────────────────────────────────────┐
│ Parse YAML Frontmatter               │
│ - Extract name, description          │
│ - Extract trigger phrases            │
│ - Identify required tools            │
└────────┬─────────────────────────────┘
         │
         ▼
┌──────────────────────────────────────┐
│ Analyze Skill Requirements           │
│ - Determine minimal tool set         │
│ - Identify output patterns           │
│ - Detect verbose operations          │
└────────┬─────────────────────────────┘
         │
         ▼
┌──────────────────────────────────────┐
│ Generate Subagent Definition         │
│ - Apply template                     │
│ - Set tools field                    │
│ - Configure output constraints       │
└────────┬─────────────────────────────┘
         │
         ▼
┌──────────────────────────────────────┐
│ Generate CLAUDE.md Snippet           │
│ - Delegation rules                   │
│ - Trigger patterns                   │
│ - Example usage                      │
└────────┬─────────────────────────────┘
         │
         ▼
┌──────────────────────────────────────┐
│ Output Files                         │
│ - ~/.claude/agents/[skill]-specialist.md
│ - CLAUDE.md integration snippet      │
└──────────────────────────────────────┘
```

### Tool Set Determination Logic

```typescript
interface ToolAnalysis {
  requiredTools: string[];
  recommendedTools: string[];
  reason: string;
}

function analyzeToolRequirements(skillMd: string): ToolAnalysis {
  const tools = new Set<string>();

  // Base tools for all subagents
  tools.add('Read');

  // Detect file operations
  if (skillMd.includes('write') || skillMd.includes('create file')) {
    tools.add('Write');
    tools.add('Edit');
  }

  // Detect command execution
  if (skillMd.includes('bash') || skillMd.includes('npm') ||
      skillMd.includes('run command')) {
    tools.add('Bash');
  }

  // Detect search operations
  if (skillMd.includes('search') || skillMd.includes('find')) {
    tools.add('Grep');
    tools.add('Glob');
  }

  return {
    requiredTools: Array.from(tools),
    recommendedTools: [...tools],
    reason: 'Minimal tool set for skill execution'
  };
}
```

## Component Details

### Component 1: Skill Builder Upgrade

**Location:** `~/.claude/skills/skill-builder/SKILL.md`

**New Sections to Add:**
1. "Subagent Configuration Generation" - When and how to create subagents
2. "Subagent Template Structure" - YAML format and fields
3. "CLAUDE.md Integration Snippets" - Copy-paste delegation rules
4. "Upgrade Existing Skills" - Transform workflow

**New Files:**
- `templates/subagent-template.md` - Base subagent template
- `scripts/generate-subagent.ts` - Generation logic
- `references/orchestrator-delegation.md` - Delegation patterns

### Component 2: CLI Subagent Command

**Location:** `packages/cli/src/commands/author.ts`

**Command Signature:**
```bash
skillsmith author subagent [path] [options]

Options:
  -o, --output <path>   Output directory (default: ~/.claude/agents)
  --tools <tools>       Override default tools (comma-separated)
  --model <model>       Model to use (default: sonnet)
  --skip-claude-md      Don't generate CLAUDE.md snippet
```

**Implementation:**
```typescript
export function createSubagentCommand(): Command {
  return new Command('subagent')
    .description('Generate a companion subagent for a skill')
    .argument('[path]', 'Path to skill directory', '.')
    .option('-o, --output <path>', 'Output directory', '~/.claude/agents')
    .option('--tools <tools>', 'Override tools (comma-separated)')
    .option('--model <model>', 'Model for subagent', 'sonnet')
    .option('--skip-claude-md', 'Skip CLAUDE.md snippet generation')
    .action(generateSubagent);
}
```

### Component 3: CLI Transform Command

**Location:** `packages/cli/src/commands/author.ts`

**Command Signature:**
```bash
skillsmith author transform [path] [options]

Options:
  --dry-run      Show what would be generated without creating files
  --force        Overwrite existing subagent definition
  --batch        Process multiple skills (comma-separated paths)
```

**Implementation:**
```typescript
export function createTransformCommand(): Command {
  return new Command('transform')
    .description('Upgrade existing skill with subagent configuration')
    .argument('[path]', 'Path to skill directory', '.')
    .option('--dry-run', 'Preview without creating files')
    .option('--force', 'Overwrite existing subagent')
    .option('--batch', 'Process multiple skills')
    .action(transformSkill);
}
```

## File Structure After Implementation

```
~/.claude/
├── skills/
│   ├── skill-builder/
│   │   ├── SKILL.md (updated)
│   │   ├── templates/
│   │   │   └── subagent-template.md (new)
│   │   ├── scripts/
│   │   │   └── generate-subagent.ts (new)
│   │   └── references/
│   │       └── orchestrator-delegation.md (new)
│   └── [other-skills]/
│       └── SKILL.md
├── agents/
│   ├── [skill-name]-specialist.md (generated)
│   └── [other-skill]-specialist.md (generated)
└── ...

packages/cli/
├── src/
│   ├── commands/
│   │   ├── author.ts (updated with subagent + transform)
│   │   └── index.ts (export new commands)
│   ├── templates/
│   │   └── subagent.md.template.ts (new)
│   └── index.ts (register command group)
└── ...
```

## Integration with Existing Systems

### Skill Builder Workflow

```
User: "Create a new PDF processing skill"
        │
        ▼
┌─────────────────────────┐
│ skill-builder invoked   │
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│ Create SKILL.md         │
│ (existing functionality)│
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────────────┐
│ NEW: Generate subagent pair     │
│ - pdf-processor-specialist.md   │
│ - CLAUDE.md delegation snippet  │
└───────────┬─────────────────────┘
            │
            ▼
┌─────────────────────────┐
│ Output complete package │
└─────────────────────────┘
```

### Transform Workflow

```
User: "Upgrade my existing linear skill with subagent"
        │
        ▼
┌─────────────────────────────────────┐
│ skillsmith author transform linear/ │
└───────────┬─────────────────────────┘
            │
            ▼
┌─────────────────────────┐
│ Parse existing SKILL.md │
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│ Generate subagent       │
│ (non-destructive)       │
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│ Output:                 │
│ - linear-specialist.md  │
│ - CLAUDE.md snippet     │
└─────────────────────────┘
```

## Security Considerations

- Subagent inherits skill permissions (via `skills:` field)
- Tools are minimized to reduce attack surface
- No automatic execution - user must add to CLAUDE.md

## References

- Research: /docs/backlog/skill-optimizations/skill-builder-upgrade-prompt.md
- Research: /docs/backlog/skill-optimizations/parallel-agents-skills-research.md
- Implementation: /docs/execution/subagent-pair-generation-implementation.md

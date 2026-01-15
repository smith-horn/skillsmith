# Subagent Pair Generation Implementation Plan

**Date:** January 2026
**Type:** Feature Upgrade (3 Components)
**Execution Model:** Sequential waves with dependencies

---

## Overview

Implementation plan for upgrading the skill development workflow to automatically generate companion specialist agents, enabling 37-97% token savings.

```
┌─────────────────────────────────────────────────────────────┐
│           SUBAGENT PAIR GENERATION IMPLEMENTATION           │
├─────────────────────────────────────────────────────────────┤
│  Wave 1: Skill Builder Upgrade                ~3 hours     │
│     └── Update SKILL.md, add templates and scripts         │
├─────────────────────────────────────────────────────────────┤
│  Wave 2: CLI Subagent Command                 ~4 hours     │
│     └── skillsmith author subagent implementation          │
├─────────────────────────────────────────────────────────────┤
│  Wave 3: CLI Transform Command                ~4 hours     │
│     └── skillsmith author transform implementation         │
├─────────────────────────────────────────────────────────────┤
│  Wave 4: Testing & Documentation              ~2 hours     │
│     └── Unit tests, integration tests, docs update         │
└─────────────────────────────────────────────────────────────┘
```

---

## Wave 1: Skill Builder Upgrade

**Est. Time:** ~3 hours
**Linear Issues:**
- SMI-XXXX - Upgrade skill-builder SKILL.md with subagent guidance
- SMI-XXXX - Create subagent template file
- SMI-XXXX - Create generate-subagent.ts script

### Tasks

#### 1.1 Update Skill Builder SKILL.md

**File:** `~/.claude/skills/skill-builder/SKILL.md`

Add new sections after existing content:

```markdown
## Subagent Pair Generation

### When to Generate a Subagent

Generate a companion subagent when the skill:
- Produces verbose output (>500 tokens working context)
- Involves document processing (PDF, Excel, large files)
- Performs multi-file analysis or code review
- Runs test suites with detailed output
- Conducts research with iterative exploration

### Subagent Definition Structure

Every skill can have a companion subagent defined at `~/.claude/agents/[skill-name]-specialist.md`:

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

Keep response under 500 tokens unless explicitly requested.
```

#### 1.2 Create Subagent Template

**File:** `~/.claude/skills/skill-builder/templates/subagent-template.md`

```yaml
---
name: {{name}}-specialist
description: {{description}}. Use when {{triggers}}.
skills: {{name}}
tools: {{tools}}
model: sonnet
---

You are a {{name}} specialist operating in isolation for context efficiency.

## Operating Protocol

1. Execute the {{name}} skill for the delegated task
2. Process all intermediate results internally
3. Return ONLY a structured summary to the orchestrator

## Output Format

Always respond with this structure:

- **Task:** [what was requested]
- **Actions:** [what you did]
- **Results:** [key outcomes, max 3-5 bullet points]
- **Artifacts:** [file paths or outputs created]

## Constraints

- Keep response under 500 tokens unless explicitly requested
- Do not include verbose logs or intermediate outputs
- Focus on actionable results and key findings
- Reference file paths rather than dumping file contents

## Example Response

- **Task:** Review PR #123 for security issues
- **Actions:** Analyzed 15 changed files, ran security patterns
- **Results:**
  - Found 2 potential SQL injection points (src/db.ts:45, src/db.ts:78)
  - Detected hardcoded credential at config/test.ts:12
  - No XSS vulnerabilities detected
- **Artifacts:** Security report saved to /tmp/security-review-pr123.md
```

#### 1.3 Create Generation Script

**File:** `~/.claude/skills/skill-builder/scripts/generate-subagent.ts`

Key functions:
- `parseSkillMd(skillPath)` - Parse YAML frontmatter from SKILL.md
- `analyzeToolRequirements(skillPath)` - Detect required tools from content
- `generateSubagent(metadata, tools, templatePath)` - Apply template
- `generateClaudeMdSnippet(metadata)` - Create delegation rules

### Acceptance Criteria

- [ ] Skill Builder SKILL.md updated with subagent guidance
- [ ] Subagent template created and functional
- [ ] Generation script runs successfully
- [ ] Dry-run mode works correctly

---

## Wave 2: CLI Subagent Command

**Est. Time:** ~4 hours
**Linear Issue:** SMI-XXXX - Add `skillsmith author subagent` CLI command

### Tasks

#### 2.1 Add Command to author.ts

**File:** `packages/cli/src/commands/author.ts`

```typescript
export function createSubagentCommand(): Command {
  return new Command('subagent')
    .description('Generate a companion subagent for a skill')
    .argument('[path]', 'Path to skill directory', '.')
    .option('-o, --output <path>', 'Output directory for subagent', '~/.claude/agents')
    .option('--tools <tools>', 'Override default tools (comma-separated)')
    .option('--model <model>', 'Model to use (sonnet, opus, haiku)', 'sonnet')
    .option('--skip-claude-md', 'Skip CLAUDE.md snippet generation')
    .action(async (skillPath: string, opts: SubagentOptions) => {
      await generateSubagent(skillPath, opts);
    });
}
```

#### 2.2 Register Command

**File:** `packages/cli/src/index.ts`

```typescript
const authorCommand = new Command('author')
  .description('Skill authoring and transformation commands');

authorCommand.addCommand(createSubagentCommand());
program.addCommand(authorCommand);
```

### Usage Examples

```bash
# Generate subagent for current skill
skillsmith author subagent ./my-skill

# Specify output directory
skillsmith author subagent ./my-skill --output ~/.claude/agents

# Override tools
skillsmith author subagent ./my-skill --tools Read,Write,Bash
```

### Acceptance Criteria

- [ ] `skillsmith author subagent` command works
- [ ] Output directory option works
- [ ] Tools override option works
- [ ] CLAUDE.md snippet generation works
- [ ] Skip option for CLAUDE.md works

---

## Wave 3: CLI Transform Command

**Est. Time:** ~4 hours
**Linear Issue:** SMI-XXXX - Add `skillsmith author transform` CLI command

### Tasks

#### 3.1 Add Transform Command

**File:** `packages/cli/src/commands/author.ts`

```typescript
export function createTransformCommand(): Command {
  return new Command('transform')
    .description('Upgrade an existing skill with subagent configuration')
    .argument('[path]', 'Path to skill directory', '.')
    .option('--dry-run', 'Show what would be generated without creating files')
    .option('--force', 'Overwrite existing subagent definition')
    .option('--batch <paths>', 'Process multiple skills (comma-separated paths)')
    .action(async (skillPath: string, opts: TransformOptions) => {
      await transformSkill(skillPath, opts);
    });
}
```

#### 3.2 Register Transform Command

**File:** `packages/cli/src/index.ts`

```typescript
authorCommand.addCommand(createTransformCommand());
```

### Usage Examples

```bash
# Transform existing skill
skillsmith author transform ./existing-skill

# Preview without creating files
skillsmith author transform ./existing-skill --dry-run

# Force overwrite existing subagent
skillsmith author transform ./existing-skill --force

# Batch process multiple skills
skillsmith author transform --batch ~/.claude/skills/linear,~/.claude/skills/pdf
```

### Acceptance Criteria

- [ ] `skillsmith author transform` command works
- [ ] Dry-run mode shows preview
- [ ] Force flag overwrites existing
- [ ] Batch mode processes multiple skills
- [ ] Non-destructive to SKILL.md

---

## Wave 4: Testing & Documentation

**Est. Time:** ~2 hours
**Linear Issues:**
- SMI-XXXX - Add unit tests for CLI commands
- SMI-XXXX - Add integration tests

### Tasks

#### 4.1 Unit Tests

**File:** `packages/cli/src/commands/__tests__/author.test.ts`

```typescript
describe('skillsmith author subagent', () => {
  it('parses skill metadata correctly', () => {
    // Test parseSkillMetadata
  });

  it('analyzes tool requirements correctly', () => {
    // Test analyzeRequiredTools
  });

  it('generates valid subagent content', () => {
    // Test generateSubagentContent
  });
});

describe('skillsmith author transform', () => {
  it('preserves original SKILL.md', () => {
    // Verify non-destructive behavior
  });

  it('handles dry-run mode correctly', () => {
    // Verify no files created
  });

  it('respects force flag', () => {
    // Verify overwrite behavior
  });
});
```

#### 4.2 Integration Tests

**File:** `packages/cli/src/commands/__tests__/author.integration.test.ts`

```typescript
describe('CLI Integration', () => {
  it('skillsmith author subagent --help works', () => {
    const output = execSync('npx skillsmith author subagent --help').toString();
    expect(output).toContain('Generate a companion subagent');
  });

  it('skillsmith author transform --help works', () => {
    const output = execSync('npx skillsmith author transform --help').toString();
    expect(output).toContain('Upgrade an existing skill');
  });
});
```

### Acceptance Criteria

- [ ] Unit tests pass
- [ ] Integration tests pass
- [ ] Test coverage >80% for new code
- [ ] No regressions in existing tests

---

## Linear Issues Summary

| Issue ID | Title | Type | Est. Hours | Dependencies |
|----------|-------|------|------------|--------------|
| SMI-XXXX | Upgrade skill-builder SKILL.md with subagent guidance | Feature | 1 | None |
| SMI-XXXX | Create subagent template file | Feature | 0.5 | None |
| SMI-XXXX | Create generate-subagent.ts script | Feature | 1.5 | Template |
| SMI-XXXX | Add `skillsmith author subagent` CLI command | Feature | 4 | Skill Builder |
| SMI-XXXX | Add `skillsmith author transform` CLI command | Feature | 4 | Subagent command |
| SMI-XXXX | Update CLI templates and index | Feature | 0.5 | Commands |
| SMI-XXXX | Add unit tests for CLI commands | Test | 1.5 | Commands |
| SMI-XXXX | Add integration tests | Test | 0.5 | Unit tests |

**Total Estimated Hours:** 13.5

---

## Critical Files to Modify

| File | Changes |
|------|---------|
| `~/.claude/skills/skill-builder/SKILL.md` | Add subagent generation guidance |
| `~/.claude/skills/skill-builder/templates/subagent-template.md` | New file - subagent template |
| `~/.claude/skills/skill-builder/scripts/generate-subagent.ts` | New file - generation script |
| `packages/cli/src/commands/author.ts` | Add subagent and transform commands |
| `packages/cli/src/index.ts` | Register author command group |
| `packages/cli/src/templates/subagent.md.template.ts` | New file - CLI template |

---

## Success Metrics

| Metric | Target |
|--------|--------|
| CLI commands work | Both subagent and transform functional |
| Test coverage | >80% for new code |
| Token savings | Measurable with generated subagents |
| User adoption | Clear documentation and examples |

---

## References

- Architecture: /docs/architecture/subagent-pair-generation-architecture.md
- Research: /docs/backlog/skill-optimizations/skill-builder-upgrade-prompt.md
- Research: /docs/backlog/skill-optimizations/parallel-agents-skills-research.md

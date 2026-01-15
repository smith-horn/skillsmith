# Skill Builder Upgrade Prompt

**Purpose:** Use this prompt in Claude Code to upgrade your skill-builder skill with parallel agent configuration capabilities.

---

## Prompt

```
I need to upgrade my skill-builder skill to incorporate best practices for skill-subagent integration. Based on recent research, skills should be configured to run in dedicated subagents rather than the main orchestrator context to achieve 37-97% token savings and prevent context pollution.

## Requirements

Upgrade the skill-builder skill to:

### 1. Add Subagent Configuration Generation

When creating or upgrading any skill, the skill-builder should:

- Generate a companion subagent definition file (`.claude/agents/[skill-name]-specialist.md`)
- Configure the subagent with the `skills:` field pointing to the new/upgraded skill
- Set appropriate `tools:` based on what the skill requires
- Include a focused system prompt that instructs the subagent to return structured summaries only

### 2. Subagent Template Structure

Every generated subagent should follow this pattern:

```yaml
---
name: [skill-name]-specialist
description: [Skill purpose]. Use when [trigger conditions matching skill description].
skills: [skill-name]
tools: [minimal required tools - Read, Write, Bash, etc.]
model: sonnet
---

You are a specialist for [skill domain].

## Operating Protocol

1. Execute the [skill-name] skill for the delegated task
2. Process all intermediate results internally
3. Return ONLY a structured summary to the orchestrator

## Output Format

Always respond with:
- **Task:** [what was requested]
- **Actions:** [what you did]
- **Results:** [key outcomes, max 3-5 bullet points]
- **Artifacts:** [file paths or outputs created]

Do not include verbose intermediate outputs, raw data dumps, or step-by-step logs.
Keep response under 500 tokens unless explicitly requested otherwise.
```

### 3. CLAUDE.md Integration Snippet

Generate a snippet for the user's CLAUDE.md that documents:
- When to delegate to the skill's specialist subagent
- The trigger patterns that should route to this specialist
- Example delegation syntax

Format:
```markdown
## Skill Delegation: [skill-name]

**Specialist:** [skill-name]-specialist
**Triggers:** [list of task patterns]
**Delegate when:** [conditions]

Example: "Use the [skill-name]-specialist to [typical task]"
```

### 4. Upgrade Existing Skills

When upgrading an existing skill:
- Analyze the current SKILL.md
- Identify the optimal tool set (prefer minimal/read-only when possible)
- Check if a companion subagent already exists
- Create or update the subagent definition
- Generate the CLAUDE.md integration snippet

### 5. New Skill Workflow

When creating a new skill, the workflow should be:
1. Gather skill requirements from user
2. Generate SKILL.md with proper frontmatter
3. Generate companion subagent definition
4. Generate CLAUDE.md integration snippet
5. Provide summary of all created files

### 6. Validation Checks

Before finalizing any skill creation/upgrade:
- Verify skill name uses lowercase-hyphenated format
- Ensure description includes both "what it does" AND "when to use it"
- Confirm tools list is minimal and appropriate
- Check that subagent output format instructions are included

## Deliverables

1. Update the skill-builder SKILL.md with these new capabilities
2. If there are supporting scripts or templates, update those too
3. Show me the diff of changes made
4. Create a test case: generate a sample skill + subagent pair to demonstrate the new workflow

## Context

This upgrade is based on research showing:
- Skills execute in main context by default (causes token bloat)
- Subagents do NOT automatically inherit skills
- Only custom subagents with explicit `skills:` field can use skills
- Built-in agents (Explore, Plan, general-purpose) cannot access custom skills
- Subagent isolation provides 37-97% token savings on complex tasks

The goal is to make skill-subagent pairing the DEFAULT output of the skill-builder, ensuring every skill is automatically configured for optimal context management.
```

---

## Usage Instructions

1. Open Claude Code in your skill-builder repository
2. Paste the prompt above
3. Review the proposed changes before accepting
4. Test with a sample skill creation to verify the new workflow

## Expected Outputs

After running this prompt, your skill-builder should generate:

```
.claude/
├── skills/
│   └── [new-skill]/
│       └── SKILL.md
└── agents/
    └── [new-skill]-specialist.md

+ CLAUDE.md snippet (printed to console or appended)
```

## Validation Checklist

After upgrade, verify the skill-builder:

- [ ] Creates companion subagent for every new skill
- [ ] Subagent includes `skills:` field referencing the skill
- [ ] Subagent has minimal tool permissions
- [ ] Subagent system prompt enforces summary-only output
- [ ] CLAUDE.md snippet is generated with delegation triggers
- [ ] Existing skills can be upgraded with `--upgrade` or similar flag

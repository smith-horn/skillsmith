# Skill Builder Best Practices

Guidelines for writing effective skill content and ensuring quality.

---

## Writing Effective Descriptions

### Front-Load Keywords

```yaml
# ✅ GOOD: Keywords first
description: "Generate TypeScript interfaces from JSON schema. Use when converting schemas, creating types, or building API clients."

# ❌ BAD: Keywords buried
description: "This skill helps developers who need to work with JSON schemas by providing a way to generate TypeScript interfaces."
```

### Include Trigger Conditions

```yaml
# ✅ GOOD: Clear "when" clause
description: "Debug React performance issues using Chrome DevTools. Use when components re-render unnecessarily, investigating slow updates, or optimizing bundle size."

# ❌ BAD: No trigger conditions
description: "Helps with React performance debugging."
```

### Be Specific

```yaml
# ✅ GOOD: Specific technologies
description: "Create Express.js REST endpoints with Joi validation, Swagger docs, and Jest tests. Use when building new APIs or adding endpoints."

# ❌ BAD: Too generic
description: "Build API endpoints with proper validation and testing."
```

---

## Progressive Disclosure Writing

### Keep Level 1 Brief (Overview)

```markdown
## What This Skill Does
Creates production-ready React components with TypeScript, hooks, and tests in 3 steps.
```

### Level 2 for Common Paths (Quick Start)

```markdown
## Quick Start
```bash
# Most common use case (80% of users)
generate-component MyComponent
```
```

### Level 3 for Details (Step-by-Step)

```markdown
## Step-by-Step Guide

### Creating a Basic Component
1. Run generator
2. Choose template
3. Customize options
[Detailed explanations]
```

### Level 4 for Edge Cases (Reference)

```markdown
## Advanced Configuration
For complex scenarios like HOCs, render props, or custom hooks, see [ADVANCED.md](docs/ADVANCED.md).
```

---

## Validation Checklist

Before publishing a skill, verify:

### YAML Frontmatter
- [ ] Starts with `---`
- [ ] Contains `name` field (max 64 chars)
- [ ] Contains `description` field (max 1024 chars)
- [ ] Description includes "what" and "when"
- [ ] Ends with `---`
- [ ] No YAML syntax errors

### File Structure
- [ ] SKILL.md exists in skill directory
- [ ] Directory is DIRECTLY in `~/.claude/skills/[skill-name]/` or `.claude/skills/[skill-name]/`
- [ ] Uses clear, descriptive directory name
- [ ] **NO nested subdirectories** (Claude Code requires top-level structure)

### Content Quality
- [ ] Level 1 (Overview) is brief and clear
- [ ] Level 2 (Quick Start) shows common use case
- [ ] Level 3 (Details) provides step-by-step guide
- [ ] Level 4 (Reference) links to advanced content
- [ ] Examples are concrete and runnable
- [ ] Troubleshooting section addresses common issues

### Progressive Disclosure
- [ ] Core instructions in SKILL.md (~2-5KB)
- [ ] Advanced content in separate docs/
- [ ] Large resources in resources/ directory
- [ ] Clear navigation between levels

### Testing
- [ ] Skill appears in Claude's skill list
- [ ] Description triggers on relevant queries
- [ ] Instructions are clear and actionable
- [ ] Scripts execute successfully (if included)
- [ ] Examples work as documented

---

## Choosing a Behavioral Classification

Use this decision tree to select the right classification for your skill:

```
┌─────────────────────────────────────────┐
│ Does the skill need user input to work? │
└─────────────────────────────────────────┘
         │                        │
        YES                       NO
         │                        │
         ▼                        ▼
┌─────────────────┐     ┌──────────────────────┐
│ Is input needed │     │ Autonomous Execution │
│ throughout, or  │     └──────────────────────┘
│ just upfront?   │
└─────────────────┘
    │           │
  UPFRONT   THROUGHOUT
    │           │
    ▼           ▼
┌────────────┐  ┌───────────────────────┐
│  Guided    │  │ Interactive           │
│  Decision  │  │ Exploration           │
└────────────┘  └───────────────────────┘

Exception: If behavior depends on config → Configurable Enforcement
```

---

## Common Mistakes to Avoid

### 1. Missing "When" Clause

```yaml
# ❌ BAD
description: "A tool for working with APIs"

# ✅ GOOD
description: "Generate API client code from OpenAPI specs. Use when integrating external APIs, building SDK wrappers, or automating API consumption."
```

### 2. Too Generic

```yaml
# ❌ BAD
description: "Helps with code"

# ✅ GOOD
description: "Generate unit tests for Python functions using pytest and mocking. Use when adding test coverage, implementing TDD, or testing legacy code."
```

### 3. Context Overload

```markdown
# ❌ BAD: Everything in SKILL.md (5000+ lines)

# ✅ GOOD: Use progressive disclosure
SKILL.md (500 lines) → docs/ADVANCED.md → docs/API_REFERENCE.md
```

### 4. Nested Directories

```bash
# ❌ BAD: Nested under category
~/.claude/skills/development/my-skill/SKILL.md

# ✅ GOOD: Top-level only
~/.claude/skills/my-skill/SKILL.md
```

### 5. No Examples

```markdown
# ❌ BAD: Abstract description only
This skill validates JSON.

# ✅ GOOD: Concrete examples
## Quick Start
```bash
./scripts/validate.sh config.json
# Output: ✅ Valid JSON (23 keys, 3 nested objects)
```
```

---

## File Size Guidelines

| File Type | Recommended Size | Max Size |
|-----------|------------------|----------|
| SKILL.md | 2-5KB | 10KB |
| Sub-documentation | 5-15KB each | 30KB |
| Scripts | Variable | No strict limit |
| Templates | Variable | No strict limit |

**Rule of Thumb**: If SKILL.md exceeds 500 lines, decompose into sub-files.

---

## Naming Conventions

### Skill Directory Names

```bash
# ✅ GOOD: Lowercase, hyphens
my-api-builder
react-component-gen
database-migration

# ❌ BAD: Spaces, underscores, mixed case
My API Builder
react_component_gen
DatabaseMigration
```

### Script Names

```bash
# ✅ GOOD: Descriptive, action-oriented
setup.sh
generate-component.sh
validate-output.sh

# ❌ BAD: Vague, numbered
script1.sh
run.sh
do-stuff.sh
```

### Sub-Documentation Names

```bash
# ✅ GOOD: Content-descriptive
specification.md
templates.md
troubleshooting.md
api-reference.md

# ❌ BAD: Numbered, vague
doc1.md
more-info.md
extra.md
```

# Activation Auditor

> **Navigation**: [Components Index](./index.md) | [Technical Index](../index.md)
>
> **Research Reference**: [Activation Failure RCA](../../research/skill-activation-failure-rca.md)

---

## Problem Context

Research shows ~50% of installed skills fail to activate properly. The causes break down as:

| Cause | Prevalence | Addressable by Tooling |
|-------|------------|------------------------|
| Non-deterministic model invocation | 40% | No (Anthropic) |
| Character budget exhaustion | 20% | **Partial** |
| YAML/frontmatter formatting errors | 15% | **Yes** |
| Directory discovery failures | 10% | **Partial** |
| MCP connection issues | 10% | No (Anthropic) |
| Plan mode restrictions | 5% | No (Anthropic) |

---

## What We Can Fix

The Activation Auditor addresses categories 2, 3, and 4 (~25-35% of failures):

### YAML/Frontmatter Validation

```typescript
interface FrontmatterValidator {
  validate(skillmd: string): ValidationResult;
}

interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
  fixes: SuggestedFix[];
}

const FRONTMATTER_SCHEMA = {
  name: {
    required: true,
    maxLength: 64,
    pattern: /^[a-z0-9-]+$/i,
  },
  description: {
    required: true,
    maxLength: 1024,       // Hard limit from Claude Code
    recommendedMax: 200,   // For activation reliability
  },
  mode: {
    type: 'boolean',
    default: false,
  },
};

function validateFrontmatter(content: string): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];
  const fixes: SuggestedFix[] = [];

  const parsed = parseFrontmatter(content);

  // Check name
  if (!parsed.name) {
    errors.push({ field: 'name', message: 'Required field missing' });
  } else if (parsed.name.length > 64) {
    errors.push({ field: 'name', message: `Exceeds 64 char limit (${parsed.name.length})` });
    fixes.push({ field: 'name', suggestion: parsed.name.slice(0, 64) });
  }

  // Check description
  if (!parsed.description) {
    errors.push({ field: 'description', message: 'Required field missing' });
  } else {
    if (parsed.description.length > 1024) {
      errors.push({
        field: 'description',
        message: `Exceeds 1024 char limit (${parsed.description.length})`
      });
    }
    if (parsed.description.length > 200) {
      warnings.push({
        field: 'description',
        message: 'Long descriptions reduce activation reliability',
      });
    }
  }

  // Check for Prettier-broken formatting
  if (content.includes('\n  ') && content.match(/description:\s*\|/)) {
    warnings.push({
      field: 'description',
      message: 'Multi-line description may break parsing (Prettier issue)',
    });
    fixes.push({
      field: 'description',
      suggestion: 'Add # prettier-ignore before frontmatter',
    });
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    fixes,
  };
}
```

---

### Character Budget Estimation

```typescript
interface BudgetEstimator {
  estimateBudget(installedSkills: Skill[]): BudgetReport;
}

interface BudgetReport {
  total_chars: number;
  budget_limit: number;         // Default 15,000, configurable
  usage_percent: number;
  at_risk_skills: Skill[];      // Skills that may be truncated
  recommendations: string[];
}

function estimateBudget(skills: Skill[]): BudgetReport {
  const DEFAULT_BUDGET = 15000;

  const skillCharCounts = skills.map(s => ({
    skill: s,
    chars: estimateSkillChars(s),
  }));

  const total = skillCharCounts.reduce((sum, s) => sum + s.chars, 0);

  // Skills loaded last are truncated first
  let cumulative = 0;
  const atRisk: Skill[] = [];

  for (const { skill, chars } of skillCharCounts) {
    cumulative += chars;
    if (cumulative > DEFAULT_BUDGET) {
      atRisk.push(skill);
    }
  }

  return {
    total_chars: total,
    budget_limit: DEFAULT_BUDGET,
    usage_percent: (total / DEFAULT_BUDGET) * 100,
    at_risk_skills: atRisk,
    recommendations: generateBudgetRecommendations(total, atRisk),
  };
}

function generateBudgetRecommendations(total: number, atRisk: Skill[]): string[] {
  const recs: string[] = [];

  if (total > 15000) {
    recs.push(
      'Set SLASH_COMMAND_TOOL_CHAR_BUDGET=30000 to increase budget'
    );
  }

  if (atRisk.length > 0) {
    recs.push(
      `Consider consolidating or removing: ${atRisk.map(s => s.name).join(', ')}`
    );
  }

  return recs;
}
```

---

### Directory Discovery Assistance

```typescript
interface DirectoryAuditor {
  auditDirectories(): DirectoryAuditResult;
}

interface DirectoryAuditResult {
  expected_locations: string[];
  found_skills: DiscoveredSkill[];
  issues: DirectoryIssue[];
}

interface DirectoryIssue {
  type: 'missing_skillmd' | 'symlink_issue' | 'permission_issue' | 'wrong_location';
  path: string;
  description: string;
  fix: string;
}

async function auditDirectories(): Promise<DirectoryAuditResult> {
  const issues: DirectoryIssue[] = [];

  const locations = [
    '~/.claude/skills/',
    './.claude/skills/',
    '~/.config/claude/skills/',
  ];

  for (const location of locations) {
    const expanded = expandPath(location);

    // Check for symlinks (known issue)
    if (await isSymlink(expanded)) {
      issues.push({
        type: 'symlink_issue',
        path: expanded,
        description: 'Symlinked skill directories may not be discovered (GitHub #14836)',
        fix: 'Copy skills directly instead of symlinking',
      });
    }

    // Check for SKILL.md in each skill directory
    const skillDirs = await listDirectories(expanded);
    for (const dir of skillDirs) {
      if (!await fileExists(join(dir, 'SKILL.md'))) {
        issues.push({
          type: 'missing_skillmd',
          path: dir,
          description: 'Skill directory missing SKILL.md file',
          fix: 'Ensure SKILL.md exists in the skill root',
        });
      }
    }
  }

  return {
    expected_locations: locations,
    found_skills: await discoverSkills(locations),
    issues,
  };
}
```

---

### Hooks Generation

```typescript
interface HooksGenerator {
  generateActivationHooks(skills: Skill[]): HookConfig;
}

interface HookConfig {
  hooks: Hook[];
  settings_json_update: object;
}

function generateActivationHooks(skills: Skill[]): HookConfig {
  const hooks: Hook[] = skills.map(skill => ({
    matcher: {
      type: 'UserPromptSubmit',
      pattern: extractTriggerKeywords(skill.description),
    },
    action: {
      type: 'prefix',
      content: `Consider using the ${skill.name} skill for this task. `,
    },
  }));

  return {
    hooks,
    settings_json_update: {
      hooks: hooks.map(h => ({
        event: 'UserPromptSubmit',
        pattern: h.matcher.pattern,
        command: `echo "${h.action.content}"`,
      })),
    },
  };
}
```

---

## Auditor Architecture

```
User: "audit my skills"
        |
        v
+------------------+
| audit_activation |
+------------------+
        |
        v
+------------------+     +------------------+     +------------------+
| Frontmatter      |     | Budget           |     | Directory        |
| Validator        |     | Estimator        |     | Auditor          |
+------------------+     +------------------+     +------------------+
        |                       |                       |
        v                       v                       v
+================================================================+
|                    Consolidated Audit Report                    |
+================================================================+
        |
        v
+------------------+
| Suggested Fixes  |
| + Generated      |
| Hooks            |
+------------------+
```

---

## Diagnostic Output Format

```markdown
# Skill Activation Audit Report
**Generated:** 2025-12-26T10:30:00Z

## Summary
- **Installed skills:** 12
- **Likely to activate:** 8 (67%)
- **At risk:** 4 (33%)
- **Critical issues:** 2

## Critical Issues

### 1. Character Budget Exceeded
**Status:** CRITICAL
**Impact:** 3 skills invisible to Claude

Your skills use **18,400 characters** but the default budget is **15,000**.

**At-risk skills (loaded last, truncated first):**
- `community/readme-generator` (1,200 chars)
- `community/test-helper` (1,800 chars)
- `myskills/custom-formatter` (400 chars)

**Fix:**
```bash
export SLASH_COMMAND_TOOL_CHAR_BUDGET=30000
```

### 2. Invalid Frontmatter
**Skill:** `myskills/custom-formatter`
**Status:** CRITICAL

**Errors:**
- `description` field exceeds 1024 character limit (1,156 chars)

**Suggested fix:**
[Truncated description provided]

## Warnings

### 1. Trigger Overlap Detected
**Skills:** `obra/superpowers/debugging`, `anthropic/test-fixing`
**Overlap:** 78%

Both skills activate on "test failure" scenarios. Consider:
- Setting priority order
- Using explicit invocation for one

### 2. Symlinked Directory
**Path:** `~/.claude/skills/` -> `/shared/skills/`

Symlinked directories may not be discovered. Consider copying directly.

## Generated Activation Hooks

The following hooks can improve activation reliability:

```json
{
  "hooks": [
    {
      "event": "UserPromptSubmit",
      "pattern": "(?i)(debug|test.*fail|error)",
      "command": "echo 'Consider using the debugging skill.'"
    }
  ]
}
```

**To apply:** Add to `~/.claude/settings.json`

## Recommendations

1. Increase character budget to 30,000
2. Fix frontmatter in `custom-formatter`
3. Consider removing low-value skills to save budget
4. Add generated hooks to improve activation rate
```

---

## Related Documentation

- [Activation Failure RCA](../../research/skill-activation-failure-rca.md) - Detailed research
- [Conflict Detection](../security/conflict-detection.md) - Skill conflicts
- [API Design](../api/index.md) - audit_activation tool specification

---

*Back to: [Components Index](./index.md)*

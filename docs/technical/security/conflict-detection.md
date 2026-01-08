# Skill Conflict Resolution

> **Navigation**: [Security Index](./index.md) | [Technical Index](../index.md)
>
> **Research Reference**: [Conflicts Research](../../research/skill-conflicts-security.md#part-1-skill-conflicts-deep-dive)

---

## Conflict Taxonomy

| Type | Description | Detection Difficulty | Example |
|------|-------------|---------------------|---------|
| **Behavioral** | Contradictory instructions | Hard | "Ship fast" vs "Test thoroughly" |
| **Trigger** | Multiple skills match same intent | Medium | Both activate on "test failure" |
| **Convention** | Incompatible style rules | Medium | Tabs vs spaces |
| **Output** | Write to same files/paths | Easy | Both generate README.md |

---

## Conflict Detection

### Detection Architecture

```typescript
interface ConflictDetector {
  detectConflicts(skills: Skill[]): ConflictReport;
}

interface ConflictReport {
  conflicts: Conflict[];
  warnings: Warning[];
  recommendations: string[];
}

interface Conflict {
  type: 'trigger' | 'output' | 'convention' | 'behavioral';
  severity: 'high' | 'medium' | 'low';
  skills: [string, string];     // The two conflicting skills
  description: string;
  resolution_options: string[];
}
```

### Trigger Overlap Detection

```typescript
function detectTriggerOverlap(skills: Skill[]): Conflict[] {
  const conflicts: Conflict[] = [];

  for (let i = 0; i < skills.length; i++) {
    for (let j = i + 1; j < skills.length; j++) {
      const similarity = computeDescriptionSimilarity(
        skills[i].description,
        skills[j].description
      );

      if (similarity > 0.7) {
        conflicts.push({
          type: 'trigger',
          severity: similarity > 0.85 ? 'high' : 'medium',
          skills: [skills[i].id, skills[j].id],
          description: `Both skills activate on similar triggers (${(similarity * 100).toFixed(0)}% overlap)`,
          resolution_options: [
            `Set priority: ${skills[i].id} > ${skills[j].id}`,
            `Disable one skill for this project`,
            `Use explicit invocation for one skill`,
          ],
        });
      }
    }
  }

  return conflicts;
}
```

### Output Collision Detection

```typescript
function detectOutputCollision(skills: Skill[]): Conflict[] {
  const outputPaths = new Map<string, string[]>();

  for (const skill of skills) {
    for (const path of extractOutputPaths(skill.content)) {
      if (!outputPaths.has(path)) {
        outputPaths.set(path, []);
      }
      outputPaths.get(path)!.push(skill.id);
    }
  }

  return Array.from(outputPaths.entries())
    .filter(([_, skills]) => skills.length > 1)
    .map(([path, skillIds]) => ({
      type: 'output' as const,
      severity: 'high' as const,
      skills: skillIds.slice(0, 2) as [string, string],
      description: `Multiple skills write to ${path}`,
      resolution_options: [
        `Configure different output paths`,
        `Disable one skill`,
      ],
    }));
}
```

---

## Conflict Resolution

### Priority/Precedence Model

```yaml
# ~/.claude-discovery/config/priorities.yaml
skill_priorities:
  # Global priority (higher = wins)
  - anthropic/*: 100              # Official always wins
  - obra/superpowers/*: 80        # Trusted sources next
  - community/*: 50               # Community default

  # Per-project overrides
  projects:
    /Users/me/enterprise-app:
      - company/internal-*: 90    # Internal skills win here
      - fast-shipping: disabled   # Explicitly disabled

conflict_resolution:
  default: highest_priority       # Options: highest_priority, ask, merge, disable_later

  # Per-type resolution
  trigger_conflicts: ask          # Always ask user
  output_conflicts: disable_later # Second skill disabled
  convention_conflicts: highest_priority
```

### User Controls

```typescript
interface ConflictResolutionUI {
  // Called when conflict detected at install time
  onConflictDetected(conflict: Conflict): Promise<Resolution>;
}

interface Resolution {
  action: 'proceed' | 'cancel' | 'configure';
  priority_override?: Record<string, number>;
  disabled_skills?: string[];
}
```

---

## Composition Rules Specification

Extension to SKILL.md frontmatter:

```yaml
---
name: test-first-development
description: TDD workflow for robust code

# Composition rules (proposed extension)
conflicts_with:
  - fast-shipping
  - move-fast-break-things

requires:
  - git-workflow-basics

complements:
  - systematic-debugging
  - code-review-standards

priority_hint: 80                 # Author-suggested priority
---
```

### Composition Fields

| Field | Type | Description |
|-------|------|-------------|
| `conflicts_with` | string[] | Skills that conflict with this one |
| `requires` | string[] | Skills that must be installed first |
| `complements` | string[] | Skills that work well together |
| `priority_hint` | number | Author-suggested priority (0-100) |

---

## Conflict Resolution Flow

```
User: "install skill-a"
        |
        v
+------------------+
| check_conflicts  |
+------------------+
        |
        v
+------------------+
| Conflicts found? |----No----> Install
+------------------+
        |
       Yes
        v
+------------------+
| Severity level?  |
+------------------+
        |
    +---+---+
    |       |
  High    Low/Med
    |       |
    v       v
+-------+  +-------+
| Block |  | Warn  |
+-------+  +-------+
    |           |
    v           v
+-------+  +-------+
| User  |  | User  |
| must  |  | may   |
| resolve| | proceed|
+-------+  +-------+
```

---

## Conflict Report Example

```markdown
## Conflict Analysis Report

### High Severity Conflicts

#### Trigger Conflict: test-first vs fast-shipping
**Overlap:** 85%

Both skills activate when discussing:
- Testing strategies
- Development workflow
- Code quality

**Resolution Required:**
1. Set priority: `test-first > fast-shipping`
2. Disable `fast-shipping` for this project
3. Use explicit invocation: `@fast-shipping` when needed

### Medium Severity Conflicts

#### Convention Conflict: eslint-strict vs prettier-relaxed
**Issue:** Conflicting formatting rules

- `eslint-strict`: Enforces tabs, double quotes
- `prettier-relaxed`: Uses spaces, single quotes

**Suggested Resolution:**
Configure one to yield to the other in `.prettierrc`.

### Warnings

#### Output Overlap: readme-generator vs doc-builder
Both skills may generate `README.md`.

Consider:
- Disabling one skill
- Configuring different output paths
```

---

## Related Documentation

- [Conflicts Research](../../research/skill-conflicts-security.md) - Detailed research
- [Activation Auditor](../components/activation-auditor.md) - Audit for conflicts
- [Trust Tiers](./trust-tiers.md) - Trust classification

---

*Next: [Static Analysis](./static-analysis.md)*

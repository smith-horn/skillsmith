# Journey: Daily Workflow Integration

> **Navigation**: [Design Index](../index.md) > [Journeys](./index.md) > Daily Workflow

How Discovery becomes a habitual part of development workflow.

---

## Journey Overview

```
TRIGGER ──────> ENGAGEMENT ──────> VALUE ──────> EXIT
    │                │               │            │
    │                │               │            │
    ▼                ▼               ▼            ▼
"I need help   "Let me check    "That worked"  "Back to
 with X"        Discovery"                       coding"
```

---

## Stage: Trigger

**User Goal:** Recognize a situation where Discovery could help

**Emotional State:** Focused on work
**Anxiety Level:** Varies (problem-dependent)
**Confidence:** N/A

### Trigger Types

1. **Problem-driven:** "I'm stuck on X, is there a skill for this?"
2. **Curiosity-driven:** "I wonder if there's a better way..."
3. **Notification-driven:** "Discovery just suggested something"
4. **Routine-driven:** "Weekly check for new skills"

### Design Requirements

- Memorable commands for quick access
- Non-intrusive but visible presence
- Context-aware suggestions
- Easy invocation from any workflow point

### Key Commands

```
/discover recommend     # Context-aware recommendation
/discover search <q>    # Quick search
/discover help          # What can I do?
```

---

## Stage: Engagement

**User Goal:** Quickly find relevant information or skills

**Emotional State:** Task-focused
**Anxiety Level:** Low
**Confidence:** Medium-High (familiar with system)

### Key Actions

- Search with specific query
- Browse recommendations
- Compare similar skills
- Read skill details

### Design Requirements

- Fast response time (<1 second)
- Relevant results on first search
- Clear comparison mechanisms
- Scannable result format

### Potential Failure Points

- Slow search response
- Irrelevant results
- Too many results to process
- Confusing presentation

### Result Format

```
Based on your query "api mocking":

1. api-mocking-patterns (82/100)
   "12 API mocking patterns for Jest and Vitest"
   2,341 installs this month

2. test-fixtures (78/100)
   "Generate realistic test data"
   1,892 installs this month

[Install #1] [Compare] [More options]
```

---

## Stage: Value

**User Goal:** Receive help that solves the triggering problem

**Emotional State:** Evaluating
**Anxiety Level:** Low
**Confidence:** High

### Key Actions

- Install recommended skill
- Use skill in current task
- Verify skill helped
- Note for future reference

### Design Requirements

- One-command install
- Immediate availability
- Clear activation confirmation
- Value visible in workflow

### Success Confirmation

```
Done. api-mocking-patterns is installed and active.

This skill will help when you're:
- Writing mock API responses
- Creating test fixtures
- Simulating network errors

It just activated for your current task.
```

---

## Stage: Exit

**User Goal:** Return to primary work with minimal friction

**Emotional State:** Satisfied or frustrated (depending on value)
**Anxiety Level:** Low
**Confidence:** High

### Key Actions

- Complete Discovery interaction
- Return to coding task
- (Optional) Note experience
- Exit cleanly

### Design Requirements

- No lingering processes
- Clean exit without prompts
- State preserved for next session
- No follow-up intrusions

### Clean Exit Example

```
Skill installed. Returning to your work.

(The skill will activate automatically when relevant.
 Use /discover status to check anytime.)
```

---

## Workflow Integration Patterns

### Pattern: Problem-Driven Search

```
User encounters problem
  └─> Searches for skill
      └─> Reviews options
          └─> Installs best match
              └─> Returns to work
```

**Optimal time:** Under 2 minutes

### Pattern: Proactive Suggestion

```
Discovery detects pattern in work
  └─> Suggests relevant skill (at pause point)
      └─> User reviews briefly
          └─> Installs or dismisses
              └─> Continues work
```

**Optimal time:** Under 30 seconds

### Pattern: Routine Check

```
Weekly or on-demand
  └─> Browse new/trending skills
      └─> Evaluate interest
          └─> Install promising ones
              └─> Resume normal work
```

**Optimal time:** 5-10 minutes

---

## Success Metrics

| Stage | Metric | Target |
|-------|--------|--------|
| Trigger | Command recall | > 80% |
| Trigger | Time to first search | < 5 seconds |
| Engagement | Search response time | < 1 second |
| Engagement | Relevant first result | > 60% |
| Value | Install to activation | < 30 seconds |
| Value | Skill helps with task | > 70% |
| Exit | Time to return to work | < 10 seconds |
| Exit | Residual processes | 0 |

---

## Related Documents

- [Entry Points](../entry-points.md) - How users access daily workflow
- [Delight Moments](../moments/delight.md) - Creating joy in routine
- [Progressive Disclosure](../progressive-disclosure.md) - Command availability

---

*Daily Workflow Journey - December 26, 2025*

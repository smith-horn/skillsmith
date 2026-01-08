# Journey: Team Adoption

> **Navigation**: [Design Index](../index.md) > [Journeys](./index.md) > Team Adoption

From individual champion to team-wide standardization.

---

## Journey Overview

```
CHAMPION       TEAM TRIAL     STANDARDIZATION      SCALE
DISCOVERY ────> INITIATED ────> ACHIEVED ──────> OPERATIONS
    │                │               │                │
    ▼                ▼               ▼                ▼
"I found       "Let's all     "This is how    "New hires
 something      try this"      we work now"    onboard fast"
 useful"
```

---

## Stage: Champion Discovery

**User:** Individual developer (becomes team champion)

**User Goal:** Discover value worth sharing with team

**Emotional State:** Enthusiastic
**Anxiety Level:** Low (personal use)
**Confidence:** High

### Key Actions

- Personal success with product
- Identifies team-relevant skills
- Prepares justification for team
- Initiates team discussion

### Design Requirements

- Shareable reports for team discussion
- Team-relevant skill bundles
- Export configuration for others
- ROI indicators for persuasion

### Champion Report Example

```
Discovery Report for [Team Name]
Generated: December 26, 2025

I've been using Discovery Hub for 3 weeks. Here's what I found:

Skills Installed: 5
Time Saved (estimated): 6-8 hours
Top Performer: systematic-debugging (23 activations)

Recommended for Team:
1. test-fixing - Would help with our flaky tests
2. api-design - Matches our current project
3. code-review-checklist - Standardizes reviews

[Share with Team] [Export Configuration]
```

---

## Stage: Team Trial

**User:** Team lead + early adopters

**User Goal:** Validate product works for team context

**Emotional State:** Cautiously optimistic
**Anxiety Level:** Medium (responsibility for team)
**Confidence:** Medium

### Key Actions

- Roll out to 2-3 team members
- Monitor adoption and issues
- Collect feedback
- Make go/no-go decision

### Design Requirements

- Easy installation for multiple users
- Consistent experience across team
- Visible usage and issues
- Simple rollback if needed

### Potential Failure Points

- Different behavior for different users
- No visibility into team adoption
- One bad experience poisons team
- No escalation path for issues

### Team Trial Dashboard

```
Team Trial Status
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Participants: 4 of 8 invited
Duration: 1 week

Installation Status:
  Alice    [Installed] Active, 12 skill activations
  Bob      [Installed] Active, 8 skill activations
  Carol    [Installed] Inactive (no activations yet)
  Dave     [Pending]   Invitation sent

Issues Reported: 1
  - Carol: "Skill didn't activate for CSS task" [Resolved]

Feedback:
  - Alice: "Helpful for debugging" (positive)
  - Bob: "Saved time on test fixes" (positive)

[Expand Trial] [End Trial] [View Details]
```

---

## Stage: Standardization

**User:** Team lead + all team members

**User Goal:** Establish consistent tool usage across team

**Emotional State:** Invested
**Anxiety Level:** Low-Medium
**Confidence:** High

### Key Actions

- Define approved skill set
- Create onboarding documentation
- Configure team-wide settings
- Monitor compliance

### Design Requirements

- Team skill registry
- Onboarding checklists
- Usage analytics by team member
- Policy enforcement tools

### Team Registry Example

```
Team Skill Registry: Frontend Team
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Approved Skills (Required):
  1. test-fixing          [All 8 members installed]
  2. code-review-checklist [All 8 members installed]
  3. systematic-debugging  [7 of 8 installed]

Approved Skills (Optional):
  4. frontend-design      [5 of 8 installed]
  5. api-mocking-patterns [3 of 8 installed]

Pending Approval:
  - performance-profiling (requested by Alice)

[Manage Registry] [View Compliance] [Onboarding Checklist]
```

---

## Stage: Scale Operations

**User:** Engineering manager + new hires

**User Goal:** Maintain standards as team grows

**Emotional State:** Operational
**Anxiety Level:** Low
**Confidence:** High

### Key Actions

- Onboard new developers quickly
- Update standards as needed
- Monitor team health metrics
- Handle exceptions and requests

### Design Requirements

- Automated onboarding flows
- Standard update mechanisms
- Health dashboards
- Exception handling processes

### New Hire Onboarding

```
Welcome to the Frontend Team!

Your team uses Discovery Hub for skill management.
I'll help you get set up with the team's standard skills.

Team Standards (3 required skills):
  1. test-fixing           [Ready to install]
  2. code-review-checklist [Ready to install]
  3. systematic-debugging  [Ready to install]

[Install All Team Skills] [Install One by One]

This takes about 2 minutes. Your lead (Alice) will be
notified when you're set up.
```

### Team Health Dashboard

```
Team Health: Frontend Team
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Members: 12
Compliance: 92% (11 of 12 have all required skills)

This Week:
  - Skill activations: 156 (up 12% from last week)
  - Most used: test-fixing (67 activations)
  - New skills installed: 3

Alerts:
  - Dave missing required skill: systematic-debugging
  - New skill version available: test-fixing v2.1

[View Member Details] [Send Compliance Reminder] [Update Standards]
```

---

## Success Metrics

| Stage | Metric | Target |
|-------|--------|--------|
| Champion | Report generation | > 50% of active users |
| Champion | Report sharing | > 30% of reports |
| Trial | Trial completion | > 70% |
| Trial | Trial to adoption | > 50% |
| Standardization | Compliance rate | > 90% |
| Standardization | Skill activation per member | > 5/week |
| Scale | New hire time to setup | < 10 minutes |
| Scale | Standards maintenance | Monthly review |

---

## Related Documents

- [Standardizer Persona](../personas/standardizer.md) - Primary persona for this journey
- [Entry Points](../entry-points.md) - Team-focused entry points
- [Failure States](../failure-states.md) - Team adoption failures

---

*Team Adoption Journey - December 26, 2025*

# Journey: Skill Creation and Publishing

> **Navigation**: [Design Index](../index.md) > [Journeys](./index.md) > Skill Creation

From personal tool to community contribution.

---

## Journey Overview

```
CREATE SKILL ───> SEEK           GET            BUILD
(Personal)        DISTRIBUTION ──> DISCOVERED ──> REPUTATION
    │                 │               │               │
    ▼                 ▼               ▼               ▼
"This helps    "Others might   "Someone       "I'm known for
 MY workflow"   find this       installed      this skill"
                useful"         my skill"
```

---

## Stage: Create Skill (Personal)

**User Goal:** Build something that improves personal workflow

**Emotional State:** Creative, focused
**Anxiety Level:** Low
**Confidence:** High (in domain expertise)

### Key Actions

- Identify personal workflow gap
- Build custom skill
- Test and refine
- Use in daily work

### Design Requirements

- Skill creation documentation
- Testing frameworks
- Local skill management
- Usage tracking for personal skills

### Personal Skill Creation

```
Creating a new skill...

Skill name: api-rate-limiter
Description: Helps implement rate limiting patterns

Files created:
  ~/.claude/skills/api-rate-limiter/
    ├── SKILL.md          # Skill definition
    ├── examples/         # Usage examples
    └── tests/            # Validation tests

Next steps:
  1. Edit SKILL.md to define your skill
  2. Add examples to the examples/ folder
  3. Test with: /discover test api-rate-limiter

[Open in editor] [View documentation]
```

---

## Stage: Seek Distribution

**User Goal:** Share creation with others who might benefit

**Emotional State:** Hopeful, vulnerable
**Anxiety Level:** Medium (fear of rejection)
**Confidence:** Medium

### Key Actions

- Prepare skill for public consumption
- Submit to registry
- Understand quality requirements
- Await initial feedback

### Design Requirements

- Clear publishing checklist
- Quality score preview before publish
- Improvement suggestions
- Submission status tracking

### Potential Failure Points

- Unclear quality requirements
- Rejection without explanation
- Opaque scoring process
- Long wait for approval

### Pre-Publish Review

```
Publishing Review: api-rate-limiter
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Quality Preview: 72/100

Breakdown:
  Documentation:  22/30  (Good, but could use more examples)
  Code Quality:   28/35  (Strong)
  Maintenance:    22/35  (No version history yet)

Improvement Suggestions:
  1. Add 2+ more usage examples (+4 points)
  2. Include a troubleshooting section (+3 points)
  3. Add changelog for future updates (+5 points)

Current tier: "Community" (70-79)
With improvements: "Trusted" (80-89)

[Publish Now] [Improve First] [Save Draft]
```

---

## Stage: Get Discovered

**User Goal:** Have skill found by relevant users

**Emotional State:** Anxious, monitoring
**Anxiety Level:** Medium-High
**Confidence:** Variable

### Key Actions

- Monitor install statistics
- Respond to feedback
- Improve based on suggestions
- Promote in relevant contexts

### Design Requirements

- Real-time install notifications
- Feedback aggregation
- Quality score trends
- Discoverability insights

### Author Dashboard

```
Author Dashboard: api-rate-limiter
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Published: 2 weeks ago
Quality Score: 76/100 (up 4 points)

Installs:
  This week:  23
  Total:      47
  Trend:      [▁▂▃▅▆] Rising

Discovery Sources:
  Search "rate limit":     15 installs
  "Similar to X" recs:     18 installs
  Direct link:             14 installs

Feedback:
  "Works great for Redis" - positive
  "Wish it supported MySQL" - feature request
  "Clear examples" - positive

[View Full Analytics] [Respond to Feedback] [Update Skill]
```

---

## Stage: Build Reputation

**User Goal:** Become recognized contributor to ecosystem

**Emotional State:** Proud, responsible
**Anxiety Level:** Low-Medium
**Confidence:** High

### Key Actions

- Maintain and update skill
- Respond to community
- Create additional skills
- Become go-to expert

### Design Requirements

- Author profile page
- Skill portfolio display
- Recognition badges
- Community interaction tools

### Author Profile

```
Author Profile: @alexdev
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Published Skills: 3
Total Installs: 892
Average Rating: 4.2/5

Skills:
  1. api-rate-limiter      (76/100)  412 installs
  2. redis-patterns        (82/100)  328 installs
  3. cache-invalidation    (71/100)  152 installs

Badges:
  [Rising Author]  First skill reached 100 installs
  [Responsive]     Responds to feedback within 48h
  [Quality Focus]  Average score above 75

Recent Activity:
  - Updated api-rate-limiter to v1.2
  - Responded to 3 feedback items
  - Published cache-invalidation

[Edit Profile] [View Public Page] [Embed Badge]
```

### Embeddable Badge

```html
<!-- For GitHub README -->
<a href="https://discoveries.dev/@alexdev">
  <img src="https://discoveries.dev/badge/@alexdev"
       alt="Discovery Hub Author: 892 installs" />
</a>
```

---

## Success Metrics

| Stage | Metric | Target |
|-------|--------|--------|
| Create | Personal skills created | Track for conversion |
| Create | Personal skill usage | > 5 activations/week |
| Distribute | Publish conversion | > 20% of personal skills |
| Distribute | Pre-publish improvements | > 50% take suggestions |
| Discovery | First external install | Within 2 weeks |
| Discovery | Install growth rate | > 10% week over week |
| Reputation | Author retention | > 70% at 6 months |
| Reputation | Second skill creation | > 30% of authors |

---

## Milestone Celebrations

### First Install
```
Your first external install!

Someone just installed api-rate-limiter.
They found it by searching "rate limiting nodejs".

This is the start. Keep building.

[See Install Details] [Share This Moment]
```

### 100 Installs
```
Milestone: 100 Installs!

api-rate-limiter has now been installed by 100 developers.

You've earned: [Rising Author] badge

Your skill is helping real people solve real problems.
That's worth celebrating.

[Share Achievement] [View Analytics]
```

---

## Related Documents

- [Creator Persona](../personas/creator.md) - Primary persona for this journey
- [Delight Moments](../moments/delight.md) - Creator celebration design
- [Tone of Voice](../tone-of-voice.md) - How to communicate with creators

---

*Skill Creation Journey - December 26, 2025*

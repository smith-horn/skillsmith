# Design Overview

> **Navigation**: [Design Index](./index.md) | Overview

**Version:** 1.1
**Date:** December 26, 2025
**Purpose:** Source of truth for all experience design decisions

---

## Executive Summary

Claude Discovery Hub is designed to help developers find, evaluate, and integrate AI-assisted skills into their workflow. This document establishes the design principles that guide all user experience decisions.

### Research Foundation

This design brief is informed by comprehensive Layer 1-3 research across 150+ sources:
- **Layer 1 (Mental Models):** How users describe their problems in their own words
- **Layer 2 (Ecosystem):** How skill authors, platforms, and enterprises view the problem
- **Layer 3 (Behavioral):** What frictions, habits, and biases block discovery

**Core Research Insight:**

> "The Claude Skill Discovery problem is fundamentally behavioral, not technical. Users with efficient workflows actively resist discovering skills that could improve those workflows."

### The Behavioral Paradox

Research reveals a fundamental tension:

| What Makes Users Productive | What It Blocks |
|----------------------------|----------------|
| Context preservation | Exploration of new capabilities |
| Task focus | Discovery of improvements |
| Workflow automation | Learning new approaches |
| "Good enough" efficiency | Optimization seeking |

**Design Imperative:** Discovery must happen *within* existing workflows, not as a separate activity that interrupts them.

---

## Design Principles

These principles guide all design decisions for Claude Discovery Hub. When in doubt, return to these.

### 1. Honest Before Impressive

**Definition:** Never hide limitations. Users trust systems that acknowledge what they cannot do.

**In Practice:**
- Show skill activation success rates even when unflattering
- Display recommendation accuracy honestly ("70% accuracy" not "smart recommendations")
- Admit when search finds nothing useful instead of showing irrelevant results
- Document what the system does not support

**Anti-pattern:** "Congratulations on your amazing results!" when results are mediocre.

---

### 2. Recoverable by Default

**Definition:** Every action can be undone. Every commitment can be reversed. Users adopt faster when escape routes are visible.

**In Practice:**
- One-command uninstall for every skill
- Rollback to previous configuration available
- "Undo" offered immediately after every install
- Session state preserved for recovery from failures

**Anti-pattern:** Install flows that cannot be reversed without manual intervention.

---

### 3. Guide Without Prescribing

**Definition:** Offer clear recommendations while respecting user autonomy. Guidance should feel like a knowledgeable peer, not a directive.

**In Practice:**
- "Based on your stack, I'd suggest..." not "You should install..."
- Always provide alternatives alongside recommendations
- Let users disagree without friction
- Explain reasoning behind suggestions

**Anti-pattern:** Modal dialogs that require action before continuing.

---

### 4. Reveal Complexity Gradually

**Definition:** New users see simple choices. Power reveals itself to those who seek it. The interface grows with user expertise.

**In Practice:**
- First-run shows 3 options maximum
- Advanced features hidden behind explicit "show more" actions
- Complexity unlocked through demonstrated competence
- Settings have sensible defaults that work for 80% of users

**Anti-pattern:** Showing every feature on first launch.

---

### 5. Celebrate Users, Not Product

**Definition:** Achievements belong to the user. The system is a tool, not a hero.

**In Practice:**
- "You completed this exercise" not "Our exercise is complete"
- Progress visualization emphasizes user growth
- Success messages focus on user outcomes
- Milestones reflect user capability, not product usage

**Anti-pattern:** "Discovery Hub helped you find 12 skills!"

---

### 6. Failure Is a Feature

**Definition:** Errors handled gracefully build more trust than errors avoided. The system's response to failure defines its character.

**In Practice:**
- Every error explains what happened
- Every error offers a path forward
- Every error collects feedback for improvement
- Silent failures are treated as bugs

**Anti-pattern:** "An error occurred. Please try again."

---

### 7. Presence Without Intrusion

**Definition:** The system should be available when needed and invisible when not. Proactive suggestions respect user flow states.

**In Practice:**
- Recommendations appear at natural pause points
- "Snooze" and "stop" options always available
- Never interrupt active work
- Time-aware interactions (respect late-night sessions, long focus periods)

**Anti-pattern:** Pop-up recommendations while user is mid-task.

---

## Behavioral Design Framework (Research-Derived)

### The Fogg Behavior Model Applied

Discovery behavior requires three elements to converge simultaneously:

**B = M × A × P** (Behavior = Motivation × Ability × Prompt)

| Component | Current State | Target Design |
|-----------|--------------|---------------|
| **Motivation** | Low (benefits unclear) | High (clear value visible) |
| **Ability** | Low (discovery is hard) | High (zero-friction discovery) |
| **Prompt** | Missing (no triggers) | Present (contextual suggestions) |

### Types of Prompts to Design

| Prompt Type | When to Use | Example |
|-------------|-------------|---------|
| **Spark** | When motivation is low | "This skill saved developers 2 hours on average" |
| **Facilitator** | When ability is low | One-click skill activation |
| **Signal** | When M+A already present | "A skill is available for this task" |

### Key Behavioral Interventions

Based on Layer 3 academic research:

| Intervention | Design Application |
|--------------|-------------------|
| **Progressive Disclosure** | Show simple choices first; reveal complexity on demand |
| **Social Proof** | "12 developers in similar projects use this skill" |
| **Default Effects** | Pre-configure relevant skills based on detected stack |
| **Loss Aversion** | "You're missing out on X capability" vs "Try X" |
| **Commitment Devices** | "You enabled 3 skills - try one more?" |

### Natural Discovery Trigger Moments

Research identified these high-receptivity moments:

| Moment | Receptivity | Design Opportunity |
|--------|-------------|-------------------|
| First session after update | High | "What's new" curiosity |
| Workflow failure point | High | Frustration creates openness |
| Task completion | Medium | "Level up" suggestion |
| Onboarding (Days 1-14) | High | Active exploration mindset |
| Colleague recommendation | Very High | Social proof trigger |

### The 11-Week Adoption Journey

Research shows skill adoption follows predictable phases:

```
Week 1-2:   4% adoption (Initial trial)
Week 6:     83% peak (Active experimentation)
Week 11+:   60% stable (Habitual usage)
```

**Design Implication:** Plan for sustained engagement, not just initial discovery.

---

## User Goals Matrix

### Goals by Persona and Category

| Goal | Explorer | Optimizer | Standardizer | Creator | Skeptic | Overwhelmed |
|------|----------|-----------|--------------|---------|---------|-------------|
| **Discovery** |
| Find relevant skills | Browse broadly | Search specifically | Curate for team | Ensure own skills found | Evaluate before install | Get recommendations |
| Discover new capabilities | High priority | Low priority | Medium priority | Medium priority | Low priority | Low priority |
| Stay updated on ecosystem | High priority | Low priority | Medium priority | High priority | Low priority | Low priority |
| **Evaluation** |
| Trust recommendations | Social proof | Measurable data | Enterprise signals | Fair scoring | Transparent criteria | Simple guidance |
| Compare alternatives | Side-by-side views | ROI comparison | Team fit analysis | Competitor analysis | Deep inspection | Not needed |
| Verify quality | Community signals | Performance data | Security audit | Fair scoring | Code inspection | Trust defaults |
| **Adoption** |
| Install easily | One-click | Zero-config | Team rollout | Clear process | Reversible | Guided wizard |
| Configure for needs | Customization | Minimal config | Standardization | Author settings | Full control | Defaults only |
| Integrate with workflow | Multiple surfaces | Seamless | Consistent team | Analytics | Non-intrusive | Automatic |
| **Ongoing Use** |
| Get ongoing value | Continuous discovery | Time savings | Team productivity | Author insights | Reliable function | Reduced confusion |
| Learn and improve | Exploration | Efficiency gains | Team capability | Community growth | Self-reliance | Competence building |
| Share with others | Discovery sharing | ROI sharing | Standards sharing | Skill promotion | Honest review | Gratitude |

### Priority Goals by Journey Stage

| Journey Stage | Primary Goal | Secondary Goal | Tertiary Goal |
|---------------|--------------|----------------|---------------|
| First Discovery - Awareness | Understand value | Assess effort | Verify trust |
| First Discovery - Trial | Test safely | Get quick value | Maintain control |
| First Discovery - First Value | Experience benefit | Confirm expectations | Plan next steps |
| First Discovery - Return | Decide commitment | Identify more value | Share experience |
| Daily Workflow - Trigger | Recognize opportunity | Minimal disruption | Quick access |
| Daily Workflow - Engagement | Find relevant info | Fast response | Clear presentation |
| Daily Workflow - Value | Solve problem | Verify help | Note for future |
| Daily Workflow - Exit | Return to work | Clean exit | No lingering |
| Team Adoption - Champion | Validate for team | Prepare justification | Initiate discussion |
| Team Adoption - Trial | Test with team | Monitor adoption | Collect feedback |
| Team Adoption - Standardization | Consistent setup | Onboarding process | Policy enforcement |
| Team Adoption - Scale | Fast onboarding | Standard maintenance | Exception handling |
| Skill Creation - Create | Improve workflow | Build effectively | Test thoroughly |
| Skill Creation - Distribute | Publish easily | Understand quality | Get feedback |
| Skill Creation - Discovery | Get found | Monitor installs | Respond to users |
| Skill Creation - Reputation | Build credibility | Maintain skill | Grow portfolio |

---

## Related Documents

- [Personas](./personas/index.md) - Detailed user archetypes
- [User Journeys](./journeys/index.md) - Stage-by-stage user flows
- [Key Moments](./moments/index.md) - Critical interaction design
- [Failure States](./failure-states.md) - Error handling design
- [Tone of Voice](./tone-of-voice.md) - Communication guidelines

---

*Design Overview - December 26, 2025*
